// test/commands/sidecar-rearm.test.ts
//
// Tests for US-003 (CAM-195, Defect 1): re-arm implementing at sidecar boot
// and idle-tick for in-flight PRDs.
//
// Coverage:
//   AC1: makeProductionRearmImplementingFn re-arms (real-writer: state file
//        ends up with phase:implementing / active:true) when prd.json is
//        in-flight + phase:implementing + no merge-watch marker.
//   AC2: phase:idle (real on-disk state) never resumes.
//   AC3: on the idle-tick, runSidecarLoop checks rearmImplementingFn BEFORE
//        runMetaLoopObserveFn, so a resumable in-flight PRD is not shadowed
//        by a new backlog dispatch.
//   AC4: refused (no resume, no write) when a drain precondition fails
//        (merge-watch present; prd not in-flight / blocked terminal).
//   "the loop is not already active": rearmImplementingFn is only reached
//        inside the active !== true branch — proven by a runSidecarLoop test
//        where active:true never calls it.
//   "sidecar boot AND idle-tick": runSidecarLoop has no separate boot
//        preamble, so the FIRST tick already exercises the same call site as
//        every subsequent idle-tick — proven by asserting rearm fires on
//        tick 1 of a fresh loop.

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSidecarLoop, type RunSidecarLoopOptions } from '../../src/supervisor/loop.ts';
import {
	makeProductionRearmImplementingFn,
	makeReadLoopPhase,
	makeHasPendingStories,
	makeSetPhaseFn,
	clearImplementBlockedMarkerForCurrentIssue,
} from '../../src/commands/sidecar.ts';
import { parseStateFile } from '../../src/commands/status.ts';
import { MERGE_WATCH_FILENAME } from '../../src/release/merge-watch.ts';
import {
	IMPLEMENT_BLOCKED_FILENAME,
	writeImplementBlockedMarker,
	readImplementBlockedMarker,
} from '../../src/supervisor/implement-blocked-marker.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];
afterAll(() => {
	for (const dir of dirsToClean) rmSync(dir, { recursive: true, force: true });
});

function makeTmpProject(): { cwd: string; claudeDir: string } {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-rearm-'));
	dirsToClean.push(cwd);
	const claudeDir = join(cwd, '.claude');
	mkdirSync(claudeDir, { recursive: true });
	return { cwd, claudeDir };
}

function writePrd(prdPath: string, prd: PrdSnapshot): void {
	writeFileSync(prdPath, JSON.stringify(prd));
}

const IN_FLIGHT_PRD: PrdSnapshot = {
	userStories: [{ id: 'US-001', priority: 1, passes: false, requires: null }],
};

const BLOCKED_PRD: PrdSnapshot = {
	userStories: [{ id: 'US-001', priority: 1, passes: false, requires: null }],
	review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'MAX_ROUNDS_DEBT' },
};

// ---------------------------------------------------------------------------
// AC1/AC2/AC4: makeProductionRearmImplementingFn (real fs, real writer)
// ---------------------------------------------------------------------------

