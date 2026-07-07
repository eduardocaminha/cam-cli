// test/supervisor/auto-ship-real-writers.test.ts
//
// Regression test (US-002, CAM-191): drives runSidecarLoop's terminal
// 'complete' tick with the REAL state-file writers (not no-op fakes), against
// a real temporary cam-loop state file and a real temporary prd.json.
//
// Every pre-existing auto-ship test (test/supervisor/auto-chain.test.ts)
// injects clearActive as a no-op and hard-codes readLoopPhaseFn to a constant
// closure, and drives runSidecarLoop with a FAKE runSupervisorFn that returns
// a canned SupervisorResult directly (never touching the real onProgress
// unlink-on-complete). None of those tests can observe the CAM-191 clobber
// chain: a later state-file write (clearActive / teardown) silently erasing
// the earlier phase:shipping write. This test exercises the REAL production
// writers end-to-end so that regression class can never come back silently.
//
// Real production writers exercised:
//   - makeClearActive(claudeDir, cwd)   (src/commands/sidecar.ts, exported US-001)
//   - makeSetPhaseFn(claudeDir, cwd)    (src/commands/sidecar.ts, exported;
//     production autoShipFn is the 1-line setPhase('shipping') wrapper --
//     see makeAutoShipFn in sidecar.ts)
//   - makeOnProgress(...)               (src/supervisor/host.ts; extracted in
//     this story from buildSupervisorOptions -- the real unlink-on-complete
//     behavior at the terminal 'complete' status)
//   - makeReadLoopPhase(claudeDir)      (src/commands/sidecar.ts, exported;
//     real parser over the SAME temp state file, not a hard-coded closure)
//   - the REAL runSupervisor (runSidecarLoop defaults runSupervisorFn to it)
//
// RED verification (pre-fix): checking out the pre-CAM-191/US-001 loop.ts
// (autoShipFn dispatched from INSIDE runSupervisor, before the outer-loop
// clearActive rewrite) against this test fails: clearActive's post-hoc
// rewrite clobbers the earlier phase:shipping write. See the commit message
// for the actual observed failure output.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSidecarLoop, type RunSidecarLoopOptions, type RunSupervisorOptions } from '../../src/supervisor/loop.ts';
import { makeClearActive, makeReadLoopPhase, makeSetPhaseFn } from '../../src/commands/sidecar.ts';
import { makeOnProgress } from '../../src/supervisor/host.ts';
import { renderStateFile, writeStateFile } from '../../src/commands/next.ts';
import { parseStateFile } from '../../src/commands/status.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';

const ESCAPE = Symbol('escape');

/** A PRD where the single story already passes and review is CLEAN, so
 *  decideNextAction resolves 'complete' on the very first supervisor tick
 *  without ever dispatching a worker. */
function makeCleanPrd(): PrdSnapshot {
	return {
		userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }],
		review: { roundsCompleted: 1, maxRounds: 3, lastVerdict: 'CLEAN' },
	};
}

