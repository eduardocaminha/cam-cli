// test/plan.test.ts
//
// Unit tests for `cam plan` (US-006: thin pane launcher).
//
// What we cover:
//   - isApproveLine: JSON/YAML/case-insensitive detection; negative cases.
//   - findApproveLine: first-match, no-match, empty-input.
//   - buildPlanArgv: bare /cam-plan and /cam-plan #N with permission mode.
//   - runPlan (tmux path): asserts ensureProjectSession + openPaneInSession
//     tmux argv via injectable tmuxSpawnFn; returns 0 immediately (thin launcher).
//   - runPlan with --issue option: slash command includes #N.
//   - runPlan with no tmuxSpawnFn failures: error path returns 1.
//
// The old PTY/APPROVE foreground tests are removed per US-006 acceptance
// criteria: APPROVE happens inside the pane; the parent process does not
// interact with the child.

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import {
	buildPlanArgv,
	findApproveLine,
	isApproveLine,
	runPlan,
} from '../src/commands/plan.ts';
import { projectSessionName, type SpawnFn as TmuxSpawnFn } from '../src/tmux/session.ts';

// --- Fake tmux spawn --------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

function makeFakeTmuxSpawn(sessionExists = false): TmuxSpawnFn & { calls: TmuxCall[] } {
	const calls: TmuxCall[] = [];
	const fn = ((cmd: string, args: string[], _opts?: { stdio?: string }) => {
		calls.push({ cmd, args: [...args] });
		// has-session returns exit 0 when sessionExists, 1 otherwise.
		if (args[0] === 'has-session') {
			return { status: sessionExists ? 0 : 1 } as SpawnSyncReturns<Buffer>;
		}
		return { status: 0 } as SpawnSyncReturns<Buffer>;
	}) as TmuxSpawnFn & { calls: TmuxCall[] };
	fn.calls = calls;
	return fn;
}

// --- isApproveLine / findApproveLine ----------------------------------------

describe('isApproveLine', () => {
	test('matches JSON-shaped verdict line', () => {
		expect(isApproveLine('"verdict": "APPROVE",')).toBe(true);
	});

	test('matches YAML-shaped verdict line', () => {
		expect(isApproveLine('verdict: APPROVE')).toBe(true);
	});

	test('matches case-insensitive on `verdict` keyword', () => {
		expect(isApproveLine('Verdict: APPROVE')).toBe(true);
		expect(isApproveLine('VERDICT = APPROVE')).toBe(true);
	});

	test('requires literal uppercase APPROVE -- `approve` alone does not match', () => {
		expect(isApproveLine('verdict: approve')).toBe(false);
	});

	test('does not match a line missing verdict keyword', () => {
		expect(isApproveLine('the answer is APPROVE')).toBe(false);
	});

	test('does not match a line missing APPROVE token', () => {
		expect(isApproveLine('verdict: BLOCK')).toBe(false);
	});
});

describe('findApproveLine', () => {
	test('returns the first APPROVE line in a multi-line buffer', () => {
		const buf = ['line one', 'line two', 'verdict: APPROVE', 'line four'].join('\n');
		expect(findApproveLine(buf)).toBe('verdict: APPROVE');
	});

	test('returns null when no line carries the verdict', () => {
		expect(findApproveLine('hello\nworld\n')).toBeNull();
	});

	test('returns null on empty input', () => {
		expect(findApproveLine('')).toBeNull();
	});
});

// --- buildPlanArgv ----------------------------------------------------------

describe('buildPlanArgv', () => {
	test('builds bare /cam-plan when no issue is provided', () => {
		expect(buildPlanArgv('bypassPermissions')).toEqual([
			'claude',
			'--permission-mode',
			'bypassPermissions',
			'/cam-plan',
		]);
	});

	test('builds /cam-plan #N when issue is provided', () => {
		expect(buildPlanArgv('bypassPermissions', 42)).toEqual([
			'claude',
			'--permission-mode',
			'bypassPermissions',
			'/cam-plan #42',
		]);
	});

	test('uses the supplied permission mode verbatim', () => {
		const argv = buildPlanArgv('default');
		expect(argv[2]).toBe('default');
	});
});

// --- runPlan (thin pane launcher) ------------------------------------------

