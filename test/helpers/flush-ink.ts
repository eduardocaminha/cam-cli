// test/helpers/flush-ink.ts
//
// Shared macrotask-flush helpers for ink-testing-library stdin-driven state
// updates (CAM-201). Retires the per-file bun-version-probe + `skipIf` guards
// introduced in CAM-186: instead of skipping the assertion on bun 1.2.x, we
// give React enough turns of the event loop to land the update, on every
// toolchain the loop can run in.
//
// Root cause (see scripts/cam/patterns.md, CAM-186 bullet): `stdin.write(char)`
// fires ink's `useInput` handler synchronously, but flushing the resulting
// React 19 state update into `lastFrame()` takes a variable number of
// macrotask ticks depending on the runtime and the depth of the component
// tree being reconciled (bun 1.2.x is slower to settle than bun >=1.3, and a
// deeply-nested wizard like SetupScreen needs more turns than a single flat
// list). A FIXED tick count (even a generous one) is measurably flaky in this
// environment: increasing repeat-trial testing showed a fixed count can fail
// roughly 1 run in 15-30 depending on load. The deterministic fix is to poll
// `lastFrame()` against the expected predicate, bounded by a generous
// timeout, rather than assume readiness after N ticks.

/** Wait one macrotask tick (a single `setTimeout(0)` turn of the event loop). */
const oneTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Flush ink-testing-library stdin-driven state updates a bounded amount
 * before the next stdin write. This is pacing, not a correctness guarantee:
 * always follow the LAST write in a sequence with `waitForFrame` (below)
 * before asserting on `lastFrame()`.
 */
export const flushInk = async (): Promise<void> => {
	await oneTick();
	await oneTick();
};

export interface WaitForFrameOptions {
	/**
	 * Total time budget to keep polling before giving up. Default 3000ms: Ink
	 * measures the terminal window by shelling out to `tput` synchronously on
	 * every render (see `node_modules/ink/build/utils.js`); under heavy
	 * concurrent-test CPU contention that spawnSync call alone can take
	 * hundreds of milliseconds, so the budget must comfortably exceed a single
	 * macrotask tick while still finishing well inside bun's 5000ms default
	 * per-test timeout.
	 */
	timeoutMs?: number;
	/** Delay between polls. Default 5ms. */
	intervalMs?: number;
}

/**
 * Poll `lastFrame()` until `predicate(frame)` is true or `timeoutMs` elapses.
 * Returns the final frame observed either way (callers still assert on it,
 * so a genuine bug produces a normal, readable assertion failure rather than
 * a silent timeout).
 *
 * This is the version-agnostic replacement for "await N macrotask ticks then
 * read lastFrame() once": the exact number of ticks bun needs to settle a
 * React 19 state update is not a stable constant (it varies by runtime and
 * by how deep the re-rendered tree is), so asserting readiness by content
 * rather than by tick-count removes the flake entirely.
 */
export const waitForFrame = async (
	lastFrame: () => string | undefined,
	predicate: (frame: string) => boolean,
	{ timeoutMs = 3000, intervalMs = 5 }: WaitForFrameOptions = {},
): Promise<string> => {
	const deadline = Date.now() + timeoutMs;
	let frame = lastFrame() ?? '';
	while (!predicate(frame) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		frame = lastFrame() ?? '';
	}
	return frame;
};
