// test/issue.test.ts
//
// Unit tests for `cam issue` (US-007: thin pane launcher).
//
// What we cover:
//   - buildIssueArgv: constructs the correct claude argv with /cam-issue create.
//   - runIssue (tmux path): asserts ensureProjectSession + openPaneInSession
//     tmux argv via injectable tmuxSpawnFn; returns 0 immediately (thin launcher).
//   - runIssue with an existing session: skips new-session, opens pane directly.
//   - runIssue error path: returns 1 when tmux throws.
//   - Dispatch wiring (index.ts): parseIssueArgs parses text correctly and
//     rejects missing/extra args.
//   - Help block exists: ISSUE_HELP string is non-empty and contains key terms.

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { buildIssueArgv, runIssue } from '../src/commands/issue.ts';
import { projectSessionName, type SpawnFn as TmuxSpawnFn } from '../src/tmux/session.ts';
import { parseIssueArgs } from '../index.ts';

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

// --- buildIssueArgv ---------------------------------------------------------

describe('buildIssueArgv', () => {
	test('builds the correct claude argv with /cam-issue create and the free text', () => {
		expect(buildIssueArgv('bypassPermissions', 'Add dark mode support')).toEqual([
			'claude',
			'--permission-mode',
			'bypassPermissions',
			'/cam-issue create Add dark mode support',
		]);
	});

	test('uses the supplied permission mode verbatim', () => {
		const argv = buildIssueArgv('default', 'some issue');
		expect(argv[2]).toBe('default');
	});

	test('embeds the free text verbatim in the slash command', () => {
		const argv = buildIssueArgv('bypassPermissions', 'fix login bug when token expires');
		const slashArg = argv[argv.length - 1] ?? '';
		expect(slashArg).toContain('/cam-issue create');
		expect(slashArg).toContain('fix login bug when token expires');
	});
});

// --- runIssue (thin pane launcher) ------------------------------------------

describe('runIssue (tmux pane launcher)', () => {
	test('calls has-session, new-session (3-pane), then split-window for the issue pane', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-test-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(false);

		const code = await runIssue({
			text: 'Add dark mode support',
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
		// openPaneInSession makes 1 more (the issue pane).
		expect(splitCalls.length).toBeGreaterThanOrEqual(3);
	});

	test('the issue pane split-window includes the claude /cam-issue create command', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-test-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(false);

		await runIssue({
			text: 'Fix the login bug',
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
		expect(cmdArg).toContain('/cam-issue create');
		expect(cmdArg).toContain('Fix the login bug');
	});

	test('skips new-session when session already exists (has-session returns 0)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-test-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(true); // session already exists

		const code = await runIssue({
			text: 'Add dark mode',
			cwd: tmpDir,
			permissionMode: 'bypassPermissions',
			tmuxSpawnFn,
		});

		expect(code).toBe(0);
		const newSessionCall = tmuxSpawnFn.calls.find((c) => c.args[0] === 'new-session');
		expect(newSessionCall).toBeUndefined();

		// openPaneInSession still runs (1 split-window call for the issue pane).
		const splitCalls = tmuxSpawnFn.calls.filter((c) => c.args[0] === 'split-window');
		expect(splitCalls.length).toBe(1);
	});

	test('returns 1 when tmux throws', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-test-'));
		const throwingSpawn: TmuxSpawnFn = ((_cmd: string, args: string[]) => {
			if (args[0] === 'has-session' || args[0] === 'new-session') {
				throw new Error('tmux not found');
			}
			return { status: 0 } as SpawnSyncReturns<Buffer>;
		}) as TmuxSpawnFn;

		const code = await runIssue({
			text: 'Add dark mode',
			cwd: tmpDir,
			permissionMode: 'bypassPermissions',
			tmuxSpawnFn: throwingSpawn,
		});

		expect(code).toBe(1);
	});

	test('issue pane split-window targets the project session', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-test-'));
		const tmuxSpawnFn = makeFakeTmuxSpawn(true); // session exists; skip new-session
		const sessionName = projectSessionName(tmpDir);

		await runIssue({
			text: 'Some issue text',
			cwd: tmpDir,
			permissionMode: 'bypassPermissions',
			tmuxSpawnFn,
		});

		// With existing session, only openPaneInSession's split-window fires.
		const splitCall = tmuxSpawnFn.calls.find((c) => c.args[0] === 'split-window');
		expect(splitCall?.args).toContain(`${sessionName}:0`);
	});
});

// --- Dispatch wiring (parseIssueArgs) ---------------------------------------

describe('parseIssueArgs (dispatch wiring in index.ts)', () => {
	test('parses a single free-text argument', () => {
		const result = parseIssueArgs(['Add dark mode support']);
		expect(result).not.toBeNull();
		expect(result?.text).toBe('Add dark mode support');
		expect(result?.help).toBe(false);
	});

	test('returns help flag when --help is passed', () => {
		const result = parseIssueArgs(['--help']);
		expect(result).not.toBeNull();
		expect(result?.help).toBe(true);
	});

	test('returns help flag when -h is passed', () => {
		const result = parseIssueArgs(['-h']);
		expect(result).not.toBeNull();
		expect(result?.help).toBe(true);
	});

	test('returns null when no argument is provided', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseIssueArgs([])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});

	test('returns null when multiple positional arguments are passed', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseIssueArgs(['word1', 'word2'])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});
});

// --- Help block existence ---------------------------------------------------

describe('ISSUE_HELP block', () => {
	test('cam issue --help output contains key terms', async () => {
		// Exercise the help path via main() to confirm it is wired and non-empty.
		const stdoutChunks: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdoutChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stdout.write;

		let exitCode: number | undefined;
		try {
			const { main } = await import('../index.ts');
			exitCode = await main(['bun', 'index.ts', 'issue', '--help']);
		} finally {
			process.stdout.write = originalWrite;
		}

		const output = stdoutChunks.join('');
		expect(exitCode).toBe(0);
		expect(output).toContain('cam issue');
		expect(output).toContain('/cam-issue create');
		expect(output).toContain('<free text>');
	});
});
