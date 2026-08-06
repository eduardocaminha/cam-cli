// test/supervisor/plan-runner.test.ts
//
// Unit tests for wiring the deterministic oracle linter into the plan-runner
// audit path (US-002, CAM-310 PRD).
//
// Coverage (matches AC1-AC5):
//   AC1: runPlanWorkerSequence gains a content-reading seam (readPrdContentFn)
//        distinct from readPlannerReportFn; exercised throughout this suite.
//   AC2: the linter runs AFTER the presence guard, BEFORE the auditor spawns;
//        a broken oracle means the auditor pane is NEVER spawned for that round.
//   AC3: a lint finding is folded into a synthetic audit-blocked result whose
//        report is a well-formed BLOCK PlanVerdictReport (storyId + offending
//        command + rule name + why-broken per finding), feeding the SAME
//        re-plan loop as an auditor BLOCK (buildReplanPlannerTaskPrompt).
//   AC4: exhausting re-plan rounds on a persistently-broken oracle writes the
//        same escalation marker the auditor-BLOCK exhaustion path writes.
//   AC5: end-to-end ordering (broken PRD -> re-plan without spending the
//        auditor; clean PRD -> auditor unchanged, zero behavior change).

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';
import {
	runPlanPhase,
	runPlanPhaseWithReplan,
	buildLintBlockReport,
	MAX_REPLAN_ROUNDS,
	type RunPlanPhaseOptions,
	type RunPlanPhaseWithReplanOptions,
	type PlanEscalationWriterParams,
} from '../../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../../src/supervisor/loop.ts';
import type { PlanVerdictReport } from '../../src/supervisor/plan-verdict-report.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import type { PlanPreflightResult } from '../../src/supervisor/plan-preflight.ts';
import { readTaskPromptFromCommand } from '../helpers/task-prompt.ts';
import type { PrdShape } from '../../src/commands/status.ts';
import type { WorkerEvent } from '../../src/supervisor/events.ts';
import {
	DISPATCH_FAILED_FILENAME,
	removeDispatchFailedMarker,
	writeDispatchFailedMarker,
	type DispatchFailedMarker,
} from '../../src/supervisor/dispatch-failed-marker.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const GENERIC_PLAN_CONFIG_DIR = createTestTmpdir('cam-plan-runner-test-config-');
const GENERIC_PLAN_CONFIG_PATH = join(GENERIC_PLAN_CONFIG_DIR, 'project.toml');
writeFileSync(GENERIC_PLAN_CONFIG_PATH, '[backend]\nplanner = "claude"\nauditor = "claude"\n');

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-310',
	title: 'Test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-16T00:00:00Z',
	updatedAt: '2026-07-16T00:00:00Z',
};

const APPROVE_REPORT: PlanVerdictReport = {
	verdict: 'APPROVE',
	summary: 'Plan looks good',
	findings: [],
};

const BLOCK_REPORT: PlanVerdictReport = {
	verdict: 'BLOCK',
	summary: 'Auditor found a real defect',
	findings: [
		{
			id: 'A.001',
			category: 'A.completeness',
			severity: 'critical',
			description: 'Missing acceptance criteria',
		},
	],
};

const BROKEN_ORACLE_COMMAND = "grep -qL 'X' path/to/file.ts";

/** A PRD whose only story carries the self-nullifying grep -q + -L idiom. */
const BROKEN_PRD: PrdShape = {
	userStories: [
		{
			id: 'US-001',
			title: 'Story with a broken oracle',
			passes: false,
			acceptanceCriteria: [`Some criterion. [oracle: ${BROKEN_ORACLE_COMMAND}]`],
		},
	],
};

/** A PRD whose oracle is well-formed (no rule trips). */
const CLEAN_PRD: PrdShape = {
	userStories: [
		{
			id: 'US-001',
			title: 'Story with a clean oracle',
			passes: false,
			acceptanceCriteria: ["Some criterion. [oracle: grep -q 'X' path/to/file.ts]"],
		},
	],
};

const PREFLIGHT_OK: PlanPreflightResult = { ok: true };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
	taskPrompt?: string;
}

interface CheckedSpawnFixture {
	fn: SpawnFn;
	calls: TmuxCall[];
}

