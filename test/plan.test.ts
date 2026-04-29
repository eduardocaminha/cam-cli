// test/plan.test.ts
//
// Unit tests for `ralph plan`. We mock the claude subprocess via the
// `spawn` injection point on `runPlan({ spawn, prompt })`, so these tests
// never actually call `claude` — they verify ralph's plumbing:
//   - APPROVE detection on a streamed stdout line
//   - prompt firing exactly once even when APPROVE appears multiple times
//   - kill() on N answer, exit 0
//   - continue (no kill) on y answer, propagate subprocess exit code
//   - issue flag flows through to the slash command sent to spawn

import { describe, expect, test } from 'bun:test';

import {
	findApproveLine,
	isApproveLine,
	type PlanSubprocess,
	type SpawnFn,
	runPlan,
} from '../src/commands/plan.ts';

// --- Fakes -----------------------------------------------------------------

/**
 * Build a ReadableStream<Uint8Array> that emits a fixed list of string chunks.
 * Each chunk is encoded UTF-8 and enqueued in order, then the stream closes.
 * Used to script claude's stdout deterministically in tests.
 */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunks[i]!));
			i += 1;
		},
	});
}

interface FakeSubprocessHandle {
	proc: PlanSubprocess;
	exitedResolve: (code: number) => void;
	killCalls: Array<number | string | undefined>;
}

/**
 * Build a fake PlanSubprocess. The caller passes scripted stdout/stderr
 * chunks; the returned handle exposes `exitedResolve()` to control when the
 * subprocess "exits" and `killCalls` to assert kill behavior.
 */
function makeFakeProcess(opts: {
	stdoutChunks?: string[];
	stderrChunks?: string[];
}): FakeSubprocessHandle {
	const killCalls: Array<number | string | undefined> = [];
	let exitedResolve: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		exitedResolve = resolve;
	});
	const proc: PlanSubprocess = {
		stdout: streamFromChunks(opts.stdoutChunks ?? []),
		stderr: streamFromChunks(opts.stderrChunks ?? []),
		exited,
		kill(signal?: number | string) {
			killCalls.push(signal);
			// On kill, simulate a clean SIGTERM exit.
			exitedResolve(143);
		},
	};
	return { proc, exitedResolve, killCalls };
}

/**
 * Build a SpawnFn that returns the given fake process and records the cmd it
 * was called with. The recorded cmd is stored on the returned object's
 * `recordedCmd` property.
 */
