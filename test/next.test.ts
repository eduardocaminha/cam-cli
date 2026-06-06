// test/next.test.ts
//
// Unit tests for `cam next`. We mock both the spawn factory and the
// state-file writer via the injection points on `runNext({ spawn, writer })`,
// so these tests never call `claude`, never invoke `tmux`, and never
// touch the real filesystem outside the bun-test tmpdir.
//
// What we cover (mapping to US-007 acceptance criteria 5+6):
//   - default `--max-iterations 30 --completion-promise "COMPLETE"` flow
//   - overrides apply (`maxIterations`, `completionPromise`)
//   - state file is rendered + written with the right frontmatter values
//   - tmux-split path (inside tmux): pane B argv is `tmux split-window -h --
//     cam dashboard`, pane A argv is `claude --permission-mode <mode>
//     /cam-next` — both spawned with the same cwd
//   - tmux-split path (outside tmux): pane B via `tmux new-session -d -s cam`
//   - VS Code path: only pane A is spawned (no split)
//   - Inline (no tmux): same as VS Code — pane A only
//   - Render: completion-promise is YAML-quoted; max-iterations is a bare int

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	buildClaudeArgv,
	buildDashboardArgv,
	deepMerge,
	detectHost,
	materializeStopHook,
	renderStateFile,
	runNext,
	SETTINGS_LOCAL_RELATIVE,
	STOP_HOOK_RELATIVE,
	writeSettingsLocal,
	writeStateFile,
	type TmuxProbeFn,
	type NextSpawnFn,
	type NextSubprocess,
} from '../src/commands/next.ts';
import { projectSessionName, type SpawnFn as TmuxSpawnFn } from '../src/tmux/session.ts';
import type { SpawnSyncReturns } from 'node:child_process';

// --- Fakes -----------------------------------------------------------------

interface FakeNextHandle {
	proc: NextSubprocess;
	exitedResolve: (code: number) => void;
	killCalls: Array<number | string | undefined>;
}

function makeFakeProcess(): FakeNextHandle {
	const killCalls: Array<number | string | undefined> = [];
	let exitedResolve: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		exitedResolve = resolve;
	});
	const proc: NextSubprocess = {
		exited,
		kill(signal?: number | string) {
			killCalls.push(signal);
			exitedResolve(143);
		},
	};
	return { proc, exitedResolve, killCalls };
}

interface SpawnRecord {
	cmd: string[];
	cwd: string;
}

function makeRecordingSpawn(handles: FakeNextHandle[]): NextSpawnFn & { calls: SpawnRecord[] } {
	const calls: SpawnRecord[] = [];
	const fn = ((cmd: string[], options: { cwd: string }) => {
		calls.push({ cmd: [...cmd], cwd: options.cwd });
		const handle = handles[calls.length - 1];
		if (!handle) {
			throw new Error(`spawn called more times than handles provided (${calls.length})`);
		}
		return handle.proc;
	}) as NextSpawnFn & { calls: SpawnRecord[] };
	fn.calls = calls;
	return fn;
}

// --- Fakes for tmux probe --------------------------------------------------

/**
 * Fake TmuxProbeFn builders for the 2 cases the acceptance criteria
 * require: tmux available, tmux missing.
 */

function makeTmuxProbeAvailable(): TmuxProbeFn {
	return (_cmd) => ({ exitCode: 0 });
}

function makeTmuxProbeMissing(): TmuxProbeFn {
	return (_cmd) => null;
}

describe('detectHost', () => {
	test('returns "tmux-split" when tmux is available and not in VS Code', () => {
		expect(detectHost({}, makeTmuxProbeAvailable())).toBe('tmux-split');
	});

	test('returns "tmux-split" inside any terminal (Ghostty, iTerm, etc.) as long as tmux is present', () => {
		expect(detectHost({ TERM_PROGRAM: 'ghostty' }, makeTmuxProbeAvailable())).toBe('tmux-split');
		expect(detectHost({ TERM_PROGRAM: 'iTerm.app' }, makeTmuxProbeAvailable())).toBe('tmux-split');
	});

	test('returns "inline" when tmux is not on PATH', () => {
		expect(detectHost({}, makeTmuxProbeMissing())).toBe('inline');
	});

	test('returns "inline" when TERM_PROGRAM=vscode regardless of tmux', () => {
		expect(detectHost({ TERM_PROGRAM: 'vscode' }, makeTmuxProbeAvailable())).toBe('inline');
	});

	test('returns "inline" when tmux exits non-zero (e.g. not installed properly)', () => {
		const badProbe: TmuxProbeFn = (_cmd) => ({ exitCode: 127 });
		expect(detectHost({}, badProbe)).toBe('inline');
	});
});

