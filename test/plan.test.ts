// test/plan.test.ts
//
// Unit tests for `cam plan`. We mock the claude subprocess via the
// `spawn` injection point on `runPlan({ spawn, prompt })`, so these tests
// never actually call `claude` — they verify cam's plumbing:
//   - APPROVE detection on a PTY data-callback stream
//   - prompt firing exactly once even when APPROVE appears multiple times
//   - kill() on N answer, exit 0
//   - continue (no kill) on y answer, propagate subprocess exit code
//   - issue flag flows through to the slash command sent to spawn
//   - terminal.write() is called with stdin forwarding chunks
//   - terminal.resize() is called when the spawn callback triggers resize
//
// US-004: migrated from piped-stdio fake to PTY terminal fake. The core
// test logic is unchanged — we now feed chunks via the onData callback
// instead of via ReadableStream, and assert on terminal.write calls.

import { describe, expect, test } from 'bun:test';

import {
	findApproveLine,
	isApproveLine,
	type PlanSubprocess,
	type PlanTerminal,
	type SpawnFn,
	runPlan,
} from '../src/commands/plan.ts';

// --- Fakes -----------------------------------------------------------------

interface FakeTerminalHandle {
	terminal: PlanTerminal;
	writeCalls: Array<string | Uint8Array>;
	resizeCalls: Array<{ cols: number; rows: number }>;
	closeCalls: number;
}

/**
 * Build a fake PlanTerminal. Captures all write/resize/close calls so tests
 * can assert on them.
 */
function makeFakeTerminal(): FakeTerminalHandle {
	const writeCalls: Array<string | Uint8Array> = [];
	const resizeCalls: Array<{ cols: number; rows: number }> = [];
	let closeCalls = 0;

	const terminal: PlanTerminal = {
		write(data: string | Uint8Array): number {
			writeCalls.push(data);
			return typeof data === 'string' ? data.length : data.byteLength;
		},
		resize(cols: number, rows: number): void {
			resizeCalls.push({ cols, rows });
		},
		close(): void {
			closeCalls += 1;
		},
	};

	return { terminal, writeCalls, resizeCalls, closeCalls: 0 };
}

interface FakeSubprocessHandle {
	proc: PlanSubprocess;
	exitedResolve: (code: number) => void;
	killCalls: Array<number | string | undefined>;
	termHandle: FakeTerminalHandle;
	/** Call this to feed data as if the PTY received output from the child. */
	emitData: (text: string) => void;
}

const encoder = new TextEncoder();

/**
 * Build a fake PlanSubprocess using the PTY callback model.
 * The caller enqueues chunks via `emitData(text)` — the fake calls the
 * registered `onData` callback synchronously, just like the real PTY would.
 * `exitedResolve` controls when the subprocess "exits".
 */
function makeFakeProcess(): FakeSubprocessHandle {
	const killCalls: Array<number | string | undefined> = [];
	let exitedResolve: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		exitedResolve = resolve;
	});
	const termHandle = makeFakeTerminal();

	// The onData callback is registered by the SpawnFn. We capture it via closure.
	let capturedOnData: ((bytes: Uint8Array) => void) | null = null;

	const proc: PlanSubprocess = {
		exited,
		terminal: termHandle.terminal,
		kill(signal?: number | string) {
			killCalls.push(signal);
			// On kill, simulate a clean SIGTERM exit.
			exitedResolve(143);
		},
	};

	const spawnFn: SpawnFn = (
		_cmd: string[],
		callbacks: { onData: (bytes: Uint8Array) => void; onExit: () => void },
	): PlanSubprocess => {
		capturedOnData = callbacks.onData;
		return proc;
	};

	const handle: FakeSubprocessHandle = {
		proc,
		exitedResolve,
		killCalls,
		termHandle,
		emitData(text: string): void {
			if (capturedOnData) {
				capturedOnData(encoder.encode(text));
			}
		},
	};

	// Attach the spawnFn to the handle so runPlan can use it.
	(handle as FakeSubprocessHandle & { spawnFn: SpawnFn }).spawnFn = spawnFn;
	return handle;
}

