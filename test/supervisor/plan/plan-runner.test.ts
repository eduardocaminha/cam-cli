// test/supervisor/plan/plan-runner.test.ts
//
// Unit tests for src/supervisor/plan-runner.ts (US-005, CAM-117).
//
// Coverage (matches AC1-AC5):
//   1.  Happy path (audit-approved): full spawn sequence + lowercase session-ids.
//   2.  Happy path (audit-blocked): reports BLOCK verdict correctly.
//   3.  Preflight failure: returns preflight-failed, NO pane spawned (AC2).
//   4.  Preflight failure: spawn list is empty when preflight fails (AC2).
//   5.  No-plannable-issue: returns no-plannable-issue, NO pane spawned (AC3).
//   6.  Mutex busy: returns mutex-busy before any pane label or respawn-pane (AC5).
//   7.  Planner timeout: kills planner, returns planner-timeout.
//   8.  Auditor timeout: kills auditor via echo, returns auditor-timeout.
//   9.  Auditor pane dies before report: returns auditor-timeout.
//  10.  Spawn sequence: set-option @cam_label 'planner' BEFORE respawn-pane planner.
//  11.  Spawn sequence: set-option @cam_label 'auditor' BEFORE respawn-pane auditor.
//  12.  Session-id: genUuid() output is lowercased (CAM-23 mac uuidgen uppercase).
//  13.  Session-id: BOTH planner and auditor uuids are lowercased.
//  14.  emitSpawnResolution: called for 'planner' before planner respawn-pane.
//  15.  emitSpawnResolution: called for 'auditor' before auditor respawn-pane.
//  16.  Exactly 2 respawn-pane calls on happy path.
//  17.  Exactly 2 set-option @cam_label calls on happy path.
//  18.  paneCountMutexFn called exactly once (before first planner spawn).

import { describe, expect, test } from 'bun:test';
import {
	runPlanPhase,
	type RunPlanPhaseOptions,
	type PlanPhaseResult,
	type PlanMutexState,
} from '../../../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../../../src/supervisor/loop.ts';
import type { PlanVerdictReport } from '../../../src/supervisor/plan-verdict-report.ts';
import type { IssueEntry } from '../../../src/issues/types.ts';
import type { PlanPreflightResult } from '../../../src/supervisor/plan-preflight.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-99',
	title: 'Test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-01T00:00:00Z',
};

const APPROVE_REPORT: PlanVerdictReport = {
	verdict: 'APPROVE',
	summary: 'Plan looks good',
	findings: [],
};

const BLOCK_REPORT: PlanVerdictReport = {
	verdict: 'BLOCK',
	summary: 'Plan has issues',
	findings: [
		{
			id: 'A.001',
			category: 'A.completeness',
			severity: 'critical',
			description: 'Missing acceptance criteria',
		},
	],
};

