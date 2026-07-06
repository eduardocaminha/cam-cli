// test/ship-runner.test.ts
//
// Unit tests for runShipPhase (src/supervisor/ship-runner.ts), US-002 CAM-149.
//
// Coverage:
//   1.  Happy path: on-main guard passes, PRD complete, commits ahead, gates
//       pass, bump succeeds, finalize succeeds, push succeeds, PR-create step
//       succeeds -> shipped carrying the prNumber and mergeMode.
//   2.  on-main: refuses immediately; no PRD read, no gates, no bump, no
//       finalize, no push, no PR-create step.
//   3.  prd-incomplete: non-operator incomplete story blocks; operator-required
//       incomplete stories do NOT block; later steps never run.
//   4.  no-commits-ahead: empty `git log main..HEAD`; later steps never run.
//   5.  gates-failed: carries the output tail; bump/finalize/push never run.
//   6.  bump-failed: bumpFn throws; detail carries the message; finalize/push
//       never run.
//   7.  finalize-failed: finalizeFn throws; detail carries the message; push
//       never runs.
//   8.  push-failed: non-zero exit on `git push origin <branch>`; detail
//       carries the exit code and stdout.
//   9.  Step order: readPrd (PRD snapshot) is captured strictly before
//       finalizeFn runs.
//   10. Push argv is exactly ['push', 'origin', branchName] -- no force variant.
//   11. logEvent: called once, with the bump result, when provided.
//   12. pr-create-failed: runShipPrStepFn returns ok:false; detail is surfaced.
//   13. runShipPrStepFn receives branchName, prdSnapshot, issueId, issueBackend
//       from the finalize result.

import { describe, expect, test } from 'bun:test';
import {
	runShipPhase,
	MAIN_BRANCH,
	type RunShipPhaseOptions,
	type ShipPrdRecord,
	type ShipBumpResultLike,
	type ShipFinalizeResultLike,
} from '../src/supervisor/ship-runner.ts';
import type { SpawnFn } from '../src/supervisor/loop.ts';
import type { WorkerEvent } from '../src/supervisor/events.ts';
import type { ShipPrStepInput, ShipPrStepOutcome } from '../src/release/ship-pr.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPLETE_PRD: ShipPrdRecord = {
	project: 'cam-cli',
	description: 'Deterministic ship runner',
	issueNumber: 149,
	userStories: [
		{ id: 'US-001', title: 'PR body composer', passes: true, requires: null },
		{ id: 'US-002', title: 'Ship runner', passes: true, requires: null },
	],
};

const INCOMPLETE_PRD: ShipPrdRecord = {
	project: 'cam-cli',
	description: 'Deterministic ship runner',
	issueNumber: 149,
	userStories: [
		{ id: 'US-001', title: 'PR body composer', passes: true, requires: null },
		{ id: 'US-002', title: 'Ship runner', passes: false, requires: null },
		{ id: 'US-006', title: 'Operator ceremony', passes: false, requires: 'operator' },
	],
};

