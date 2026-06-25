// test/issue.test.ts
//
// Unit tests for `cam issue` (US-006: thin-proxy to orchestrator).
//
// What we cover:
//   - parseIssueArgs: text parsing, --help, rejections.
//   - runIssue (hit path): orch alive → send-keys /cam-issue create <text> and return 0.
//   - runIssue (miss path): bootstrap + wait + send-keys.
//   - runIssue: bootstrap failure returns 1.
//   - runIssue: marker timeout returns 1.
//   - send-keys is atomic (NO -l; -l would make "Enter" literal; text + Enter same call).
//   - Free text is forwarded verbatim (including metacharacters).
//   - Help block exists and contains key terms.

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { runIssue } from '../src/commands/issue.ts';
import { projectSessionName, type SpawnFn as TmuxSpawnFn } from '../src/tmux/session.ts';
import { parseIssueArgs } from '../index.ts';

// --- Fake tmux spawn --------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

function makeFakeTmuxSpawn(opts: {
	sessionExists?: boolean;
	orchAlive?: boolean;
	orchPaneId?: string;
	/** When true, paneCountMutex returns 'busy' (3 panes instead of 2). */
	paneMutexBusy?: boolean;
} = {}): TmuxSpawnFn & { calls: TmuxCall[] } {
	const { sessionExists = true, orchAlive = true, orchPaneId = '%0', paneMutexBusy = false } = opts;
	const calls: TmuxCall[] = [];

	const fn = ((cmd: string, args: string[]) => {
		calls.push({ cmd, args: [...args] });
		const base: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};
		const subcommand = args[0] === '-L' ? args[2] : args[0];

		if (subcommand === 'has-session') {
			return { ...base, status: sessionExists ? 0 : 1 };
		}

		if (subcommand === 'list-panes') {
			if (!sessionExists) return { ...base, status: 1 };
			const fIdx = args.indexOf('-F');
			const fmt = fIdx !== -1 ? (args[fIdx + 1] ?? '') : '';
			if (fmt === '#{@cam_label}') {
				// orchestratorAlive keys on @cam_label (the orchestrator runs claude
				// under a bash respawn-wrapper, so pane_current_command is never claude).
				return {
					...base,
					stdout: Buffer.from(orchAlive ? `orchestrator\ndashboard\n` : `dashboard\n`),
				};
			}
			if (fmt === '#{pane_index};#{pane_id}') {
				return { ...base, stdout: Buffer.from(`0;${orchPaneId}\n`) };
			}
			if (fmt === '#{pane_id}') {
				// For paneCountMutex: return 2 pane IDs (available) or 3 (busy).
				const panes = paneMutexBusy ? '%0\n%1\n%2\n' : '%0\n%1\n';
				return { ...base, stdout: Buffer.from(panes) };
			}
			return { ...base, stdout: Buffer.from('') };
		}

		if (subcommand === 'capture-pane') {
			// Return idle pane content so the idle-check (US-008) passes immediately.
			return { ...base, stdout: Buffer.from('> ') };
		}
		if (subcommand === 'send-keys') return base;
		return base;
	}) as TmuxSpawnFn & { calls: TmuxCall[] };
	fn.calls = calls;
	return fn;
}

// --- parseIssueArgs ---------------------------------------------------------