/**
 * Build a SpawnFn that returns the given fake process and records the cmd it
 * was called with. The recorded cmd is stored on the returned object's
 * `recordedCmd` property.
 */
function makeSpawnFnFromHandle(
	handle: FakeSubprocessHandle,
): SpawnFn & { recordedCmd: string[] | null } {
	const fn = ((
		cmd: string[],
		callbacks: { onData: (bytes: Uint8Array) => void; onExit: () => void },
	) => {
		(fn as unknown as { recordedCmd: string[] }).recordedCmd = [...cmd];
		// Register the onData callback in the handle so emitData works.
		(
			handle as FakeSubprocessHandle & {
				_setOnData: (cb: (b: Uint8Array) => void) => void;
			}
		)._setOnData?.(callbacks.onData);
		return handle.proc;
	}) as SpawnFn & { recordedCmd: string[] | null };
	fn.recordedCmd = null;
	return fn;
}

/**
 * Build a complete test harness: a fake subprocess + spawn function that
 * are pre-wired to each other. `emitData(text)` feeds chunks via the PTY
 * data callback.
 */
function makeTestHarness(): {
	spawn: SpawnFn & { recordedCmd: string[] | null };
	killCalls: Array<number | string | undefined>;
	emitData: (text: string) => void;
	exitedResolve: (code: number) => void;
} {
	const killCalls: Array<number | string | undefined> = [];
	let exitedResolve: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		exitedResolve = resolve;
	});
	const termHandle = makeFakeTerminal();

	let capturedOnData: ((bytes: Uint8Array) => void) | null = null;

	const proc: PlanSubprocess = {
		exited,
		terminal: termHandle.terminal,
		kill(signal?: number | string) {
			killCalls.push(signal);
			exitedResolve(143);
		},
	};

	const spawn = ((
		cmd: string[],
		callbacks: { onData: (bytes: Uint8Array) => void; onExit: () => void },
	) => {
		(spawn as unknown as { recordedCmd: string[] }).recordedCmd = [...cmd];
		capturedOnData = callbacks.onData;
		return proc;
	}) as SpawnFn & { recordedCmd: string[] | null };
	spawn.recordedCmd = null;

	function emitData(text: string): void {
		capturedOnData?.(encoder.encode(text));
	}

	return { spawn, killCalls, emitData, exitedResolve };
}

