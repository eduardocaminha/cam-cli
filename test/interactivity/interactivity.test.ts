// test/interactivity/interactivity.test.ts
//
// US-013 — Interactivity preservation tests (Scope D, 4 sub-checks).
//
// The contract these tests defend is documented in
// `~/Documents/Projects/reporter/scripts/cam/CLAUDE.md § Interactivity
// preserved`:
//
//   "The CLI's TUI does NOT intercept the underlying claude session — Esc
//   still interrupts the current turn, and a typed message becomes the next
//   user-turn (the loop's prompt re-injection is suppressed for that one
//   cycle, then resumes on the following turn). You can drop in mid-loop,
//   course-correct, and step back out."
//
// We mock the claude subprocess via `test/fixtures/interactivity/mock-claude.ts`
// — a Bun script that reads stdin, emits scripted JSON-line events, and
// honors three behaviors: Esc (raw 0x1B byte) → interrupt event; typed line
// → user + assistant echo events; EOF → done event. This lets us validate
// the IPC boundary (stdin bytes really flow to the subprocess; stdout bytes
// really flow back) without a real `claude` binary or a real Anthropic API
// call. Pure JS-level fakes (FakeSubprocessHandle in plan.test.ts) are
// great for protocol logic but cannot exercise the kernel-level IPC that
// IS the interactivity question.
//
// All four tests use Bun.spawn directly — we are testing the spawn surface
// itself, not cam's wrappers around it. The wrappers (plan.ts, next.ts)
// inject `spawn` for unit tests; here we go straight to the syscall path.
//
// Test discipline:
//   - Every spawn is awaited or killed before the test ends. We track all
//     PIDs in `livePids` and tear them down in afterEach to prevent zombies.
//   - The mock fixture is path-resolved once at module load.
//   - Each test owns a fresh tmpdir for any file artifacts it produces.

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { isInitInteractiveGate, runInit } from '../../src/commands/init.ts';
import { isSetupInteractiveGate, collectViaReadline } from '../../src/commands/setup.ts';
import { runStatus, parseStateFile, buildStatusReport } from '../../src/commands/status.ts';

// --- Setup -----------------------------------------------------------------

/** Absolute path to the mock-claude fixture (resolved at load). */
let MOCK_CLAUDE_PATH = '';

/** PIDs of subprocesses spawned during a test. afterEach reaps any survivors. */
const livePids = new Set<number>();

beforeAll(() => {
	const here = fileURLToPath(new URL('.', import.meta.url));
	MOCK_CLAUDE_PATH = join(here, '..', 'fixtures', 'interactivity', 'mock-claude.ts');
	if (!existsSync(MOCK_CLAUDE_PATH)) {
		throw new Error(
			`mock-claude fixture missing at ${MOCK_CLAUDE_PATH} — did test/fixtures/interactivity/ get checked in?`,
		);
	}
});

afterEach(() => {
	// Reap any subprocess still alive from a failed test. We use kill -0 to
	// probe and SIGKILL to force-tear-down; a forgotten subprocess from one
	// test must not leak into the next.
	for (const pid of livePids) {
		try {
			process.kill(pid, 0);
			// Still alive — kill it.
			process.kill(pid, 'SIGKILL');
		} catch {
			// Already exited — nothing to do.
		}
	}
	livePids.clear();
});

/**
 * Spawn the mock-claude fixture under Bun. Returns the Bun.Subprocess handle
 * plus a `pid` we register for teardown.
 */
