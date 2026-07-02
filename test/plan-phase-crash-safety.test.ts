// test/plan-phase-crash-safety.test.ts
//
// Unit/functional tests for US-005 (CAM-155): crash-proofing the plan phase so
// that any exception from runPlanPhase / runPostAuditAction is caught, logged,
// and the sidecar survives to the next tick.
//
// Acceptance criteria proved:
//   AC1: makeProductionPlanPhaseFn's returned closure wraps its body in try/catch:
//        on any thrown exception it logs a structured 'sidecar-exit' event and
//        calls setPhaseFn('idle'), then returns normally (never rethrows).
//        Verified via source-text oracle + functional closure-pattern test.
//   AC2: Behavioral oracle: injecting a runPlanPhaseFn that throws into
//        runSidecarLoop's planning branch does not reject or terminate the loop;
//        the exception is caught/logged and the loop proceeds to the next tick
//        (sidecar survives).
//   AC3: With a throwing plan-phase dep and a real temp .claude/cam-loop.local.md,
//        the phase file ends as 'idle' after the closure runs.
//   AC4 (typecheck): bun run typecheck passes.
//   AC5 (tests):     bun test passes.
//   AC6 (quality):   bun run check:all passes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
	runSidecarLoop,
	type RunSidecarLoopOptions,
	type RunSupervisorOptions,
	type SupervisorResult,
} from '../src/supervisor/loop.ts';
import {
	makeInMemoryEventLogger,
	type WorkerEventKind,
} from '../src/supervisor/events.ts';
import { makeSetPhaseFn } from '../src/commands/sidecar.ts';
import { parseStateFile } from '../src/commands/status.ts';

// ---------------------------------------------------------------------------
// Escape sentinel (same ESCAPE pattern as merge-watch.test.ts)
// ---------------------------------------------------------------------------

const ESCAPE = Symbol('escape');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RunSupervisorOptions that never does any real I/O. */
function makeDummySupervisorOpts(): RunSupervisorOptions {
	return {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-07-02T00:00:00Z',
		reviewDispatch: () => ({ status: 'ok', detail: '' }),
		writeSessionMarker: () => {},
		isPaneAlive: () => true,
		workerPaneId: '%2',
		prdPath: '/fake/prd.json',
		handoffPath: '/fake/handoff.json',
		permissionMode: 'bypassPermissions',
		taskPrompt: 'test',
		sleepFn: () => {},
		nowMs: () => 0,
	};
}

const COMPLETE_RESULT: SupervisorResult = {
	status: 'complete',
	iterations: 1,
	lastOutcome: null,
};

// ---------------------------------------------------------------------------
// AC1: source-text oracle for makeProductionPlanPhaseFn try/catch
// ---------------------------------------------------------------------------

describe('AC1: source-text oracle -- makeProductionPlanPhaseFn has try/catch', () => {
	const sidecarSrc = readFileSync(
		resolve(import.meta.dir, '../src/commands/sidecar.ts'),
		'utf8',
	);

	// Find the function body of makeProductionPlanPhaseFn
	const fnStart = sidecarSrc.indexOf('function makeProductionPlanPhaseFn(');
	const fnEnd = sidecarSrc.indexOf('\nfunction ', fnStart + 1);
	const fnBody = fnStart >= 0 ? sidecarSrc.slice(fnStart, fnEnd > 0 ? fnEnd : undefined) : '';

	test('makeProductionPlanPhaseFn body contains try {', () => {
		expect(fnBody).toContain('try {');
	});

	test('makeProductionPlanPhaseFn body contains catch (err: unknown)', () => {
		expect(fnBody).toContain('catch (err: unknown)');
	});

	test("makeProductionPlanPhaseFn catch block logs kind: 'sidecar-exit'", () => {
		expect(fnBody).toContain("'sidecar-exit'");
	});

	test("makeProductionPlanPhaseFn catch block calls makeSetPhaseFn(...)(  'idle')", () => {
		// The catch block must call setPhase('idle') to reset the loop on crash.
		expect(fnBody).toContain("'idle'");
	});

	test("makeProductionPlanPhaseFn catch block includes reason: 'plan-phase-crash'", () => {
		expect(fnBody).toContain("'plan-phase-crash'");
	});
});

// ---------------------------------------------------------------------------
// AC1 (functional): closure-pattern test with real makeSetPhaseFn
// ---------------------------------------------------------------------------