describe('makeProductionRearmImplementingFn (real fs)', () => {
	test('AC1: re-arms (writes phase:implementing / active:true) when in-flight + phase:implementing + no merge-watch', () => {
		const { cwd, claudeDir } = makeTmpProject();
		const prdPath = join(cwd, 'prd.json');
		writePrd(prdPath, IN_FLIGHT_PRD);

		// Seed the state file at phase:implementing but active:false (the exact
		// wedge scenario: a restart landed mid-cycle with active collapsed).
		makeSetPhaseFn(claudeDir, cwd)('implementing');

		const rearm = makeProductionRearmImplementingFn(
			claudeDir,
			cwd,
			makeHasPendingStories(prdPath),
			makeReadLoopPhase(claudeDir),
		);

		expect(rearm()).toBe(true);

		const stateFile = join(claudeDir, 'cam-loop.local.md');
		const parsed = parseStateFile(readFileSync(stateFile, 'utf8'));
		expect(parsed?.phase).toBe('implementing');
		expect(parsed?.active).toBe(true);
	});

	test('AC2: phase:idle never resumes (no write, returns false)', () => {
		const { cwd, claudeDir } = makeTmpProject();
		const prdPath = join(cwd, 'prd.json');
		writePrd(prdPath, IN_FLIGHT_PRD);

		makeSetPhaseFn(claudeDir, cwd)('idle');

		const rearm = makeProductionRearmImplementingFn(
			claudeDir,
			cwd,
			makeHasPendingStories(prdPath),
			makeReadLoopPhase(claudeDir),
		);

		expect(rearm()).toBe(false);

		const stateFile = join(claudeDir, 'cam-loop.local.md');
		const parsed = parseStateFile(readFileSync(stateFile, 'utf8'));
		expect(parsed?.phase).toBe('idle');
		expect(parsed?.active).toBe(false);
	});

	test('AC4: refused when a merge-watch marker is present, even at phase:implementing + in-flight', () => {
		const { cwd, claudeDir } = makeTmpProject();
		const prdPath = join(cwd, 'prd.json');
		writePrd(prdPath, IN_FLIGHT_PRD);
		makeSetPhaseFn(claudeDir, cwd)('implementing');
		writeFileSync(join(claudeDir, MERGE_WATCH_FILENAME), JSON.stringify({ issueId: 'CAM-1' }));

		const rearm = makeProductionRearmImplementingFn(
			claudeDir,
			cwd,
			makeHasPendingStories(prdPath),
			makeReadLoopPhase(claudeDir),
		);

		expect(rearm()).toBe(false);
	});

	test('AC4: refused when the review verdict is the MAX_ROUNDS_DEBT blocked terminal', () => {
		const { cwd, claudeDir } = makeTmpProject();
		const prdPath = join(cwd, 'prd.json');
		writePrd(prdPath, BLOCKED_PRD);
		makeSetPhaseFn(claudeDir, cwd)('implementing');

		const rearm = makeProductionRearmImplementingFn(
			claudeDir,
			cwd,
			makeHasPendingStories(prdPath),
			makeReadLoopPhase(claudeDir),
		);

		expect(rearm()).toBe(false);
	});

	test('AC4: refused when prd.json is absent (nothing in-flight)', () => {
		const { cwd, claudeDir } = makeTmpProject();
		const prdPath = join(cwd, 'prd.json'); // never written
		makeSetPhaseFn(claudeDir, cwd)('implementing');

		const rearm = makeProductionRearmImplementingFn(
			claudeDir,
			cwd,
			makeHasPendingStories(prdPath),
			makeReadLoopPhase(claudeDir),
		);

		expect(rearm()).toBe(false);
		expect(existsSync(prdPath)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC3 + "not already active": runSidecarLoop wiring
// ---------------------------------------------------------------------------

const ESCAPE = Symbol('escape');

function makeDummySupervisorOpts() {
	return {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-07-11T00:00:00Z',
		reviewDispatch: () => ({ status: 'ok' as const, detail: '' }),
		writeSessionMarker: () => {},
		isPaneAlive: () => true,
		workerPaneId: '%2',
		prdPath: '/fake/prd.json',
		handoffPath: '/fake/handoff.json',
		permissionMode: 'bypassPermissions' as const,
		taskPrompt: 'test',
		sleepFn: () => {},
		nowMs: () => 0,
	};
}

function makeLoopOpts(ticks: number, extraOpts: Partial<RunSidecarLoopOptions> = {}): RunSidecarLoopOptions {
	let sleepCount = 0;
	return {
		buildOpts: () => makeDummySupervisorOpts(),
		readActive: () => false,
		clearActive: () => {},
		sleep: () => {
			sleepCount++;
			if (sleepCount >= ticks) throw ESCAPE;
		},
		hasPendingStories: () => false,
		acquireLock: () => ({ acquired: true, release: () => {} }),
		...extraOpts,
	};
}

async function runTicks(opts: RunSidecarLoopOptions): Promise<void> {
	try {
		await runSidecarLoop(opts);
	} catch (e) {
		if (e !== ESCAPE) throw e;
	}
}

describe('runSidecarLoop wiring: rearmImplementingFn (AC3)', () => {
	test('AC3: rearm is checked BEFORE runMetaLoopObserveFn — when rearm fires, observe is not called that tick', async () => {
		let rearmCalls = 0;
		let observeCalls = 0;

		const opts = makeLoopOpts(2, {
			rearmImplementingFn: () => {
				rearmCalls++;
				return true;
			},
			runMetaLoopObserveFn: async () => {
				observeCalls++;
			},
		});

		await runTicks(opts);

		expect(rearmCalls).toBeGreaterThan(0);
		expect(observeCalls).toBe(0);
	});

	test('regression: when rearm does not fire, runMetaLoopObserveFn still runs as before', async () => {
		let observeCalls = 0;

		const opts = makeLoopOpts(2, {
			rearmImplementingFn: () => false,
			runMetaLoopObserveFn: async () => {
				observeCalls++;
			},
		});

		await runTicks(opts);

		expect(observeCalls).toBeGreaterThan(0);
	});

	test('regression: absent rearmImplementingFn is a complete no-op (existing tests unaffected)', async () => {
		let observeCalls = 0;

		const opts = makeLoopOpts(2, {
			runMetaLoopObserveFn: async () => {
				observeCalls++;
			},
		});

		await runTicks(opts);

		expect(observeCalls).toBeGreaterThan(0);
	});

	test('"the loop is not already active": rearmImplementingFn is never called while active:true', async () => {
		let rearmCalls = 0;

		const opts = makeLoopOpts(2, {
			readActive: () => true,
			hasPendingStories: () => false, // no pending work: falls straight to clearActive + idle
			rearmImplementingFn: () => {
				rearmCalls++;
				return true;
			},
		});

		await runTicks(opts);

		expect(rearmCalls).toBe(0);
	});

	test('"sidecar boot": rearm fires on the very FIRST idle tick (no separate boot preamble needed)', async () => {
		let rearmCalledOnFirstTick = false;
		let ticksSeen = 0;

		const opts = makeLoopOpts(1, {
			rearmImplementingFn: () => {
				ticksSeen++;
				if (ticksSeen === 1) rearmCalledOnFirstTick = true;
				return true;
			},
		});

		await runTicks(opts);

		expect(rearmCalledOnFirstTick).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// US-005 (CAM-195, Defect 2): implement-blocked marker cleared on rearm
// ---------------------------------------------------------------------------

describe('US-005: durable implement-blocked marker cleared on rearm (CAM-195, Defect 2)', () => {
	test('AC2: a rearm (AC1 scenario) clears a matching-issue implement-blocked marker', () => {
		const { cwd, claudeDir } = makeTmpProject();
		const prdPath = join(cwd, 'prd.json');
		writePrd(prdPath, { ...IN_FLIGHT_PRD, issueNumber: 195 });
		makeSetPhaseFn(claudeDir, cwd)('implementing');

		const markerPath = join(claudeDir, IMPLEMENT_BLOCKED_FILENAME);
		writeImplementBlockedMarker(markerPath, {
			issueId: '195',
			story: 'US-001',
			reason: 'timeout',
			writtenAt: '2026-07-11T00:00:00Z',
		});

		const rearm = makeProductionRearmImplementingFn(
			claudeDir,
			cwd,
			makeHasPendingStories(prdPath),
			makeReadLoopPhase(claudeDir),
		);

		expect(rearm()).toBe(true);
		expect(existsSync(markerPath)).toBe(false);
	});

	test('a refused rearm (phase:idle) does NOT clear the marker', () => {
		const { cwd, claudeDir } = makeTmpProject();
		const prdPath = join(cwd, 'prd.json');
		writePrd(prdPath, { ...IN_FLIGHT_PRD, issueNumber: 195 });
		makeSetPhaseFn(claudeDir, cwd)('idle');

		const markerPath = join(claudeDir, IMPLEMENT_BLOCKED_FILENAME);
		writeImplementBlockedMarker(markerPath, {
			issueId: '195',
			story: 'US-001',
			reason: 'timeout',
			writtenAt: '2026-07-11T00:00:00Z',
		});

		const rearm = makeProductionRearmImplementingFn(
			claudeDir,
			cwd,
			makeHasPendingStories(prdPath),
			makeReadLoopPhase(claudeDir),
		);

		expect(rearm()).toBe(false);
		expect(existsSync(markerPath)).toBe(true);
	});
});

describe('clearImplementBlockedMarkerForCurrentIssue', () => {
	test('removes the marker when its issueId matches the current prd.json issueNumber', () => {
		const { cwd, claudeDir } = makeTmpProject();
		const prdPath = join(cwd, 'prd.json');
		writePrd(prdPath, { ...IN_FLIGHT_PRD, issueNumber: 195 });
		const markerPath = join(claudeDir, IMPLEMENT_BLOCKED_FILENAME);
		writeImplementBlockedMarker(markerPath, {
			issueId: '195',
			story: 'US-001',
			reason: 'timeout',
			writtenAt: '2026-07-11T00:00:00Z',
		});

		clearImplementBlockedMarkerForCurrentIssue(markerPath, prdPath);

		expect(existsSync(markerPath)).toBe(false);
	});

	test('leaves a marker referencing a DIFFERENT issueId untouched', () => {
		const { cwd, claudeDir } = makeTmpProject();
		const prdPath = join(cwd, 'prd.json');
		writePrd(prdPath, { ...IN_FLIGHT_PRD, issueNumber: 195 });
		const markerPath = join(claudeDir, IMPLEMENT_BLOCKED_FILENAME);
		const stale = {
			issueId: '193',
			story: 'US-002',
			reason: 'timeout',
			writtenAt: '2026-07-10T00:00:00Z',
		};
		writeImplementBlockedMarker(markerPath, stale);

		clearImplementBlockedMarkerForCurrentIssue(markerPath, prdPath);

		expect(readImplementBlockedMarker(markerPath)).toEqual(stale);
	});

	test('is a no-op when no marker is present', () => {
		const { cwd, claudeDir } = makeTmpProject();
		const prdPath = join(cwd, 'prd.json');
		writePrd(prdPath, { ...IN_FLIGHT_PRD, issueNumber: 195 });
		const markerPath = join(claudeDir, IMPLEMENT_BLOCKED_FILENAME);

		expect(() => clearImplementBlockedMarkerForCurrentIssue(markerPath, prdPath)).not.toThrow();
		expect(existsSync(markerPath)).toBe(false);
	});

	test('best-effort: clears unconditionally when prd.json is unreadable (nothing to compare against)', () => {
		const { claudeDir } = makeTmpProject();
		const prdPath = join(claudeDir, 'nonexistent-prd.json');
		const markerPath = join(claudeDir, IMPLEMENT_BLOCKED_FILENAME);
		writeImplementBlockedMarker(markerPath, {
			issueId: '195',
			story: 'US-001',
			reason: 'timeout',
			writtenAt: '2026-07-11T00:00:00Z',
		});

		clearImplementBlockedMarkerForCurrentIssue(markerPath, prdPath);

		expect(existsSync(markerPath)).toBe(false);
	});
});
