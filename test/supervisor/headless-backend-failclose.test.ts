// test/supervisor/headless-backend-failclose.test.ts
//
// US-R1-005 (CAM-516): headless dispatch plus a non-'claude' implBackend must
// fail closed BEFORE any dispatch, not silently render a `claude` argv while
// project.toml configures a different backend. `buildHeadlessChildInvocation`
// (headless-argv.ts:74) hardcodes argv[0] = 'claude', so with
// `[backend] implementer = "codex"` plus `--headless` the loop used to
// silently dispatch `claude` -- contradicting the configured backend, with no
// spawn-resolution audit event recorded either. These tests pin four
// observable contracts:
//
//   1. headless on + implBackend === 'codex' -> the loop blocks BEFORE
//      dispatching, with a blocked outcome whose detail names both
//      'headless' and the resolved backend ('codex'), and headlessDispatchFn
//      is never invoked.
//   2. a spawn-resolution event IS still recorded (fixing the "no
//      emitSpawnResolution event recorded either" half of the bug) even
//      though the dispatch itself is blocked.
//   3. 'claude backend still dispatches': the fail-close is scoped to a
//      non-claude backend only -- headless on + implBackend 'claude' (the
//      default, no [backend] section) still dispatches normally through the
//      existing US-005 seam.
//   4. the claude-backend success path ALSO now emits a spawn-resolution
//      event (previously the headless branch emitted none at all, for any
//      backend).

import { describe, expect, test, beforeEach } from 'bun:test';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
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
import type { WorkerReport } from '../../src/supervisor/worker-report.ts';
import type { HeadlessDispatchOutcome } from '../../src/supervisor/headless-dispatch.ts';
import type { WorkerEvent } from '../../src/supervisor/events.ts';
import { withVerifiedPanePid } from '../helpers/verified-pane-pid-spawn.ts';

const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';
const WORKER_PANE_ID = '%3';

let uuidCounter = 0;
function fakeGenUuid(): string {
	uuidCounter++;
	return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
}

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
		timestamp: '2026-06-08T00:00:00Z',
	};
}

const CODEX_CONFIG_DIR = createTestTmpdir('cam-headless-backend-failclose-codex-config-');
const CODEX_CONFIG_PATH = join(CODEX_CONFIG_DIR, 'project.toml');
writeFileSync(CODEX_CONFIG_PATH, '[backend]\nimplementer = "codex"\n');

const CLAUDE_CONFIG_DIR = createTestTmpdir('cam-headless-backend-failclose-claude-config-');
const CLAUDE_CONFIG_PATH = join(CLAUDE_CONFIG_DIR, 'project.toml');
writeFileSync(CLAUDE_CONFIG_PATH, '[backend]\nimplementer = "claude"\n');

function makeBaseOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	const spawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
	const capturePane: CapturePane = (_paneId) => '';
	const readPrd: ReadPrd = () => null;
	const writePrd: WritePrd = (_prd) => {};
	const readHandoff: ReadHandoff = () => null;
	const clock: ClockFn = () => '2026-06-08T00:00:00Z';
	const reviewDispatch: ReviewDispatch = (_uuid) => ({ status: 'ok', detail: 'review ok' });
	const writeSessionMarker: WriteSessionMarker = (_storyId, _uuid) => {};
	const isPaneAlive: IsPaneAlive = (_paneId) => true;

	const merged: RunSupervisorOptions = {
		spawn,
		capturePane,
		readPrd,
		writePrd,
		readHandoff,
		clock,
		genUuid: fakeGenUuid,
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
		...overrides,
		configPath: 'configPath' in overrides ? overrides.configPath : CODEX_CONFIG_PATH,
	};
	merged.spawn = withVerifiedPanePid(overrides.spawn ?? spawn);
	return merged;
}

function oneStoryBase(): Partial<RunSupervisorOptions> {
	const prdImpl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
	const prdDone = makePrd({
		stories: [{ id: 'US-001', priority: 1, passes: true }],
		review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
	});
	const fakeReport: WorkerReport = {
		outcome: 'DONE',
		story: 'US-001',
		gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
		notes: 'none',
	};
	let prdCall = 0;
	return {
		readPrd: () => {
			prdCall++;
			return prdCall <= 1 ? prdImpl : prdDone;
		},
		readHandoff: () => makeHandoff('US-001'),
		readWorkerReport: () => fakeReport,
	};
}

beforeEach(() => {
	uuidCounter = 0;
});

describe('headless + non-claude backend fail-close (US-R1-005, CAM-516)', () => {
	test('blocks before dispatch with a detail naming both headless and the resolved backend', async () => {
		let headlessDispatchCalls = 0;

		const opts = makeBaseOpts({
			...oneStoryBase(),
			headless: true,
			workerIsolation: 'host',
			configPath: CODEX_CONFIG_PATH,
			headlessDispatchFn: async () => {
				headlessDispatchCalls++;
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.lastOutcome?.kind).toBe('blocked');
		expect(result.lastOutcome?.detail).toContain('headless');
		expect(result.lastOutcome?.detail).toContain('codex');
		expect(headlessDispatchCalls).toBe(0);
	});

	test('still records a spawn-resolution audit event even though the dispatch is blocked', async () => {
		const events: WorkerEvent[] = [];

		const opts = makeBaseOpts({
			...oneStoryBase(),
			headless: true,
			workerIsolation: 'host',
			configPath: CODEX_CONFIG_PATH,
			logEvent: (e) => events.push(e),
			headlessDispatchFn: async () => {
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		const spawnEvents = events.filter((e) => e.kind === 'spawn-resolution');
		expect(spawnEvents.length).toBe(1);
		expect(spawnEvents[0]?.detail).toMatchObject({ phase: 'implementer', backend: 'codex' });
	});

	test('claude backend still dispatches normally', async () => {
		const headlessCalls: Array<{ uuid: string; storyId: string | undefined; taskPrompt: string; model: string }> = [];

		const opts = makeBaseOpts({
			...oneStoryBase(),
			headless: true,
			workerIsolation: 'host',
			configPath: CLAUDE_CONFIG_PATH,
			headlessDispatchFn: async (params) => {
				headlessCalls.push(params);
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.lastOutcome?.kind).toBe('pass');
		expect(headlessCalls.length).toBe(1);
		expect(headlessCalls[0]?.storyId).toBe('US-001');
	});

	test('claude backend also emits a spawn-resolution audit event on the success path', async () => {
		const events: WorkerEvent[] = [];

		const opts = makeBaseOpts({
			...oneStoryBase(),
			headless: true,
			workerIsolation: 'host',
			configPath: CLAUDE_CONFIG_PATH,
			logEvent: (e) => events.push(e),
			headlessDispatchFn: async () => {
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
		});

		await runSupervisor(opts);

		const spawnEvents = events.filter((e) => e.kind === 'spawn-resolution');
		expect(spawnEvents.length).toBe(1);
		expect(spawnEvents[0]?.detail).toMatchObject({ phase: 'implementer', backend: 'claude' });
	});
});