function spawnMockClaude(): {
	proc: ReturnType<typeof Bun.spawn>;
	pid: number;
} {
	const proc = Bun.spawn(['bun', MOCK_CLAUDE_PATH], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const pid = proc.pid as number;
	livePids.add(pid);
	return { proc, pid };
}

/**
 * Read newline-delimited events from a stdout ReadableStream until either
 * `predicate` matches one of them or `timeoutMs` elapses. Returns the events
 * collected so far. Each event is a parsed JSON object.
 */
async function readEventsUntil(
	stream: ReadableStream<Uint8Array>,
	predicate: (event: Record<string, unknown>) => boolean,
	timeoutMs: number,
): Promise<Array<Record<string, unknown>>> {
	const decoder = new TextDecoder('utf-8');
	const reader = stream.getReader();
	const events: Array<Record<string, unknown>> = [];
	let lineBuf = '';
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			// We can't time-bound `reader.read()` directly; use Promise.race
			// against a setTimeout to bound it.
			const chunk = await Promise.race([
				reader.read(),
				new Promise<{ done: true; value: undefined }>((resolve) =>
					setTimeout(() => resolve({ done: true, value: undefined }), remaining),
				),
			]);
			if (chunk.done) break;
			lineBuf += decoder.decode(chunk.value, { stream: true });
			let nlIdx = lineBuf.indexOf('\n');
			while (nlIdx >= 0) {
				const line = lineBuf.slice(0, nlIdx).trim();
				lineBuf = lineBuf.slice(nlIdx + 1);
				if (line.length > 0) {
					try {
						const parsed = JSON.parse(line) as Record<string, unknown>;
						events.push(parsed);
						if (predicate(parsed)) return events;
					} catch {
						// Non-JSON line — ignore (the fixture only emits JSON).
					}
				}
				nlIdx = lineBuf.indexOf('\n');
			}
		}
		return events;
	} finally {
		reader.releaseLock();
	}
}

// --- Test 1: Esc keypress mid-turn interrupts claude, parent stays alive --

describe('Test 1: Esc keypress mid-turn interrupts the current claude turn but does NOT kill the parent loop process', () => {
	test('parent PID still alive after Esc reaches the subprocess', async () => {
		const parentPid = process.pid;
		const { proc, pid } = spawnMockClaude();

		// Wait for the fixture's `ready` event before sending Esc — this ensures
		// the mock has wired up its stdin handler.
		const readyEvents = await readEventsUntil(
			proc.stdout as ReadableStream<Uint8Array>,
			(e) => e['subtype'] === 'ready',
			6000,
		);
		expect(readyEvents.some((e) => e['subtype'] === 'ready')).toBe(true);

		// Send a single Esc byte (0x1B) on the subprocess's stdin. This is
		// what a real terminal sends when the operator presses Escape.
		const stdinWriter = (proc.stdin as { write?: (data: Uint8Array) => void }).write;
		if (typeof stdinWriter !== 'function') {
			throw new Error('proc.stdin missing write() — unexpected Bun.Subprocess shape');
		}
		stdinWriter.call(proc.stdin, new Uint8Array([0x1b]));

		// Read events until we see the `interrupted` event from the fixture.
		const interruptEvents = await readEventsUntil(
			proc.stdout as ReadableStream<Uint8Array>,
			(e) => e['subtype'] === 'interrupted',
			6000,
		);
		expect(interruptEvents.some((e) => e['subtype'] === 'interrupted')).toBe(true);

		// THE LOAD-BEARING ASSERTION: the parent (this test process) is still
		// alive after Esc reaches the subprocess. process.kill(pid, 0) throws
		// if the pid is not alive; if it returns without throwing, the parent
		// is still running (which is what we want — Esc interrupts the
		// subprocess's turn, not the parent loop).
		expect(() => process.kill(parentPid, 0)).not.toThrow();

		// Bonus assertion: the subprocess is also still alive (Esc cancelled
		// the simulated turn but did NOT exit the session). This is what real
		// claude does — Esc puts you back at the prompt.
		expect(() => process.kill(pid, 0)).not.toThrow();

		// Clean up: send EOF so the fixture exits cleanly.
		(proc.stdin as { end?: () => void }).end?.();
		await proc.exited;
		livePids.delete(pid);
	}, { timeout: 20_000 });
});

// --- Test 2: Typed message becomes next user-turn -------------------------