describe('US-002: real-writer regression -- phase:shipping survives the terminal teardown chain', () => {
	test('after the complete tick the state file carries phase:shipping; the following tick reads it via the REAL parser and dispatches runShipPhaseFn exactly once', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-auto-ship-real-'));
		try {
			const claudeDir = join(cwd, '.claude');
			const scriptsDir = join(cwd, 'scripts', 'cam');
			mkdirSync(claudeDir, { recursive: true });
			mkdirSync(scriptsDir, { recursive: true });

			const prdPath = join(scriptsDir, 'prd.json');
			const stateFilePath = join(claudeDir, 'cam-loop.local.md');

			writeFileSync(prdPath, `${JSON.stringify(makeCleanPrd(), null, 2)}\n`, 'utf8');

			// Seed a live state file the same way the real supervisor would (via
			// the real renderStateFile/writeStateFile writers).
			const seedBody = renderStateFile({
				maxIterations: 50,
				completionPromise: 'COMPLETE',
				startedAt: new Date().toISOString(),
				pid: 1,
				phase: 'implementing',
			});
			writeStateFile(cwd, seedBody, { force: true });

			// --- Real production writers under test ---
			const realClearActive = makeClearActive(claudeDir, cwd);
			const realReadLoopPhase = makeReadLoopPhase(claudeDir);
			const realOnProgress = makeOnProgress(stateFilePath, {
				maxIterations: 50,
				completionPromise: 'COMPLETE',
				startedAt: new Date().toISOString(),
				pid: 1,
			});

			const readPrd = (): PrdSnapshot | null => {
				try {
					return JSON.parse(readFileSync(prdPath, 'utf8')) as PrdSnapshot;
				} catch {
					return null;
				}
			};
			const writePrd = (prd: PrdSnapshot): void => {
				writeFileSync(prdPath, `${JSON.stringify(prd, null, 2)}\n`, 'utf8');
			};

			// Everything below is never invoked: decideNextAction resolves
			// 'complete' on the first tick (no worker dispatch, no review dispatch).
			const supervisorOpts: RunSupervisorOptions = {
				spawn: () => ({ stdout: '', exitCode: 0 }),
				capturePane: () => '',
				readPrd,
				writePrd,
				readHandoff: () => null,
				clock: () => '2026-07-07T21:00:00Z',
				reviewDispatch: () => ({ status: 'ok', detail: '' }),
				writeSessionMarker: () => {},
				isPaneAlive: () => true,
				workerPaneId: '%2',
				prdPath,
				handoffPath: join(scriptsDir, 'handoff.json'),
				permissionMode: 'bypassPermissions',
				taskPrompt: 'test',
				sleepFn: () => {},
				nowMs: () => 0,
				// teardownWorkerPaneFn deliberately omitted: runSupervisor defaults it
				// to a no-op, so this test never spawns a real tmux process while
				// still exercising the real onProgress unlink + real
				// clearActive/setPhase chain that CAM-191 broke.
				onProgress: realOnProgress,
			};

			let shipPhaseCalls = 0;
			let sleepCalls = 0;
			let activeCallCount = 0;

			const loopOpts: RunSidecarLoopOptions = {
				buildOpts: () => supervisorOpts,
				readActive: () => {
					activeCallCount++;
					return activeCallCount === 1;
				},
				clearActive: realClearActive,
				sleep: () => {
					sleepCalls++;
					if (sleepCalls >= 2) throw ESCAPE;
				},
				hasPendingStories: () => true,
				acquireLock: () => ({ acquired: true as const, release: () => {} }),
				readLoopPhaseFn: realReadLoopPhase,
				autoShipFn: () => {
					// Mirrors makeAutoShipFn (sidecar.ts) exactly: a 1-line
					// setPhase('shipping') wrapper over the real, exported
					// makeSetPhaseFn.
					makeSetPhaseFn(claudeDir, cwd)('shipping');
				},
				runShipPhaseFn: async (): Promise<void> => {
					shipPhaseCalls++;
				},
			};

			let caughtErr: unknown;
			try {
				await runSidecarLoop(loopOpts);
			} catch (err) {
				caughtErr = err;
			}

			expect(caughtErr).toBe(ESCAPE);

			// The state file must still exist and carry phase:shipping -- the
			// clobber this regression targets deletes/rewrites it back to idle.
			expect(existsSync(stateFilePath)).toBe(true);
			const finalContents = readFileSync(stateFilePath, 'utf8');
			const parsed = parseStateFile(finalContents);
			expect(parsed?.phase).toBe('shipping');

			// The FOLLOWING tick's real readLoopPhaseFn parser (not a hard-coded
			// () => 'shipping' closure) must observe the write and dispatch the
			// ship phase exactly once.
			expect(shipPhaseCalls).toBe(1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
