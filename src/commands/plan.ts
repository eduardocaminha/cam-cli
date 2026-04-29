// src/commands/plan.ts
//
// Implementation of `ralph plan` — wraps an interactive `claude` session that
// dispatches `/ralph-plan` (or `/ralph-plan #N`) and, after the prd-auditor
// emits its `verdict: "APPROVE"` line, asks the operator whether to let
// branch + commit happen.
//
// Acceptance criteria (US-006):
//   1. `ralph plan` exists as a CLI subcommand (wired in index.ts).
//   2. Spawns `claude --permission-mode bypassPermissions <slash>` inline,
//      attached to the current TTY for stdin (operator interacts directly).
//   3. Dispatches `/ralph-plan` (or `/ralph-plan #N` when --issue is passed)
//      as the trailing argv prompt — claude treats that as the first user-turn.
//   4. Watches the subprocess stdout for the prd-auditor's verdict line —
//      a line containing both the literal substring `verdict` (any case) AND
//      the literal substring `APPROVE` — and on first match prompts the
//      operator `Approve PRD and create branch? [y/N]`.
//   5. On `y` (case-insensitive): prints a short ack and lets the planning
//      session continue to its branch/commit step. We do NOT exit ralph plan;
//      ralph plan resolves when the claude subprocess itself exits.
//   6. On `N` / empty / anything else: kills the claude subprocess (which is
//      the ralph-CLI equivalent of "press Esc and bail") and exits 0 with a
//      polite cancel message.
//   7. Bun unit test mocks the claude subprocess (FakeClaudeProcess) and
//      asserts the prompt fires on APPROVE.
//   8. `bunx tsc --noEmit` passes.
//
// IMPLEMENTATION NOTES:
// - The notes field in the PRD recommended `stdio: ['inherit', 'pipe', 'pipe']`.
//   That gives us: operator types into claude's TTY directly, ralph reads
//   stdout to spot the verdict line, ralph reads stderr for diagnostics. The
//   trade-off is that the operator's keystrokes go straight to claude — they
//   do NOT also flow through ralph-cli's stdin, so the only way ralph can
//   "send Esc" is to kill the subprocess. That's functionally identical to
//   the operator pressing Esc + Ctrl+C inside claude (claude tears down its
//   TUI on signal); we surface a polite message before killing so the
//   operator knows ralph initiated the cancel.
// - Verdict detection regex is **deliberately tolerant**: matches any line
//   that contains both `verdict` (case-insensitive) and the literal
//   `APPROVE` (case-sensitive — APPROVE is the canonical machine-parseable
//   form, lowercase `approve` in prose should NOT trigger). Falsely
//   triggering on a quoted reproduction of the rule (e.g. claude saying
//   "the verdict line should look like `verdict: APPROVE`") is acceptable —
//   the operator still gets the prompt, and they can answer N to back out.
//   Missing the trigger is the worse failure mode.
// - The yes/no prompt reads from process.stdin. Default on empty input is N
//   (cautious default for an action that creates a branch + commit).

import process from 'node:process';

import { printError, printHint, printSuccess, printWarning } from '../logging/color.ts';

// --- Types -----------------------------------------------------------------

export interface PlanOptions {
	/** Optional GitHub issue number; passed through as `/ralph-plan #N`. */
	issue?: number;
	/**
	 * Spawn factory — overridable for tests. The default uses Bun.spawn with
	 * stdio: ['inherit', 'pipe', 'pipe']. Tests pass a fake that emits a
	 * scripted stdout sequence and resolves `exited` on demand.
	 */
	spawn?: SpawnFn;
	/**
	 * Yes/No prompt — overridable for tests. The default reads a single line
	 * from process.stdin. Tests pass a fake that returns a pre-canned answer.
	 * Receives the prompt string for display.
	 */
	prompt?: PromptFn;
}

