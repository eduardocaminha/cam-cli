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
//
// sendKeysVerified (US-002, CAM-200) extends this with post-send delivery
// verification: a busy TUI can still drop the trailing Enter even after the
// pane looked idle at check time (capture-pane lags by one refresh cycle), so
// the pushed line silently never submits. sendKeysVerified re-checks the pane
// after each send for a composer-emptied STATE signal (did the pushed text
// leave the composer), and retries with bounded backoff up to N attempts,
// emitting a 'push-undelivered' event on exhaustion instead of blocking or
// throwing. sendKeysWhenIdle now delegates to it so every existing thin-proxy
// caller (review.ts, issue.ts, spec.ts) gets verify+retry for free.

import { tmuxArgs, type SpawnFn as TmuxSpawnFn } from './session.ts';
import { computeBackoffMs, JITTER_FRACTION } from '../supervisor/loop.ts';
import type { WorkerEventKind, WorkerEventDetail } from '../supervisor/events.ts';

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
	 * Default: `IDLE_WAIT_DEADLINE_MS` (see below).
	 */
	idleTimeoutMs?: number;
	/**
	 * Sleep function between polls. Default: `Bun.sleepSync`.
	 * Tests inject a no-op to avoid real waits.
	 */
	sleepFn?: (ms: number) => void;
}

/**
 * Options for `sendKeysVerified` (US-002, CAM-200). A superset of
 * `SendKeysWhenIdleOptions`: every field there means the same thing here, plus
 * the retry/verify knobs below. `sendKeysWhenIdle` delegates straight through
 * to this function, so its callers keep working unchanged with the defaults.
 */
export interface SendKeysVerifiedOptions extends SendKeysWhenIdleOptions {
	/**
	 * Maximum number of send attempts (the initial send plus retries) before
	 * giving up and emitting 'push-undelivered'. Default: 3.
	 */
	maxAttempts?: number;
	/**
	 * Base backoff (ms) between a failed verify and the next send attempt,
	 * fed to `computeBackoffMs` (src/supervisor/loop.ts:606). Default: 300.
	 */
	retryBaseMs?: number;
	/** Backoff cap (ms) fed to `computeBackoffMs`. Default: 2_000. */
	retryMaxMs?: number;
	/** Jitter fraction fed to `computeBackoffMs`. Default: JITTER_FRACTION (0.2). */
	jitterFraction?: number;
	/** Random source fed to `computeBackoffMs`. Default: `Math.random`. */
	randomFn?: () => number;
	/**
	 * Injected event sink, called with `('push-undelivered', detail)` once all
	 * attempts are exhausted without a composer-emptied verify. Optional and
	 * side-effect-free by default: omitting it emits no event (mirrors the
	 * sub-state-machine logEvent seam pattern used by merge-watch). The caller
	 * wraps this into a full WorkerEvent (ts/storyId/uuid) if it wants the
	 * event durably recorded.
	 */
	logEvent?: (kind: WorkerEventKind, detail: WorkerEventDetail) => void;
}

// ---------------------------------------------------------------------------
// Idle detection
// ---------------------------------------------------------------------------

/**
 * Settle window (ms) between a send-keys spawn and the post-send
 * `isComposerEmptied` verification capture (US-001, CAM-358).
 *
 * `capture-pane` lags the tmux server's own render cycle: reading the pane
 * immediately after send-keys returns can still observe the PRE-send screen
 * (the pushed text still visibly sitting in the composer), which makes
 * `isComposerEmptied` misreport an undelivered payload as delivered on
 * attempt 1 and skip the retry loop entirely. Sleeping this window (via the
 * injected `sleepFn`, never a bare `Bun.sleepSync`) before every verify
 * capture gives the pane one refresh cycle to catch up.
 */
export const SEND_KEYS_SETTLE_MS = 50;

/**
 * Default idle-wait deadline (ms) for `waitForIdlePane` before the
 * send-anyway fallback fires (US-002, CAM-358).
 *
 * The previous inline default (5_000) made the fallback the COMMON case
 * rather than the exception: an orchestrator running a routine long tool
 * call (a full test run, a `git` operation, a slow lint pass) is routinely
 * still mid-turn 5 seconds later, so the idle-gate timed out and sent blind
 * on nearly every push (5 'did not go idle within 5000 ms; sending anyway'
 * warnings logged in a single session, see journal DRAIN-CAM357-2026-07-19).
 * Raised well above that so a routine long tool call is actually waited
 * out; the send-anyway fallback (warn + send, never block indefinitely)
 * still fires past this deadline unchanged.
 */
export const IDLE_WAIT_DEADLINE_MS = 30_000;

/**
 * Glyphs that indicate the claude TUI is mid-turn (busy):
 * - Full braille block U+2800-U+28FF (covers every glyph claude renders during
 *   a spinner half-cycle; previously only ~10 specific chars were listed, which
 *   caused isOrchPaneIdle to return true mid-spin ~half the time, defeating the
 *   US-008 idle-guarantee). The range includes the null braille char U+2800 and
 *   runs through U+28FF which encompasses all 256 braille patterns.
 * - Active tool-call glyph used by claude CLI: ◆ (U+25C6)
 *
 * Any of these in the last 5 lines of the pane means we must wait.
 */
const BUSY_GLYPHS = /[⠀-⣿◆]/u;

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

/**
 * Return true if `text` (the line we just pushed) is no longer present in the
 * tail of the captured pane content, i.e. it left the composer (US-002,
 * CAM-200).
 *
 * This is a STATE check only: it looks for the pushed line's own text, never
 * for report content or any parsed structure in the rendered scrollback
 * (capture-pane is rendered markdown and lossy for that purpose; see the
 * CAM-75/77/78 structured-handback decision). A busy TUI that drops the
 * trailing Enter leaves the composer still holding `text`, which this
 * detects so the caller can retry.
 *
 * Exported for direct unit testing.
 */
