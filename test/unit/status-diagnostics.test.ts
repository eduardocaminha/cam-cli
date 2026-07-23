// test/unit/status-diagnostics.test.ts
//
// US-003 (CAM-401): the closed, ordered why-not-moving diagnostic.
//
// What we cover (per acceptance criteria):
//   1. `diagnoseWhyNotMoving` is a pure function (no I/O, no LLM call): every
//      enumerated condition maps to exactly one fixed message + suggested
//      command.
//   2. Closed + ordered rule-set: every id in WHY_NOT_MOVING_CONDITIONS gets
//      its own test asserting the EXACT message and command; precedence is
//      asserted by constructing inputs that satisfy multiple conditions at
//      once and checking the higher-precedence one wins.
//   3. orch-pane-busy vs delivery-exhausted are distinguished (never conflated).
//   4. The no-blocker default returns a single fixed 'none' result.
//   5. `buildStatusReport` attaches the diagnostic onto StatusReport and
//      performs no writes (mtimeMs-diff, mirrors test/unit/status-projection.test.ts).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	diagnoseWhyNotMoving,
	WHY_NOT_MOVING_CONDITIONS,
	type WhyNotMovingReportInput,
	type WhyNotMovingSignals,
} from '../../src/commands/status-diagnostics.ts';
import { buildStatusReport } from '../../src/commands/status.ts';
import { SHIP_STALLED_FILENAME, writeShipStalledMarker } from '../../src/release/merge-watch.ts';
import { PLAN_ESCALATED_FILENAME, writePlanEscalatedMarker } from '../../src/supervisor/plan-escalation.ts';
import { IMPLEMENT_BLOCKED_FILENAME, writeImplementBlockedMarker } from '../../src/supervisor/implement-blocked-marker.ts';

/** Minimal "nothing is going on" baseline input; individual tests override one field at a time. */
function baseReport(): WhyNotMovingReportInput {
	return { state: 'active' };
}

function baseSignals(): WhyNotMovingSignals {
	return { orchPaneBusy: false };
}

