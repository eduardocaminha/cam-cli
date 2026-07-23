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
// Fallback on timeout: log the condition and still send, EXACTLY ONCE, with
// no verify/retry cycle. The check is best-effort by design: capture-pane lags
// by one tmux refresh cycle and we never want to block the caller indefinitely.
// `push-undelivered` is still emitted here (reason 'pane-not-idle'), but it
// reports that delivery is UNKNOWN, not that it was verified to have failed.
// A dedicated 'orch-pane-busy' event (US-001, CAM-401) is emitted alongside
// it so a why-not-moving diagnostic can attribute this transient send-anyway
// wedge to a specific pane/timeout without conflating it with genuine
// retries-exhausted delivery failure.
//
// sendKeysVerified (US-002) extends the idle case (pane went idle within
// budget) with post-send delivery verification: a busy TUI can still drop the
// trailing Enter even after the pane looked idle at check time (capture-pane
// lags by one refresh cycle), so the pushed line silently never submits. On
// that path only, sendKeysVerified re-checks the pane after each send for
// delivery, and retries with bounded backoff up to N attempts, emitting a
// 'push-undelivered' event (reason 'retries-exhausted') on exhaustion instead
// of blocking or throwing. sendKeysWhenIdle now delegates to it so every
// existing thin-proxy caller (review.ts, issue.ts, spec.ts) gets verify+retry
// for free on the idle path.
//
// Delivery verdict: derived from tmux CURSOR GEOMETRY, not from
// substring-matching the payload against captured pane content (captured
// text is renderable/forgeable, and a wrapped payload never appears whole on
// any single captured line). tmux's own `#{cursor_x}`/`#{cursor_y}` are
// server-side state a payload cannot forge. A baseline (x, y) is sampled once,
// immediately before the single physical send-keys call; each verify attempt
// re-samples and compares the FULL pair against that baseline.
//
// Prompt-row discriminator (CAM-364): the full (x, y) pair alone is
// PROVABLY insufficient for one residue class (an Ink composer grows upward
// from a fixed bottom anchor, so cursor_y is pinned constant; cursor_x is a
// value mod paneWidth, and a modulo is periodic, so a payload whose wrapped
// length lands the cursor back on the baseline column collides on both
// axes). When geometry reads "unchanged", the discriminator additionally
// checks whether the row AT cursor_y starts with the rendered prompt glyph
// (`cursorRowStartsWithPrompt`, `PROMPT_ROW_START = /^\s*[>❯]/`): a genuinely
// empty composer's cursor row always starts with the prompt; a genuinely
// undelivered row (blank, mid-wrap, or holding unsent text) never does. This
// only ever narrows an "unchanged" geometry verdict to "not delivered", never
// the reverse.
//
// Residue NOT closed by this fix: a payload whose own text contains a
// literal prompt glyph landing at the START of a wrap row would still forge
// this discriminator into a false "delivered" read. That residue is
// narrower than the trailing-space collision class this fix closes, but it
// is not zero.
//
// Reader decoupling (US-R2-001): cursor_y indexes rows relative to the TOP OF
// THE VISIBLE PANE, which only holds for a VISIBLE-SCREEN capture
// (`capture-pane -p -t <paneId>`). The production sidecar wires `capturePaneFn`
// to a FULL-SCROLLBACK reader (`capture-pane -p -S -`) for unrelated state
// reads elsewhere in the supervisor, so the row discriminator samples through
// its own dedicated `visibleCaptureFn`, always built fresh from `tmuxSpawnFn`
// (`capture-pane -p -t <paneId>`, no `-S -`) unless a test overrides it.
// `capturePaneFn` feeds ONLY the PRE-send idle-gate (`waitForIdlePane`), which
// just scans the pane's last 5 lines and is insensitive to scrollback vs
// visible-screen framing.
//
// Send-once guard on the idle path (CAM-375): the baseline geometry sample
// and the physical send-keys call each happen exactly ONCE, before the
// verify/retry loop -- a persistent geometry-oracle false-negative no longer
// re-sends the identical payload on every attempt. Every subsequent attempt
// only re-samples and re-verifies (settle sleep + post-send geometry sample +
// `geometryUnchanged` + `cursorRowStartsWithPrompt`) and backs off before the
// next verify; it never re-spawns send-keys. `retriesExhausted` on the
// exhaustion event still equals `maxAttempts`: it counts VERIFY attempts, not
// physical sends. The pane-not-idle fallback (`sendOnceUnverified`) and the
// delivered-on-first-attempt fast path are unaffected: both already issue
// exactly one physical send.

