// test/plan.test.ts
//
// Unit tests for `cam plan` (US-006: thin pane launcher).
//
// What we cover:
//   - isApproveLine: JSON/YAML/case-insensitive detection; negative cases.
//   - findApproveLine: first-match, no-match, empty-input.
//   - parsePlanArgs: positional integer, leading-# tolerance, bare (no arg),
//     and standardized error on any present-but-non-integer token.
//   - buildPlanArgv: bare /cam-plan and /cam-plan N with permission mode.
//   - runPlan (tmux path): asserts ensureProjectSession + openPaneInSession
//     tmux argv via injectable tmuxSpawnFn; returns 0 immediately (thin launcher).
//   - runPlan with an issue number: slash command includes N (no `#`).
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
import { parsePlanArgs } from '../index.ts';
import { projectSessionName, type SpawnFn as TmuxSpawnFn } from '../src/tmux/session.ts';

// --- Fake tmux spawn --------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

function makeFakeTmuxSpawn(sessionExists = false): TmuxSpawnFn & { calls: TmuxCall[] } {
	const calls: TmuxCall[] = [];
	let paneCounter = 0;
	const fn = ((cmd: string, args: string[], opts?: { stdio?: string }) => {
		calls.push({ cmd, args: [...args] });
		const base: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};
		// With -L cam prefix: args[0]='-L', args[1]='cam', args[2]=subcommand.
		const subcommand = args[0] === '-L' ? args[2] : args[0];
		// has-session returns exit 0 when sessionExists, 1 otherwise.
		if (subcommand === 'has-session') {
			return { ...base, status: sessionExists ? 0 : 1 };
		}
		// Return a stable pane id for calls that capture it (-P -F #{pane_id}).
		if (
			(subcommand === 'new-session' || subcommand === 'split-window') &&
			opts?.stdio === 'pipe'
		) {
			paneCounter += 1;
			return { ...base, stdout: Buffer.from(`%${paneCounter}\n`) };
		}
		return base;
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

	test('builds /cam-plan N when issue is provided', () => {
		expect(buildPlanArgv('bypassPermissions', 42)).toEqual([
			'claude',
			'--permission-mode',
			'bypassPermissions',
			'/cam-plan 42',
		]);
	});

	test('uses the supplied permission mode verbatim', () => {
		const argv = buildPlanArgv('default');
		expect(argv[2]).toBe('default');
	});
});

// --- parsePlanArgs (strict, number-only CLI contract) ----------------------

describe('parsePlanArgs', () => {
	test('parses a positional integer issue number', () => {
		expect(parsePlanArgs(['21'])).toEqual({ issue: 21, help: false });
	});

	test('tolerates a leading `#` on the number', () => {
		expect(parsePlanArgs(['#21'])).toEqual({ issue: 21, help: false });
	});

	test('bare (no argument) leaves issue undefined', () => {
		expect(parsePlanArgs([])).toEqual({ help: false });
	});

	test('--help / -h set the help flag', () => {
		expect(parsePlanArgs(['--help'])).toEqual({ help: true });
		expect(parsePlanArgs(['-h'])).toEqual({ help: true });
	});

	test('rejects a present-but-non-integer token (returns null)', () => {
		expect(parsePlanArgs(['abc'])).toBeNull();
		expect(parsePlanArgs(['1.5'])).toBeNull();
		expect(parsePlanArgs(['21abc'])).toBeNull();
		expect(parsePlanArgs(['#abc'])).toBeNull();
		expect(parsePlanArgs([''])).toBeNull();
	});

	test('rejects zero and negatives', () => {
		expect(parsePlanArgs(['0'])).toBeNull();
		expect(parsePlanArgs(['-5'])).toBeNull();
	});

	test('rejects the removed --issue flag and any unknown option', () => {
		expect(parsePlanArgs(['--issue', '21'])).toBeNull();
		expect(parsePlanArgs(['--issue=21'])).toBeNull();
		expect(parsePlanArgs(['--bogus'])).toBeNull();
	});

	test('rejects more than one positional argument', () => {
		expect(parsePlanArgs(['21', '22'])).toBeNull();
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
			(c) => c.args[2] === 'has-session' && c.args.includes(sessionName),
		);
		expect(hasSessionCall).toBeDefined();

		// Verify new-session was called (session didn't exist).
		const newSessionCall = tmuxSpawnFn.calls.find((c) => c.args[2] === 'new-session');
		expect(newSessionCall).toBeDefined();
		expect(newSessionCall?.args).toContain(sessionName);

		// Verify openPaneInSession was called with split-window.
		const splitCalls = tmuxSpawnFn.calls.filter((c) => c.args[2] === 'split-window');
		// ensureProjectSession makes 2 split-window calls (pane 1 + pane 2),
		// openPaneInSession makes 1 more (the plan pane).
		expect(splitCalls.length).toBeGreaterThanOrEqual(3);
	});

	test('the plan pane split-window includes the claude /cam-plan command as separate argv elements', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-test-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(false);

		await runPlan({
			cwd: tmpDir,
			permissionMode: 'bypassPermissions',
			tmuxSpawnFn,
		});

		// The last split-window call is openPaneInSession; it must contain each
		// claude argv element as a discrete arg (not one joined shell string).
		const splitCalls = tmuxSpawnFn.calls.filter((c) => c.args[2] === 'split-window');
		const lastSplit = splitCalls[splitCalls.length - 1];
		expect(lastSplit?.args).toContain('claude');
		expect(lastSplit?.args).toContain('--permission-mode');
		expect(lastSplit?.args).toContain('bypassPermissions');
		expect(lastSplit?.args).toContain('/cam-plan');
		// No issue number, so no '#' in the slash arg.
		const slashArg = lastSplit?.args.find((a) => a.startsWith('/cam-plan'));
		expect(slashArg).toBe('/cam-plan');
	});

	test('includes N (no `#`) in the plan pane command when issue is provided', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-test-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(false);

		await runPlan({
			cwd: tmpDir,
			permissionMode: 'bypassPermissions',
			issue: 99,
			tmuxSpawnFn,
		});

		const splitCalls = tmuxSpawnFn.calls.filter((c) => c.args[2] === 'split-window');
		const lastSplit = splitCalls[splitCalls.length - 1];
		// The slash command element must include the issue number.
		const slashArg = lastSplit?.args.find((a) => a.startsWith('/cam-plan'));
		expect(slashArg).toContain('/cam-plan 99');
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
		const newSessionCall = tmuxSpawnFn.calls.find((c) => c.args[2] === 'new-session');
		expect(newSessionCall).toBeUndefined();

		// openPaneInSession still runs (1 split-window call for the plan pane).
		const splitCalls = tmuxSpawnFn.calls.filter((c) => c.args[2] === 'split-window');
		expect(splitCalls.length).toBe(1);
	});

	test('returns 1 when tmux throws', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-test-'));
		const throwingSpawn: TmuxSpawnFn = ((_cmd: string, args: string[]) => {
			// With -L cam prefix: args[0]='-L', args[1]='cam', args[2]=subcommand.
			const subcommand = args[0] === '-L' ? args[2] : args[0];
			if (subcommand === 'has-session' || subcommand === 'new-session') {
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
		const splitCall = tmuxSpawnFn.calls.find((c) => c.args[2] === 'split-window');
		expect(splitCall?.args).toContain(`${sessionName}:0`);
	});
});