// --- renderStateFile -------------------------------------------------------

describe('renderStateFile', () => {
	test('substitutes all placeholders and emits YAML frontmatter + prompt body', () => {
		const out = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			prompt: '/cam-next',
			startedAt: '2026-04-28T22:00:00Z',
			sessionId: 'sess-abc',
			pid: 4242,
		});
		expect(out).toContain('max_iterations: 30');
		expect(out).toContain('completion_promise: "COMPLETE"');
		expect(out).toContain('started_at: "2026-04-28T22:00:00Z"');
		expect(out).toContain('session_id: sess-abc');
		expect(out).toContain('active: true');
		expect(out).toContain('iteration: 1');
		expect(out).toContain('pid: 4242');
		expect(out.trimEnd().endsWith('/cam-next')).toBe(true);
	});

	test('emits null for empty completion-promise', () => {
		const out = renderStateFile({
			maxIterations: 0,
			completionPromise: '',
			prompt: '/cam-next',
			startedAt: '2026-04-28T22:00:00Z',
			sessionId: '',
			pid: 4242,
		});
		expect(out).toContain('completion_promise: null');
	});

	test('escapes a double-quote inside the completion-promise', () => {
		const out = renderStateFile({
			maxIterations: 30,
			completionPromise: 'TASK "DONE"',
			prompt: '/cam-next',
			startedAt: '2026-04-28T22:00:00Z',
			sessionId: '',
			pid: 4242,
		});
		expect(out).toContain('completion_promise: "TASK \\"DONE\\""');
	});

	test('writes the pid field for the heartbeat probe', () => {
		const out = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			prompt: '/cam-next',
			startedAt: '2026-04-28T22:00:00Z',
			sessionId: '',
			pid: 99999,
		});
		expect(out).toContain('pid: 99999');
	});
});

// --- writeStateFile --------------------------------------------------------