function makeCheckedSpawn(
	override?: (
		cmd: string,
		args: string[],
	) => { stdout: string; stderr?: string; exitCode: number | null } | undefined,
): CheckedSpawnFixture {
	const calls: TmuxCall[] = [];
	let panePid = 900;
	const fn: SpawnFn = (cmd, args) => {
		calls.push({ cmd, args });
		const overridden = override?.(cmd, args);
		if (overridden !== undefined) return overridden;
		if (args[2] === 'display-message' && args.includes('#{pane_pid}')) {
			return { stdout: `${panePid}\n`, exitCode: 0 };
		}
		if (args[2] === 'respawn-pane') panePid++;
		return { stdout: '', exitCode: 0 };
	};
	return { fn, calls };
}

function auditorRespawnCalls(calls: TmuxCall[]): TmuxCall[] {
	return calls.filter(
		(c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a.includes('subagent-auditor')),
	);
}

function plannerRespawnCalls(calls: TmuxCall[]): TmuxCall[] {
	return calls.filter(
		(c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a.includes('subagent-planner')),
	);
}

/**
 * Builds opts for a single runPlanPhase call. Planner dies after 1 poll tick;
 * auditor (when spawned) reports APPROVE by default. readPrdContentFn is
 * absent by default (backward compat: lint skipped unless overridden).
 */
function makeOpts(overrides: Partial<RunPlanPhaseOptions> = {}): {
	opts: RunPlanPhaseOptions;
	calls: TmuxCall[];
} {
	const calls: TmuxCall[] = [];
	let plannerAliveCount = 1;
	let panePid = 100;

	const spawnFn: SpawnFn = (cmd, args) => {
		if (args[2] === 'display-message' && args.includes('#{pane_pid}')) {
			calls.push({ cmd, args });
			return { stdout: `${panePid}\n`, exitCode: 0 };
		}
		const shell = args[args.length - 1] ?? '';
		const taskPrompt =
			args.includes('respawn-pane') && shell.includes('.cam-task-prompt-')
				? readTaskPromptFromCommand(shell)
				: undefined;
		calls.push({ cmd, args, taskPrompt });
		if (args[2] === 'respawn-pane') panePid++;
		return { stdout: '', exitCode: 0 };
	};

	const opts: RunPlanPhaseOptions = {
		spawnFn,
		isPaneAlive: () => {
			if (plannerAliveCount > 0) {
				plannerAliveCount--;
				return true;
			}
			return false;
		},
		sleepFn: () => {},
		genUuid: (() => {
			let n = 0;
			return () => `uuid-${++n}`;
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
		...overrides,
		configPath: 'configPath' in overrides ? overrides.configPath : GENERIC_PLAN_CONFIG_PATH,
	};

	return { opts, calls };
}

/**
 * Builds opts for runPlanPhaseWithReplan across multiple rounds. Round N's
 * prd.json content and auditor verdict are read from `prdContents[N]` /
 * `verdicts[N]` (index pinned by teardownPlanPanesFn, which advances the
 * round index — mirrors test/supervisor/plan/plan-runner-replan.test.ts).
 */
function makeReplanOpts(
	prdContents: (PrdShape | null)[],
	verdicts: PlanVerdictReport[],
	overrides: Partial<RunPlanPhaseWithReplanOptions> = {},
): {
	opts: RunPlanPhaseWithReplanOptions;
	calls: TmuxCall[];
	teardownCallCount: () => number;
	markerCalls: PlanEscalationWriterParams[];
} {
	const calls: TmuxCall[] = [];
	let teardownCount = 0;
	const markerCalls: PlanEscalationWriterParams[] = [];
	let roundIndex = 0;
	let plannerAliveCount = 1;
	let panePid = 200;

	const spawnFn: SpawnFn = (cmd, args) => {
		if (args[2] === 'display-message' && args.includes('#{pane_pid}')) {
			calls.push({ cmd, args });
			return { stdout: `${panePid}\n`, exitCode: 0 };
		}
		const shell = args[args.length - 1] ?? '';
		const taskPrompt =
			args.includes('respawn-pane') && shell.includes('.cam-task-prompt-')
				? readTaskPromptFromCommand(shell)
				: undefined;
		calls.push({ cmd, args, taskPrompt });
		if (args[2] === 'respawn-pane') panePid++;
		return { stdout: '', exitCode: 0 };
	};

	const opts: RunPlanPhaseWithReplanOptions = {
		spawnFn,
		isPaneAlive: () => {
			if (plannerAliveCount > 0) {
				plannerAliveCount--;
				return true;
			}
			return false;
		},
		sleepFn: () => {},
		genUuid: (() => {
			let n = 0;
			return () => `uuid-${++n}`;
		})(),
		selectIssueFn: () => MOCK_ISSUE,
		readPrdContentFn: () => prdContents[roundIndex] ?? prdContents[prdContents.length - 1] ?? null,
		readPlanVerdictFn: () => verdicts[roundIndex] ?? verdicts[verdicts.length - 1] ?? APPROVE_REPORT,
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
		teardownPlanPanesFn: () => {
			teardownCount++;
			plannerAliveCount = 1;
			roundIndex++;
		},
		writeEscalationMarkerFn: (params) => {
			markerCalls.push(params);
		},
		...overrides,
		configPath: 'configPath' in overrides ? overrides.configPath : GENERIC_PLAN_CONFIG_PATH,
	};

	return {
		opts,
		calls,
		teardownCallCount: () => teardownCount,
		markerCalls,
	};
}

// ---------------------------------------------------------------------------
// buildLintBlockReport (pure helper)
// ---------------------------------------------------------------------------

describe('buildLintBlockReport', () => {
	test('builds a BLOCK PlanVerdictReport with one finding per lint finding', () => {
		const report = buildLintBlockReport([
			{ storyId: 'US-002', command: BROKEN_ORACLE_COMMAND, ruleName: 'grep-q-plus-list-files', reason: 'why broken' },
		]);
		expect(report.verdict).toBe('BLOCK');
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]).toMatchObject({
			storyId: 'US-002',
			category: 'grep-q-plus-list-files',
			severity: 'critical',
		});
		expect(report.findings[0]!.description).toContain(BROKEN_ORACLE_COMMAND);
		expect(report.findings[0]!.description).toContain('why broken');
	});

	test('summary reports the finding count', () => {
		const report = buildLintBlockReport([
			{ storyId: 'A', command: 'c1', ruleName: 'r', reason: 'why' },
			{ storyId: 'B', command: 'c2', ruleName: 'r', reason: 'why' },
		]);
		expect(report.summary).toContain('2');
	});
});