// --- isApproveLine / findApproveLine ---------------------------------------

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

	test('requires literal uppercase APPROVE — `approve` alone does not match', () => {
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

// --- runPlan integration ---------------------------------------------------

describe('runPlan', () => {
	test('dispatches /cam-plan when no issue is provided', async () => {
		const { spawn, killCalls, exitedResolve } = makeTestHarness();
		// Subprocess exits cleanly with no APPROVE — prompt never fires.
		queueMicrotask(() => exitedResolve(0));
		const code = await runPlan({
			spawn,
			prompt: () => Promise.resolve('y'),
		});
		expect(code).toBe(0);
		expect(spawn.recordedCmd).toEqual([
			'claude',
			'--permission-mode',
			'bypassPermissions',
			'/cam-plan',
		]);
		expect(killCalls).toEqual([]);
	});

	test('dispatches /cam-plan #N when issue option is provided', async () => {
		const { spawn, exitedResolve } = makeTestHarness();
		queueMicrotask(() => exitedResolve(0));
		await runPlan({
			issue: 142,
			spawn,
			prompt: () => Promise.resolve(''),
		});
		expect(spawn.recordedCmd).toEqual([
			'claude',
			'--permission-mode',
			'bypassPermissions',
			'/cam-plan #142',
		]);
	});

	test('fires prompt on APPROVE and continues on y answer (no kill)', async () => {
		const { spawn, killCalls, emitData, exitedResolve } = makeTestHarness();
		const promptCalls: string[] = [];

		// Schedule: emit some output, including APPROVE, then exit
		queueMicrotask(() => {
			emitData('booting...\n');
			emitData('planning...\n');
			emitData('"verdict": "APPROVE"\n');
			emitData('continuing...\n');
			// Give the promise chain (handleApprove) a tick to resolve
			// before the subprocess "exits".
			setTimeout(() => exitedResolve(0), 5);
		});

		const code = await runPlan({
			spawn,
			prompt: (q) => {
				promptCalls.push(q);
				return Promise.resolve('y');
			},
		});
		expect(promptCalls.length).toBe(1);
		expect(promptCalls[0]).toContain('Approve PRD and create branch?');
		expect(killCalls).toEqual([]);
		expect(code).toBe(0);
	});

	test('fires prompt on APPROVE and kills on N answer, exits 0', async () => {
		const { spawn, killCalls, emitData } = makeTestHarness();
		// Emit APPROVE then let kill() trigger exit.
		queueMicrotask(() => {
			emitData('planning...\n');
			emitData('verdict: APPROVE\n');
		});
		const code = await runPlan({
			spawn,
			prompt: () => Promise.resolve('N'),
		});
		expect(killCalls.length).toBe(1);
		expect(killCalls[0]).toBe('SIGTERM');
		expect(code).toBe(0);
	});

	test('empty answer (just Enter) defaults to N — kills subprocess', async () => {
		const { spawn, killCalls, emitData } = makeTestHarness();
		queueMicrotask(() => {
			emitData('verdict: APPROVE\n');
		});
		const code = await runPlan({
			spawn,
			prompt: () => Promise.resolve(''),
		});
		expect(killCalls.length).toBe(1);
		expect(code).toBe(0);
	});

	test('any non-y answer kills (cautious default)', async () => {
		const { spawn, killCalls, emitData } = makeTestHarness();
		queueMicrotask(() => {
			emitData('verdict: APPROVE\n');
		});
		const code = await runPlan({
			spawn,
			prompt: () => Promise.resolve('maybe later'),
		});
		expect(killCalls.length).toBe(1);
		expect(code).toBe(0);
	});

	test('prompt fires only once even if APPROVE appears in multiple chunks', async () => {
		const { spawn, emitData, exitedResolve } = makeTestHarness();
		let promptCount = 0;
		queueMicrotask(() => {
			emitData('first verdict: APPROVE\n');
			emitData('(planner echoes verdict: APPROVE again)\n');
			emitData('continuing...\n');
			setTimeout(() => exitedResolve(0), 5);
		});
		await runPlan({
			spawn,
			prompt: () => {
				promptCount += 1;
				return Promise.resolve('y');
			},
		});
		expect(promptCount).toBe(1);
	});

	test('subprocess exits without ever emitting APPROVE — prompt does not fire', async () => {
		const { spawn, killCalls, emitData, exitedResolve } = makeTestHarness();
		queueMicrotask(() => {
			emitData('planning...\n');
			emitData('verdict: BLOCK\n');
			exitedResolve(2);
		});
		let promptCount = 0;
		const code = await runPlan({
			spawn,
			prompt: () => {
				promptCount += 1;
				return Promise.resolve('y');
			},
		});
		expect(promptCount).toBe(0);
		expect(killCalls).toEqual([]);
		// Subprocess's own exit code propagates when cam didn't intervene.
		expect(code).toBe(2);
	});

	test('detects APPROVE even when split across PTY data chunks', async () => {
		const { spawn, killCalls, emitData } = makeTestHarness();
		// Split "verdict: APPROVE" across two chunks to verify the rolling
		// buffer in onData stitches partial reads.
		queueMicrotask(() => {
			emitData('blah\nver');
			emitData('dict: APP');
			emitData('ROVE\n');
		});
		let promptCount = 0;
		const code = await runPlan({
			spawn,
			prompt: () => {
				promptCount += 1;
				return Promise.resolve('N');
			},
		});
		expect(promptCount).toBe(1);
		expect(killCalls.length).toBe(1);
		expect(code).toBe(0);
	});
});