/**
 * The subset of `Bun.Subprocess` that ralph plan actually uses. Defining the
 * surface explicitly (instead of importing `Bun.Subprocess`) keeps tests free
 * of Bun-specific types and makes the contract obvious.
 */
export interface PlanSubprocess {
	/** stdout stream — must be a ReadableStream of Uint8Array chunks. */
	readonly stdout: ReadableStream<Uint8Array> | null;
	/** stderr stream — same shape; may be null when unused. */
	readonly stderr: ReadableStream<Uint8Array> | null;
	/** Resolves with the exit code when the subprocess exits. */
	readonly exited: Promise<number>;
	/** Send SIGTERM (default). Idempotent. */
	kill(signal?: number | string): void;
}

export type SpawnFn = (cmd: string[]) => PlanSubprocess;
export type PromptFn = (question: string) => Promise<string>;

// --- Verdict detection -----------------------------------------------------

/**
 * Test whether a line carries the prd-auditor's APPROVE verdict.
 *
 * The contract: a line contains both `verdict` (case-insensitive) AND the
 * literal substring `APPROVE` (uppercase). Tolerates surrounding markup —
 * JSON (`"verdict": "APPROVE"`), YAML (`verdict: APPROVE`), prose
 * ("the verdict is APPROVE"), and any whitespace are all fine.
 */
export function isApproveLine(line: string): boolean {
	if (!/verdict/i.test(line)) return false;
	return line.includes('APPROVE');
}

/**
 * Scan a multi-line buffer for the first APPROVE verdict line.
 * Returns the matching line, or null when none is found yet.
 */
export function findApproveLine(buffer: string): string | null {
	for (const line of buffer.split('\n')) {
		if (isApproveLine(line)) return line;
	}
	return null;
}

// --- Default prompt + spawn implementations --------------------------------

/**
 * Read a single line from process.stdin. Returns the line without the
 * trailing newline. Resolves with an empty string on EOF.
 *
 * We use a one-shot listener on `data` rather than readline to avoid an
 * extra dep; the trade-off is that we don't get line-editing affordances
 * like backspace handling. For a y/N prompt that's acceptable — the answer
 * is a single keystroke followed by Enter.
 */
async function defaultPrompt(question: string): Promise<string> {
	process.stdout.write(question);
	return new Promise((resolve) => {
		const onData = (chunk: Buffer) => {
			process.stdin.off('data', onData);
			process.stdin.pause();
			resolve(chunk.toString().replace(/\r?\n$/, ''));
		};
		process.stdin.on('data', onData);
		process.stdin.resume();
	});
}

/**
 * Default subprocess spawn — uses Bun.spawn with the stdio shape from the
 * PRD notes. We pin stdin to 'inherit' (operator controls claude's TTY)
 * and pipe stdout + stderr so ralph can scan for the verdict.
 */