const BUMP_RESULT: ShipBumpResultLike = { from: '0.61.0', to: '0.62.0', bumpType: 'minor' };
const FINALIZE_RESULT: ShipFinalizeResultLike = { issueId: 'CAM-149', issueBackend: 'none' };
const PR_STEP_RESULT: ShipPrStepOutcome = { ok: true, prNumber: 42, mergeMode: 'immediate' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SpawnCall {
	cmd: string;
	args: string[];
}

interface MakeOptsConfig {
	branch?: string;
	commitsAhead?: boolean;
	pushExitCode?: number;
	pushStdout?: string;
	prd?: ShipPrdRecord;
	gatesOk?: boolean;
	gatesOutputTail?: string;
	bumpImpl?: () => ShipBumpResultLike;
	finalizeImpl?: () => ShipFinalizeResultLike;
	prStepImpl?: (input: ShipPrStepInput) => ShipPrStepOutcome;
}

interface MakeOptsResult {
	opts: RunShipPhaseOptions;
	calls: SpawnCall[];
	callOrder: string[];
	events: WorkerEvent[];
	readPrdCount: () => number;
	gatesCount: () => number;
	bumpCount: () => number;
	finalizeCount: () => number;
	prStepCount: () => number;
	prStepInputs: () => ShipPrStepInput[];
}

function makeOpts(cfg: MakeOptsConfig = {}): MakeOptsResult {
	const branch = cfg.branch ?? 'cam/pr-149-ship-runner-deterministic';
	const commitsAhead = cfg.commitsAhead ?? true;
	const pushExitCode = cfg.pushExitCode ?? 0;
	const pushStdout = cfg.pushStdout ?? '';
	const prd = cfg.prd ?? COMPLETE_PRD;
	const gatesOk = cfg.gatesOk ?? true;
	const gatesOutputTail = cfg.gatesOutputTail ?? '';

	const calls: SpawnCall[] = [];
	const callOrder: string[] = [];
	const events: WorkerEvent[] = [];
	let readPrdCalls = 0;
	let gatesCalls = 0;
	let bumpCalls = 0;
	let finalizeCalls = 0;
	let prStepCalls = 0;
	const prStepInputs: ShipPrStepInput[] = [];

	const spawnFn: SpawnFn = (cmd, args) => {
		calls.push({ cmd, args });
		if (args[0] === 'branch' && args[1] === '--show-current') {
			callOrder.push('branch-check');
			return { stdout: `${branch}\n`, exitCode: 0 };
		}
		if (args[0] === 'log') {
			callOrder.push('commits-ahead-check');
			return { stdout: commitsAhead ? 'abc1234 feat: something\n' : '', exitCode: 0 };
		}
		if (args[0] === 'push') {
			callOrder.push('push');
			return { stdout: pushStdout, exitCode: pushExitCode };
		}
		return { stdout: '', exitCode: 0 };
	};

	const opts: RunShipPhaseOptions = {
		spawnFn,
		readPrd: () => {
			readPrdCalls++;
			callOrder.push('read-prd');
			return prd;
		},
		runGatesFn: () => {
			gatesCalls++;
			callOrder.push('gates');
			return { ok: gatesOk, outputTail: gatesOutputTail };
		},
		bumpFn: () => {
			bumpCalls++;
			callOrder.push('bump');
			return cfg.bumpImpl ? cfg.bumpImpl() : BUMP_RESULT;
		},
		finalizeFn: () => {
			finalizeCalls++;
			callOrder.push('finalize');
			return cfg.finalizeImpl ? cfg.finalizeImpl() : FINALIZE_RESULT;
		},
		runShipPrStepFn: (input) => {
			prStepCalls++;
			prStepInputs.push(input);
			callOrder.push('pr-step');
			return cfg.prStepImpl ? cfg.prStepImpl(input) : PR_STEP_RESULT;
		},
		clock: () => '2026-07-05T00:00:00.000Z',
		logEvent: (event) => {
			events.push(event);
		},
	};

	return {
		opts,
		calls,
		callOrder,
		events,
		readPrdCount: () => readPrdCalls,
		gatesCount: () => gatesCalls,
		bumpCount: () => bumpCalls,
		finalizeCount: () => finalizeCalls,
		prStepCount: () => prStepCalls,
		prStepInputs: () => prStepInputs,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runShipPhase', () => {
	test('happy path returns shipped with prNumber and mergeMode from the PR-create step', () => {
		const { opts, callOrder, prStepCount, prStepInputs } = makeOpts();
		const result = runShipPhase(opts);

		expect(result).toEqual({ kind: 'shipped', prNumber: 42, mergeMode: 'immediate' });
		expect(prStepCount()).toBe(1);
		expect(prStepInputs()).toEqual([
			{
				branchName: 'cam/pr-149-ship-runner-deterministic',
				prdSnapshot: {
					project: 'cam-cli',
					description: 'Deterministic ship runner',
					issueNumber: 149,
					userStories: COMPLETE_PRD.userStories,
					notes: undefined,
				},
				issueId: FINALIZE_RESULT.issueId,
				issueBackend: FINALIZE_RESULT.issueBackend,
			},
		]);

		// Full step order: branch -> read-prd -> commits-ahead -> gates -> bump -> finalize -> push -> pr-step.
		expect(callOrder).toEqual([
			'branch-check',
			'read-prd',
			'commits-ahead-check',
			'gates',
			'bump',
			'finalize',
			'push',
			'pr-step',
		]);
	});

	test('on-main refuses immediately; no PRD read, no gates, no bump, no finalize, no push, no pr-step', () => {
		const { opts, calls, readPrdCount, gatesCount, bumpCount, finalizeCount, prStepCount } = makeOpts({
			branch: MAIN_BRANCH,
		});
		const result = runShipPhase(opts);

		expect(result).toEqual({ kind: 'on-main' });
		expect(readPrdCount()).toBe(0);
		expect(gatesCount()).toBe(0);
		expect(bumpCount()).toBe(0);
		expect(finalizeCount()).toBe(0);
		expect(prStepCount()).toBe(0);
		// Only the branch check spawned; no commits-ahead check, no push.
		expect(calls).toEqual([{ cmd: 'git', args: ['branch', '--show-current'] }]);
	});

	test('prd-incomplete blocks on non-operator incomplete stories only; later steps never run', () => {
		const { opts, gatesCount, bumpCount, finalizeCount, prStepCount } = makeOpts({ prd: INCOMPLETE_PRD });
		const result = runShipPhase(opts);

		expect(result).toEqual({ kind: 'prd-incomplete', blockingStoryIds: ['US-002'] });
		expect(gatesCount()).toBe(0);
		expect(bumpCount()).toBe(0);
		expect(finalizeCount()).toBe(0);
		expect(prStepCount()).toBe(0);
	});

	test('no-commits-ahead when git log main..HEAD is empty; later steps never run', () => {
		const { opts, gatesCount, bumpCount, finalizeCount, prStepCount } = makeOpts({ commitsAhead: false });
		const result = runShipPhase(opts);

		expect(result).toEqual({ kind: 'no-commits-ahead' });
		expect(gatesCount()).toBe(0);
		expect(bumpCount()).toBe(0);
		expect(finalizeCount()).toBe(0);
		expect(prStepCount()).toBe(0);
	});

	test('gates-failed carries the output tail; bump/finalize/push/pr-step never run', () => {
		const { opts, calls, bumpCount, finalizeCount, prStepCount } = makeOpts({
			gatesOk: false,
			gatesOutputTail: 'FAIL: typecheck error TS2345',
		});
		const result = runShipPhase(opts);

		expect(result).toEqual({ kind: 'gates-failed', outputTail: 'FAIL: typecheck error TS2345' });
		expect(bumpCount()).toBe(0);
		expect(finalizeCount()).toBe(0);
		expect(prStepCount()).toBe(0);
		expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
	});

	test('bump-failed carries the thrown message; finalize/push/pr-step never run', () => {
		const { opts, calls, finalizeCount, prStepCount } = makeOpts({
			bumpImpl: () => {
				throw new Error('git commit failed (exit 1)');
			},
		});
		const result = runShipPhase(opts);

		expect(result).toEqual({ kind: 'bump-failed', detail: 'git commit failed (exit 1)' });
		expect(finalizeCount()).toBe(0);
		expect(prStepCount()).toBe(0);
		expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
	});

	test('finalize-failed carries the thrown message; push/pr-step never run', () => {
		const { opts, calls, prStepCount } = makeOpts({
			finalizeImpl: () => {
				throw new Error('cannot resolve issueId for issueNumber=abc');
			},
		});
		const result = runShipPhase(opts);

		expect(result).toEqual({
			kind: 'finalize-failed',
			detail: 'cannot resolve issueId for issueNumber=abc',
		});
		expect(prStepCount()).toBe(0);
		expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
	});

	test('push-failed carries the exit code and stdout; pr-step never runs', () => {
		const { opts, prStepCount } = makeOpts({ pushExitCode: 1, pushStdout: 'remote: rejected\n' });
		const result = runShipPhase(opts);

		expect(result.kind).toBe('push-failed');
		if (result.kind !== 'push-failed') return;
		expect(result.detail).toContain('exit 1');
		expect(result.detail).toContain('remote: rejected');
		expect(prStepCount()).toBe(0);
	});

	test('pr-create-failed carries the detail when runShipPrStepFn returns ok:false', () => {
		const { opts } = makeOpts({
			prStepImpl: () => ({ ok: false, detail: 'gh pr create failed (exit 1): permission denied' }),
		});
		const result = runShipPhase(opts);

		expect(result).toEqual({
			kind: 'pr-create-failed',
			detail: 'gh pr create failed (exit 1): permission denied',
		});
	});

	test('push argv is exactly push origin <branch>, never a force variant', () => {
		const { opts, calls } = makeOpts();
		runShipPhase(opts);

		const pushCall = calls.find((c) => c.args[0] === 'push');
		expect(pushCall).toEqual({
			cmd: 'git',
			args: ['push', 'origin', 'cam/pr-149-ship-runner-deterministic'],
		});
	});

	test('PRD snapshot is captured strictly before finalizeFn runs', () => {
		const { opts, callOrder } = makeOpts();
		runShipPhase(opts);

		const readPrdIndex = callOrder.indexOf('read-prd');
		const finalizeIndex = callOrder.indexOf('finalize');
		expect(readPrdIndex).toBeGreaterThanOrEqual(0);
		expect(finalizeIndex).toBeGreaterThan(readPrdIndex);
	});

	test('logEvent is called once with the bump result when provided', () => {
		const { opts, events } = makeOpts();
		runShipPhase(opts);

		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('ship-bump');
		expect(events[0]?.detail).toEqual({ ...BUMP_RESULT });
	});

	test('logEvent absent (undefined) does not throw', () => {
		const { opts } = makeOpts();
		const optsNoLogger: RunShipPhaseOptions = { ...opts, logEvent: undefined };
		expect(() => runShipPhase(optsNoLogger)).not.toThrow();
	});
});
