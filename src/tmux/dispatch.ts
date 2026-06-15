// src/tmux/dispatch.ts
//
// Idle-guarantee helper for atomic send-keys to the orchestrator pane (US-008).
//
// The send-keys operation injects a /cam-* command into the orchestrator pane.
// If the orchestrator is mid-turn (spinner running, tool call in progress), the
// injected text lands mid-output and is lost or corrupts the TUI state. This
// module wraps the raw send-keys call with an idle-check: it polls capture-pane
// until the pane content shows a stable prompt (no busy glyph, no in-flight
// tool call), then issues send-keys exactly once.
//
// Fallback on timeout: log the condition and still send (fire-and-forget). The
// check is best-effort by design: capture-pane lags by one tmux refresh cycle
// and we never want to block the caller indefinitely.

import { tmuxArgs, type SpawnFn as TmuxSpawnFn } from './session.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable capture-pane reader.
 *
 * Accepts a pane ID (e.g. `%3`) and returns the captured text content of that
 * pane. Defaults to a real `tmux capture-pane -p -t <paneId>` call. Tests
 * inject a fake to avoid spinning up a real tmux server.
 */
export type CapturePaneFn = (paneId: string) => string;

export interface SendKeysWhenIdleOptions {
	/** Target pane ID (e.g. `%3`). */
	paneId: string;
	/**
	 * Text payload to send. Issued as two separate tmux args: the text literal
	 * and 'Enter', so the pane receives them as an atomic keystroke sequence.
	 */
	text: string;
	/** Spawn function used for both capture-pane polling and send-keys. */
	tmuxSpawnFn: TmuxSpawnFn;
	/**
	 * Override the capture-pane reader for tests. Default: calls real tmux
	 * `capture-pane -p -t <paneId>` via tmuxSpawnFn.
	 */
	capturePaneFn?: CapturePaneFn;
	/**
	 * Milliseconds between idle-check polls. Default: 200.
	 *
	 * Keep this short so the overall wait feels snappy for the operator, but
	 * not so short that we flood the tmux server with capture-pane calls.
	 */
	pollIntervalMs?: number;
	/**
	 * Maximum milliseconds to wait for an idle pane before giving up.
	 *
	 * Fallback behavior on timeout: log a warning to stderr and send anyway.
	 * This ensures the caller never blocks indefinitely even if the pane is
	 * stuck in a busy state (e.g. a long-running tool call).
	 *
	 * Default: 5_000 (5 seconds).
	 */
	idleTimeoutMs?: number;
	/**
	 * Sleep function between polls. Default: `Bun.sleepSync`.
	 * Tests inject a no-op to avoid real waits.
	 */
	sleepFn?: (ms: number) => void;
}

// ---------------------------------------------------------------------------
// Idle detection
// ---------------------------------------------------------------------------

/**
 * Glyphs that indicate the claude TUI is mid-turn (busy):
 * - Braille spinner set: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏
 * - Active tool-call glyph used by claude CLI: ◆
 *
 * Any of these in the last 5 lines of the pane means we must wait.
 */
const BUSY_GLYPHS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◆]/u;

/**
 * Prompt pattern that indicates the claude TUI is idle (waiting for input).
 *
 * The claude CLI renders `>` or `❯` at the prompt line. A line ending with
 * one of these characters (optionally followed by trailing whitespace) is
 * treated as the idle prompt.
 */
const IDLE_PROMPT = /[>❯]\s*$/;

/**
 * Return true if the captured pane content indicates an idle (ready-for-input)
 * orchestrator state.
 *
 * Algorithm:
 *   1. If the content is blank, the pane is not yet ready.
 *   2. Inspect the last 5 lines for busy glyphs (spinner, active tool call).
 *      If any are present, the pane is busy.
 *   3. Confirm at least one line in the tail ends with the claude prompt char.
 *
 * This is heuristic by nature (capture-pane lags one tmux refresh cycle).
 * Callers poll multiple times before concluding the pane is idle.
 *
 * Exported for direct unit testing.
 */
export function isOrchPaneIdle(content: string): boolean {
	if (!content.trim()) return false; // blank pane: not yet ready
	const lines = content.split('\n').map((l) => l.trimEnd());
	// Check the last 5 lines for any busy glyph.
	const tail = lines.slice(-5);
	if (tail.some((l) => BUSY_GLYPHS.test(l))) return false;
	// At least one tail line must look like the idle prompt.
	return tail.some((l) => IDLE_PROMPT.test(l.trim()));
}

// ---------------------------------------------------------------------------
// Default capture-pane reader
// ---------------------------------------------------------------------------

function defaultCapturePaneFn(paneId: string, spawnFn: TmuxSpawnFn): string {
	const r = spawnFn(
		'tmux',
		tmuxArgs(['capture-pane', '-p', '-t', paneId]),
		{ stdio: 'pipe' },
	);
	return typeof r.stdout === 'string' ? r.stdout : (r.stdout?.toString() ?? '');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wait until the orchestrator pane is idle, then issue an atomic send-keys.
 *
 * Polls `capture-pane` at `pollIntervalMs` intervals (default 200 ms) until
 * `isOrchPaneIdle` returns true or the `idleTimeoutMs` budget is exhausted
 * (default 5 000 ms).
 *
 * **Timeout fallback**: if the budget expires before the pane goes idle, a
 * warning is printed to stderr and send-keys fires anyway. The caller is never
 * blocked indefinitely.
 *
 * The send-keys call is atomic: text and 'Enter' are passed as discrete argv
 * elements in a single `send-keys` invocation with `-l` (literal, prevents
 * tmux from interpreting special chars). This matches the invariant documented
 * in patterns.md ("send-keys atomic text+Enter, -l for literal").
 */
export function sendKeysWhenIdle(opts: SendKeysWhenIdleOptions): void {
	const {
		paneId,
		text,
		tmuxSpawnFn,
		capturePaneFn,
		pollIntervalMs = 200,
		idleTimeoutMs = 5_000,
		sleepFn = (ms: number) => {
			Bun.sleepSync(ms);
		},
	} = opts;

	const capture = capturePaneFn
		? capturePaneFn
		: (id: string) => defaultCapturePaneFn(id, tmuxSpawnFn);

	const deadline = Date.now() + idleTimeoutMs;
	let timedOut = false;

	while (true) {
		const content = capture(paneId);
		if (isOrchPaneIdle(content)) break;
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			timedOut = true;
			break;
		}
		sleepFn(Math.min(pollIntervalMs, remaining));
	}

	if (timedOut) {
		// Fallback: log + still send. Never block indefinitely.
		process.stderr.write(
			`[cam] warn: orchestrator pane ${paneId} did not go idle within ${idleTimeoutMs} ms; sending anyway\n`,
		);
	}

	// Atomic send-keys: text + Enter in ONE call, WITHOUT -l. A `-l` flag makes
	// EVERY argument literal, so "Enter" would be TYPED as the text "Enter" rather
	// than submitting the command (empirically verified, CAM-55). `text` is a single
	// non-key-name argv element, so tmux already sends its characters literally;
	// only "Enter" must remain a recognised key so the command actually submits.
	tmuxSpawnFn(
		'tmux',
		tmuxArgs(['send-keys', '-t', paneId, text, 'Enter']),
		{ stdio: 'ignore' },
	);
}