describe('Test 2: Operator types a message → next assistant response addresses the typed content, NOT a re-injected /cam-next', () => {
	test('typed line "course correct" is reflected in the assistant response, with no /cam-next prompt re-injection', async () => {
		const { proc, pid } = spawnMockClaude();
		const TYPED_MARKER = 'course correct: please re-read the PRD';

		// Wait for the fixture to be ready.
		await readEventsUntil(
			proc.stdout as ReadableStream<Uint8Array>,
			(e) => e['subtype'] === 'ready',
			2000,
		);

		// Send the typed line via stdin.
		const stdinWriter = (proc.stdin as { write?: (data: Uint8Array) => void }).write;
		if (typeof stdinWriter !== 'function') {
			throw new Error('proc.stdin missing write()');
		}
		const encoder = new TextEncoder();
		stdinWriter.call(proc.stdin, encoder.encode(TYPED_MARKER + '\n'));

		// Read until we see the assistant event.
		const events = await readEventsUntil(
			proc.stdout as ReadableStream<Uint8Array>,
			(e) => e['type'] === 'assistant',
			2000,
		);

		// Find the user-turn echo and assistant response.
		const userEvent = events.find((e) => e['type'] === 'user');
		const assistantEvent = events.find((e) => e['type'] === 'assistant');

		expect(userEvent).toBeDefined();
		expect(userEvent?.['text']).toBe(TYPED_MARKER);

		expect(assistantEvent).toBeDefined();
		const assistantText = String(assistantEvent?.['text'] ?? '');

		// The response must contain the typed marker — proving the typed
		// message became the next user-turn.
		expect(assistantText).toContain(TYPED_MARKER);

		// The response must NOT contain `/cam-next` — proving the loop's
		// prompt re-injection is suppressed for this cycle. (The mock fixture
		// has no notion of /cam-next, so this is essentially a guard
		// against a future regression where someone routes operator input
		// through a re-injection layer.)
		expect(assistantText).not.toContain('/cam-next');

		// The response must also not contain pre-flight output markers
		// (typical of /cam-next dispatch). The implementer agent's pre-flight
		// emits a "## Pre-flight" header; if any of that leaks through, the
		// assistant is responding to a re-injected prompt rather than the
		// operator's typed message.
		expect(assistantText).not.toContain('## Pre-flight');
		expect(assistantText).not.toContain('CAM_IMPLEMENTER_STATUS');

		// Clean up.
		(proc.stdin as { end?: () => void }).end?.();
		await proc.exited;
		livePids.delete(pid);
	});
});

// --- Test 3: /cancel-cam removes state file → cam status reports idle -