import { join } from 'node:path';

import { tmuxArgs, type SpawnFn as TmuxSpawnFn } from './session.ts';
import { sampleCursorGeometry, type CursorGeometry } from './display-message.ts';
import { computeBackoffMs, JITTER_FRACTION } from '../supervisor/loop.ts';
import {
	makeFileEventLogger,
	type WorkerEventKind,
	type WorkerEventDetail,
	type WorkerEventLogger,
} from '../supervisor/events.ts';

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
	 *
	 * Feeds ONLY the PRE-send idle-gate (`waitForIdlePane`, US-008) from the
	 * review round 2 fix (US-R2-001, CAM-359) onward: it may be a
	 * full-scrollback reader in production (the sidecar wires one for
	 * unrelated state reads) without corrupting the content-backstop verdict,
	 * since that backstop now reads through the separate `visibleCaptureFn`
	 * (see `SendKeysVerifiedOptions`).
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
	/**
	 * Injected event sink, called with `('push-undelivered', detail)` on TWO
	 * distinct occasions that are NOT both an exhaustion signal (US-002,
	 * CAM-373): (1) all verify/retry attempts are exhausted without a
	 * geometry-verified delivery (`reason: 'retries-exhausted'`, US-003,
	 * CAM-359), or (2) the idle-gate itself timed out, in which case exactly
	 * one send fires with NO verify/retry cycle and delivery is genuinely
	 * UNKNOWN, not confirmed failed (`reason: 'pane-not-idle'`). Optional and
	 * side-effect-free by default: omitting it emits no event (mirrors the
	 * sub-state-machine logEvent seam pattern used by merge-watch). The caller
	 * wraps this into a full WorkerEvent (ts/storyId/uuid) if it wants the
	 * event durably recorded. Declared here (rather than only on
	 * `SendKeysVerifiedOptions`) so every plain `sendKeysWhenIdle` call site
	 * can thread it through too.
	 */
	logEvent?: (kind: WorkerEventKind, detail: WorkerEventDetail) => void;
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
	 * giving up and emitting 'push-undelivered' (`reason: 'retries-exhausted'`).
	 * Default: 3. Only consulted on the idle path: when the idle-gate times
	 * out (US-002, CAM-373), this knob is not read at all -- exactly one send
	 * fires unconditionally and `push-undelivered` is emitted with
	 * `reason: 'pane-not-idle'` and `retriesExhausted: 1` instead.
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
	 * Injectable cursor-geometry sampler (US-002, CAM-359). Default: the real
	 * `sampleCursorGeometry` (src/tmux/display-message.ts), which shells out to
	 * `tmux display-message`. Tests inject a fake to avoid a real tmux server.
	 * Sampled once per attempt immediately before send-keys (the per-send
	 * baseline) and once again after the settle window (the post-send
	 * reading); the delivery verdict compares the two.
	 */
	sampleGeometryFn?: (paneId: string, tmuxSpawnFn: TmuxSpawnFn) => CursorGeometry | null;
	/**
	 * Injectable VISIBLE-SCREEN capture-pane reader for the prompt-row
	 * discriminator (`cursorRowStartsWithPrompt`, US-001, CAM-364, replacing
	 * the tail-matching backstop from US-R1-001; decoupled from
	 * `capturePaneFn` in the review round 2 fix, US-R2-001, CAM-359).
	 *
	 * `cursorY` indexes rows relative to the TOP OF THE VISIBLE PANE, so this
	 * reader must never be a full-scrollback capture (`capture-pane -p -S -`):
	 * a scrollback reader indexes an arbitrary history line instead of the
	 * true cursor row. Default: a fresh `capture-pane -p -t <paneId>` built
	 * directly from `tmuxSpawnFn`, deliberately NOT derived from whatever
	 * `capturePaneFn` the caller injected (whose scrollback semantics are
	 * unspecified and, in production, full-history). Tests inject a fake to
	 * simulate a specific row's content without a real tmux server.
	 */
	visibleCaptureFn?: CapturePaneFn;
}

