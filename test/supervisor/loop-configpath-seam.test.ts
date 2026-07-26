// test/supervisor/loop-configpath-seam.test.ts
//
// Unit tests for US-001 (CAM-420): the `configPath` DI seam on
// RunSupervisorOptions, threaded into the two implementer-resolution call
// sites (readPhaseBackend('implementer', opts.configPath) and the
// resolvePhaseModel({ ..., configPath: opts.configPath }) call immediately
// below it) inside runSupervisor (src/supervisor/loop.ts).
//
// Modelled on test/supervisor/review.test.ts:2008's "AC5 regression:
// reviewer=codex resolved via the injected seam does not fail with
// codex-auth-failed" test (the reviewer-side sibling seam from CAM-405),
// adapted to the implementer dispatch path and runSupervisor's
// oneStoryBase-style fake wiring (mirrors loop-model-resolution.test.ts's
// conventions).
//
// Coverage:
//   AC1/AC2: covered by the static grep oracles in prd.json (no runtime test
//     needed for "the field exists" / "the call sites pass it through").
//   AC3: covered implicitly -- every existing suite (loop.test.ts,
//     loop-model-resolution.test.ts, etc.) omits configPath and stays green,
//     proving the omitted-seam path is byte-for-byte unchanged.
//   AC4 (this file): a tmpdir project.toml selects [backend] implementer =
//     "codex" plus a [models.codex] implementer pin (gpt-5-codex). Injecting
//     a fake codexAuthCheckFn alongside configPath proves resolution went
//     through the FIXTURE (not the repo's live scripts/cam/project.toml,
//     which stays on 'claude'): (a) the fake auth check was called, (b) no
//     outcome detail contains 'codex-auth-failed', (c) the dispatched worker
//     command carries the pinned codex model.
//
// Red-sweep (issue AC7): this file was copied into a worktree of unmodified
// main (git worktree add <tmp> main; bun install --frozen-lockfile inside
// the worktree first) and run there with
// `bun test loop-configpath-seam.test.ts`. Measured result: 1 fail / 0 pass.
// On main, RunSupervisorOptions has no configPath field, so the extra
// property on the opts literal is inert at runtime (Bun strips types, does
// not typecheck excess object properties); readPhaseBackend('implementer')
// is called with NO configPath argument at loop.ts's implementer call site,
// so it resolves the repo's own live scripts/cam/project.toml relative to
// process.cwd() (the worktree root, which the test does not chdir away
// from) instead of the tmpdir fixture. That live config selects the claude
// backend, so codexAuthPreflight's `backend !== 'codex'` short-circuit means
// the injected codexAuthCheckFn is NEVER invoked. Assertion (a)
// `expect(authCheckCalled).toBe(true)` fails on main with `authCheckCalled`
// still `false`, exactly as required by the red-sweep gate.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSupervisor } from '../../src/supervisor/loop.ts';
import type { RunSupervisorOptions } from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import type { WorkerReport } from '../../src/supervisor/worker-report.ts';

// ---------------------------------------------------------------------------
// Fake builder helpers (mirrors test/supervisor/loop-model-resolution.test.ts)
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
		timestamp: '2026-07-26T00:00:00Z',
	};
}

function donePane(storyId: string): string {
	return `Implemented something\nCAM_IMPLEMENTER_STATUS=DONE story=${storyId}\n`;
}

const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';
const WORKER_PANE_ID = '%3';

let uuidCounter = 0;
function fakeGenUuid(): string {
	uuidCounter++;
	return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
}

function makeBaseOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	return {
		spawn: (_cmd, _args) => ({ stdout: '', exitCode: 0 }),
		capturePane: (_paneId) => '',
		readPrd: () => null,
		writePrd: (_prd) => {},
		readHandoff: () => null,
		clock: () => '2026-07-26T00:00:00Z',
		genUuid: fakeGenUuid,
		reviewDispatch: (_uuid) => ({ status: 'ok', detail: 'review ok' }),
		writeSessionMarker: (_storyId, _uuid) => {},
		isPaneAlive: (_paneId) => true,
		workerPaneId: WORKER_PANE_ID,
		prdPath: PRD_PATH,
		handoffPath: HANDOFF_PATH,
		permissionMode: 'bypassPermissions',
		taskPrompt: 'Implement the next story from the PRD.',
		sleepFn: (_ms: number) => {},
		nowMs: () => 0,
		...overrides,
	};
}

/**
 * Shared helper: build a one-story PRD + matching report that drives the loop
 * to 'complete' in one iteration (mirrors loop-model-resolution.test.ts's
 * oneStoryBase, itself mirroring loop.test.ts).
 */
function oneStoryBase(): Partial<RunSupervisorOptions> {
	const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
	const prd_done = makePrd({
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
			return prdCall <= 1 ? prd_impl : prd_done;
		},
		readHandoff: () => makeHandoff('US-001'),
		capturePane: (_paneId) => donePane('US-001'),
		readWorkerReport: () => fakeReport,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSupervisor US-001 (CAM-420): configPath seam on the implementer resolution call sites', () => {
	test('AC6: configPath override resolves implBackend=codex from the fixture, not the live scripts/cam/project.toml, with no codex-auth-failed abort', async () => {
		const codexConfigDir = mkdtempSync(join(tmpdir(), 'cam-loop-configpath-seam-'));
		const codexConfigPath = join(codexConfigDir, 'project.toml');
		writeFileSync(
			codexConfigPath,
			'[backend]\nimplementer = "codex"\n\n[models.codex]\nimplementer = "gpt-5-codex"\n',
		);
		try {
			const dispatchedCmds: string[] = [];
			let authCheckCalled = false;
			const opts = makeBaseOpts({
				...oneStoryBase(),
				// The seam under test: implBackend resolves to 'codex' from THIS
				// fixture, not from the repo's live scripts/cam/project.toml (which
				// stays on 'claude'). Combined with the pre-existing
				// codexAuthCheckFn seam (US-002, CAM-352) faking an authenticated
				// codex, this proves the implementer dispatch path can validate a
				// codex backend in CI without real codex auth or a chdir/stub
				// workaround (patterns.md CAM-350 note).
				configPath: codexConfigPath,
				codexAuthCheckFn: () => {
					authCheckCalled = true;
					return { authenticated: true };
				},
				spawn: (_cmd, args) => {
					if (args.includes('respawn-pane')) {
						const lastArg = args[args.length - 1];
						if (typeof lastArg === 'string') dispatchedCmds.push(lastArg);
					}
					return { stdout: '', exitCode: 0 };
				},
			});

			const result = await runSupervisor(opts);

			// (a) the fake auth check was called.
			expect(authCheckCalled).toBe(true);
			// (b) no outcome detail contains 'codex-auth-failed'.
			expect(result.status).not.toBe('blocked');
			expect(result.lastOutcome?.detail ?? '').not.toContain('codex-auth-failed');
			// (c) the dispatched worker command carries the pinned codex model.
			expect(dispatchedCmds.length).toBeGreaterThanOrEqual(1);
			const dispatchedCmd = dispatchedCmds[0] ?? '';
			expect(dispatchedCmd).toContain('gpt-5-codex');
		} finally {
			rmSync(codexConfigDir, { recursive: true, force: true });
		}
	});
});