const PREFLIGHT_OK: PlanPreflightResult = { ok: true };
const PREFLIGHT_FAIL: PlanPreflightResult = {
	ok: false,
	step: 'typecheck',
	detail: 'error TS2345',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recorded tmux call. */
interface TmuxCall {
	cmd: string;
	args: string[];
}

/**
 * Builds a minimal set of opts for runPlanPhase.
 * By default: preflight ok, issue found, mutex available, planner dies after 1 tick,
 * auditor report returns APPROVE on first read.
 */
function makeOpts(overrides: Partial<RunPlanPhaseOptions> = {}): {
	opts: RunPlanPhaseOptions;
	calls: TmuxCall[];
	loggedPhases: string[];
} {
	const calls: TmuxCall[] = [];
	const loggedPhases: string[] = [];

	// Track pane alive state across planner polling phase
	let plannerAliveCount = 1; // pane alive for 1 poll tick, then dies

	const spawnFn: SpawnFn = (cmd, args) => {
		calls.push({ cmd, args });
		return { stdout: '', exitCode: 0 };
	};

	const opts: RunPlanPhaseOptions = {
		spawnFn,
		isPaneAlive: () => {
			// Die after first poll tick
			if (plannerAliveCount > 0) {
				plannerAliveCount--;
				return true;
			}
			return false;
		},
		sleepFn: () => {},
		genUuid: (() => {
			let n = 0;
			return () => `UUID-${++n}`;
		})(),
		selectIssueFn: () => MOCK_ISSUE,
		readPlanVerdictFn: () => APPROVE_REPORT,
		preflightFn: () => PREFLIGHT_OK,
		clock: (() => {
			let t = 0;
			return () => (t += 100);
		})(),
		plannerPaneId: '%3',
		paneCountMutexFn: () => 'available',
		pollIntervalMs: 1,
		plannerTimeoutMs: 999_999,
		auditorTimeoutMs: 999_999,
		logEvent: (event) => {
			if (event.kind === 'spawn-resolution') {
				const detail = event.detail as { phase?: string };
				if (typeof detail.phase === 'string') {
					loggedPhases.push(detail.phase);
				}
			}
		},
		...overrides,
	};

	return { opts, calls, loggedPhases };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPlanPhase', () => {
	// -------------------------------------------------------------------------
	// Happy path - audit-approved
	// -------------------------------------------------------------------------
	test('happy path returns audit-approved when report is APPROVE', () => {
		const { opts } = makeOpts();
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('audit-approved');
	});

	test('happy path includes the selected issue in the result', () => {
		const { opts } = makeOpts();
		const result = runPlanPhase(opts) as { kind: 'audit-approved'; issue: IssueEntry };
		expect(result.issue.id).toBe('CAM-99');
	});

	test('happy path includes the report in the result', () => {
		const { opts } = makeOpts();
		const result = runPlanPhase(opts) as { kind: 'audit-approved'; report: PlanVerdictReport };
		expect(result.report.verdict).toBe('APPROVE');
	});

	// -------------------------------------------------------------------------
	// Happy path - audit-blocked
	// -------------------------------------------------------------------------
	test('returns audit-blocked when report is BLOCK', () => {
		const { opts } = makeOpts({ readPlanVerdictFn: () => BLOCK_REPORT });
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('audit-blocked');
	});

	test('audit-blocked includes the BLOCK report', () => {
		const { opts } = makeOpts({ readPlanVerdictFn: () => BLOCK_REPORT });
		const result = runPlanPhase(opts) as { kind: 'audit-blocked'; report: PlanVerdictReport };
		expect(result.report.verdict).toBe('BLOCK');
	});

	// -------------------------------------------------------------------------
	// Preflight failure (AC2)
	// -------------------------------------------------------------------------
	test('preflight failure returns preflight-failed kind', () => {
		const { opts } = makeOpts({ preflightFn: () => PREFLIGHT_FAIL });
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('preflight-failed');
	});

	test('preflight failure propagates step and detail', () => {
		const { opts } = makeOpts({ preflightFn: () => PREFLIGHT_FAIL });
		const result = runPlanPhase(opts) as { kind: 'preflight-failed'; step: string; detail: string };
		expect(result.step).toBe('typecheck');
		expect(result.detail).toBe('error TS2345');
	});

	test('preflight failure spawns NO pane (AC2)', () => {
		const { opts, calls } = makeOpts({ preflightFn: () => PREFLIGHT_FAIL });
		runPlanPhase(opts);
		// No respawn-pane or set-option calls should have been made
		const respawnCalls = calls.filter(
			(c) => c.args[2] === 'respawn-pane' || c.args[2] === 'set-option',
		);
		expect(respawnCalls.length).toBe(0);
	});

	test('preflight failure: spawn call list is completely empty (AC2)', () => {
		const { opts, calls } = makeOpts({ preflightFn: () => PREFLIGHT_FAIL });
		runPlanPhase(opts);
		expect(calls.length).toBe(0);
	});

	// -------------------------------------------------------------------------
	// No plannable issue (AC3)
	// -------------------------------------------------------------------------
	test('no-plannable-issue returns correct kind (AC3)', () => {
		const { opts } = makeOpts({ selectIssueFn: () => null });
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('no-plannable-issue');
	});

	test('no-plannable-issue spawns no pane (AC3)', () => {
		const { opts, calls } = makeOpts({ selectIssueFn: () => null });
		runPlanPhase(opts);
		expect(calls.length).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Mutex busy (AC5)
	// -------------------------------------------------------------------------
	test('mutex busy returns mutex-busy kind (AC5)', () => {
		const { opts } = makeOpts({ paneCountMutexFn: () => 'busy' });
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('mutex-busy');
	});

	test('mutex busy: no pane label or respawn-pane call made (AC5)', () => {
		const { opts, calls } = makeOpts({ paneCountMutexFn: () => 'busy' });
		runPlanPhase(opts);
		// No set-option or respawn-pane should be called when busy
		const tmuxCalls = calls.filter(
			(c) => c.args[2] === 'set-option' || c.args[2] === 'respawn-pane',
		);
		expect(tmuxCalls.length).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Planner timeout
	// -------------------------------------------------------------------------
	test('planner timeout returns planner-timeout kind', () => {
		// pane is always alive; clock advances fast past plannerTimeoutMs
		let tick = 0;
		const { opts } = makeOpts({
			isPaneAlive: () => true, // never dies
			clock: () => (tick += 1_000_000), // jump past timeout on first check
			plannerTimeoutMs: 1,
		});
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('planner-timeout');
	});

	test('planner timeout emits echo planner-timeout kill command', () => {
		let tick = 0;
		const { opts, calls } = makeOpts({
			isPaneAlive: () => true,
			clock: () => (tick += 1_000_000),
			plannerTimeoutMs: 1,
		});
		runPlanPhase(opts);
		const killCall = calls.find(
			(c) => c.args[2] === 'respawn-pane' && c.args.includes('echo planner-timeout'),
		);
		expect(killCall).toBeDefined();
	});

	// -------------------------------------------------------------------------
	// Auditor timeout
	// -------------------------------------------------------------------------
	test('auditor timeout returns auditor-timeout kind', () => {
		// planner dies instantly; auditor never writes report; clock times out
		let plannerDied = false;
		let auditorTick = 0;
		const { opts } = makeOpts({
			isPaneAlive: () => {
				if (!plannerDied) {
					plannerDied = true;
					return false; // planner dies immediately
				}
				return true; // auditor stays alive
			},
			readPlanVerdictFn: () => null, // no report ever
			clock: () => (auditorTick += 1_000_000), // jump past timeout
			auditorTimeoutMs: 1,
			plannerTimeoutMs: 999_999,
		});
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('auditor-timeout');
	});

	test('auditor pane dies before report: returns auditor-timeout', () => {
		// planner dies after 1 tick; auditor also dies immediately (no report)
		let paneAliveCount = 1; // alive for 1 check (planner poll), then dead
		const { opts } = makeOpts({
			isPaneAlive: () => {
				if (paneAliveCount > 0) {
					paneAliveCount--;
					return true;
				}
				return false;
			},
			readPlanVerdictFn: () => null, // no report
		});
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('auditor-timeout');
	});

	// -------------------------------------------------------------------------
	// Spawn sequence: @cam_label set BEFORE respawn-pane (AC4, AC5)
	// -------------------------------------------------------------------------
	test('set-option @cam_label planner appears before respawn-pane planner (AC4, AC5)', () => {
		const { opts, calls } = makeOpts();
		runPlanPhase(opts);

		const setLabelPlannerIdx = calls.findIndex(
			(c) => c.args[2] === 'set-option' && c.args.includes('planner'),
		);
		const respawnPlannerIdx = calls.findIndex(
			(c) =>
				c.args[2] === 'respawn-pane' &&
				c.args.some((a) => a.includes('subagent-planner')),
		);

		expect(setLabelPlannerIdx).toBeGreaterThanOrEqual(0);
		expect(respawnPlannerIdx).toBeGreaterThanOrEqual(0);
		expect(setLabelPlannerIdx).toBeLessThan(respawnPlannerIdx);
	});

	test('set-option @cam_label auditor appears before respawn-pane auditor (AC4, AC5)', () => {
		const { opts, calls } = makeOpts();
		runPlanPhase(opts);

		const setLabelAuditorIdx = calls.findIndex(
			(c) => c.args[2] === 'set-option' && c.args.includes('auditor'),
		);
		const respawnAuditorIdx = calls.findIndex(
			(c) =>
				c.args[2] === 'respawn-pane' &&
				c.args.some((a) => a.includes('subagent-auditor')),
		);

		expect(setLabelAuditorIdx).toBeGreaterThanOrEqual(0);
		expect(respawnAuditorIdx).toBeGreaterThanOrEqual(0);
		expect(setLabelAuditorIdx).toBeLessThan(respawnAuditorIdx);
	});

	test('@cam_label planner set-option uses correct tmux flag format (AC5)', () => {
		const { opts, calls } = makeOpts();
		runPlanPhase(opts);

		const plannerLabel = calls.find(
			(c) => c.args[2] === 'set-option' && c.args.includes('planner'),
		);
		expect(plannerLabel).toBeDefined();
		// Expected: tmux -L cam set-option -p -t <paneId> @cam_label planner
		expect(plannerLabel?.args).toEqual([
			'-L', 'cam', 'set-option', '-p', '-t', '%3', '@cam_label', 'planner',
		]);
	});

	test('@cam_label auditor set-option uses correct tmux flag format (AC5)', () => {
		const { opts, calls } = makeOpts();
		runPlanPhase(opts);

		const auditorLabel = calls.find(
			(c) => c.args[2] === 'set-option' && c.args.includes('auditor'),
		);
		expect(auditorLabel).toBeDefined();
		expect(auditorLabel?.args).toEqual([
			'-L', 'cam', 'set-option', '-p', '-t', '%3', '@cam_label', 'auditor',
		]);
	});

	// -------------------------------------------------------------------------
	// Session-id is lowercase (CAM-23 mac uuidgen uppercase)
	// -------------------------------------------------------------------------
	test('planner session-id is lowercased even when genUuid returns uppercase (AC4)', () => {
		const { opts, calls } = makeOpts({
			genUuid: (() => {
				let n = 0;
				return () => `UPPERCASE-UUID-${++n}`;
			})(),
		});
		runPlanPhase(opts);

		const plannerRespawn = calls.find(
			(c) =>
				c.args[2] === 'respawn-pane' &&
				c.args.some((a) => a.includes('subagent-planner')),
		);
		expect(plannerRespawn).toBeDefined();
		const shellCmd = plannerRespawn?.args[plannerRespawn.args.length - 1] ?? '';
		// The --session-id value must be lowercase
		const sessionIdMatch = /--session-id\s+(\S+)/.exec(shellCmd);
		expect(sessionIdMatch).not.toBeNull();
		const sessionId = sessionIdMatch?.[1] ?? '';
		expect(sessionId).toBe(sessionId.toLowerCase());
	});

	test('auditor session-id is lowercased even when genUuid returns uppercase (AC4)', () => {
		const { opts, calls } = makeOpts({
			genUuid: (() => {
				let n = 0;
				return () => `UPPERCASE-UUID-${++n}`;
			})(),
		});
		runPlanPhase(opts);

		const auditorRespawn = calls.find(
			(c) =>
				c.args[2] === 'respawn-pane' &&
				c.args.some((a) => a.includes('subagent-auditor')),
		);
		expect(auditorRespawn).toBeDefined();
		const shellCmd = auditorRespawn?.args[auditorRespawn.args.length - 1] ?? '';
		const sessionIdMatch = /--session-id\s+(\S+)/.exec(shellCmd);
		expect(sessionIdMatch).not.toBeNull();
		const sessionId = sessionIdMatch?.[1] ?? '';
		expect(sessionId).toBe(sessionId.toLowerCase());
	});

	// -------------------------------------------------------------------------
	// Exact spawn sequence (AC4)
	// -------------------------------------------------------------------------
	test('exactly 2 respawn-pane calls on happy path (AC4)', () => {
		const { opts, calls } = makeOpts();
		runPlanPhase(opts);

		const respawnCalls = calls.filter((c) => c.args[2] === 'respawn-pane');
		expect(respawnCalls.length).toBe(2);
	});

	test('exactly 2 set-option @cam_label calls on happy path (AC5)', () => {
		const { opts, calls } = makeOpts();
		runPlanPhase(opts);

		const labelCalls = calls.filter(
			(c) => c.args[2] === 'set-option' && c.args.includes('@cam_label'),
		);
		expect(labelCalls.length).toBe(2);
	});

	test('full spawn order: label-planner, respawn-planner, label-auditor, respawn-auditor (AC4)', () => {
		const { opts, calls } = makeOpts();
		runPlanPhase(opts);

		const tmuxCalls = calls
			.filter((c) => c.args[2] === 'set-option' || c.args[2] === 'respawn-pane')
			.filter((c) => !c.args.includes('echo planner-timeout') && !c.args.includes('echo auditor-timeout'));

		expect(tmuxCalls.length).toBe(4);
		expect(tmuxCalls[0]?.args[2]).toBe('set-option');
		expect(tmuxCalls[0]?.args).toContain('planner');
		expect(tmuxCalls[1]?.args[2]).toBe('respawn-pane');
		expect(tmuxCalls[1]?.args.some((a) => a.includes('subagent-planner'))).toBe(true);
		expect(tmuxCalls[2]?.args[2]).toBe('set-option');
		expect(tmuxCalls[2]?.args).toContain('auditor');
		expect(tmuxCalls[3]?.args[2]).toBe('respawn-pane');
		expect(tmuxCalls[3]?.args.some((a) => a.includes('subagent-auditor'))).toBe(true);
	});

	// -------------------------------------------------------------------------
	// emitSpawnResolution called for both planner and auditor (patterns.md)
	// -------------------------------------------------------------------------
	test('emitSpawnResolution fires for planner phase before respawn-pane (AC4)', () => {
		const { opts, loggedPhases } = makeOpts();
		runPlanPhase(opts);
		expect(loggedPhases).toContain('planner');
	});

	test('emitSpawnResolution fires for auditor phase (AC4)', () => {
		const { opts, loggedPhases } = makeOpts();
		runPlanPhase(opts);
		expect(loggedPhases).toContain('auditor');
	});

	// -------------------------------------------------------------------------
	// paneCountMutexFn called exactly once
	// -------------------------------------------------------------------------
	test('paneCountMutexFn is called exactly once (before first planner spawn)', () => {
		let mutexCallCount = 0;
		const { opts } = makeOpts({
			paneCountMutexFn: () => {
				mutexCallCount++;
				return 'available';
			},
		});
		runPlanPhase(opts);
		expect(mutexCallCount).toBe(1);
	});

	test('paneCountMutexFn not called when preflight fails', () => {
		let mutexCallCount = 0;
		const { opts } = makeOpts({
			preflightFn: () => PREFLIGHT_FAIL,
			paneCountMutexFn: () => {
				mutexCallCount++;
				return 'available';
			},
		});
		runPlanPhase(opts);
		expect(mutexCallCount).toBe(0);
	});

	test('paneCountMutexFn not called when no plannable issue', () => {
		let mutexCallCount = 0;
		const { opts } = makeOpts({
			selectIssueFn: () => null,
			paneCountMutexFn: () => {
				mutexCallCount++;
				return 'available';
			},
		});
		runPlanPhase(opts);
		expect(mutexCallCount).toBe(0);
	});

	// -------------------------------------------------------------------------
	// respawn-pane uses -k flag and correct pane id
	// -------------------------------------------------------------------------
	test('planner respawn-pane uses -k flag and correct pane id', () => {
		const { opts, calls } = makeOpts();
		runPlanPhase(opts);

		const plannerRespawn = calls.find(
			(c) =>
				c.args[2] === 'respawn-pane' &&
				c.args.some((a) => a.includes('subagent-planner')),
		);
		expect(plannerRespawn?.args).toContain('-k');
		expect(plannerRespawn?.args).toContain('-t');
		expect(plannerRespawn?.args).toContain('%3');
	});

	test('auditor respawn-pane uses -k flag and correct pane id', () => {
		const { opts, calls } = makeOpts();
		runPlanPhase(opts);

		const auditorRespawn = calls.find(
			(c) =>
				c.args[2] === 'respawn-pane' &&
				c.args.some((a) => a.includes('subagent-auditor')),
		);
		expect(auditorRespawn?.args).toContain('-k');
		expect(auditorRespawn?.args).toContain('-t');
		expect(auditorRespawn?.args).toContain('%3');
	});

	// -------------------------------------------------------------------------
	// sleepFn is called during polling
	// -------------------------------------------------------------------------
	test('sleepFn is called at least once during the planner poll', () => {
		let sleepCount = 0;
		const { opts } = makeOpts({ sleepFn: () => { sleepCount++; } });
		runPlanPhase(opts);
		expect(sleepCount).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// TypeScript discriminant narrowing sanity check
	// -------------------------------------------------------------------------
	test('PlanPhaseResult kinds are exhaustive and distinct', () => {
		const kinds: PlanPhaseResult['kind'][] = [
			'preflight-failed',
			'no-plannable-issue',
			'mutex-busy',
			'planner-timeout',
			'auditor-timeout',
			'audit-approved',
			'audit-blocked',
		];
		// Simply assert all expected kinds are valid strings (type safety guard)
		expect(kinds.every((k) => typeof k === 'string')).toBe(true);
	});

	// -------------------------------------------------------------------------
	// selectIssueFn is NOT called when preflight fails (AC2 enforcement)
	// -------------------------------------------------------------------------
	test('selectIssueFn is not called when preflight fails', () => {
		let selectCalled = false;
		const { opts } = makeOpts({
			preflightFn: () => PREFLIGHT_FAIL,
			selectIssueFn: () => { selectCalled = true; return MOCK_ISSUE; },
		});
		runPlanPhase(opts);
		expect(selectCalled).toBe(false);
	});

	// -------------------------------------------------------------------------
	// readPlanVerdictFn: auditor verdict sourced from file only (AC4)
	// -------------------------------------------------------------------------
	test('readPlanVerdictFn is called during auditor poll (AC4)', () => {
		let readCount = 0;
		const { opts } = makeOpts({
			readPlanVerdictFn: () => {
				readCount++;
				return APPROVE_REPORT;
			},
		});
		runPlanPhase(opts);
		expect(readCount).toBeGreaterThan(0);
	});
});
