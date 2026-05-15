// src/commands/plan.ts
//
// Implementation of `cam plan` — wraps an interactive `claude` session that
// dispatches `/cam-plan` (or `/cam-plan #N`) and, after the prd-auditor
// emits its `verdict: "APPROVE"` line, asks the operator whether to let
// branch + commit happen.
//
// Acceptance criteria (US-006, updated US-004):
//   1. `cam plan` exists as a CLI subcommand (wired in index.ts).
//   2. Spawns `claude --permission-mode bypassPermissions <slash>` with PTY mode
//      via `Bun.spawn(cmd, { terminal: { cols, rows, data(t, bytes) {...} } })`.
//      The child sees process.stdout.isTTY === true (real TTY), so claude's
//      interactive TUI stays active. The parent receives bytes via the data
//      callback for verdict scanning.
//   3. Dispatches `/cam-plan` (or `/cam-plan #N` when --issue is passed)
//      as the trailing argv prompt — claude treats that as the first user-turn.
//   4. The data callback writes bytes to process.stdout (operator sees claude's
//      output verbatim) AND scans them for the APPROVE verdict line
//      (existing isApproveLine/findApproveLine helpers reused).
//   5. Operator keystrokes are forwarded to the child via proc.terminal.write()
//      — reads process.stdin in raw mode and forwards chunks to the terminal.
//   6. On terminal resize (process.stdout SIGWINCH), call
//      proc.terminal.resize(cols, rows) so claude's TUI re-layouts.
//   7. On `y` (case-insensitive): prints a short ack and lets the planning
//      session continue to its branch/commit step. We do NOT exit cam plan;
//      cam plan resolves when the claude subprocess itself exits.
//   8. On `N` / empty / anything else: kills the claude subprocess (which is
//      the cam-CLI equivalent of "press Esc and bail") and exits 0 with a
//      polite cancel message.
//   9. Bun unit test mocks the new spawn surface (terminal.data callback,
//      terminal.write) and asserts the prompt fires on APPROVE.
//  10. `bunx tsc --noEmit` passes.
//
// IMPLEMENTATION NOTES (PTY migration from US-004):
// - With `terminal:` option, proc.stdin/stdout/stderr are all null — use
//   proc.terminal instead.
// - The data callback receives Uint8Array bytes from the child. We write them
//   directly to process.stdout (passthrough) and also scan the decoded text
//   for the verdict line.
// - stdin forwarding: we call process.stdin.setRawMode(true) and listen on
//   'data' to forward each chunk via proc.terminal.write(). This lets the
//   operator type directly into claude's TTY. Raw mode must be restored (false)
//   on exit to avoid leaving the terminal in a broken state.
// - SIGWINCH: on process.stdout 'resize' event (Node/Bun emits this on
//   SIGWINCH), we call proc.terminal.resize(cols, rows) with the new dimensions.
// - The approve prompt pauses stdin forwarding (we need line-editing for y/N),
//   then resumes forwarding or exits depending on the answer.

import process from 'node:process';

import { readPermissionMode } from '../config/permission-mode.ts';
import { printError, printHint, printSuccess, printWarning } from '../logging/color.ts';
import {
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
} from '../logging/screen.ts';
import { promptSelect } from '../ui/promptSelect.tsx';

// --- Types -----------------------------------------------------------------