// ---------------------------------------------------------------------------
// Idle detection
// ---------------------------------------------------------------------------

/**
 * Settle window (ms) between a send-keys spawn and the post-send
 * cursor-geometry verification sample (US-001/US-002, CAM-358/CAM-359).
 *
 * tmux's own render/cursor-tracking cycle lags a send-keys call: sampling
 * the cursor position immediately after send-keys returns can still observe
 * the PRE-send geometry (the pushed text not yet reflected in the pane),
 * which would misreport an undelivered payload as delivered on attempt 1
 * and skip the retry loop entirely. Sleeping this window (via the injected
 * `sleepFn`, never a bare `Bun.sleepSync`) before every post-send geometry
 * sample gives the pane one refresh cycle to catch up. Geometry sampling
 * does not remove this requirement: an un-rendered pane reads the SAME
 * baseline geometry a genuinely empty (delivered) composer would.
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
 * Dedicated idle-wait deadline (ms) for the sidecar's best-effort narration
 * push (`makeNotifyOrchestrator`, src/supervisor/host.ts), strictly less than
 * `IDLE_WAIT_DEADLINE_MS` (US-001, CAM-361).
 *
 * A mid-turn orchestrator pane blocking the shared 30s deadline stalls the
 * OUTER sidecar loop and its in-memory merge-watch timers for up to 30s per
 * narration line pushed while the operator is busy -- narration is fire-and-
 * forget best-effort, so it should never hold the loop hostage that long.
 * Bounding it to a short dedicated deadline lets the send-anyway fallback
 * (see `sendOnceUnverified`) fire quickly instead.
 *
 * `IDLE_WAIT_DEADLINE_MS` itself stays untouched at 30_000: the one-shot CLI
 * thin-proxy waits (`cam issue`/`cam review`/`cam spec`) and the
 * `orch-recycle-watch` backstop process are each a dedicated short-lived
 * process whose only job is this one send, so they can afford to wait out a
 * routine long tool call in full.
 */
export const NARRATION_IDLE_TIMEOUT_MS = 2_000;

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
 * Return true if two sampled cursor geometries represent the SAME pane
 * position (US-002, CAM-359).
 *
 * Compares the full `(cursorX, cursorY)` pair. Never reduce this to a
 * single-axis comparison. `paneWidth`/`paneHeight` are deliberately excluded
 * from the comparison: they describe the pane's bounds, not the composer's
 * delivery state, and a mid-attempt resize would otherwise falsely read as
 * "undelivered".
 *
 * A `true` result here is NOT a final delivered verdict by itself: in
 * production `cursorY` is pinned constant (see module header), so this can
 * coincidentally read `true` for an undelivered wrap-boundary-length
 * payload too. Callers must run `cursorRowStartsWithPrompt` as a
 * discriminator before trusting a `true` result as "delivered".
 */
function geometryUnchanged(before: CursorGeometry, after: CursorGeometry): boolean {
	return before.cursorX === after.cursorX && before.cursorY === after.cursorY;
}

/**
 * Start-anchored prompt pattern (US-001, CAM-364): matches when a prompt
 * glyph sits at the START of a line, optionally preceded by whitespace/
 * padding. Tolerant of BOTH U+003E (`>`, ASCII test fixtures) and U+276F
 * (`❯`, the production glyph) so both match.
 *
 * Deliberately distinct from `IDLE_PROMPT` above, which is END-anchored and
 * feeds a different question (`isOrchPaneIdle`: does ANY of the last 5
 * lines of the pane look like an idle prompt?). Measured against a real
 * claude Ink TUI (2026-07-20), the real empty-composer row reads
 * '❯ Try "how do I log an error?"' -- it ends in '?"', so `IDLE_PROMPT`'s
 * end-anchor provably does NOT match it. Reusing `IDLE_PROMPT` here would
 * misclassify every genuinely-delivered send as "not delivered".
 */
const PROMPT_ROW_START = /^\s*[>❯]/;

