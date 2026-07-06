// test/plan-runner-target-invalid.test.ts
//
// Unit tests for the plan-target-invalid terminal + explicit-target-wins
// regression proof (US-002, CAM-203).
//
// Acceptance criteria proved:
//   AC1: RunPlanPhaseOptions accepts planTargetId; when set and selectIssueFn()
//        returns null, runPlanPhase returns { kind: 'plan-target-invalid',
//        targetId }, and the planner pane is NEVER spawned.
//   AC2: the literal result kind exists in the plan-runner result union
//        (grep oracle, satisfied structurally by src/supervisor/plan-runner.ts).
//   AC3: explicit target wins over a higher-ranked issue -- selectIssueFn is
//        composed from selectPlanTargetFromFile over a fixture backlog where
//        the target is unranked and a different issue holds rank 1; the
//        planner respawn shell string names the target via
//        buildPlannerTaskPrompt, not the top-ranked issue.
//   AC4: bare path unchanged -- with no planTargetId, a null selection still
//        returns 'no-plannable-issue'.
//   AC5: runPlanPhaseWithReplan passes 'plan-target-invalid' through as a
//        non-audit kind: no re-plan round, no teardown call, no escalation
//        marker write.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	runPlanPhase,
	runPlanPhaseWithReplan,
	type RunPlanPhaseOptions,
	type RunPlanPhaseWithReplanOptions,
} from '../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../src/supervisor/loop.ts';
import type { IssueEntry } from '../src/issues/types.ts';
import { selectPlanTargetFromFile } from '../src/issues/select.ts';
import type { BacklogSpawnFn } from '../src/issues/backlog.ts';

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

interface SpawnCall {
	cmd: string;
	args: string[];
}

/** Minimal SpawnSyncReturns<string> stub (mirrors test/issues/select.test.ts). */
function stubReturn(stdout: string): SpawnSyncReturns<string> {
	return {
		stdout,
		stderr: '',
		status: 0,
		output: [],
		pid: 0,
		signal: null,
		error: undefined,
	};
}

/** Builds the framed `git cat-file --batch` output for the given entries. */
function makeBatchOutput(entries: IssueEntry[]): string {
	let output = '';
	for (const entry of entries) {
		const content = JSON.stringify(entry);
		const size = Buffer.byteLength(content, 'utf8');
		output += `deadbeef0000000000000000000000000000000000 blob ${size}\n${content}\n`;
	}
	return output;
}

/** Builds a fake BacklogSpawnFn serving ls-tree paths then cat-file batch output. */
function makeBacklogSpawnFn(entries: IssueEntry[]): BacklogSpawnFn {
	const paths = entries.map(
		(e) => `scripts/cam/issues/CAM-${String(parseInt(e.id.split('-').at(-1) ?? '0', 10)).padStart(4, '0')}.json`,
	);
	const lsTreeOut = paths.join('\n') + (paths.length > 0 ? '\n' : '');
	const batchOut = makeBatchOutput(entries);

	return (_cmd, args, _opts) => {
		const subCmd = args[2] ?? '';
		if (subCmd === 'ls-tree') return stubReturn(lsTreeOut);
		if (subCmd === 'cat-file') return stubReturn(batchOut);
		return stubReturn('');
	};
}

/** Builds minimal runPlanPhase opts with sane defaults; overrides win. */
function makeBaseOpts(overrides: Partial<RunPlanPhaseOptions> = {}): {
	opts: RunPlanPhaseOptions;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const spawnFn: SpawnFn = (cmd, args) => {
		calls.push({ cmd, args });
		return { stdout: '', exitCode: 0 };
	};

	const opts: RunPlanPhaseOptions = {
		spawnFn,
		isPaneAlive: () => false,
		sleepFn: () => {},
		genUuid: () => 'test-uuid-0000-0000-0000-invalidtarget',
		selectIssueFn: () => MOCK_ISSUE,
		readPlanVerdictFn: () => null,
		readPlannerReportFn: () => null,
		preflightFn: () => ({ ok: true }),
		clock: (() => {
			let t = 0;
			return () => (t += 100);
		})(),
		plannerPaneId: '%5',
		paneCountMutexFn: () => 'available',
		pollIntervalMs: 1,
		plannerTimeoutMs: 999_999,
		auditorTimeoutMs: 999_999,
		...overrides,
	};

	return { opts, calls };
}

// ---------------------------------------------------------------------------
// AC1: plan-target-invalid terminal, no planner spawn
// ---------------------------------------------------------------------------