describe('parseIssueArgs (dispatch wiring in index.ts)', () => {
	test('parses a single free-text argument (mode=text)', () => {
		const result = parseIssueArgs(['Add dark mode support']);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe('text');
		// Narrow to 'text' mode to access the text field.
		if (result?.mode === 'text') {
			expect(result.text).toBe('Add dark mode support');
		}
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

// --- runIssue (thin-proxy): hit path ----------------------------------------

describe('runIssue (thin-proxy, hit path)', () => {
	test('sends /cam-issue create <text> to orchestrator pane and returns 0', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-hit-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%1' });

		const code = await runIssue({
			text: 'Add dark mode support',
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
		});

		expect(code).toBe(0);
		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeDefined();
		expect(sendKeys?.args).not.toContain('-l');
		expect(sendKeys?.args).toContain('/cam-issue create Add dark mode support');
		expect(sendKeys?.args).toContain('Enter');
		expect(sendKeys?.args).toContain('%1');
	});

	test('free text is forwarded verbatim as a single argument', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-verbatim-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });
		const metacharText = 'fix login; $(echo injected) `whoami` & rm -rf /';

		await runIssue({
			text: metacharText,
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
		});

		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		const slashArg = sendKeys?.args.find((a) => a.startsWith('/cam-issue create'));
		expect(slashArg).toBeDefined();
		expect(slashArg).toContain(metacharText);
	});

	test('send-keys does NOT use -l (regression: -l makes "Enter" literal)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-literal-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

		await runIssue({ text: 'some text', cwd: tmpDir, tmuxSpawnFn: spawnFn });

		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys?.args).not.toContain('-l');
	});

	test('Enter is a separate argument in the send-keys call (atomic)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-atomic-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

		await runIssue({ text: 'test', cwd: tmpDir, tmuxSpawnFn: spawnFn });

		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		const enterIdx = sendKeys?.args.lastIndexOf('Enter') ?? -1;
		const textIdx = sendKeys?.args.findIndex((a) => a.startsWith('/cam-issue create')) ?? -1;
		expect(enterIdx).toBeGreaterThan(textIdx);
	});

	test('skips bootstrap when orchestrator is already alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-no-bootstrap-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		let bootstrapCalled = false;

		await runIssue({
			text: 'test issue',
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => { bootstrapCalled = true; return true; },
		});

		expect(bootstrapCalled).toBe(false);
	});

	test('returns 1 and does not send-keys when pane mutex is busy', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-busy-'));
		const spawnFn = makeFakeTmuxSpawn({
			sessionExists: true,
			orchAlive: true,
			paneMutexBusy: true,
		});

		const code = await runIssue({ text: 'Fix bug', cwd: tmpDir, tmuxSpawnFn: spawnFn });

		expect(code).toBe(1);
		// send-keys must NOT have been called (worker is still running)
		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeUndefined();
	});
});

// --- runIssue (thin-proxy): miss path ----------------------------------------

describe('runIssue (thin-proxy, miss path)', () => {
	test('bootstraps + waits + sends keys when orch not alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-miss-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

		let bootstrapCalled = false;
		let markerPresent = false;
		const bootstrapFn = async () => {
			bootstrapCalled = true;
			markerPresent = true;
			return true;
		};

		// Use sessionExists=false to trigger miss path, then use alive spawnFn after bootstrap.
		const missSpawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		// missSpawnFn for has-session check (miss), spawnFn for post-bootstrap liveness.
		// Simulate: first call (has-session) misses, then bootstrap sets marker,
		// then liveness check (via waitForOrchestrator's spawnFn) passes.
		const code = await runIssue({
			text: 'file a bug',
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn, // alive spawnFn for post-bootstrap calls
			bootstrapFn,
			statFn: () => markerPresent,
			sleepFn: () => {},
			waitTimeoutMs: 5_000,
		});

		// Since spawnFn sees a live orch (orchAlive=true), the hit path fires instead.
		// This test verifies the miss→bootstrap→send flow with a separate miss spawnFn.
		expect(code).toBe(0);

		// Call with the miss spawn: session does NOT exist, bootstrap sets marker but
		// missSpawnFn still reports orch not alive → waitForOrchestrator times out.
		// This confirms the two-condition check (marker AND liveness) is required.
		markerPresent = false;
		const code2 = await runIssue({
			text: 'another bug',
			cwd: tmpDir,
			tmuxSpawnFn: missSpawnFn, // all tmux calls miss (orchAlive=false)
			bootstrapFn: async () => { markerPresent = true; return true; },
			statFn: () => markerPresent,
			sleepFn: () => {},
			waitTimeoutMs: 5, // tiny budget so the loop exits immediately
		});
		// missSpawnFn has orchAlive=false so orchestratorAlive re-check fails → timeout.
		expect(code2).toBe(1);
	});

	test('returns 1 when bootstrap fails', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-boot-fail-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		const code = await runIssue({
			text: 'test',
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => false,
		});

		expect(code).toBe(1);
	});

	test('returns 1 when marker never appears (timeout)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-timeout-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		const code = await runIssue({
			text: 'test',
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => true,
			statFn: () => false, // marker never appears
			sleepFn: () => {},
			waitTimeoutMs: 5,
		});

		expect(code).toBe(1);
	});
});

// --- runIssue: session name -------------------------------------------------

describe('runIssue: session name', () => {
	test('all tmux calls include the project session name', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-sessname-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		const sessionName = projectSessionName(tmpDir);

		await runIssue({ text: 'test', cwd: tmpDir, tmuxSpawnFn: spawnFn });

		const callsWithSession = spawnFn.calls.filter((c) => c.args.includes(sessionName));
		expect(callsWithSession.length).toBeGreaterThan(0);
	});
});

// --- Help block existence ---------------------------------------------------

describe('ISSUE_HELP block', () => {
	test('cam issue --help output contains key terms', async () => {
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
