// test/integration/headless-roundtrip.test.ts
//
// Integration test (REAL git + REAL child process): proves one story travels
// the headless path (US-005, CAM-516) through commit and push against a real
// on-disk git remote, end to end through runSupervisor -- not through a unit
// fake. US-007 (CAM-516).
//
// Scope honesty (mirrors this story's `notes` in prd.json): the fixture
// executable (test/fixtures/headless/roundtrip-child.ts) stands in for the
// `claude` binary, so this test proves the SEAM (loop.ts's headless branch,
// US-005) plus the git wire (a real commit reaching a real bare remote), not
// a real model dispatch. That gap is intentional and tracked separately as
// an operator ceremony.
//
// What "real" means here, precisely:
//   - A real bare remote (`git init --bare`) and a real scratch working
//     clone are created on disk in a tmpdir (createTestTmpdir).
//   - runSupervisor's headless branch (`opts.headless = true`) is exercised
//     for real: the injected `headlessDispatchFn` closure wires the REAL
//     production functions (`openHeadlessDispatchLog`, `runHeadlessDispatch`)
//     around a REAL spawned child (`bun roundtrip-child.ts`), never an
//     in-process mock of either.
//   - The fixture child performs a REAL `git commit --allow-empty` + `git
//     push` against the scratch clone's real `origin` remote.
//   - Everything ELSE runSupervisor needs (PRD state, handoff, review
//     dispatch, pane liveness) is faked in-memory, mirroring
//     test/supervisor/headless-route.test.ts's `makeBaseOpts` recipe: this
//     story is not re-proving PRD/review bookkeeping (already covered
//     elsewhere), only the headless dispatch's real I/O boundary.
//
// Each of the three named tests below (AC2/AC3/AC4) re-runs the full round
// trip in its own `beforeEach`, so each is independently satisfiable under a
// `bun test ... -t "<name>"` filter, matching this story's oracles.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { gitAvailable } from '../helpers/test-deps.ts';