describe('runPlan (tmux pane launcher)', () => {
	test('calls has-session, new-session (x2 split-window), then split-window for the plan pane', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-test-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(false);

		const code = await runPlan({
			cwd: tmpDir,
			permissionMode: 'bypassPermissions',
			tmuxSpawnFn,
		});

		expect(code).toBe(0);

		// Verify has-session was called with the project session name.
		const sessionName = projectSessionName(tmpDir);
		const hasSessionCall = tmuxSpawnFn.calls.find(
			(c) => c.args[0] === 'has-session' && c.args.includes(sessionName),
		);
		expect(hasSessionCall).toBeDefined();

		// Verify new-session was called (session didn't exist).
		const newSessionCall = tmuxSpawnFn.calls.find((c) => c.args[0] === 'new-session');
		expect(newSessionCall).toBeDefined();
		expect(newSessionCall?.args).toContain(sessionName);

		// Verify openPaneInSession was called with split-window.
		const splitCalls = tmuxSpawnFn.calls.filter((c) => c.args[0] === 'split-window');
		// ensureProjectSession makes 2 split-window calls (pane 1 + pane 2),
		// openPaneInSession makes 1 more (the plan pane).
		expect(splitCalls.length).toBeGreaterThanOrEqual(3);
	});

	test('the plan pane split-window includes the claude /cam-plan command', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-test-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(false);

		await runPlan({
			cwd: tmpDir,
			permissionMode: 'bypassPermissions',
			tmuxSpawnFn,
		});

		// The last split-window call is openPaneInSession; it must contain the claude cmd.
		const splitCalls = tmuxSpawnFn.calls.filter((c) => c.args[0] === 'split-window');
		const lastSplit = splitCalls[splitCalls.length - 1];
		const cmdArg = lastSplit?.args[lastSplit.args.length - 1] ?? '';
		expect(cmdArg).toContain('claude');
		expect(cmdArg).toContain('--permission-mode');
		expect(cmdArg).toContain('bypassPermissions');
		expect(cmdArg).toContain('/cam-plan');
		expect(cmdArg).not.toContain('#');
	});

	test('includes #N in the plan pane command when issue is provided', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-test-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(false);

		await runPlan({
			cwd: tmpDir,
			permissionMode: 'bypassPermissions',
			issue: 99,
			tmuxSpawnFn,
		});

		const splitCalls = tmuxSpawnFn.calls.filter((c) => c.args[0] === 'split-window');
		const lastSplit = splitCalls[splitCalls.length - 1];
		const cmdArg = lastSplit?.args[lastSplit.args.length - 1] ?? '';
		expect(cmdArg).toContain('/cam-plan #99');
	});

	test('skips new-session when session already exists (has-session returns 0)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-test-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(true); // session already exists

		const code = await runPlan({
			cwd: tmpDir,
			permissionMode: 'bypassPermissions',
			tmuxSpawnFn,
		});

		expect(code).toBe(0);
		const newSessionCall = tmuxSpawnFn.calls.find((c) => c.args[0] === 'new-session');
		expect(newSessionCall).toBeUndefined();

		// openPaneInSession still runs (1 split-window call for the plan pane).
		const splitCalls = tmuxSpawnFn.calls.filter((c) => c.args[0] === 'split-window');
		expect(splitCalls.length).toBe(1);
	});

	test('returns 1 when tmux throws', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-test-'));
		const throwingSpawn: TmuxSpawnFn = ((_cmd: string, args: string[]) => {
			if (args[0] === 'has-session' || args[0] === 'new-session') {
				throw new Error('tmux not found');
			}
			return { status: 0 } as SpawnSyncReturns<Buffer>;
		}) as TmuxSpawnFn;

		const code = await runPlan({
			cwd: tmpDir,
			permissionMode: 'bypassPermissions',
			tmuxSpawnFn: throwingSpawn,
		});

		expect(code).toBe(1);
	});

	test('plan pane split-window targets the project session', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-test-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(true); // session exists; skip new-session
		const sessionName = projectSessionName(tmpDir);

		await runPlan({
			cwd: tmpDir,
			permissionMode: 'bypassPermissions',
			tmuxSpawnFn,
		});

		// With existing session, only openPaneInSession's split-window fires.
		const splitCall = tmuxSpawnFn.calls.find((c) => c.args[0] === 'split-window');
		expect(splitCall?.args).toContain(`${sessionName}:0`);
	});
});