function defaultSpawn(cmd: string[]): PlanSubprocess {
	const proc = Bun.spawn(cmd, {
		stdin: 'inherit',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	// Bun's typings make stdout/stderr loose; cast to the surface we expose.
	return {
		stdout: proc.stdout as ReadableStream<Uint8Array> | null,
		stderr: proc.stderr as ReadableStream<Uint8Array> | null,
		exited: proc.exited,
		kill: (signal?: number | string) => {
			proc.kill(signal as number | NodeJS.Signals | undefined);
		},
	};
}

// --- Stream tee helper -----------------------------------------------------

/**
 * Read `stream` to completion. For each chunk: write its raw bytes to
 * `passthrough` (so the operator still sees claude's output exactly as it
 * was emitted, including ANSI), and append the decoded text to a buffer.
 * After every chunk, if no APPROVE line has been emitted yet, scan the new
 * buffer slice for one and call `onApprove` exactly once when found.
 *
 * Returns a Promise that resolves when the stream ends.
 */
async function teeAndScan(
	stream: ReadableStream<Uint8Array>,
	passthrough: NodeJS.WriteStream,
	onApprove: (line: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	let approveFired = false;
	try {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const { value, done } = await reader.read();
			if (done) return;
			if (value) {
				passthrough.write(value);
				if (!approveFired) {
					buffer += decoder.decode(value, { stream: true });
					const match = findApproveLine(buffer);
					if (match !== null) {
						approveFired = true;
						onApprove(match);
					}
					// Trim buffer to the last 16 KiB so long sessions don't
					// grow the buffer unboundedly. The verdict line is short;
					// 16 KiB is plenty of overlap for split chunks.
					if (buffer.length > 16 * 1024) {
						buffer = buffer.slice(-8 * 1024);
					}
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

// --- Public entrypoint -----------------------------------------------------

/**
 * Run the full `ralph plan` flow. Returns the process exit code.
 *
 * Resolution order:
 *   - operator answers N / empty / anything-not-y → kill subprocess, exit 0
 *   - operator answers y → let the subprocess continue; ralph plan resolves
 *     with whatever exit code the subprocess returns
 *   - subprocess exits before any verdict is seen → exit 0 (the planner
 *     might have legitimately bailed early; we surface its exit code as-is)
 *   - subprocess exits with non-zero before verdict → propagate that code
 */
export async function runPlan(options: PlanOptions = {}): Promise<number> {
	const slash = options.issue !== undefined ? `/ralph-plan #${options.issue}` : '/ralph-plan';
	const cmd = ['claude', '--permission-mode', 'bypassPermissions', slash];

	const spawn = options.spawn ?? defaultSpawn;
	const prompt = options.prompt ?? defaultPrompt;

	let proc: PlanSubprocess;
	try {
		proc = spawn(cmd);
	} catch (err) {
		printError(
			'failed to spawn `claude`',
			err instanceof Error ? err.message : String(err),
		);
		printHint('verify `claude` is on PATH (re-run `ralph init` to validate)');
		return 1;
	}

	printSuccess(`ralph plan: dispatched ${slash}`);
	printHint('the planning session is interactive — your keystrokes go directly to claude');

	let promptFired = false;
	let killedByOperator = false;

	const handleApprove = async (line: string): Promise<void> => {
		if (promptFired) return;
		promptFired = true;
		// Newline before our prompt so it doesn't run into claude's last
		// stdout chunk on the same line.
		process.stdout.write('\n');
		printSuccess('prd-auditor APPROVE detected', line.trim().slice(0, 80));
		const answer = await prompt('Approve PRD and create branch? [y/N] ');
		if (/^y(es)?$/i.test(answer.trim())) {
			printSuccess('continuing — letting planner finish branch + commit');
			return;
		}
		printWarning('plan cancelled by operator', 'sending Esc + terminating planning session');
		killedByOperator = true;
		proc.kill('SIGTERM');
	};

	// Tee stdout + stderr to the operator's screen while scanning stdout.
	// We deliberately only scan stdout — stderr from claude is logging noise,
	// not the assistant's response stream. Both still pass through to the
	// operator's terminal so they see warnings / errors as they happen.
	const stdoutPromise = proc.stdout
		? teeAndScan(proc.stdout, process.stdout, (line) => {
				void handleApprove(line);
			})
		: Promise.resolve();
	const stderrPromise = proc.stderr
		? teeAndScan(proc.stderr, process.stderr, () => {
				/* no scan on stderr */
			})
		: Promise.resolve();

	const exitCode = await proc.exited;
	// Give the tee loops a chance to drain remaining bytes after the
	// subprocess exits. They resolve on the stream end-of-file; awaiting
	// them avoids dropping the last line of output.
	await Promise.allSettled([stdoutPromise, stderrPromise]);

	if (killedByOperator) {
		// Operator chose to bail. Exit 0 — this is a clean cancel, not an error.
		return 0;
	}
	return exitCode ?? 0;
}