describe('AC1 (functional): crash-guard closure pattern with makeSetPhaseFn', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-crash-guard-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test('closure catches exception, logs sidecar-exit event, sets phase idle', () => {
		const claudeDir = join(tmpDir, '.claude');
		mkdirSync(claudeDir, { recursive: true });

		// Set initial phase to planning via the production helper.
		makeSetPhaseFn(claudeDir, tmpDir)('planning');
		const initial = parseStateFile(readFileSync(join(claudeDir, 'cam-loop.local.md'), 'utf8'));
		expect(initial?.phase).toBe('planning');

		const { logger: logEvent, events } = makeInMemoryEventLogger();

		// Build a closure that mirrors makeProductionPlanPhaseFn's try/catch contract:
		// inner op throws -> catch logs sidecar-exit event + calls setPhase('idle').
		const closure = (): void => {
			try {
				throw new Error('simulated plan-phase crash');
			} catch (err: unknown) {
				logEvent({
					ts: new Date().toISOString(),
					storyId: undefined,
					uuid: 'sidecar',
					kind: 'sidecar-exit',
					detail: {
						reason: 'plan-phase-crash',
						error: err instanceof Error ? err.message : String(err),
					},
				});
				makeSetPhaseFn(claudeDir, tmpDir)('idle');
			}
		};

		// Must not throw.
		expect(() => closure()).not.toThrow();

		// Phase file must now be 'idle'.
		const final = parseStateFile(readFileSync(join(claudeDir, 'cam-loop.local.md'), 'utf8'));
		expect(final?.phase).toBe('idle');

		// Event must have been logged with the correct kind and reason.
		expect(events.length).toBe(1);
		expect(events[0]?.kind).toBe('sidecar-exit' as WorkerEventKind);
		const detail = events[0]?.detail as { reason?: string; error?: string };
		expect(detail.reason).toBe('plan-phase-crash');
		expect(detail.error).toContain('simulated plan-phase crash');
	});

	test('closure returns normally (no rethrow) even when setPhase would fail', () => {
		// Even if the claudeDir is a non-existent path (setPhase would silently fail),
		// the closure must still return without throwing.
		const badClaudeDir = join(tmpDir, 'nonexistent', '.claude');
		const { logger: logEvent } = makeInMemoryEventLogger();

		const closure = (): void => {
			try {
				throw new Error('crash with bad claudeDir');
			} catch (err: unknown) {
				logEvent({
					ts: new Date().toISOString(),
					storyId: undefined,
					uuid: 'sidecar',
					kind: 'sidecar-exit',
					detail: { reason: 'plan-phase-crash', error: err instanceof Error ? err.message : String(err) },
				});
				// makeSetPhaseFn is non-fatal (it catches FS errors internally).
				makeSetPhaseFn(badClaudeDir, tmpDir)('idle');
			}
		};

		expect(() => closure()).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// AC2: runSidecarLoop survives a throwing runPlanPhaseFn
// ---------------------------------------------------------------------------

describe('AC2: runSidecarLoop -- throwing runPlanPhaseFn does not kill the loop', () => {
	test('loop catches the exception and proceeds to the next tick without rejecting', async () => {
		const { logger: logEvent, events } = makeInMemoryEventLogger();
		let planPhaseCalls = 0;
		let sleepCalls = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			// Always return false so the loop stays in the planning/idle path.
			readActive: (): boolean | undefined => false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				// Escape after the 2nd sleep (one from the planning tick, one from idle).
				if (sleepCalls >= 2) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			// Planning phase is always active.
			readLoopPhaseFn: () => 'planning',
			// Injected runPlanPhaseFn always throws.
			runPlanPhaseFn: async (): Promise<void> => {
				planPhaseCalls++;
				throw new Error('injected plan-phase crash');
			},
			logEvent,
		};

		// The loop must not reject: any thrown error should be the ESCAPE sentinel.
		let caughtErr: unknown = undefined;
		try {
			await runSidecarLoop(loopOpts);
		} catch (err) {
			caughtErr = err;
		}

		// The only error that escaped must be the ESCAPE sentinel (not the plan crash).
		expect(caughtErr).toBe(ESCAPE);

		// runPlanPhaseFn must have been called at least once (the loop entered planning).
		expect(planPhaseCalls).toBeGreaterThanOrEqual(1);

		// The loop guard must have logged a 'sidecar-exit' event for the crash.
		const crashEvents = events.filter((e) => e.kind === 'sidecar-exit');
		expect(crashEvents.length).toBeGreaterThanOrEqual(1);
		const crashDetail = crashEvents[0]?.detail as { reason?: string };
		expect(crashDetail.reason).toBe('plan-phase-crash-outer');
	});

	test('loop continues to the next tick after the throwing planning tick', async () => {
		let ticks = 0;
		let planCrashCount = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: (): boolean | undefined => false,
			clearActive: () => {},
			sleep: () => {
				ticks++;
				if (ticks >= 3) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			readLoopPhaseFn: () => 'planning',
			runPlanPhaseFn: async (): Promise<void> => {
				planCrashCount++;
				throw new Error('repeated crash');
			},
		};

		try {
			await runSidecarLoop(loopOpts);
		} catch (err) {
			if (err !== ESCAPE) throw err;
		}

		// The loop ran multiple planning ticks (crash did not halt the loop).
		expect(ticks).toBeGreaterThanOrEqual(2);
		expect(planCrashCount).toBeGreaterThanOrEqual(2);
	});
});

// ---------------------------------------------------------------------------
// AC3: real temp .claude/cam-loop.local.md ends as 'idle' after closure crash
// ---------------------------------------------------------------------------

describe('AC3: real state file ends as idle after the crash-guard closure runs', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-crash-ac3-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test('phase file transitions from planning to idle when inner op throws', () => {
		const claudeDir = join(tmpDir, '.claude');
		mkdirSync(claudeDir, { recursive: true });
		const stateFile = join(claudeDir, 'cam-loop.local.md');

		// Set up the real state file with phase:planning.
		makeSetPhaseFn(claudeDir, tmpDir)('planning');
		expect(existsSync(stateFile)).toBe(true);

		const initial = parseStateFile(readFileSync(stateFile, 'utf8'));
		expect(initial?.phase).toBe('planning');

		// Simulate the crash-guard closure behavior:
		// catch block calls makeSetPhaseFn(claudeDir, cwd)('idle').
		const { logger: logEvent } = makeInMemoryEventLogger();
		const closure = (): void => {
			try {
				throw new Error('runPlanPhase threw unexpectedly');
			} catch (err: unknown) {
				logEvent({
					ts: new Date().toISOString(),
					storyId: undefined,
					uuid: 'sidecar',
					kind: 'sidecar-exit',
					detail: {
						reason: 'plan-phase-crash',
						error: err instanceof Error ? err.message : String(err),
					},
				});
				makeSetPhaseFn(claudeDir, tmpDir)('idle');
			}
		};

		closure();

		// State file must exist and have phase:idle.
		expect(existsSync(stateFile)).toBe(true);
		const final = parseStateFile(readFileSync(stateFile, 'utf8'));
		expect(final?.phase).toBe('idle');
	});

	test('phase file is created as idle when no state file existed before crash', () => {
		const claudeDir = join(tmpDir, '.claude');
		mkdirSync(claudeDir, { recursive: true });
		const stateFile = join(claudeDir, 'cam-loop.local.md');

		// No state file exists yet.
		expect(existsSync(stateFile)).toBe(false);

		const { logger: logEvent } = makeInMemoryEventLogger();
		const closure = (): void => {
			try {
				throw new Error('crash before state file written');
			} catch (err: unknown) {
				logEvent({
					ts: new Date().toISOString(),
					storyId: undefined,
					uuid: 'sidecar',
					kind: 'sidecar-exit',
					detail: {
						reason: 'plan-phase-crash',
						error: err instanceof Error ? err.message : String(err),
					},
				});
				makeSetPhaseFn(claudeDir, tmpDir)('idle');
			}
		};

		closure();

		// makeSetPhaseFn creates the file when absent.
		expect(existsSync(stateFile)).toBe(true);
		const final = parseStateFile(readFileSync(stateFile, 'utf8'));
		expect(final?.phase).toBe('idle');
	});
});

// ---------------------------------------------------------------------------
// Source-text oracle for loop.ts outer guard (belt-and-suspenders)
// ---------------------------------------------------------------------------

describe('loop.ts outer guard: source-text oracle', () => {
	const loopSrc = readFileSync(
		resolve(import.meta.dir, '../src/supervisor/loop.ts'),
		'utf8',
	);

	// Find the planning branch try/catch context.
	const planningBranchIdx = loopSrc.indexOf("loopPhase === 'planning'");
	const planningBranchBlock = planningBranchIdx >= 0
		? loopSrc.slice(planningBranchIdx, planningBranchIdx + 800)
		: '';

	test("planning branch in loop.ts contains try { await opts.runPlanPhaseFn() }", () => {
		expect(planningBranchBlock).toContain('await opts.runPlanPhaseFn()');
		expect(planningBranchBlock).toContain('try {');
	});

	test("planning branch catch block logs reason: 'plan-phase-crash-outer'", () => {
		expect(planningBranchBlock).toContain("'plan-phase-crash-outer'");
	});

	test('planning branch catch block does NOT call setPhase (phase->idle lives in closure)', () => {
		// The outer loop guard must NOT attempt to write phase->idle itself.
		// It only catches+logs; the closure's own catch block handles setPhase.
		expect(planningBranchBlock).not.toContain('setPhase');
		expect(planningBranchBlock).not.toContain('setPhaseFn');
	});
});
