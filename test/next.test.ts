// test/next.test.ts
//
// Unit tests for `ralph next`. We mock both the spawn factory and the
// state-file writer via the injection points on `runNext({ spawn, writer })`,
// so these tests never call `claude`, never invoke `ghostty`, and never
// touch the real filesystem outside the bun-test tmpdir.
//
// What we cover (mapping to US-007 acceptance criteria 5+6):
//   - default `--max-iterations 30 --completion-promise "COMPLETE"` flow
//   - overrides apply (`maxIterations`, `completionPromise`)
//   - state file is rendered + written with the right frontmatter values
//   - Ghostty split path: pane B argv is `ghostty +new-split horizontal --
//     ralph dashboard`, pane A argv is `claude --permission-mode <mode>
//     /ralph-next` — both spawned with the same cwd
//   - VS Code path: only pane A is spawned (no Ghostty split)
//   - Inline (unknown terminal): same as VS Code — pane A only
//   - Render: completion-promise is YAML-quoted; max-iterations is a bare int

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	buildClaudeArgv,
	buildDashboardArgv,
	buildGhosttySplitArgv,
	detectHost,
	renderStateFile,
	runNext,
	writeStateFile,
	type NextSpawnFn,
	type NextSubprocess,
} from '../src/commands/next.ts';

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

// --- detectHost ------------------------------------------------------------

describe('detectHost', () => {
	test('returns "ghostty-split" when GHOSTTY_RESOURCES_DIR is set', () => {
		expect(detectHost({ GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/...' })).toBe(
			'ghostty-split',
		);
	});

	test('returns "ghostty-split" when TERM_PROGRAM=ghostty', () => {
		expect(detectHost({ TERM_PROGRAM: 'ghostty' })).toBe('ghostty-split');
	});

	test('returns "inline" when TERM_PROGRAM=vscode (overrides Ghostty env)', () => {
		// VS Code's embedded terminal can inherit GHOSTTY_RESOURCES_DIR from
		// the parent shell — we still fall back to inline because splitting
		// outside the IDE would surprise the operator.
		expect(
			detectHost({
				TERM_PROGRAM: 'vscode',
				GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/...',
			}),
		).toBe('inline');
	});

	test('returns "inline" on an unknown terminal', () => {
		expect(detectHost({})).toBe('inline');
		expect(detectHost({ TERM_PROGRAM: 'iTerm.app' })).toBe('inline');
	});
});

// --- renderStateFile -------------------------------------------------------

describe('renderStateFile', () => {
	test('substitutes all placeholders and emits YAML frontmatter + prompt body', () => {
		const out = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			prompt: '/ralph-next',
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
		expect(out.trimEnd().endsWith('/ralph-next')).toBe(true);
	});

	test('emits null for empty completion-promise', () => {
		const out = renderStateFile({
			maxIterations: 0,
			completionPromise: '',
			prompt: '/ralph-next',
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
			prompt: '/ralph-next',
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
			prompt: '/ralph-next',
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
		const dir = mkdtempSync(join(tmpdir(), 'ralph-next-write-'));
		try {
			const written = writeStateFile(dir, 'hello\n');
			expect(written).toBe(join(dir, '.claude', 'ralph-loop.local.md'));
			expect(existsSync(written)).toBe(true);
			expect(readFileSync(written, 'utf8')).toBe('hello\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('refuses to clobber an existing state file unless force=true', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ralph-next-clobber-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(join(dir, '.claude', 'ralph-loop.local.md'), 'old\n');
			expect(() => writeStateFile(dir, 'new\n')).toThrow(/already exists/);
			// With force=true, it overwrites.
			writeStateFile(dir, 'newer\n', { force: true });
			expect(readFileSync(join(dir, '.claude', 'ralph-loop.local.md'), 'utf8')).toBe(
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
			'/ralph-next',
		]);
	});

	test('buildDashboardArgv is `ralph dashboard`', () => {
		expect(buildDashboardArgv()).toEqual(['ralph', 'dashboard']);
	});

	test('buildGhosttySplitArgv puts target after `--`', () => {
		expect(buildGhosttySplitArgv(['ralph', 'dashboard'])).toEqual([
			'ghostty',
			'+new-split',
			'horizontal',
			'--',
			'ralph',
			'dashboard',
		]);
	});
});

// --- runNext integration ---------------------------------------------------

describe('runNext', () => {
	test('inline mode (VS Code): writes state file + spawns claude only (no Ghostty split)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ralph-next-inline-'));
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
				'/ralph-next',
			]);
			expect(spawn.calls[0]!.cwd).toBe(dir);

			// State file was pre-armed with default max=30, promise=COMPLETE.
			const statePath = join(dir, '.claude', 'ralph-loop.local.md');
			expect(existsSync(statePath)).toBe(true);
			const body = readFileSync(statePath, 'utf8');
			expect(body).toContain('max_iterations: 30');
			expect(body).toContain('completion_promise: "COMPLETE"');
			expect(body).toContain('session_id: sess-xyz');
			expect(body).toContain('started_at: "2026-04-28T22:00:00Z"');
			expect(body.trimEnd().endsWith('/ralph-next')).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Ghostty split: spawns ghostty +new-split first, then claude', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ralph-next-ghostty-'));
		try {
			const splitHandle = makeFakeProcess();
			const claudeHandle = makeFakeProcess();
			const spawn = makeRecordingSpawn([splitHandle, claudeHandle]);
			// Ghostty's split call returns immediately after dispatching.
			queueMicrotask(() => splitHandle.exitedResolve(0));
			// Claude exits cleanly after the operator's session ends.
			queueMicrotask(() => claudeHandle.exitedResolve(0));

			const code = await runNext({
				cwd: dir,
				hostMode: 'ghostty-split',
				permissionMode: 'bypassPermissions',
				spawn,
				startedAt: '2026-04-28T22:00:00Z',
				sessionId: '',
			});

			expect(code).toBe(0);
			expect(spawn.calls.length).toBe(2);
			// First call: pane B (dashboard) via ghostty split.
			expect(spawn.calls[0]!.cmd).toEqual([
				'ghostty',
				'+new-split',
				'horizontal',
				'--',
				'ralph',
				'dashboard',
			]);
			// Second call: pane A (claude with the loop kick-off prompt).
			expect(spawn.calls[1]!.cmd).toEqual([
				'claude',
				'--permission-mode',
				'bypassPermissions',
				'/ralph-next',
			]);
			expect(spawn.calls[0]!.cwd).toBe(dir);
			expect(spawn.calls[1]!.cwd).toBe(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('overrides --max-iter and --completion-promise via options', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ralph-next-overrides-'));
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
			const body = readFileSync(join(dir, '.claude', 'ralph-loop.local.md'), 'utf8');
			expect(body).toContain('max_iterations: 5');
			expect(body).toContain('completion_promise: "DONE"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns non-zero when state file already exists (no force)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ralph-next-existing-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(join(dir, '.claude', 'ralph-loop.local.md'), 'old\n');
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
		const dir = mkdtempSync(join(tmpdir(), 'ralph-next-mode-'));
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
				'/ralph-next',
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
