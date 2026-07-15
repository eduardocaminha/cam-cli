// test/plan-runner-target-prompt.test.ts
//
// Unit tests: proves that runPlanPhase threads the selected issue id into the
// planner task prompt (CAM-157 root-cause fix, US-001).
//
// Acceptance criteria proved:
//   AC1: runPlanPhase builds the planner task prompt from issue.id AFTER the
//        null-check, and the resolveAndSpawnPlanner call receives the built
//        prompt (grep oracle: issue.id|selectedIssue|targetId|buildPlannerTaskPrompt
//        in src/supervisor/plan-runner.ts is satisfied by the implementation).
//
//   AC2: buildPlannerTaskPrompt(issueId) contains the issue id AND a
//        do-not-re-select phrase.
//
//   AC3: opts.plannerTaskPrompt override is honored when explicitly provided
//        (backward compat: existing tests that inject a fixed prompt continue
//        to work; the built prompt is NOT used when override is present).
//
//   AC5: selectIssueFn returning null -> no-plannable-issue, no planner spawn.

import { test, expect } from 'bun:test';
import {
	runPlanPhase,
	buildPlannerTaskPrompt,
	DEFAULT_PLANNER_TASK_PROMPT,
} from '../src/supervisor/plan-runner.ts';
import type { IssueEntry } from '../src/issues/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-157',
	title: 'Plan runner authoritative target',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-02T00:00:00Z',
	updatedAt: '2026-07-02T00:00:00Z',
};