export interface PlanOptions {
	/** Optional GitHub issue number; passed through as `/cam-plan #N`. */
	issue?: number;
	/**
	 * Spawn factory — overridable for tests. The default uses Bun.spawn with
	 * the terminal: PTY option. Tests pass a fake that emits a scripted data
	 * sequence via the onData callback and resolves `exited` on demand.
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
 * The terminal handle subset that cam plan actually uses. Defining the
 * surface explicitly (instead of importing Bun.Terminal) keeps tests free of
 * Bun-specific types and makes the contract obvious.
 *
 * With the terminal: PTY option, this is how we interact with the child —
 * proc.stdin/stdout/stderr are all null.
 */
export interface PlanTerminal {
	/** Forward bytes to the child's stdin (operator keystrokes). */
	write(data: string | Uint8Array): number;
	/** Notify the child of a terminal resize. */
	resize(cols: number, rows: number): void;
	/** Close the terminal (tears down the PTY). */
	close(): void;
}

/**
 * Callback-based spawn API for PTY mode. The caller provides:
 *   - `onData(bytes)` — called for every chunk from the child (stdout+stderr
 *     merged via PTY). The implementer should write to process.stdout and
 *     scan for the verdict.
 *   - `onExit()` — called when the PTY stream closes.
 * Returns the subprocess handle (for `exited` and `kill`).
 */
export interface PlanSubprocess {
	/** Resolves with the exit code when the subprocess exits. */
	readonly exited: Promise<number>;
	/** The terminal handle — write()/resize()/close() the PTY. */
	readonly terminal: PlanTerminal;
	/** Send SIGTERM (default). Idempotent. */
	kill(signal?: number | string): void;
}

export type SpawnFn = (
	cmd: string[],
	callbacks: {
		onData: (bytes: Uint8Array) => void;
		onExit: () => void;
	},
) => PlanSubprocess;

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

/** True when we can render Ink to the operator's TTY. */
function isInteractiveTTY(): boolean {
	return Boolean(process.stdout.isTTY) && !process.env['CI'];
}

/**
 * Ask "approve the PRD?" — Ink Select inside an interactive TTY, blocking
 * text prompt elsewhere (tests inject `options.prompt`, which is why the
 * second arg short-circuits to the text path even on a real TTY when the
 * caller is asserting synchronous behaviour).
 *
 * Returns `true` when the operator answered yes, `false` otherwise.
 */
async function askApprove(promptFn: PromptFn, testOverride: boolean): Promise<boolean> {
	if (testOverride || !isInteractiveTTY()) {
		const answer = await promptFn('Approve PRD and create branch? [y/N] ');
		return /^y(es)?$/i.test(answer.trim());
	}
	const chosen = await promptSelect<'y' | 'n'>({
		question: 'Approve PRD and create branch?',
		options: [
			{ value: 'y', label: 'Yes', description: 'Let the planner continue to its branch + commit step' },
			{ value: 'n', label: 'No', description: 'Cancel — terminate the planning session' },
		],
		defaultValue: 'n',
	});
	return chosen === 'y';
}

/**
 * Default subprocess spawn — uses Bun.spawn with the PTY terminal: option.
 * The child sees process.stdout.isTTY === true so claude's interactive TUI
 * stays active. The parent receives child output via the data callback.
 *
 * With terminal: set, proc.stdin/stdout/stderr are null — all I/O goes
 * through proc.terminal.
 */
function defaultSpawn(
	cmd: string[],
	callbacks: {
		onData: (bytes: Uint8Array) => void;
		onExit: () => void;
	},
): PlanSubprocess {
	const proc = Bun.spawn(cmd, {
		terminal: {
			cols: process.stdout.columns ?? 80,
			rows: process.stdout.rows ?? 24,
			data(_terminal, bytes) {
				callbacks.onData(bytes);
			},
			exit(_terminal, _exitCode, _signal) {
				callbacks.onExit();
			},
		},
	});

	const terminal: PlanTerminal = {
		write(data: string | Uint8Array): number {
			return proc.terminal!.write(data);
		},
		resize(cols: number, rows: number): void {
			proc.terminal!.resize(cols, rows);
		},
		close(): void {
			proc.terminal!.close();
		},
	};

	return {
		exited: proc.exited,
		terminal,
		kill: (signal?: number | string) => {
			proc.kill(signal as number | NodeJS.Signals | undefined);
		},
	};
}

// --- Public entrypoint -----------------------------------------------------

/**
 * Run the full `cam plan` flow. Returns the process exit code.
 *
 * Resolution order:
 *   - operator answers N / empty / anything-not-y → kill subprocess, exit 0
 *   - operator answers y → let the subprocess continue; cam plan resolves
 *     with whatever exit code the subprocess returns
 *   - subprocess exits before any verdict is seen → exit 0 (the planner
 *     might have legitimately bailed early; we surface its exit code as-is)
 *   - subprocess exits with non-zero before verdict → propagate that code
 */
export async function runPlan(options: PlanOptions = {}): Promise<number> {
	const slash = options.issue !== undefined ? `/cam-plan #${options.issue}` : '/cam-plan';
	// `permission_mode` is sourced exclusively from `~/.config/cam/config.toml`
	// (default `bypassPermissions` — see `config/permission-mode.ts`). No CLI
	// flag overrides it; that's enforced by `test/no-permission-mode-flag.test.ts`.
	const permissionMode = readPermissionMode();
	const cmd = ['claude', '--permission-mode', permissionMode, slash];

	const spawnFn = options.spawn ?? defaultSpawn;
	const prompt = options.prompt ?? defaultPrompt;

	// --- Verdict scanning state -----------------------------------------------
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	let approveFired = false;
	let promptFired = false;
	let killedByOperator = false;
	let proc: PlanSubprocess;

	// --- stdin forwarding state -----------------------------------------------
	// We enable raw mode on process.stdin so operator keystrokes (including
	// arrow keys, Ctrl sequences) flow byte-for-byte into the child's PTY.
	// When the APPROVE prompt fires we pause forwarding (to read the y/N line),
	// then either resume or exit.
	let stdinForwarding = false;
	let rawModeSet = false;

	function startStdinForwarding(): void {
		if (stdinForwarding) return;
		stdinForwarding = true;
		try {
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(true);
				rawModeSet = true;
			}
		} catch {
			// setRawMode may throw if stdin is not a TTY (e.g. piped in CI).
			// Safe to ignore — forwarding still works, just without raw mode.
		}
		process.stdin.resume();
		process.stdin.on('data', forwardStdinChunk);
	}