/**
 * Discriminator for `geometryUnchanged`'s residual ambiguity (US-001,
 * CAM-364, replacing the tail-matching backstop from US-R1-001): breaks the
 * tie by checking whether the prompt glyph sits at the START of the row the
 * cursor rests on.
 *
 * Measured shapes (real claude Ink TUI, 80x30 pane, 2026-07-20), both at
 * IDENTICAL cursor geometry (2, 26):
 *   - Genuinely empty composer: row[26] === '❯ Try "how do I log an
 *     error?"' -- the prompt glyph sits at the START of the cursor row.
 *   - Wrap-boundary collision (a payload ending in a space that lands the
 *     wrapped cursor back on the baseline column): row[26] === '' (BLANK by
 *     construction), with the prompt and the payload's own remnant one row
 *     UP at row[25].
 *
 * So: prompt-at-start-of-cursor-row means delivered; anything else (a blank
 * row, payload text, the prompt one row up) means NOT delivered, fall
 * through to retry. This is a sounder signal than the old suffix-match
 * backstop: no minimum-match-length heuristic, no coincidental-suffix risk
 * -- it only ever asks "is this the idle prompt row", never "does this
 * fragment look like the tail of what we sent".
 *
 * Only meaningful when `geometryUnchanged` already read `true`: a geometry
 * mismatch is already a sound "not delivered" verdict on its own.
 *
 * `noUncheckedIndexedAccess` guard: an out-of-range `cursorY` (a resize
 * mid-attempt, or a fake/test geometry with an implausible row) yields
 * `undefined` for `lines[cursorY]`, treated as "not the prompt row" (fails
 * closed toward "not delivered", never fabricates a false prompt match).
 *
 * NOT-closed residue (module header): a payload containing a literal prompt
 * glyph landing at the START of a wrap row would still forge this
 * discriminator into a false "delivered" read.
 */