describe('writeStateFile', () => {
	test('creates .claude/ when missing and writes the body', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-write-'));
		try {
			const written = writeStateFile(dir, 'hello\n');
			expect(written).toBe(join(dir, '.claude', 'cam-loop.local.md'));
			expect(existsSync(written)).toBe(true);
			expect(readFileSync(written, 'utf8')).toBe('hello\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('refuses to clobber an existing state file unless force=true', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-clobber-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'old\n');
			expect(() => writeStateFile(dir, 'new\n')).toThrow(/already exists/);
			// With force=true, it overwrites.
			writeStateFile(dir, 'newer\n', { force: true });
			expect(readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8')).toBe(
				'newer\n',
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- argv builders ---------------------------------------------------------

describe('argv builders', () => {
	test('buildClaudeArgv passes permission_mode through', () => {
		expect(buildClaudeArgv('bypassPermissions')).toEqual([
			'claude',
			'--permission-mode',
			'bypassPermissions',
			'/cam-next',
		]);
	});

	test('buildDashboardArgv is `cam dashboard`', () => {
		expect(buildDashboardArgv()).toEqual(['cam', 'dashboard']);
	});
});

// --- TmuxSpawnFn fake -------------------------------------------------------

interface TmuxSpawnRecord {
	cmd: string;
	args: string[];
}

function makeTmuxSpawnFake(): TmuxSpawnFn & { calls: TmuxSpawnRecord[] } {
	const calls: TmuxSpawnRecord[] = [];
	const fn = (
		cmd: string,
		args: string[],
	): SpawnSyncReturns<Buffer> => {
		calls.push({ cmd, args: [...args] });
		// has-session returns 1 (not found) so ensureProjectSession creates the session.
		// All other tmux calls return 0 (success).
		const isHasSession = cmd === 'tmux' && args[0] === 'has-session';
		return {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: isHasSession ? 1 : 0,
			signal: null,
		};
	};
	const decorated = fn as unknown as TmuxSpawnFn & { calls: TmuxSpawnRecord[] };
	decorated.calls = calls;
	return decorated;
}

// --- runNext integration ---------------------------------------------------

describe('runNext', () => {
	test('inline mode (VS Code): writes state file + spawns claude only (no Ghostty split)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-inline-'));
		try {
			const claudeHandle = makeFakeProcess();
			const spawn = makeRecordingSpawn([claudeHandle]);
			queueMicrotask(() => claudeHandle.exitedResolve(0));

			const code = await runNext({
				cwd: dir,
				hostMode: 'inline',
				permissionMode: 'bypassPermissions',
				spawn,
				startedAt: '2026-04-28T22:00:00Z',
				sessionId: 'sess-xyz',
			});

			expect(code).toBe(0);
			expect(spawn.calls.length).toBe(1);
			expect(spawn.calls[0]!.cmd).toEqual([
				'claude',
				'--permission-mode',
				'bypassPermissions',
				'/cam-next',
			]);
			expect(spawn.calls[0]!.cwd).toBe(dir);

			// State file was pre-armed with default max=30, promise=COMPLETE.
			const statePath = join(dir, '.claude', 'cam-loop.local.md');
			expect(existsSync(statePath)).toBe(true);
			const body = readFileSync(statePath, 'utf8');
			expect(body).toContain('max_iterations: 30');
			expect(body).toContain('completion_promise: "COMPLETE"');
			expect(body).toContain('session_id: sess-xyz');
			expect(body).toContain('started_at: "2026-04-28T22:00:00Z"');
			expect(body.trimEnd().endsWith('/cam-next')).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('tmux-split: ensures project session then opens claude as a pane (thin launcher)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-tmux-inside-'));
		try {
			// In tmux-split mode, runNext returns 0 immediately (no async claude spawn).
			const spawn = makeRecordingSpawn([]); // no async spawns expected
			const tmuxSpawnFake = makeTmuxSpawnFake();

			const code = await runNext({
				cwd: dir,
				hostMode: 'tmux-split',
				permissionMode: 'bypassPermissions',
				spawn,
				tmuxSpawnFn: tmuxSpawnFake,
				startedAt: '2026-04-28T22:00:00Z',
				sessionId: '',
			});

			// Thin launcher returns 0 immediately.
			expect(code).toBe(0);
			// No async (claude) spawns — claude lives in the session pane.
			expect(spawn.calls.length).toBe(0);

			const sessionName = projectSessionName(dir);

			// ensureProjectSession: has-session probe + new-session + 2x split-window.
			const hasSessionCall = tmuxSpawnFake.calls.find(
				(c) => c.cmd === 'tmux' && c.args[0] === 'has-session',
			);
			expect(hasSessionCall).toBeDefined();
			expect(hasSessionCall?.args).toContain(sessionName);

			const newSessionCall = tmuxSpawnFake.calls.find(
				(c) => c.cmd === 'tmux' && c.args[0] === 'new-session',
			);
			expect(newSessionCall).toBeDefined();
			expect(newSessionCall?.args).toContain(sessionName);

			// openPaneInSession: split-window -t <sessionName>:0 -v -d -- <arg0> <arg1> ...
			// Each claude argv element is a discrete arg (not one joined shell string).
			const splitCalls = tmuxSpawnFake.calls.filter(
				(c) => c.cmd === 'tmux' && c.args[0] === 'split-window',
			);
			// At least one split-window call opens the claude pane.
			const claudePaneCall = splitCalls.find(
				(c) => c.args.some((a) => a === 'claude'),
			);
			expect(claudePaneCall).toBeDefined();
			// Each argv element is discrete; no joined string.
			expect(claudePaneCall?.args).toContain('claude');
			expect(claudePaneCall?.args).toContain('--permission-mode');
			expect(claudePaneCall?.args).toContain('bypassPermissions');
			expect(claudePaneCall?.args).toContain('/cam-next');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('overrides --max-iter and --completion-promise via options', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-overrides-'));
		try {
			const claudeHandle = makeFakeProcess();
			const spawn = makeRecordingSpawn([claudeHandle]);
			queueMicrotask(() => claudeHandle.exitedResolve(0));

			const code = await runNext({
				cwd: dir,
				hostMode: 'inline',
				permissionMode: 'bypassPermissions',
				spawn,
				maxIterations: 5,
				completionPromise: 'DONE',
				startedAt: '2026-04-28T22:00:00Z',
				sessionId: '',
			});

			expect(code).toBe(0);
			const body = readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8');
			expect(body).toContain('max_iterations: 5');
			expect(body).toContain('completion_promise: "DONE"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns non-zero when state file already exists (no force)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-existing-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'old\n');
			const claudeHandle = makeFakeProcess();
			const spawn = makeRecordingSpawn([claudeHandle]);

			const code = await runNext({
				cwd: dir,
				hostMode: 'inline',
				permissionMode: 'bypassPermissions',
				spawn,
				startedAt: '2026-04-28T22:00:00Z',
				sessionId: '',
			});

			// Pre-arm failed → exit 1, claude never spawned.
			expect(code).toBe(1);
			expect(spawn.calls.length).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('forwards permission_mode override into claude argv', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-mode-'));
		try {
			const claudeHandle = makeFakeProcess();
			const spawn = makeRecordingSpawn([claudeHandle]);
			queueMicrotask(() => claudeHandle.exitedResolve(0));

			await runNext({
				cwd: dir,
				hostMode: 'inline',
				permissionMode: 'acceptEdits',
				spawn,
				startedAt: '2026-04-28T22:00:00Z',
				sessionId: '',
			});

			expect(spawn.calls[0]!.cmd).toEqual([
				'claude',
				'--permission-mode',
				'acceptEdits',
				'/cam-next',
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('materializes stop hook and writes settings.local.json before state file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-hooks-'));
		try {
			const claudeHandle = makeFakeProcess();
			const spawn = makeRecordingSpawn([claudeHandle]);
			queueMicrotask(() => claudeHandle.exitedResolve(0));

			const hookPaths: string[] = [];
			const settingsPaths: string[] = [];

			const code = await runNext({
				cwd: dir,
				hostMode: 'inline',
				permissionMode: 'bypassPermissions',
				spawn,
				startedAt: '2026-04-28T22:00:00Z',
				sessionId: '',
				hookMaterializer: (cwd2) => {
					const p = join(cwd2, STOP_HOOK_RELATIVE);
					hookPaths.push(p);
					return p;
				},
				settingsWriter: (cwd2) => {
					const p = join(cwd2, SETTINGS_LOCAL_RELATIVE);
					settingsPaths.push(p);
					return p;
				},
			});

			expect(code).toBe(0);
			// Both injected before claude spawns (spawn.calls.length === 1 means claude was called)
			expect(hookPaths).toHaveLength(1);
			expect(settingsPaths).toHaveLength(1);
			expect(hookPaths[0]).toBe(join(dir, STOP_HOOK_RELATIVE));
			expect(settingsPaths[0]).toBe(join(dir, SETTINGS_LOCAL_RELATIVE));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns 1 when hook materialization fails', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-hook-fail-'));
		try {
			const spawn = makeRecordingSpawn([]);

			const code = await runNext({
				cwd: dir,
				hostMode: 'inline',
				permissionMode: 'bypassPermissions',
				spawn,
				startedAt: '2026-04-28T22:00:00Z',
				sessionId: '',
				hookMaterializer: () => {
					throw new Error('permission denied');
				},
			});

			expect(code).toBe(1);
			expect(spawn.calls.length).toBe(0); // claude never spawned
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns 1 when settings.local.json write fails', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-settings-fail-'));
		try {
			const spawn = makeRecordingSpawn([]);

			const code = await runNext({
				cwd: dir,
				hostMode: 'inline',
				permissionMode: 'bypassPermissions',
				spawn,
				startedAt: '2026-04-28T22:00:00Z',
				sessionId: '',
				hookMaterializer: (cwd2) => join(cwd2, STOP_HOOK_RELATIVE),
				settingsWriter: () => {
					throw new Error('disk full');
				},
			});

			expect(code).toBe(1);
			expect(spawn.calls.length).toBe(0); // claude never spawned
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('tmux-split: returns 1 on tmux failure without claiming a fallback', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-tmux-fail-'));
		try {
			const spawn = makeRecordingSpawn([]); // no async spawns expected

			// A tmuxSpawnFn that throws on the first tmux call (simulates tmux failure).
			const throwingTmuxSpawn = ((_cmd: string, _args: string[]) => {
				throw new Error('tmux: command failed');
			}) as unknown as TmuxSpawnFn;

			const chunks: string[] = [];
			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = ((chunk: string | Uint8Array) => {
				chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
				return true;
			}) as typeof process.stdout.write;

			let code: number;
			try {
				code = await runNext({
					cwd: dir,
					hostMode: 'tmux-split',
					permissionMode: 'bypassPermissions',
					spawn,
					tmuxSpawnFn: throwingTmuxSpawn,
					startedAt: '2026-04-28T22:00:00Z',
					sessionId: '',
				});
			} finally {
				process.stdout.write = originalWrite;
			}

			const output = chunks.join('');

			// Must return 1 — the launch failed.
			expect(code).toBe(1);
			// No async claude spawns occurred.
			expect(spawn.calls.length).toBe(0);
			// Must NOT claim a fallback that did not happen.
			expect(output).not.toContain('Falling back to inline mode');
			// Must NOT claim success when the launch failed.
			expect(output).not.toContain('Launched claude in project session');
			// Must report the real failure.
			expect(output).toContain('tmux session pane launch failed');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- materializeStopHook ---------------------------------------------------

describe('materializeStopHook', () => {
	test('writes hook file and makes it executable', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-hook-mat-'));
		try {
			const fakeContents = '#!/bin/bash\necho "fake hook"\n';
			const written = materializeStopHook(dir, () => fakeContents);
			expect(written).toBe(join(dir, STOP_HOOK_RELATIVE));
			expect(existsSync(written)).toBe(true);
			expect(readFileSync(written, 'utf8')).toBe(fakeContents);
			// Verify it's executable (owner execute bit)
			const { statSync } = require('node:fs') as typeof import('node:fs');
			const mode = statSync(written).mode;
			expect(mode & 0o100).toBeTruthy(); // owner execute bit set
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('creates .claude/hooks/ directory when missing', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-hook-mkdir-'));
		try {
			materializeStopHook(dir, () => '#!/bin/bash\n');
			expect(existsSync(join(dir, '.claude', 'hooks'))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- writeSettingsLocal ----------------------------------------------------

describe('writeSettingsLocal', () => {
	test('creates settings.local.json with Stop hook when file does not exist', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-settings-new-'));
		try {
			const written = writeSettingsLocal(dir, () => null);
			expect(existsSync(written)).toBe(true);
			const parsed = JSON.parse(readFileSync(written, 'utf8'));
			expect(parsed.hooks?.Stop).toBeDefined();
			expect(parsed.hooks.Stop[0]?.hooks[0]?.type).toBe('command');
			expect(parsed.hooks.Stop[0]?.hooks[0]?.command).toContain('cam-loop-stop.sh');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('deep-merges with existing settings.local.json (existing keys preserved)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-settings-merge-'));
		try {
			const existing = JSON.stringify({
				permissions: { allow: ['Bash(*)', 'Edit'] },
				customKey: 42,
			});
			const written = writeSettingsLocal(dir, () => existing);
			const parsed = JSON.parse(readFileSync(written, 'utf8'));
			// Existing keys preserved
			expect(parsed.permissions?.allow).toEqual(['Bash(*)', 'Edit']);
			expect(parsed.customKey).toBe(42);
			// Stop hook added
			expect(parsed.hooks?.Stop).toBeDefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('handles malformed existing JSON gracefully (starts fresh)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-settings-bad-json-'));
		try {
			const written = writeSettingsLocal(dir, () => '{ not valid json');
			const parsed = JSON.parse(readFileSync(written, 'utf8'));
			expect(parsed.hooks?.Stop).toBeDefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('creates .claude/ directory when missing', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-settings-mkdir-'));
		try {
			writeSettingsLocal(dir, () => null);
			expect(existsSync(join(dir, '.claude'))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- deepMerge -------------------------------------------------------------

describe('deepMerge', () => {
	test('shallow merge: source keys overwrite target keys', () => {
		const result = deepMerge({ a: 1, b: 2 }, { b: 99, c: 3 });
		expect(result).toEqual({ a: 1, b: 99, c: 3 });
	});

	test('deep merge: nested objects are recursively merged', () => {
		const result = deepMerge(
			{ hooks: { PreToolUse: ['existing'] } },
			{ hooks: { Stop: ['new'] } },
		);
		expect(result).toEqual({ hooks: { PreToolUse: ['existing'], Stop: ['new'] } });
	});

	test('arrays are replaced, not concatenated', () => {
		const result = deepMerge({ items: [1, 2, 3] }, { items: [4, 5] });
		expect(result).toEqual({ items: [4, 5] });
	});

	test('null values overwrite', () => {
		const result = deepMerge({ a: 'original' }, { a: null });
		expect(result).toEqual({ a: null });
	});
});