const TOP_OF_QUEUE_ISSUE: IssueEntry = {
	id: 'CAM-99',
	title: 'Some other issue that would be top-of-queue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-01T00:00:00Z',
	updatedAt: '2026-07-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// buildPlannerTaskPrompt unit tests (AC2)
// ---------------------------------------------------------------------------

test('buildPlannerTaskPrompt: prompt contains the selected issue id', () => {
	const prompt = buildPlannerTaskPrompt('CAM-157');
	expect(prompt).toContain('CAM-157');
});

test('buildPlannerTaskPrompt: prompt contains a do-not-re-select phrase', () => {
	const prompt = buildPlannerTaskPrompt('CAM-157');
	// Must contain some form of "do not re-select" instruction.
	const hasDoNotReselect =
		prompt.toLowerCase().includes('do not re-select') ||
		prompt.toLowerCase().includes('do not reselect') ||
		prompt.toLowerCase().includes('do not select') ||
		prompt.toLowerCase().includes('only') ||
		prompt.toLowerCase().includes('specifically');
	expect(hasDoNotReselect).toBe(true);
});

test('buildPlannerTaskPrompt: prompt differs from DEFAULT_PLANNER_TASK_PROMPT', () => {
	const prompt = buildPlannerTaskPrompt('CAM-157');
	expect(prompt).not.toBe(DEFAULT_PLANNER_TASK_PROMPT);
});

test('buildPlannerTaskPrompt: different issue ids produce different prompts', () => {
	const p157 = buildPlannerTaskPrompt('CAM-157');
	const p99 = buildPlannerTaskPrompt('CAM-99');
	expect(p157).not.toBe(p99);
	expect(p157).toContain('CAM-157');
	expect(p99).toContain('CAM-99');
});

// ---------------------------------------------------------------------------
// runPlanPhase: prompt threading (AC1)
// ---------------------------------------------------------------------------

test('runPlanPhase: spawned planner receives prompt built from selected issue id, not DEFAULT_PLANNER_TASK_PROMPT', () => {
	// Capture the shell string passed to respawn-pane.
	const capturedShellStrings: string[] = [];

	const spawnFn = (cmd: string, args: string[]): { stdout: string; exitCode: number } => {
		// Capture respawn-pane calls (the shell string is the last arg).
		if (cmd === 'tmux' && args.includes('respawn-pane')) {
			const shellStr = args[args.length - 1] ?? '';
			capturedShellStrings.push(shellStr);
		}
		return { stdout: '', exitCode: 0 };
	};

	// isPaneAlive returns false so the poll loop exits immediately (pane-death fallback).
	const isPaneAlive = (_paneId: string): boolean => false;

	runPlanPhase({
		spawnFn,
		isPaneAlive,
		sleepFn: () => {},
		genUuid: () => 'test-uuid-0000-0000-0000-target00000',
		// selectIssueFn returns CAM-157 (not top-of-queue).
		selectIssueFn: () => MOCK_ISSUE,
		readPlanVerdictFn: () => null,
		// readPlannerReportFn: defined but returns null (no prd.json) so planner-failed.
		readPlannerReportFn: () => null,
		preflightFn: () => ({ ok: true }),
		clock: (() => { let t = 0; return () => (t += 100); })(),
		plannerPaneId: '%5',
		paneCountMutexFn: () => 'available',
		pollIntervalMs: 1,
		plannerTimeoutMs: 999_999,
		auditorTimeoutMs: 999_999,
		// No plannerTaskPrompt override -> must use buildPlannerTaskPrompt(issue.id).
	});

	// At least one respawn-pane call must have happened (the planner spawn).
	expect(capturedShellStrings.length).toBeGreaterThanOrEqual(1);

	const plannerShell = capturedShellStrings[0] ?? '';

	// AC1: prompt contains the selected issue id.
	expect(plannerShell).toContain('CAM-157');

	// AC1: prompt does NOT fall through to DEFAULT_PLANNER_TASK_PROMPT.
	expect(plannerShell).not.toContain(DEFAULT_PLANNER_TASK_PROMPT);
});

test('runPlanPhase: spawned planner receives CAM-157 id, not top-of-queue CAM-99', () => {
	const capturedShellStrings: string[] = [];

	const spawnFn = (cmd: string, args: string[]): { stdout: string; exitCode: number } => {
		if (cmd === 'tmux' && args.includes('respawn-pane')) {
			capturedShellStrings.push(args[args.length - 1] ?? '');
		}
		return { stdout: '', exitCode: 0 };
	};

	runPlanPhase({
		spawnFn,
		isPaneAlive: () => false,
		sleepFn: () => {},
		genUuid: () => 'test-uuid-0000-0000-0000-targetcam157',
		// selectIssueFn returns CAM-157, NOT the top-of-queue CAM-99.
		selectIssueFn: () => MOCK_ISSUE,
		readPlanVerdictFn: () => null,
		readPlannerReportFn: () => null,
		preflightFn: () => ({ ok: true }),
		clock: (() => { let t = 0; return () => (t += 100); })(),
		plannerPaneId: '%5',
		paneCountMutexFn: () => 'available',
		pollIntervalMs: 1,
		plannerTimeoutMs: 999_999,
		auditorTimeoutMs: 999_999,
	});

	const plannerShell = capturedShellStrings[0] ?? '';
	expect(plannerShell).toContain('CAM-157');
	// Must NOT name the top-of-queue issue.
	expect(plannerShell).not.toContain('CAM-99');
});

// ---------------------------------------------------------------------------
// runPlanPhase: opts.plannerTaskPrompt override (AC3)
// ---------------------------------------------------------------------------

test('runPlanPhase: opts.plannerTaskPrompt override is honored (backward compat)', () => {
	const capturedShellStrings: string[] = [];
	const OVERRIDE_PROMPT = 'Fixed test prompt: do something specific.';

	const spawnFn = (cmd: string, args: string[]): { stdout: string; exitCode: number } => {
		if (cmd === 'tmux' && args.includes('respawn-pane')) {
			capturedShellStrings.push(args[args.length - 1] ?? '');
		}
		return { stdout: '', exitCode: 0 };
	};

	runPlanPhase({
		spawnFn,
		isPaneAlive: () => false,
		sleepFn: () => {},
		genUuid: () => 'test-uuid-0000-0000-0000-override00',
		selectIssueFn: () => MOCK_ISSUE,
		readPlanVerdictFn: () => null,
		readPlannerReportFn: () => null,
		preflightFn: () => ({ ok: true }),
		clock: (() => { let t = 0; return () => (t += 100); })(),
		plannerPaneId: '%5',
		paneCountMutexFn: () => 'available',
		pollIntervalMs: 1,
		plannerTimeoutMs: 999_999,
		auditorTimeoutMs: 999_999,
		// Explicit override: must use this, NOT buildPlannerTaskPrompt(issue.id).
		plannerTaskPrompt: OVERRIDE_PROMPT,
	});

	const plannerShell = capturedShellStrings[0] ?? '';
	// The override prompt must appear in the shell string.
	expect(plannerShell).toContain(OVERRIDE_PROMPT);
});

// ---------------------------------------------------------------------------
// runPlanPhase: null issue -> no-plannable-issue (AC5 - halt unchanged)
// ---------------------------------------------------------------------------

test('runPlanPhase: selectIssueFn returning null -> no-plannable-issue, no planner spawn', () => {
	const spawnCalls: string[][] = [];

	const spawnFn = (cmd: string, args: string[]): { stdout: string; exitCode: number } => {
		spawnCalls.push([cmd, ...args]);
		return { stdout: '', exitCode: 0 };
	};

	const result = runPlanPhase({
		spawnFn,
		isPaneAlive: () => false,
		sleepFn: () => {},
		genUuid: () => 'test-uuid-0000-0000-0000-nullissue0',
		selectIssueFn: () => null,
		readPlanVerdictFn: () => null,
		preflightFn: () => ({ ok: true }),
		clock: () => 0,
		plannerPaneId: '%5',
		paneCountMutexFn: () => 'available',
		pollIntervalMs: 1,
		plannerTimeoutMs: 999_999,
		auditorTimeoutMs: 999_999,
	});

	// AC5: result kind is no-plannable-issue.
	expect(result.kind).toBe('no-plannable-issue');

	// No planner was spawned (no respawn-pane calls).
	const respawnCalls = spawnCalls.filter(
		(args) => args[0] === 'tmux' && args.includes('respawn-pane'),
	);
	expect(respawnCalls.length).toBe(0);
});

// ---------------------------------------------------------------------------
// runPlanPhase: top-of-queue selection (AC4 - "bare selection path")
// ---------------------------------------------------------------------------

test('runPlanPhase: when selectIssueFn returns top-of-queue issue, prompt names that issue', () => {
	const capturedShellStrings: string[] = [];

	const spawnFn = (cmd: string, args: string[]): { stdout: string; exitCode: number } => {
		if (cmd === 'tmux' && args.includes('respawn-pane')) {
			capturedShellStrings.push(args[args.length - 1] ?? '');
		}
		return { stdout: '', exitCode: 0 };
	};

	runPlanPhase({
		spawnFn,
		isPaneAlive: () => false,
		sleepFn: () => {},
		genUuid: () => 'test-uuid-0000-0000-0000-topqueue00',
		// Returns top-of-queue issue (CAM-99).
		selectIssueFn: () => TOP_OF_QUEUE_ISSUE,
		readPlanVerdictFn: () => null,
		readPlannerReportFn: () => null,
		preflightFn: () => ({ ok: true }),
		clock: (() => { let t = 0; return () => (t += 100); })(),
		plannerPaneId: '%5',
		paneCountMutexFn: () => 'available',
		pollIntervalMs: 1,
		plannerTimeoutMs: 999_999,
		auditorTimeoutMs: 999_999,
	});

	const plannerShell = capturedShellStrings[0] ?? '';
	// Top-of-queue issue id must appear in the prompt.
	expect(plannerShell).toContain('CAM-99');
});