function makeSpawnFn(handle: FakeSubprocessHandle): SpawnFn & { recordedCmd: string[] | null } {
	const fn = ((cmd: string[]) => {
		(fn as unknown as { recordedCmd: string[] }).recordedCmd = [...cmd];
		return handle.proc;
	}) as SpawnFn & { recordedCmd: string[] | null };
	fn.recordedCmd = null;
	return fn;
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
	test('dispatches /ralph-plan when no issue is provided', async () => {
		const handle = makeFakeProcess({ stdoutChunks: [] });
		const spawn = makeSpawnFn(handle);
		// Subprocess exits cleanly with no APPROVE — prompt never fires.
		queueMicrotask(() => handle.exitedResolve(0));
		const code = await runPlan({
			spawn,
			prompt: () => Promise.resolve('y'),
		});
		expect(code).toBe(0);
		expect(spawn.recordedCmd).toEqual([
			'claude',
			'--permission-mode',
			'bypassPermissions',
			'/ralph-plan',
		]);
		expect(handle.killCalls).toEqual([]);
	});

	test('dispatches /ralph-plan #N when issue option is provided', async () => {
		const handle = makeFakeProcess({ stdoutChunks: [] });
		const spawn = makeSpawnFn(handle);
		queueMicrotask(() => handle.exitedResolve(0));
		await runPlan({
			issue: 142,
			spawn,
			prompt: () => Promise.resolve(''),
		});
		expect(spawn.recordedCmd).toEqual([
			'claude',
			'--permission-mode',
			'bypassPermissions',
			'/ralph-plan #142',
		]);
	});

	test('fires prompt on APPROVE and continues on y answer (no kill)', async () => {
		const handle = makeFakeProcess({
			stdoutChunks: ['booting...\n', 'planning...\n', '"verdict": "APPROVE"\n', 'continuing...\n'],
		});
		const spawn = makeSpawnFn(handle);
		const promptCalls: string[] = [];
		// On y, ralph plan should NOT kill and should propagate the
		// subprocess exit code. Schedule a clean exit shortly after the
		// stream drains.
		queueMicrotask(() => {
			// Let the stream drain + prompt handler resolve before the
			// subprocess "exits". The setTimeout(0) gives the tee loop a tick.
			setTimeout(() => handle.exitedResolve(0), 5);
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
		expect(handle.killCalls).toEqual([]);
		expect(code).toBe(0);
	});

	test('fires prompt on APPROVE and kills on N answer, exits 0', async () => {
		const handle = makeFakeProcess({
			stdoutChunks: ['planning...\n', 'verdict: APPROVE\n'],
		});
		const spawn = makeSpawnFn(handle);
		const code = await runPlan({
			spawn,
			prompt: () => Promise.resolve('N'),
		});
		expect(handle.killCalls.length).toBe(1);
		expect(handle.killCalls[0]).toBe('SIGTERM');
		expect(code).toBe(0);
	});

	test('empty answer (just Enter) defaults to N — kills subprocess', async () => {
		const handle = makeFakeProcess({
			stdoutChunks: ['verdict: APPROVE\n'],
		});
		const spawn = makeSpawnFn(handle);
		const code = await runPlan({
			spawn,
			prompt: () => Promise.resolve(''),
		});
		expect(handle.killCalls.length).toBe(1);
		expect(code).toBe(0);
	});

	test('any non-y answer kills (cautious default)', async () => {
		const handle = makeFakeProcess({
			stdoutChunks: ['verdict: APPROVE\n'],
		});
		const spawn = makeSpawnFn(handle);
		const code = await runPlan({
			spawn,
			prompt: () => Promise.resolve('maybe later'),
		});
		expect(handle.killCalls.length).toBe(1);
		expect(code).toBe(0);
	});

	test('prompt fires only once even if APPROVE appears in multiple lines', async () => {
		const handle = makeFakeProcess({
			stdoutChunks: [
				'first verdict: APPROVE\n',
				'(planner echoes verdict: APPROVE again)\n',
				'continuing...\n',
			],
		});
		const spawn = makeSpawnFn(handle);
		let promptCount = 0;
		queueMicrotask(() => {
			setTimeout(() => handle.exitedResolve(0), 5);
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
		const handle = makeFakeProcess({
			stdoutChunks: ['planning...\n', 'verdict: BLOCK\n'],
		});
		const spawn = makeSpawnFn(handle);
		queueMicrotask(() => handle.exitedResolve(2));
		let promptCount = 0;
		const code = await runPlan({
			spawn,
			prompt: () => {
				promptCount += 1;
				return Promise.resolve('y');
			},
		});
		expect(promptCount).toBe(0);
		expect(handle.killCalls).toEqual([]);
		// Subprocess's own exit code propagates when ralph didn't intervene.
		expect(code).toBe(2);
	});

	test('detects APPROVE even when split across stream chunks', async () => {
		const handle = makeFakeProcess({
			// Split "verdict: APPROVE" across two chunks to verify the
			// rolling buffer in teeAndScan stitches partial reads.
			stdoutChunks: ['blah\nver', 'dict: APP', 'ROVE\n'],
		});
		const spawn = makeSpawnFn(handle);
		let promptCount = 0;
		const code = await runPlan({
			spawn,
			prompt: () => {
				promptCount += 1;
				return Promise.resolve('N');
			},
		});
		expect(promptCount).toBe(1);
		expect(handle.killCalls.length).toBe(1);
		expect(code).toBe(0);
	});
});