export function cursorRowStartsWithPrompt(capturedContent: string, cursorY: number): boolean {
	const lines = capturedContent.split('\n');
	const line = lines[cursorY];
	if (line === undefined) return false;
	return PROMPT_ROW_START.test(line);
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

/**
 * Timed-out idle-gate fallback (US-002, CAM-373): send EXACTLY ONCE and skip
 * the verify/retry loop entirely. The idle-gate already burned the full
 * `idleTimeoutMs` budget failing to observe an idle pane; running the
 * geometry-verify/backoff/retry machinery on top of that (as the
 * pre-CAM-373 code did) meant the SAME payload could be sent up to
 * `maxAttempts` times in a row, since a busy pane also fails every post-send
 * geometry check. Never block indefinitely: still send.
 *
 * Delivery is genuinely UNKNOWN here, not confirmed: the geometry sampler is
 * deliberately never consulted on this path (the pane was already
 * known-busy, so a post-send read would be meaningless), so the emitted
 * event does not mean "we verified it failed" the way the exhaustion-path
 * event does.
 *
 * Emits TWO events, not one (US-001, CAM-401): the existing generic
 * `push-undelivered` (reason: 'pane-not-idle', required by downstream
 * consumers) plus a dedicated `orch-pane-busy` carrying the same paneId and
 * `idleTimeoutMs`, so a why-not-moving diagnostic can tell this transient
 * send-anyway wedge apart from genuine retries-exhausted delivery failure
 * without parsing cam-supervisor.log.
 */
function sendOnceUnverified(args: {
	paneId: string;
	text: string;
	tmuxSpawnFn: TmuxSpawnFn;
	idleTimeoutMs: number;
	logEvent?: (kind: WorkerEventKind, detail: WorkerEventDetail) => void;
}): void {
	const { paneId, text, tmuxSpawnFn, idleTimeoutMs, logEvent } = args;
	process.stderr.write(
		`[cam] warn: orchestrator pane ${paneId} did not go idle within ${idleTimeoutMs} ms; sending anyway\n`,
	);
	tmuxSpawnFn(
		'tmux',
		tmuxArgs(['send-keys', '-t', paneId, text, 'Enter']),
		{ stdio: 'ignore' },
	);
	logEvent?.('push-undelivered', { paneId, retriesExhausted: 1, reason: 'pane-not-idle' });
	logEvent?.('orch-pane-busy', { paneId, idleTimeoutMs });
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
 *      fallback (US-002, CAM-373)**: if the budget expires before the pane
 *      goes idle, a warning is printed to stderr and send-keys fires EXACTLY
 *      ONCE, unconditionally, with NO verify/retry cycle: steps 3 and 4 below
 *      do not run on this path, `maxAttempts`/backoff/the geometry sampler
 *      are never consulted, and `push-undelivered` (`reason: 'pane-not-idle'`,
 *      `retriesExhausted: 1`) is emitted immediately after that single send.
 *      Delivery on this path is genuinely UNKNOWN, not verified to have
 *      failed: the pane was already known-busy, so a post-send geometry read
 *      would be near-certain to read "not delivered" regardless of whether
 *      the payload actually landed, and retrying it would just resend the
 *      same narration line up to `maxAttempts` times. The caller is never
 *      blocked indefinitely either way.
 *   2. Baseline + send (idle path only, EXACTLY ONCE; US-001, CAM-375 send-once
 *      guard): immediately BEFORE the single send-keys call, sample the
 *      pane's cursor geometry as the baseline via `sampleGeometryFn` (default
 *      `sampleCursorGeometry`, src/tmux/display-message.ts). Then issue ONE
 *      `send-keys` invocation: text and 'Enter' are passed as discrete argv
 *      elements in a single call, WITHOUT `-l`. With `-l` every arg is
 *      literal, so 'Enter' would be typed as the text "Enter" and never
 *      submit (sendkeys-literal-enter-gotcha, CAM-55). The text is a single
 *      non-key-name arg, so tmux already sends its characters literally; only
 *      'Enter' must stay a recognised key. This send is never repeated below,
 *      even across multiple verify attempts: a persistent geometry-oracle
 *      false-negative re-verifies, it does not re-send.
 *   3. Settle + verify, once per attempt (idle path only; US-002, CAM-359;
 *      content backstop review round 1 fix US-R1-001; send-once guard
 *      US-001, CAM-375): after the send above, sleep `SEND_KEYS_SETTLE_MS`
 *      (via the injected `sleepFn`, US-001, CAM-358) so tmux has one refresh
 *      cycle to catch up, then sample geometry again. The full `(cursorX,
 *      cursorY)` pair is compared against the SAME baseline sampled in step 2
 *      (never a single axis, never re-sampled per attempt: no new send
 *      occurred to invalidate it). A `null` sample (the geometry helper's
 *      fail-closed result, e.g. a non-zero tmux exit) is treated as NOT
 *      delivered on that attempt, never as delivered. If the pair reads
 *      unchanged, `cursorRowStartsWithPrompt` (US-001, CAM-364) inspects the
 *      row at the reported cursor_y, read via `visibleCaptureFn` (review
 *      round 2 fix, US-R2-001, CAM-359: a DEDICATED visible-screen reader,
 *      never `capturePaneFn`, whose scrollback semantics are unspecified and
 *      would misindex the row), for the prompt glyph sitting at the START of
 *      that row before trusting the "delivered" verdict (module header:
 *      cursor_y is pinned constant in production, so geometry alone cannot
 *      rule out a wrap-boundary-length collision).
 *   4. Retry-the-VERIFY, not the send (idle path only; US-001, CAM-375): if
 *      not delivered, sleep `computeBackoffMs(attempt, ...)`
 *      (src/supervisor/loop.ts:606) and re-run step 3 (settle + resample +
 *      re-verify against the same baseline), up to `maxAttempts` (default 3)
 *      total VERIFY attempts. send-keys itself is never re-issued.
 *
 * `push-undelivered` (via the injected `logEvent`, default: no-op, so callers
 * that don't care about durable events see zero side effects) is NOT
 * exclusively an exhaustion signal: it fires on exhaustion of the idle path's
 * verify/retry loop (still not delivered after `maxAttempts` VERIFY attempts,
 * `reason: 'retries-exhausted'`, `retriesExhausted` counting verify attempts,
 * never physical sends) OR, separately, on the timed-out path's single
 * unverified send (`reason: 'pane-not-idle'`, step 1 above). Never throws and
 * never blocks indefinitely.
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
		sampleGeometryFn = sampleCursorGeometry,
		visibleCaptureFn,
	} = opts;

	const capture = capturePaneFn
		? capturePaneFn
		: (id: string) => defaultCapturePaneFn(id, tmuxSpawnFn);

	// Dedicated visible-screen reader for the prompt-row discriminator (review
	// round 2 fix, US-R2-001, CAM-359): deliberately NOT derived from `capture`
	// above, since `capturePaneFn` may be a full-scrollback reader in
	// production and `cursorRowStartsWithPrompt` (US-001, CAM-364) indexes
	// rows relative to the top of the VISIBLE pane.
	const visibleCapture = visibleCaptureFn
		? visibleCaptureFn
		: (id: string) => defaultCapturePaneFn(id, tmuxSpawnFn);

	const timedOut = waitForIdlePane({ paneId, capture, pollIntervalMs, idleTimeoutMs, sleepFn });
	if (timedOut) {
		sendOnceUnverified({ paneId, text, tmuxSpawnFn, idleTimeoutMs, logEvent });
		return;
	}

	// Baseline: sampled immediately before the single send-keys call (US-002,
	// CAM-359). A null (unknown) sample fails closed below.
	const baseline = sampleGeometryFn(paneId, tmuxSpawnFn);

	// Send-once guard (US-001, CAM-375): the atomic send-keys call fires
	// EXACTLY ONCE on the idle path, text + Enter in ONE call, WITHOUT -l
	// (see flow step 2 above; CAM-55 regression guard). Every verify attempt
	// below re-samples and re-verifies against this SAME baseline; none of
	// them re-issue this call.
	tmuxSpawnFn(
		'tmux',
		tmuxArgs(['send-keys', '-t', paneId, text, 'Enter']),
		{ stdio: 'ignore' },
	);

	let delivered = false;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		sleepFn(SEND_KEYS_SETTLE_MS);

		const after = sampleGeometryFn(paneId, tmuxSpawnFn);

		if (baseline !== null && after !== null && geometryUnchanged(baseline, after)) {
			// Ambiguous branch (review round 1 fix, US-R1-001): the geometry pair
			// alone cannot rule out a wrap-boundary-length collision (module
			// header). Break the tie with the prompt-row discriminator (US-001,
			// CAM-364) before trusting this as delivered.
			const afterContent = visibleCapture(paneId);
			if (cursorRowStartsWithPrompt(afterContent, after.cursorY)) {
				delivered = true;
				break;
			}
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
		logEvent?.('push-undelivered', { paneId, retriesExhausted: maxAttempts, reason: 'retries-exhausted' });
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

/**
 * Adapt a full `WorkerEventLogger` (ts/storyId/uuid/kind/detail) down to the
 * bare `(kind, detail) => void` seam `sendKeysVerified`'s `logEvent` expects
 * (US-003, CAM-359).
 *
 * `storyId` is always `undefined`: a push-undelivered narration from one of
 * these thin-proxy commands is never tied to a story. `uuid` is caller-supplied
 * rather than a single hardcoded constant: `src/supervisor/host.ts` has its own
 * `adaptLogEventForPush` fixed to `uuid: 'sidecar'` because every one of its
 * callers genuinely IS the sidecar process, but a `cam issue`/`cam review`/
 * `cam spec`/`cam orch-recycle-watch` invocation is a distinct CLI command, not
 * the sidecar, so blindly reusing `'sidecar'` there would misattribute the
 * event's origin. Each thin-proxy call site passes its own short, stable label
 * (e.g. `'cli-issue'`).
 */
export function adaptLogEventForPush(
	logEvent: WorkerEventLogger,
	uuid: string,
): (kind: WorkerEventKind, detail: WorkerEventDetail) => void {
	return (kind, detail) => {
		logEvent({ ts: new Date().toISOString(), storyId: undefined, uuid, kind, detail });
	};
}

/**
 * Build the production default `logEvent` for a thin-proxy command's
 * `sendKeysWhenIdle` call (US-003, CAM-359): the real file event logger
 * writing `.claude/cam-worker-events.jsonl`, adapted via
 * `adaptLogEventForPush`. Factored out of each of the four call sites (they'd
 * otherwise each repeat the same `makeFileEventLogger(join(...))` +
 * `adaptLogEventForPush(...)` pair inline).
 */
export function makePushLogEvent(
	cwd: string,
	uuid: string,
): (kind: WorkerEventKind, detail: WorkerEventDetail) => void {
	return adaptLogEventForPush(makeFileEventLogger(join(cwd, '.claude', 'cam-worker-events.jsonl')), uuid);
}