// ---------------------------------------------------------------------------
// runPlanPhase: lint wiring (AC2, AC3, AC5)
// ---------------------------------------------------------------------------

describe('runPlanPhase: oracle lint wiring (AC2, AC3, AC5)', () => {
	test('AC2: a broken oracle blocks BEFORE the auditor is ever spawned', () => {
		const { opts, calls } = makeOpts({ readPrdContentFn: () => BROKEN_PRD });
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('audit-blocked');
		expect(auditorRespawnCalls(calls)).toHaveLength(0);
		expect(plannerRespawnCalls(calls)).toHaveLength(1);
	});

	test('AC3: the synthetic audit-blocked report carries story id + offending command + rule name + reason', () => {
		const { opts } = makeOpts({ readPrdContentFn: () => BROKEN_PRD });
		const result = runPlanPhase(opts) as { kind: 'audit-blocked'; issue: IssueEntry; report: PlanVerdictReport };
		expect(result.issue.id).toBe('CAM-310');
		expect(result.report.verdict).toBe('BLOCK');
		expect(typeof result.report.summary).toBe('string');
		expect(result.report.findings).toHaveLength(1);
		const finding = result.report.findings[0]!;
		expect(finding.storyId).toBe('US-001');
		expect(finding.category).toBe('grep-q-plus-list-files');
		expect(finding.description).toContain(BROKEN_ORACLE_COMMAND);
	});

	test("audit-blocked carries origin oracle-lint for a lint block and auditor for an auditor BLOCK", () => {
		const { opts: lintOpts, calls: lintCalls } = makeOpts({ readPrdContentFn: () => BROKEN_PRD });
		const lintResult = runPlanPhase(lintOpts) as { kind: 'audit-blocked'; origin: 'oracle-lint' | 'auditor' };
		expect(lintResult.kind).toBe('audit-blocked');
		expect(lintResult.origin).toBe('oracle-lint');
		expect(auditorRespawnCalls(lintCalls)).toHaveLength(0);

		const { opts: auditorOpts } = makeOpts({
			readPrdContentFn: () => CLEAN_PRD,
			readPlanVerdictFn: () => BLOCK_REPORT,
		});
		const auditorResult = runPlanPhase(auditorOpts) as { kind: 'audit-blocked'; origin: 'oracle-lint' | 'auditor' };
		expect(auditorResult.kind).toBe('audit-blocked');
		expect(auditorResult.origin).toBe('auditor');
	});

	test('AC5: a clean prd.json proceeds to the auditor unchanged (zero behavior change)', () => {
		const { opts, calls } = makeOpts({ readPrdContentFn: () => CLEAN_PRD });
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('audit-approved');
		expect(auditorRespawnCalls(calls)).toHaveLength(1);
	});

	test('backward compat: readPrdContentFn absent skips the lint entirely', () => {
		const { opts, calls } = makeOpts();
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('audit-approved');
		expect(auditorRespawnCalls(calls)).toHaveLength(1);
	});

	test('readPrdContentFn returning null (unreadable prd.json) does not block', () => {
		const { opts, calls } = makeOpts({ readPrdContentFn: () => null });
		const result = runPlanPhase(opts);
		expect(result.kind).toBe('audit-approved');
		expect(auditorRespawnCalls(calls)).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// runPlanPhaseWithReplan: fold into the re-plan loop (AC3, AC4, AC5)
// ---------------------------------------------------------------------------

describe('runPlanPhaseWithReplan: lint findings fold into the re-plan loop (AC3, AC4, AC5)', () => {
	test('AC5: round-1 broken oracle re-plans without spending the auditor; round-2 clean prd.json spawns the auditor once', () => {
		const { opts, calls } = makeReplanOpts([BROKEN_PRD, CLEAN_PRD], [APPROVE_REPORT, APPROVE_REPORT]);
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('audit-approved');
		// Exactly one auditor spawn total: round 1's lint-block never spawns it,
		// round 2 (clean) spawns it exactly once.
		expect(auditorRespawnCalls(calls)).toHaveLength(1);
		expect(plannerRespawnCalls(calls)).toHaveLength(2);
	});

	test('AC3: round-2 planner spawn prompt embeds the lint finding as re-plan feedback, pinned to the same issue', () => {
		const { opts, calls } = makeReplanOpts([BROKEN_PRD, CLEAN_PRD], [APPROVE_REPORT, APPROVE_REPORT]);
		runPlanPhaseWithReplan(opts);
		const plannerCalls = plannerRespawnCalls(calls);
		expect(plannerCalls).toHaveLength(2);
		const round2Prompt = plannerCalls[1]?.taskPrompt ?? '';
		expect(round2Prompt).toContain('CAM-310');
		expect(round2Prompt).toContain('Do not re-select from the backlog');
		expect(round2Prompt).toContain('grep-q-plus-list-files');
		expect(round2Prompt).toContain('grep -qL');
		expect(round2Prompt).toContain('path/to/file.ts');
	});

	test('AC4: exhausting re-plan rounds on a persistently-broken oracle escalates via writeEscalationMarkerFn, auditor never spawned', () => {
		const { opts, calls, markerCalls } = makeReplanOpts([BROKEN_PRD, BROKEN_PRD], [APPROVE_REPORT, APPROVE_REPORT]);
		const result = runPlanPhaseWithReplan(opts) as { kind: 'plan-escalated'; roundsCompleted: number };
		expect(result.kind).toBe('plan-escalated');
		expect(result.roundsCompleted).toBe(MAX_REPLAN_ROUNDS);
		expect(markerCalls).toHaveLength(1);
		expect(markerCalls[0]?.issueId).toBe('CAM-310');
		expect(markerCalls[0]?.roundsCompleted).toBe(MAX_REPLAN_ROUNDS);
		// The auditor is NEVER spawned across BOTH rounds: the lint blocks every round.
		expect(auditorRespawnCalls(calls)).toHaveLength(0);
		// Never proceeds to branch creation.
		expect(calls.filter((c) => c.cmd === 'git')).toHaveLength(0);
	});

	test('mixed: round-1 lint-block then round-2 real auditor BLOCK do NOT fold into the same escalation path (US-002, CAM-448)', () => {
		// Round 1: lint blocks (BROKEN_PRD), spending the lint budget only.
		// Round 2: prd.json is clean (CLEAN_PRD), so the auditor is spawned for
		// real and returns BLOCK -- that spends the FIRST round of the
		// (untouched) auditor budget, not the exhausted lint budget. Round 3
		// (also lint-clean, falls back to CLEAN_PRD) still has auditor budget
		// left and approves, so the run converges instead of escalating.
		const { opts, markerCalls, calls } = makeReplanOpts(
			[BROKEN_PRD, CLEAN_PRD],
			[APPROVE_REPORT, BLOCK_REPORT, APPROVE_REPORT],
		);
		const result = runPlanPhaseWithReplan(opts);
		expect(result.kind).toBe('audit-approved');
		expect(auditorRespawnCalls(calls).length).toBeGreaterThanOrEqual(2);
		// No escalation: the marker writer is never invoked.
		expect(markerCalls).toHaveLength(0);
	});
});

describe('CAM-433 verified plan dispatch and terminal lifecycles', () => {
	test('planner and record-bearing auditor prompts stay out of tmux argv; verified success removes prompt files and a stale failure marker', () => {
		const claudeDir = createTestTmpdir('cam-plan-verified-success-');
		const markerPath = join(claudeDir, DISPATCH_FAILED_FILENAME);
		const uniqueAuditorRecord = 'AUDITOR_RECORD_MUST_ONLY_EXIST_IN_PROMPT_FILE';
		const issue: IssueEntry = {
			...MOCK_ISSUE,
			title: uniqueAuditorRecord,
			spec: {
				acceptanceCriteria: [`${uniqueAuditorRecord} acceptance`],
				scope: uniqueAuditorRecord,
				gotchas: [],
				domainTerms: [],
			},
		};
		const staleMarker: DispatchFailedMarker = {
			phase: 'planner',
			paneId: '%3',
			uuid: 'stale',
			exitCode: 1,
			stderr: 'old',
			reason: 'respawn-pane-exited',
			timestamp: '2026-07-27T00:00:00.000Z',
		};
		writeDispatchFailedMarker(markerPath, staleMarker);

		try {
			const { opts, calls } = makeOpts({
				claudeDir,
				selectIssueFn: () => issue,
				writeDispatchFailedMarkerFn: (marker) =>
					writeDispatchFailedMarker(markerPath, marker),
				removeDispatchFailedMarkerFn: () => removeDispatchFailedMarker(markerPath),
			});
			const result = runPlanPhase(opts);
			expect(result.kind).toBe('audit-approved');

			const auditorRespawn = auditorRespawnCalls(calls)[0];
			expect(auditorRespawn?.taskPrompt).toContain(uniqueAuditorRecord);
			const auditorArgv = auditorRespawn?.args.at(-1) ?? '';
			expect(auditorArgv).toContain('.cam-task-prompt-');
			expect(auditorArgv).not.toContain(uniqueAuditorRecord);

			// Two pane_pid reads per actor, and pipe-pane is part of each verified
			// helper call rather than an unchecked follow-up.
			expect(calls.filter((call) => call.args.includes('#{pane_pid}'))).toHaveLength(4);
			expect(calls.filter((call) => call.args[2] === 'pipe-pane')).toHaveLength(2);
			expect(existsSync(markerPath)).toBe(false);
			expect(
				readdirSync(claudeDir).filter((name) => name.startsWith('.cam-task-prompt-')),
			).toEqual([]);
		} finally {
			rmSync(claudeDir, { recursive: true, force: true });
		}
	});

	test('unchanged pane_pid is a dispatch-failed terminal and removes its prompt file', () => {
		const claudeDir = createTestTmpdir('cam-plan-verified-unchanged-');
		const events: WorkerEvent[] = [];
		const markers: DispatchFailedMarker[] = [];
		const messages: string[] = [];
		const spawn = makeCheckedSpawn((_cmd, args) => {
			if (args[2] === 'display-message' && args.includes('#{pane_pid}')) {
				return { stdout: '444\n', exitCode: 0 };
			}
			return undefined;
		});

		try {
			const { opts } = makeOpts({
				spawnFn: spawn.fn,
				claudeDir,
				logEvent: (event) => events.push(event),
				writeDispatchFailedMarkerFn: (marker) => markers.push(marker),
				notifyFn: (message) => messages.push(message),
			});
			const result = runPlanPhase(opts);
			expect(result).toEqual({
				kind: 'dispatch-failed',
				phase: 'planner',
				reason: 'pane-pid-unchanged',
			});
			expect(events.some((event) => event.kind === 'dispatch-failed')).toBe(true);
			expect(markers.at(-1)?.reason).toBe('pane-pid-unchanged');
			expect(messages.some((message) => message.includes('pane-pid-unchanged'))).toBe(true);
			expect(
				readdirSync(claudeDir).filter((name) => name.startsWith('.cam-task-prompt-')),
			).toEqual([]);
		} finally {
			rmSync(claudeDir, { recursive: true, force: true });
		}
	});

	test('planner timeout checks the sentinel respawn exit and emits event, marker, notification, and prompt cleanup', () => {
		const claudeDir = createTestTmpdir('cam-plan-timeout-planner-');
		const events: WorkerEvent[] = [];
		const markers: DispatchFailedMarker[] = [];
		const messages: string[] = [];
		const spawn = makeCheckedSpawn((_cmd, args) =>
			args[2] === 'respawn-pane' && args.includes('echo planner-timeout')
				? { stdout: '', stderr: 'sentinel refused', exitCode: 23 }
				: undefined,
		);
		let now = 0;

		try {
			const { opts } = makeOpts({
				spawnFn: spawn.fn,
				claudeDir,
				isPaneAlive: () => true,
				clock: () => (now += 1_000),
				plannerTimeoutMs: 1,
				logEvent: (event) => events.push(event),
				writeDispatchFailedMarkerFn: (marker) => markers.push(marker),
				notifyFn: (message) => messages.push(message),
			});
			expect(runPlanPhase(opts).kind).toBe('planner-timeout');
			expect(
				events.some(
					(event) =>
						event.kind === 'dispatch-failed' &&
						(event.detail as { reason?: string }).reason === 'respawn-pane-exited',
				),
			).toBe(true);
			expect(markers.some((marker) => marker.exitCode === 23)).toBe(true);
			expect(markers.at(-1)?.reason).toBe('planner-timeout');
			expect(messages.some((message) => message.includes('planner timed out'))).toBe(true);
			expect(
				readdirSync(claudeDir).filter((name) => name.startsWith('.cam-task-prompt-')),
			).toEqual([]);
		} finally {
			rmSync(claudeDir, { recursive: true, force: true });
		}
	});

	test('auditor timeout checks the sentinel respawn exit and emits event, marker, and notification', () => {
		const events: WorkerEvent[] = [];
		const markers: DispatchFailedMarker[] = [];
		const messages: string[] = [];
		const spawn = makeCheckedSpawn((_cmd, args) =>
			args[2] === 'respawn-pane' && args.includes('echo auditor-timeout')
				? { stdout: '', stderr: 'auditor sentinel refused', exitCode: 29 }
				: undefined,
		);
		let now = 0;
		const { opts } = makeOpts({
			spawnFn: spawn.fn,
			isPaneAlive: () => true,
			readPlannerReportFn: () => ({ written: true }),
			readPlanVerdictFn: () => null,
			clock: () => (now += 1_000),
			auditorTimeoutMs: 1,
			logEvent: (event) => events.push(event),
			writeDispatchFailedMarkerFn: (marker) => markers.push(marker),
			notifyFn: (message) => messages.push(message),
		});

		expect(runPlanPhase(opts).kind).toBe('auditor-timeout');
		expect(
			events.some(
				(event) =>
					event.kind === 'dispatch-failed' &&
					(event.detail as { reason?: string }).reason === 'respawn-pane-exited',
			),
		).toBe(true);
		expect(markers.some((marker) => marker.exitCode === 29)).toBe(true);
		expect(markers.at(-1)?.reason).toBe('auditor-timeout');
		expect(messages.some((message) => message.includes('auditor timed out'))).toBe(true);
	});
});