describe('runPlanPhase - plan-target-invalid (AC1)', () => {
	test('planTargetId set + selectIssueFn() null -> plan-target-invalid carrying the target id', () => {
		const { opts } = makeBaseOpts({
			planTargetId: 'CAM-777',
			selectIssueFn: () => null,
		});
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('plan-target-invalid');
		if (result.kind === 'plan-target-invalid') {
			expect(result.targetId).toBe('CAM-777');
		}
	});

	test('planner pane is NEVER spawned on plan-target-invalid (no respawn-pane call)', () => {
		const { opts, calls } = makeBaseOpts({
			planTargetId: 'CAM-777',
			selectIssueFn: () => null,
		});
		runPlanPhase(opts);
		const respawnCalls = calls.filter((c) => c.args.includes('respawn-pane'));
		expect(respawnCalls.length).toBe(0);
	});

	test('no set-option @cam_label call either (no spawn side effects at all)', () => {
		const { opts, calls } = makeBaseOpts({
			planTargetId: 'CAM-777',
			selectIssueFn: () => null,
		});
		runPlanPhase(opts);
		expect(calls.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC3: explicit target wins over a higher-ranked issue (regression proof)
// ---------------------------------------------------------------------------

describe('runPlanPhase - explicit-target-wins regression (AC3)', () => {
	test('selectIssueFn composed from selectPlanTargetFromFile: unranked target beats ranked rank:1 issue', () => {
		// Fixture backlog: CAM-1 holds rank 1 (would win top-of-queue selection);
		// CAM-777 is unranked but is the explicit target.
		const entries: IssueEntry[] = [
			{
				id: 'CAM-1',
				title: 'Top-ranked issue',
				stage: 'specified',
				status: 'open',
				blockedBy: [],
				createdAt: '2026-07-01T00:00:00Z',
				rank: 1,
			},
			{
				id: 'CAM-777',
				title: 'Explicit target, unranked',
				stage: 'specified',
				status: 'open',
				blockedBy: [],
				createdAt: '2026-07-02T00:00:00Z',
			},
		];
		const spawn = makeBacklogSpawnFn(entries);
		const targetId = 'CAM-777';

		const capturedShellStrings: string[] = [];
		const spawnFn: SpawnFn = (cmd, args) => {
			if (cmd === 'tmux' && args.includes('respawn-pane')) {
				capturedShellStrings.push(args[args.length - 1] ?? '');
			}
			return { stdout: '', exitCode: 0 };
		};

		const result = runPlanPhase({
			spawnFn,
			isPaneAlive: () => false,
			sleepFn: () => {},
			genUuid: () => 'test-uuid-0000-0000-0000-targetwins00',
			// Composed from selectPlanTargetFromFile over the fixture backlog +
			// the explicit target id (AC3 regression proof at the runPlanPhase level).
			selectIssueFn: () => selectPlanTargetFromFile('/repo', targetId, spawn),
			planTargetId: targetId,
			readPlanVerdictFn: () => null,
			readPlannerReportFn: () => null,
			preflightFn: () => ({ ok: true }),
			clock: (() => {
				let t = 0;
				return () => (t += 100);
			})(),
			plannerPaneId: '%5',
			paneCountMutexFn: () => 'available',
			pollIntervalMs: 1,
			plannerTimeoutMs: 999_999,
			auditorTimeoutMs: 999_999,
		});

		// The selected issue is the explicit target, not the ranked champion.
		expect(result.kind).not.toBe('plan-target-invalid');
		expect(result.kind).not.toBe('no-plannable-issue');

		const plannerShell = capturedShellStrings[0] ?? '';
		expect(plannerShell).toContain('Plan issue CAM-777 specifically');
		expect(plannerShell).not.toContain('Plan issue CAM-1 specifically');
	});
});

// ---------------------------------------------------------------------------
// AC4: bare path unchanged (no planTargetId)
// ---------------------------------------------------------------------------

describe('runPlanPhase - bare path unchanged (AC4)', () => {
	test('no planTargetId + null selection -> no-plannable-issue (unchanged)', () => {
		const { opts } = makeBaseOpts({
			selectIssueFn: () => null,
			// planTargetId intentionally absent.
		});
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('no-plannable-issue');
	});

	test('no planTargetId + null selection -> no planner pane spawned', () => {
		const { opts, calls } = makeBaseOpts({
			selectIssueFn: () => null,
		});
		runPlanPhase(opts);
		const respawnCalls = calls.filter((c) => c.args.includes('respawn-pane'));
		expect(respawnCalls.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC5: runPlanPhaseWithReplan passes plan-target-invalid through untouched
// ---------------------------------------------------------------------------

describe('runPlanPhaseWithReplan - plan-target-invalid passthrough (AC5)', () => {
	function makeReplanOpts(overrides: Partial<RunPlanPhaseWithReplanOptions> = {}): {
		opts: RunPlanPhaseWithReplanOptions;
		teardownCalls: { n: number };
		markerCalls: unknown[];
	} {
		const teardownCalls = { n: 0 };
		const markerCalls: unknown[] = [];
		const { opts: baseOpts } = makeBaseOpts({
			planTargetId: 'CAM-777',
			selectIssueFn: () => null,
		});

		const opts: RunPlanPhaseWithReplanOptions = {
			...baseOpts,
			teardownPlanPanesFn: () => {
				teardownCalls.n++;
			},
			writeEscalationMarkerFn: (params) => {
				markerCalls.push(params);
			},
			...overrides,
		};

		return { opts, teardownCalls, markerCalls };
	}

	test('returns plan-target-invalid unchanged (no re-plan round)', () => {
		const { opts } = makeReplanOpts();
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('plan-target-invalid');
		if (result.kind === 'plan-target-invalid') {
			expect(result.targetId).toBe('CAM-777');
		}
	});

	test('teardownPlanPanesFn is NEVER called', () => {
		const { opts, teardownCalls } = makeReplanOpts();
		runPlanPhaseWithReplan(opts);
		expect(teardownCalls.n).toBe(0);
	});

	test('writeEscalationMarkerFn is NEVER called', () => {
		const { opts, markerCalls } = makeReplanOpts();
		runPlanPhaseWithReplan(opts);
		expect(markerCalls.length).toBe(0);
	});

	test('no re-plan round: selectIssueFn / runPlanPhase runs exactly once (single planner-pane spawn attempt, i.e. zero here since none is plannable)', () => {
		let selectCalls = 0;
		const { opts } = makeReplanOpts();
		const wrappedOpts: RunPlanPhaseWithReplanOptions = {
			...opts,
			selectIssueFn: () => {
				selectCalls++;
				return null;
			},
		};
		runPlanPhaseWithReplan(wrappedOpts);
		expect(selectCalls).toBe(1);
	});
});