	function stopStdinForwarding(): void {
		if (!stdinForwarding) return;
		stdinForwarding = false;
		process.stdin.off('data', forwardStdinChunk);
		process.stdin.pause();
		try {
			if (rawModeSet) {
				process.stdin.setRawMode(false);
				rawModeSet = false;
			}
		} catch {
			// Safe to ignore — best-effort raw mode restoration.
		}
	}

	// forwardStdinChunk is defined after proc so it can close over it.
	// We use a late-binding wrapper that refers to `proc` via closure.
	function forwardStdinChunk(chunk: Buffer): void {
		try {
			proc.terminal.write(chunk);
		} catch {
			// Child may have exited — ignore write errors.
		}
	}

	// --- SIGWINCH / terminal resize -------------------------------------------
	function onResize(): void {
		try {
			proc.terminal.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
		} catch {
			// Child may have exited — ignore resize errors.
		}
	}

	// --- APPROVE handler -------------------------------------------------------
	const handleApprove = async (line: string): Promise<void> => {
		if (promptFired) return;
		promptFired = true;

		// Pause stdin forwarding so the y/N prompt can read stdin normally.
		stopStdinForwarding();

		// Newline before our prompt so it doesn't run into claude's last
		// output chunk on the same line.
		process.stdout.write('\n');
		printSuccess('prd-auditor APPROVE detected', line.trim().slice(0, 80));
		const approved = await askApprove(prompt, options.prompt !== undefined);
		if (approved) {
			printSuccess('Continuing — letting planner finish branch + commit');
			// Resume stdin forwarding so the operator can keep interacting.
			startStdinForwarding();
			return;
		}
		printWarning('Plan cancelled by operator', 'Sending Esc + terminating planning session');
		killedByOperator = true;
		proc.kill('SIGTERM');
	};

	// --- Data callback (verdict scanning + passthrough) -----------------------
	function onData(bytes: Uint8Array): void {
		// Write raw bytes to operator's terminal — preserves ANSI sequences.
		process.stdout.write(bytes);

		if (!approveFired) {
			buffer += decoder.decode(bytes, { stream: true });
			const match = findApproveLine(buffer);
			if (match !== null) {
				approveFired = true;
				void handleApprove(match);
			}
			// Trim buffer to the last 16 KiB so long sessions don't grow
			// unboundedly. The verdict line is short; 16 KiB is plenty of
			// overlap for split chunks.
			if (buffer.length > 16 * 1024) {
				buffer = buffer.slice(-8 * 1024);
			}
		}
	}

	// --- Spawn ----------------------------------------------------------------
	emitTitle('cam plan');
	emitSectionHeading('Session');

	try {
		proc = spawnFn(cmd, { onData, onExit: () => {} });
	} catch (err) {
		printError(
			'Failed to spawn `claude`',
			err instanceof Error ? err.message : String(err),
		);
		printHint('Verify `claude` is on PATH (re-run `cam init` to validate)');
		emitTrailingBlank();
		return 1;
	}

	emitOk(`Dispatched ${slash}`);
	emitMutedHint('The planning session is interactive — your keystrokes go directly to claude');

	// Start forwarding stdin to the child PTY immediately.
	startStdinForwarding();

	// Listen for terminal resize events.
	process.stdout.on('resize', onResize);

	// Wait for the subprocess to exit.
	const exitCode = await proc.exited;

	// Cleanup: remove the resize listener and stop stdin forwarding.
	process.stdout.off('resize', onResize);
	stopStdinForwarding();

	// Close the terminal (tears down the PTY) after the process exits.
	try {
		proc.terminal.close();
	} catch {
		// Already closed — ignore.
	}

	if (killedByOperator) {
		// Operator chose to bail. Exit 0 — this is a clean cancel, not an error.
		return 0;
	}
	return exitCode ?? 0;
}