function withTmpCwd(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'cam-status-diagnostics-'));
	try {
		mkdirSync(join(dir, '.claude'), { recursive: true });
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// AC1, AC2: every enumerated condition, its exact message + command
// ---------------------------------------------------------------------------

describe('diagnoseWhyNotMoving: closed rule-set, one fixed message/command per condition (AC1, AC2)', () => {
	test('operator-paused', () => {
		const result = diagnoseWhyNotMoving({ ...baseReport(), state: 'operator-paused' }, baseSignals());
		expect(result).toEqual({
			condition: 'operator-paused',
			message: 'Loop is intentionally paused by the operator (.cam-pause marker present).',
			suggestedCommand: 'cam resume',
		});
	});

	test('ship-stalled', () => {
		const result = diagnoseWhyNotMoving(
			{ ...baseReport(), shipStalled: { prNumber: 1, prUrl: null, issueId: null, reason: 'ci-red', ts: 't' } },
			baseSignals(),
		);
		expect(result).toEqual({
			condition: 'ship-stalled',
			message: 'Ship phase is stalled: the auto-merge/ship sequence did not complete and needs manual recovery.',
			suggestedCommand: 'cam ship --finalize',
		});
	});

	test('plan-escalated', () => {
		const result = diagnoseWhyNotMoving(
			{ ...baseReport(), planEscalated: { issueId: 'CAM-1', summary: 's', findings: [], roundsCompleted: 3, writtenAt: 't' } },
			baseSignals(),
		);
		expect(result).toEqual({
			condition: 'plan-escalated',
			message: 'Plan phase escalated: a BLOCK verdict persisted after exhausting the re-plan rounds.',
			suggestedCommand: 'cam next',
		});
	});

	test('plan-preflight-failed', () => {
		const result = diagnoseWhyNotMoving(
			{ ...baseReport(), planPreflightFailed: { step: 'typecheck', detail: 'tsc failed', writtenAt: 't' } },
			baseSignals(),
		);
		expect(result).toEqual({
			condition: 'plan-preflight-failed',
			message:
				'Plan preflight failed: a deterministic environment check (clean tree, typecheck, or tests) failed before the planner could spawn.',
			suggestedCommand: 'git status',
		});
	});

	test('implement-blocked', () => {
		const result = diagnoseWhyNotMoving(
			{
				...baseReport(),
				implementBlocked: {
					issueId: 'CAM-1',
					story: 'US-001',
					reason: 'r',
					writtenAt: 't',
					consecutiveCount: 1,
					keyHash: 'h',
				},
			},
			baseSignals(),
		);
		expect(result).toEqual({
			condition: 'implement-blocked',
			message: 'Implement loop is blocked: the last worker terminal was BLOCKED and needs operator attention before it re-arms.',
			suggestedCommand: 'cam next',
		});
	});

	test('post-merge-stalled', () => {
		const result = diagnoseWhyNotMoving(
			{
				...baseReport(),
				postMergeStalled: {
					prNumber: 1,
					issueId: null,
					completedSteps: [],
					remainingSteps: ['tag'],
					reason: 'pull-rebase-failed',
					writtenAt: 't',
				},
			},
			baseSignals(),
		);
		expect(result).toEqual({
			condition: 'post-merge-stalled',
			message: 'Post-merge sequence stalled: the pull request merged but tag/prune/close did not finish.',
			suggestedCommand: 'git fetch origin',
		});
	});

	test('sidecar-stalled', () => {
		const result = diagnoseWhyNotMoving(
			{ ...baseReport(), sidecarStalled: { reason: 'firewall-init-failed', detail: 'd', writtenAt: 't' } },
			baseSignals(),
		);
		expect(result).toEqual({
			condition: 'sidecar-stalled',
			message: 'Sidecar failed to bring up the worker container or session before it could dispatch.',
			suggestedCommand: 'cam next',
		});
	});

	test('gate-awaiting-decision', () => {
		const result = diagnoseWhyNotMoving(
			{ ...baseReport(), gate: { gate: 'in-progress-conflict', options: ['abandon', 'resume'], context: 'c' } },
			baseSignals(),
		);
		expect(result).toEqual({
			condition: 'gate-awaiting-decision',
			message: 'An operator-decision gate is open: the sidecar is waiting on a decision before it can continue.',
			suggestedCommand: 'cam decide',
		});
	});

	test('merge-watch-waiting', () => {
		const result = diagnoseWhyNotMoving(
			{ ...baseReport(), mergeWatch: { prNumber: 7, pollCount: 2 } },
			baseSignals(),
		);
		expect(result).toEqual({
			condition: 'merge-watch-waiting',
			message: 'Merge-watch is polling an open pull request: the loop is waiting on CI/merge, not stuck.',
			suggestedCommand: 'gh pr status',
		});
	});

	test('orch-pane-busy', () => {
		const result = diagnoseWhyNotMoving(baseReport(), { orchPaneBusy: true });
		expect(result).toEqual({
			condition: 'orch-pane-busy',
			message: 'Orchestrator pane was busy when the sidecar last pushed a wake-up nudge (transient, self-resolving send-anyway).',
			suggestedCommand: 'cam status',
		});
	});

	test('delivery-exhausted', () => {
		const result = diagnoseWhyNotMoving(baseReport(), { orchPaneBusy: false, pushUndeliveredReason: 'retries-exhausted' });
		expect(result).toEqual({
			condition: 'delivery-exhausted',
			message:
				'A wake-up push to the orchestrator pane failed delivery after exhausting retries: a genuine delivery failure, not a busy-pane wedge.',
			suggestedCommand: 'cam resume',
		});
	});

	test('none (AC4): nothing blocking returns the single fixed default, never empty/ambiguous', () => {
		const result = diagnoseWhyNotMoving(baseReport(), baseSignals());
		expect(result).toEqual({
			condition: 'none',
			message: 'Nothing blocking: the cycle is progressing normally.',
			suggestedCommand: 'cam status',
		});
	});

	/**
	 * One isolated (report, signals) input per enumerated condition, each
	 * satisfying ONLY that condition (never a higher-precedence one), so this
	 * table doubles as the closedness/exhaustiveness fixture below.
	 */
	const CONDITION_FIXTURES: Record<string, { report: WhyNotMovingReportInput; signals: WhyNotMovingSignals }> = {
		'operator-paused': { report: { ...baseReport(), state: 'operator-paused' }, signals: baseSignals() },
		'ship-stalled': {
			report: { ...baseReport(), shipStalled: { prNumber: 1, prUrl: null, issueId: null, reason: 'ci-red', ts: 't' } },
			signals: baseSignals(),
		},
		'plan-escalated': {
			report: {
				...baseReport(),
				planEscalated: { issueId: 'CAM-1', summary: 's', findings: [], roundsCompleted: 3, writtenAt: 't' },
			},
			signals: baseSignals(),
		},
		'plan-preflight-failed': {
			report: { ...baseReport(), planPreflightFailed: { step: 'typecheck', detail: 'd', writtenAt: 't' } },
			signals: baseSignals(),
		},
		'implement-blocked': {
			report: {
				...baseReport(),
				implementBlocked: { issueId: 'CAM-1', story: 'US-001', reason: 'r', writtenAt: 't', consecutiveCount: 1, keyHash: 'h' },
			},
			signals: baseSignals(),
		},
		'post-merge-stalled': {
			report: {
				...baseReport(),
				postMergeStalled: {
					prNumber: 1,
					issueId: null,
					completedSteps: [],
					remainingSteps: ['tag'],
					reason: 'r',
					writtenAt: 't',
				},
			},
			signals: baseSignals(),
		},
		'sidecar-stalled': {
			report: { ...baseReport(), sidecarStalled: { reason: 'firewall-init-failed', detail: 'd', writtenAt: 't' } },
			signals: baseSignals(),
		},
		'gate-awaiting-decision': {
			report: { ...baseReport(), gate: { gate: 'in-progress-conflict', options: ['a'], context: 'c' } },
			signals: baseSignals(),
		},
		'merge-watch-waiting': { report: { ...baseReport(), mergeWatch: { prNumber: 1, pollCount: 0 } }, signals: baseSignals() },
		'orch-pane-busy': { report: baseReport(), signals: { orchPaneBusy: true } },
		'delivery-exhausted': { report: baseReport(), signals: { orchPaneBusy: false, pushUndeliveredReason: 'retries-exhausted' } },
		none: { report: baseReport(), signals: baseSignals() },
	};

	test('every enumerated condition id has a distinct message and a distinct suggested command mapping (closedness)', () => {
		expect(Object.keys(CONDITION_FIXTURES).sort()).toEqual([...WHY_NOT_MOVING_CONDITIONS].sort());
		const messages = new Set<string>();
		for (const condition of WHY_NOT_MOVING_CONDITIONS) {
			const fixture = CONDITION_FIXTURES[condition];
			if (!fixture) throw new Error(`no fixture for condition ${condition}`);
			const result = diagnoseWhyNotMoving(fixture.report, fixture.signals);
			expect(result.condition).toBe(condition);
			expect(typeof result.message).toBe('string');
			expect(result.message.length).toBeGreaterThan(0);
			expect(typeof result.suggestedCommand).toBe('string');
			expect(result.suggestedCommand.length).toBeGreaterThan(0);
			messages.add(result.message);
		}
		// every one of the enumerated conditions has its OWN fixed message (no collisions).
		expect(messages.size).toBe(WHY_NOT_MOVING_CONDITIONS.length);
	});
});

// ---------------------------------------------------------------------------
// AC2: fixed precedence order
// ---------------------------------------------------------------------------

describe('diagnoseWhyNotMoving: fixed precedence order (AC2)', () => {
	test('operator-paused wins over ship-stalled when both are present', () => {
		const result = diagnoseWhyNotMoving(
			{
				...baseReport(),
				state: 'operator-paused',
				shipStalled: { prNumber: 1, prUrl: null, issueId: null, reason: 'ci-red', ts: 't' },
			},
			baseSignals(),
		);
		expect(result.condition).toBe('operator-paused');
	});

	test('gate-awaiting-decision wins over merge-watch-waiting when both are present', () => {
		const result = diagnoseWhyNotMoving(
			{
				...baseReport(),
				gate: { gate: 'in-progress-conflict', options: ['a'], context: 'c' },
				mergeWatch: { prNumber: 1, pollCount: 0 },
			},
			baseSignals(),
		);
		expect(result.condition).toBe('gate-awaiting-decision');
	});
});

// ---------------------------------------------------------------------------
// AC3: orch-pane-busy wedge vs genuine delivery-exhaustion, never conflated
// ---------------------------------------------------------------------------

describe('diagnoseWhyNotMoving: busy-pane wedge vs delivery-exhaustion, distinguished (AC3)', () => {
	test('orch-pane-busy present takes precedence over a push-undelivered retries-exhausted signal', () => {
		const result = diagnoseWhyNotMoving(baseReport(), { orchPaneBusy: true, pushUndeliveredReason: 'retries-exhausted' });
		expect(result.condition).toBe('orch-pane-busy');
	});

	test('push-undelivered reason "pane-not-idle" alone (no orch-pane-busy) does not trigger delivery-exhausted', () => {
		const result = diagnoseWhyNotMoving(baseReport(), { orchPaneBusy: false, pushUndeliveredReason: 'pane-not-idle' });
		expect(result.condition).toBe('none');
	});

	test('push-undelivered reason "retries-exhausted" alone triggers delivery-exhausted, distinct message from orch-pane-busy', () => {
		const busy = diagnoseWhyNotMoving(baseReport(), { orchPaneBusy: true });
		const exhausted = diagnoseWhyNotMoving(baseReport(), { orchPaneBusy: false, pushUndeliveredReason: 'retries-exhausted' });
		expect(busy.condition).toBe('orch-pane-busy');
		expect(exhausted.condition).toBe('delivery-exhausted');
		expect(busy.message).not.toBe(exhausted.message);
		expect(busy.suggestedCommand).not.toBe(exhausted.suggestedCommand);
	});
});

// ---------------------------------------------------------------------------
// AC5: buildStatusReport attaches the diagnostic, no writes
// ---------------------------------------------------------------------------

describe('buildStatusReport: attaches the why-not-moving diagnostic (AC5)', () => {
	test('idle report (no state file) still carries a diagnostic', () => {
		withTmpCwd((dir) => {
			const report = buildStatusReport({ cwd: dir });
			expect(report.state).toBe('idle');
			expect(report.diagnostic).toEqual({
				condition: 'none',
				message: 'Nothing blocking: the cycle is progressing normally.',
				suggestedCommand: 'cam status',
			});
		});
	});

	test('a ship-stalled marker on disk is reflected in the attached diagnostic', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			writeShipStalledMarker(join(claudeDir, SHIP_STALLED_FILENAME), {
				prNumber: 9,
				prUrl: null,
				issueId: null,
				reason: 'ci-red',
				ts: '2026-07-23T00:00:00Z',
			});
			const report = buildStatusReport({ cwd: dir });
			expect(report.diagnostic?.condition).toBe('ship-stalled');
		});
	});

	test('an orch-pane-busy event in the event log drives the attached diagnostic', () => {
		withTmpCwd((dir) => {
			const eventsPath = join(dir, '.claude', 'cam-worker-events.jsonl');
			appendFileSync(
				eventsPath,
				`${JSON.stringify({ kind: 'orch-pane-busy', ts: '2026-07-23T00:00:00Z', detail: { paneId: '%0', idleTimeoutMs: 5000 } })}\n`,
				'utf8',
			);
			const report = buildStatusReport({ cwd: dir });
			expect(report.diagnostic?.condition).toBe('orch-pane-busy');
		});
	});

	test('a push-undelivered retries-exhausted event (with no orch-pane-busy) drives delivery-exhausted', () => {
		withTmpCwd((dir) => {
			const eventsPath = join(dir, '.claude', 'cam-worker-events.jsonl');
			appendFileSync(
				eventsPath,
				`${JSON.stringify({
					kind: 'push-undelivered',
					ts: '2026-07-23T00:00:00Z',
					detail: { paneId: '%0', retriesExhausted: 3, reason: 'retries-exhausted' },
				})}\n`,
				'utf8',
			);
			const report = buildStatusReport({ cwd: dir });
			expect(report.diagnostic?.condition).toBe('delivery-exhausted');
		});
	});

	test('a durable marker (plan-escalated) beats a transient orch-pane-busy signal, per fixed precedence', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			writePlanEscalatedMarker(join(claudeDir, PLAN_ESCALATED_FILENAME), {
				issueId: 'CAM-1',
				summary: 's',
				findings: [],
				roundsCompleted: 3,
				writtenAt: '2026-07-23T00:00:00Z',
			});
			appendFileSync(
				join(claudeDir, 'cam-worker-events.jsonl'),
				`${JSON.stringify({ kind: 'orch-pane-busy', ts: '2026-07-23T00:00:00Z', detail: { paneId: '%0', idleTimeoutMs: 5000 } })}\n`,
				'utf8',
			);
			const report = buildStatusReport({ cwd: dir });
			expect(report.diagnostic?.condition).toBe('plan-escalated');
		});
	});

	test('a malformed line in the event log never stops the scan for a later valid orch-pane-busy event', () => {
		withTmpCwd((dir) => {
			const eventsPath = join(dir, '.claude', 'cam-worker-events.jsonl');
			writeFileSync(
				eventsPath,
				`not json at all\n${JSON.stringify({ kind: 'orch-pane-busy', ts: 't', detail: { paneId: '%0', idleTimeoutMs: 1 } })}\n`,
				'utf8',
			);
			const report = buildStatusReport({ cwd: dir });
			expect(report.diagnostic?.condition).toBe('orch-pane-busy');
		});
	});

	test('buildStatusReport performs no writes: every file under cwd is byte-for-byte untouched (mtimeMs)', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			writeImplementBlockedMarker(join(claudeDir, IMPLEMENT_BLOCKED_FILENAME), {
				issueId: 'CAM-1',
				story: 'US-001',
				reason: 'r',
				writtenAt: 't',
				consecutiveCount: 1,
				keyHash: 'h',
			});
			const markerPath = join(claudeDir, IMPLEMENT_BLOCKED_FILENAME);
			const before = statSync(markerPath).mtimeMs;
			buildStatusReport({ cwd: dir });
			buildStatusReport({ cwd: dir });
			const after = statSync(markerPath).mtimeMs;
			expect(after).toBe(before);
		});
	});
});