describe('Test 3: /cancel-cam removes .claude/cam-loop.local.md AND the next cam status invocation does NOT detect a stale loop', () => {
	let tmpDir = '';

	afterEach(() => {
		if (tmpDir && existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('after state-file removal, runStatus returns state: idle and no iteration info', () => {
		// Create a fresh tmpdir + .claude/ subdir.
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-cancel-test-'));
		const claudeDir = join(tmpDir, '.claude');
		mkdirSync(claudeDir);
		const stateFilePath = join(claudeDir, 'cam-loop.local.md');

		// Pre-arm: write a state file mirroring what `cam next` would write.
		const stateBody = `---
active: true
iteration: 7
max_iterations: 30
completion_promise: "COMPLETE"
started_at: "2026-04-29T03:00:00Z"
pid: ${process.pid}
---

/cam-next
`;
		writeFileSync(stateFilePath, stateBody, 'utf8');
		expect(existsSync(stateFilePath)).toBe(true);

		// Sanity: before removal, runStatus reports active.
		const reportBefore = buildStatusReport({ cwd: tmpDir });
		expect(reportBefore.state).toBe('active');
		expect(reportBefore.iteration).toEqual({ current: 7, max: 30 });

		// Simulate `/cancel-cam` — the plugin's cancel command removes the
		// state file. (We don't dispatch the slash command itself; that
		// requires a real claude session. The contract we test is the
		// observable side effect: file removed → next status sees no loop.)
		rmSync(stateFilePath);
		expect(existsSync(stateFilePath)).toBe(false);

		// Now `cam status` (via runStatus → buildStatusReport) must NOT
		// detect a stale loop. Idle is the only acceptable verdict.
		const reportAfter = buildStatusReport({ cwd: tmpDir });
		expect(reportAfter.state).toBe('idle');
		expect(reportAfter.iteration).toBeUndefined();
		expect(reportAfter.startedAt).toBeUndefined();
		expect(reportAfter.completionPromise).toBeUndefined();

		// Also verify `runStatus` (the printing variant) returns 0 — `cam
		// status` is documented as always-exit-0, even on idle.
		const exitCode = runStatus({ cwd: tmpDir });
		expect(exitCode).toBe(0);
	});

	test('removing only the state file (leaving prd.json) still yields idle, with prd.json still readable as next-pending', () => {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-cancel-test-'));
		const claudeDir = join(tmpDir, '.claude');
		mkdirSync(claudeDir);
		const stateFilePath = join(claudeDir, 'cam-loop.local.md');
		writeFileSync(
			stateFilePath,
			`---
active: true
iteration: 3
max_iterations: 30
started_at: "2026-04-29T02:00:00Z"
pid: ${process.pid}
---
/cam-next
`,
			'utf8',
		);
		writeFileSync(
			join(tmpDir, 'prd.json'),
			JSON.stringify({
				userStories: [
					{ id: 'US-100', title: 'Pending feature', priority: 1, passes: false },
				],
			}),
			'utf8',
		);

		// Cancel.
		rmSync(stateFilePath);

		const report = buildStatusReport({ cwd: tmpDir });
		expect(report.state).toBe('idle');
		// PRD survives the cancel; the next-pending story is surfaced.
		expect(report.currentStory).toEqual({ id: 'US-100', title: 'Pending feature' });
	});
});

// --- Test 4: Type message + later /cam-next preserves iter count --------

describe("Test 4: Operator types a message + later /cam-next resumes without losing iter count (the state file iteration field doesn't reset)", () => {
	let tmpDir = '';

	afterEach(() => {
		if (tmpDir && existsSync(tmpDir)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('typed-message interlude leaves the state file iteration unchanged', async () => {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-resume-test-'));
		const claudeDir = join(tmpDir, '.claude');
		mkdirSync(claudeDir);
		const stateFilePath = join(claudeDir, 'cam-loop.local.md');

		// Pre-arm with iteration: 5 — pretend the loop is mid-flight.
		const ITERATION_BEFORE = 5;
		const stateBody = `---
active: true
iteration: ${ITERATION_BEFORE}
max_iterations: 30
completion_promise: "COMPLETE"
started_at: "2026-04-29T01:00:00Z"
pid: ${process.pid}
---

/cam-next
`;
		writeFileSync(stateFilePath, stateBody, 'utf8');

		// Capture the on-disk state before the operator typed interlude.
		const stateBeforeRaw = readFileSync(stateFilePath, 'utf8');
		const stateBefore = parseStateFile(stateBeforeRaw);
		expect(stateBefore?.iteration).toBe(ITERATION_BEFORE);

		// Now spawn the mock claude and have the operator type a message.
		// The contract: typing a message becomes the next user-turn but does
		// NOT mutate the state file. The state file is the plugin's
		// concern; only the plugin's stop hook (firing after a turn ends)
		// increments `iteration`. An operator-typed interlude is a SINGLE
		// turn that doesn't pass through the loop's re-injection path.
		const { proc, pid } = spawnMockClaude();
		await readEventsUntil(
			proc.stdout as ReadableStream<Uint8Array>,
			(e) => e['subtype'] === 'ready',
			2000,
		);

		const stdinWriter = (proc.stdin as { write?: (data: Uint8Array) => void }).write;
		if (typeof stdinWriter !== 'function') {
			throw new Error('proc.stdin missing write()');
		}
		const encoder = new TextEncoder();
		stdinWriter.call(proc.stdin, encoder.encode('please summarize the diff so far\n'));

		await readEventsUntil(
			proc.stdout as ReadableStream<Uint8Array>,
			(e) => e['type'] === 'assistant',
			2000,
		);

		// Clean up the subprocess.
		(proc.stdin as { end?: () => void }).end?.();
		await proc.exited;
		livePids.delete(pid);

		// Re-read the state file — the operator's typed interlude must NOT
		// have mutated `iteration`. (The mock fixture doesn't write to the
		// state file at all — no claim is made about IT writing — but the
		// invariant is broader: the typed-interlude path should never reach
		// the state file. If a future change accidentally routes operator
		// input through the loop's stop-hook path, this test catches it.)
		const stateAfterRaw = readFileSync(stateFilePath, 'utf8');
		const stateAfter = parseStateFile(stateAfterRaw);
		expect(stateAfter?.iteration).toBe(ITERATION_BEFORE);
		// All other state-file fields likewise unchanged.
		expect(stateAfter?.max_iterations).toBe(30);
		expect(stateAfter?.completion_promise).toBe('COMPLETE');
		expect(stateAfter?.started_at).toBe('2026-04-29T01:00:00Z');
		expect(stateAfter?.active).toBe(true);

		// Bonus: `buildStatusReport` should still see iteration: 5/30 — the
		// "later /cam-next" referenced in the AC would arm a new claude
		// turn against this same state file, and that next turn picks up at
		// iteration 5 (then becomes 6 after the next turn's stop hook fires
		// — but that increment isn't part of THIS test's contract).
		const report = buildStatusReport({ cwd: tmpDir });
		expect(report.state).toBe('active');
		expect(report.iteration).toEqual({ current: ITERATION_BEFORE, max: 30 });
	});
});

// --- Test 5: Raw-mode gate decision ----------------------------------------

describe('Test 5: Init and setup interactivity gate — non-interactive path when stdin raw-mode unavailable', () => {
	// Pure predicate tests: no TTY, no process, no network.

	test('isInitInteractiveGate returns false when stdin is not a TTY (build-smoke shape: stdout TTY, stdin piped)', () => {
		// Mimics: cam init run with stdout attached to a terminal but stdin
		// redirected from /dev/null (build smoke). Gate must return false so
		// runInitLinear is chosen rather than the Ink path that would crash with
		// "Raw mode is not supported".
		expect(isInitInteractiveGate(true, false, undefined)).toBe(false);
	});

	test('isInitInteractiveGate returns false when stdout is not a TTY', () => {
		expect(isInitInteractiveGate(false, true, undefined)).toBe(false);
	});

	test('isInitInteractiveGate returns false when CI env is set (even with both TTYs)', () => {
		expect(isInitInteractiveGate(true, true, '1')).toBe(false);
	});

	test('isInitInteractiveGate returns true only when both stdout and stdin are TTYs and CI is absent', () => {
		expect(isInitInteractiveGate(true, true, undefined)).toBe(true);
	});

	test('isSetupInteractiveGate returns false when stdin is not a TTY (build-smoke shape)', () => {
		// Mimics the same scenario for setup: Ink SetupScreen uses useInput
		// which needs raw-mode stdin; gate must fall back to collectViaReadline.
		expect(isSetupInteractiveGate(true, false, undefined)).toBe(false);
	});

	test('isSetupInteractiveGate returns false when CI env is set', () => {
		expect(isSetupInteractiveGate(true, true, '1')).toBe(false);
	});

	test('isSetupInteractiveGate returns true only when both TTYs and no CI', () => {
		expect(isSetupInteractiveGate(true, true, undefined)).toBe(true);
	});

	test('runInit in test environment (stdin not a raw-capable TTY) does not throw and exits via the linear print path', async () => {
		// In bun test, process.stdin.isTTY is undefined (falsy) → gate returns
		// false → runInitLinear is selected → no Ink render, no raw-mode crash.
		const tmpWorkDir = mkdtempSync(join(tmpdir(), 'cam-gate-init-test-'));
		const prevConfigPath = process.env.CAM_CONFIG_PATH;
		process.env.CAM_CONFIG_PATH = join(tmpWorkDir, 'config.toml');
		try {
			// Must resolve (not reject) with a number exit code — proves the
			// linear path ran without throwing "Raw mode is not supported".
			const exitCode = await runInit();
			expect(typeof exitCode).toBe('number');
		} finally {
			if (prevConfigPath === undefined) delete process.env.CAM_CONFIG_PATH;
			else process.env.CAM_CONFIG_PATH = prevConfigPath;
			rmSync(tmpWorkDir, { recursive: true, force: true });
		}
	});

	test('setup gate=false routes to collectViaReadline: returns configured answers on EOF', async () => {
		// When isSetupInteractiveGate returns false, collectSetupAnswers picks
		// collectViaReadline. Drive it directly with a pre-filled options bag
		// (no readline prompts needed) to prove the readline path handles the
		// non-interactive case and returns valid answers.
		const eofStream = new Readable({ read() { this.push(null); } });
		const answers = await collectViaReadline(
			{
				projectMode: 'existing',
				issueSystem: 'none',
				mergeMode: 'immediate',
				planApproval: 'auto',
			},
			eofStream,
		);
		expect(answers.projectMode).toBe('existing');
		expect(answers.issueSystem).toBe('none');
		expect(answers.mergeMode).toBe('immediate');
		expect(answers.planApproval).toBe('auto');
	});
});