import { runSupervisor } from '../../src/supervisor/loop.ts';
import type {
	RunSupervisorOptions,
	SpawnFn,
	CapturePane,
	ReadPrd,
	WritePrd,
	ReadHandoff,
	ClockFn,
	ReviewDispatch,
	WriteSessionMarker,
	IsPaneAlive,
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import { openHeadlessDispatchLog, headlessDispatchLogPath } from '../../src/supervisor/headless-log.ts';
import { runHeadlessDispatch } from '../../src/supervisor/headless-dispatch.ts';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/headless/roundtrip-child.ts', import.meta.url));

if (!existsSync(FIXTURE_PATH)) {
	throw new Error(`roundtrip-child.ts missing at ${FIXTURE_PATH} — did test/fixtures/headless/ get checked in?`);
}

const COMMIT_MESSAGE = 'feat: [US-001] - Fixture round-trip commit';
const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';
const WORKER_PANE_ID = '%3';

const CONFIG_DIR = createTestTmpdir('cam-headless-roundtrip-config-');
const CONFIG_PATH = join(CONFIG_DIR, 'project.toml');
writeFileSync(CONFIG_PATH, '[backend]\nimplementer = "claude"\n');

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

function git(dir: string, args: string[]): SpawnSyncReturns<string> {
	return spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' }) as SpawnSyncReturns<string>;
}

/** Real bare remote + real scratch working clone, wired together via `origin`. */
function makeScratchRepoWithBareRemote(): { bareRemoteDir: string; scratchDir: string } {
	const bareRemoteDir = createTestTmpdir('cam-headless-rt-bare-');
	git(bareRemoteDir, ['init', '--bare']);

	const scratchDir = createTestTmpdir('cam-headless-rt-work-');
	git(scratchDir, ['init']);
	git(scratchDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
	git(scratchDir, ['config', 'user.email', 'test@example.com']);
	git(scratchDir, ['config', 'user.name', 'Test User']);
	git(scratchDir, ['commit', '--allow-empty', '-m', 'chore: initial commit']);
	git(scratchDir, ['remote', 'add', 'origin', bareRemoteDir]);
	git(scratchDir, ['push', '-u', 'origin', 'main']);

	return { bareRemoteDir, scratchDir };
}

// ---------------------------------------------------------------------------
// PRD / handoff fakes (mirrors test/supervisor/headless-route.test.ts)
// ---------------------------------------------------------------------------

function makePrd(opts: {
	stories: Array<{ id: string; priority: number; passes: boolean; requires?: string }>;
	review?: PrdSnapshot['review'];
}): PrdSnapshot {
	return {
		userStories: opts.stories.map((s) => ({
			id: s.id,
			priority: s.priority,
			passes: s.passes,
			requires: s.requires ?? null,
		})),
		review: opts.review,
	};
}

function makeHandoff(storyId: string) {
	return {
		lastCompletedStory: { id: storyId, title: `Story ${storyId}` },
		branchName: 'cam/test',
		timestamp: '2026-08-09T00:00:00Z',
	};
}

// ---------------------------------------------------------------------------
// Round-trip runner: shared by all three named tests below.
// ---------------------------------------------------------------------------

interface RoundTripResult {
	bareRemoteDir: string;
	scratchDir: string;
	claudeDir: string;
	spawnCalls: string[][];
	capturedUuid: string | undefined;
	status: string;
}

async function runRoundTrip(): Promise<RoundTripResult> {
	const { bareRemoteDir, scratchDir } = makeScratchRepoWithBareRemote();
	const claudeDir = join(scratchDir, '.claude');

	let capturedUuid: string | undefined;

	// The real US-005 seam: the exact production functions (US-001/US-002/
	// US-003) host.ts's real headlessDispatchFn closure wires together, here
	// pointed at the fixture executable instead of the real `claude` binary.
	const headlessDispatchFn: RunSupervisorOptions['headlessDispatchFn'] = async (params) => {
		capturedUuid = params.uuid;
		const log = openHeadlessDispatchLog(claudeDir, params.uuid);
		const inputMessage = JSON.stringify({
			type: 'user',
			message: { role: 'user', content: params.taskPrompt },
		});
		return runHeadlessDispatch({
			argv: ['bun', FIXTURE_PATH, COMMIT_MESSAGE],
			env: process.env,
			cwd: scratchDir,
			inputMessage,
			log,
		});
	};

	const prdImpl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
	const prdDone = makePrd({
		stories: [{ id: 'US-001', priority: 1, passes: true }],
		review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
	});
	let prdCall = 0;
	const readPrd: ReadPrd = () => {
		prdCall++;
		return prdCall <= 1 ? prdImpl : prdDone;
	};
	const writePrd: WritePrd = (_prd) => {};
	const readHandoff: ReadHandoff = () => makeHandoff('US-001');
	const clock: ClockFn = () => '2026-08-09T00:00:00Z';
	const reviewDispatch: ReviewDispatch = async (_uuid) => ({ status: 'ok', detail: 'review ok' });
	const writeSessionMarker: WriteSessionMarker = (_storyId, _uuid) => {};

	// AC4 ('no tmux'): the injected tmux spawn fake. Headless mode structurally
	// never reaches respawn-pane/ensureWorkerPane/runVerifiedWorkerDispatch
	// (test/supervisor/headless-route.test.ts's "routes implementer dispatch"
	// proves the same fake DOES record `respawn-pane` calls when headless is
	// off), so recording zero calls here is a real proof by absence, not a
	// tautology.
	const spawnCalls: string[][] = [];
	const spawn: SpawnFn = (_cmd, args) => {
		spawnCalls.push(args);
		return { stdout: '', exitCode: 0 };
	};
	const capturePane: CapturePane = (_paneId) => '';
	const isPaneAlive: IsPaneAlive = (_paneId) => {
		throw new Error('isPaneAlive must never be called in headless mode');
	};

	const opts: RunSupervisorOptions = {
		spawn,
		capturePane,
		readPrd,
		writePrd,
		readHandoff,
		clock,
		reviewDispatch,
		writeSessionMarker,
		isPaneAlive,
		workerPaneId: WORKER_PANE_ID,
		prdPath: PRD_PATH,
		handoffPath: HANDOFF_PATH,
		permissionMode: 'bypassPermissions',
		taskPrompt: 'Implement the next story from the PRD.',
		sleepFn: (_ms: number) => {},
		nowMs: () => 0,
		headless: true,
		headlessDispatchFn,
		configPath: CONFIG_PATH,
	};

	const result = await runSupervisor(opts);

	return { bareRemoteDir, scratchDir, claudeDir, spawnCalls, capturedUuid, status: result.status };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('headless round trip against a real repo + real bare remote (US-007, CAM-516)', () => {
	let ctx: RoundTripResult;

	beforeEach(async () => {
		if (!gitAvailable) return;
		ctx = await runRoundTrip();
	});

	afterEach(() => {
		// createTestTmpdir directories are reaped run-wide (test/helpers/reap-preload.ts);
		// nothing to clean up per-test here.
	});

	test.skipIf(!gitAvailable)('one dispatch runs through the real headless seam', () => {
		expect(ctx.status).toBe('complete');
		expect(ctx.capturedUuid).toBeDefined();
	});

	test.skipIf(!gitAvailable)('commit reaches the bare remote', () => {
		// Read the commit sha back out of the BARE remote with a real git
		// invocation against IT (not the working clone): `refs/heads/main` is
		// the bare repo's own ref, resolved with `git -C <bareRemoteDir>`.
		const bareShaResult = git(ctx.bareRemoteDir, ['rev-parse', 'refs/heads/main']);
		expect(bareShaResult.status).toBe(0);
		const bareSha = bareShaResult.stdout.trim();
		expect(bareSha).toMatch(/^[0-9a-f]{40}$/);

		// The commit object is real and reachable directly in the bare remote:
		// its subject matches the fixture's own commit, read via a git
		// invocation scoped to bareRemoteDir.
		const bareSubjectResult = git(ctx.bareRemoteDir, ['log', '-1', '--format=%s', bareSha]);
		expect(bareSubjectResult.status).toBe(0);
		expect(bareSubjectResult.stdout.trim()).toBe(COMMIT_MESSAGE);

		// Cross-check against the working clone's HEAD: same commit, proving the
		// push actually landed the clone's tip on the bare remote (not merely
		// some other unrelated commit satisfying the subject match above).
		const scratchShaResult = git(ctx.scratchDir, ['rev-parse', 'HEAD']);
		expect(scratchShaResult.stdout.trim()).toBe(bareSha);
	});

	test.skipIf(!gitAvailable)('append-only log carries the result event', () => {
		expect(ctx.capturedUuid).toBeDefined();
		const uuid = ctx.capturedUuid as string;
		const logPath = headlessDispatchLogPath(ctx.claudeDir, uuid);
		expect(existsSync(logPath)).toBe(true);

		const lines = readFileSync(logPath, 'utf8')
			.split('\n')
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as Record<string, unknown>);

		const resultLine = lines.find((l) => l.type === 'result');
		expect(resultLine).toBeDefined();
		expect(resultLine?.total_cost_usd).toBe(0.0789);
	});

	test.skipIf(!gitAvailable)('no tmux', () => {
		expect(ctx.spawnCalls.length).toBe(0);
	});
});