export function isComposerEmptied(content: string, text: string): boolean {
	const lines = content.split('\n').map((l) => l.trimEnd());
	const tail = lines.slice(-5);
	return !tail.some((l) => l.includes(text));
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

/**
 * Poll `capture` at `pollIntervalMs` intervals until `isOrchPaneIdle` returns
 * true or `idleTimeoutMs` is exhausted. Returns whether the wait timed out
 * (fallback: caller still sends, but logs a warning first).
 */
function waitForIdlePane(args: {
	paneId: string;
	capture: CapturePaneFn;
	pollIntervalMs: number;
	idleTimeoutMs: number;
	sleepFn: (ms: number) => void;
}): boolean {
	const { paneId, capture, pollIntervalMs, idleTimeoutMs, sleepFn } = args;
	const deadline = Date.now() + idleTimeoutMs;

	while (true) {
		const content = capture(paneId);
		if (isOrchPaneIdle(content)) return false;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return true;
		sleepFn(Math.min(pollIntervalMs, remaining));
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wait until the orchestrator pane is idle, then issue an atomic send-keys,
 * verifying delivery and retrying with bounded backoff on failure (US-002,
 * CAM-200).
 *
 * Flow:
 *   1. Idle-gate: poll `capture-pane` at `pollIntervalMs` intervals (default
 *      200 ms) until `isOrchPaneIdle` returns true or `idleTimeoutMs` is
 *      exhausted (default `IDLE_WAIT_DEADLINE_MS`, 30 000 ms). **Timeout
 *      fallback**: if the budget expires before the pane goes idle, a
 *      warning is printed to stderr and send-keys fires anyway. The caller
 *      is never blocked indefinitely.
 *   2. Send: text and 'Enter' are passed as discrete argv elements in a
 *      single `send-keys` invocation, WITHOUT `-l`. With `-l` every arg is
 *      literal, so 'Enter' would be typed as the text "Enter" and never
 *      submit (sendkeys-literal-enter-gotcha, CAM-55). The text is a single
 *      non-key-name arg, so tmux already sends its characters literally; only
 *      'Enter' must stay a recognised key.
 *   3. Settle + verify: sleep `SEND_KEYS_SETTLE_MS` (via the injected
 *      `sleepFn`, US-001, CAM-358) so the tmux server has one refresh cycle
 *      to render the post-send screen, then re-capture the pane and check
 *      `isComposerEmptied` (the pushed line left the composer). This is a
 *      pane-STATE check only; it never parses rendered scrollback for report
 *      content.
 *   4. Retry: if not delivered, sleep `computeBackoffMs(attempt, ...)`
 *      (src/supervisor/loop.ts:606) and resend, up to `maxAttempts` (default
 *      3) total attempts.
 *
 * On exhaustion (still not delivered after `maxAttempts`), emits
 * `'push-undelivered'` via the injected `logEvent` (default: no-op, so
 * callers that don't care about durable events see zero side effects). Never
 * throws and never blocks indefinitely.
 */
export function sendKeysVerified(opts: SendKeysVerifiedOptions): void {
	const {
		paneId,
		text,
		tmuxSpawnFn,
		capturePaneFn,
		pollIntervalMs = 200,
		idleTimeoutMs = IDLE_WAIT_DEADLINE_MS,
		sleepFn = (ms: number) => {
			Bun.sleepSync(ms);
		},
		maxAttempts = 3,
		retryBaseMs = 300,
		retryMaxMs = 2_000,
		jitterFraction = JITTER_FRACTION,
		randomFn = Math.random,
		logEvent,
	} = opts;

	const capture = capturePaneFn
		? capturePaneFn
		: (id: string) => defaultCapturePaneFn(id, tmuxSpawnFn);

	const timedOut = waitForIdlePane({ paneId, capture, pollIntervalMs, idleTimeoutMs, sleepFn });
	if (timedOut) {
		// Fallback: log + still send. Never block indefinitely.
		process.stderr.write(
			`[cam] warn: orchestrator pane ${paneId} did not go idle within ${idleTimeoutMs} ms; sending anyway\n`,
		);
	}

	let delivered = false;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		// Atomic send-keys: text + Enter in ONE call, WITHOUT -l (see flow
		// step 2 above; CAM-55 regression guard).
		tmuxSpawnFn(
			'tmux',
			tmuxArgs(['send-keys', '-t', paneId, text, 'Enter']),
			{ stdio: 'ignore' },
		);

		sleepFn(SEND_KEYS_SETTLE_MS);

		if (isComposerEmptied(capture(paneId), text)) {
			delivered = true;
			break;
		}

		if (attempt < maxAttempts) {
			const backoffMs = computeBackoffMs(attempt, {
				base: retryBaseMs,
				max: retryMaxMs,
				jitterFraction,
				random: randomFn,
			});
			sleepFn(backoffMs);
		}
	}

	if (!delivered) {
		logEvent?.('push-undelivered', { paneId, retriesExhausted: maxAttempts });
	}
}

/**
 * Thin-proxy call sites (review.ts, issue.ts, spec.ts, meta-loop dispatch)
 * call this with `SendKeysWhenIdleOptions` only; delegating to
 * `sendKeysVerified` with its retry/verify defaults gives them
 * verify-then-retry-then-push-undelivered for free with no signature-shape
 * change at the call site (US-002, CAM-200).
 */
export function sendKeysWhenIdle(opts: SendKeysWhenIdleOptions): void {
	sendKeysVerified(opts);
}
