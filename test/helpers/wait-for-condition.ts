// test/helpers/wait-for-condition.ts
//
// Bounded poll-until-true helper for the real-I/O integration tier (US-001,
// CAM-62). Real tmux/git subprocesses cannot have a fake clock injected, so
// tests in that tier need a deterministic "poll until true or bounded
// timeout" primitive instead of a fixed setTimeout/Bun.sleepSync wait. This
// module is intentionally zero-dependency (predicate-in, promise-out; no
// git/tmux/fs calls) so it composes with any real subprocess-driven check.

export interface WaitForConditionOptions {
	/** Total time budget to keep polling before rejecting. Default 5000ms. */
	timeoutMs?: number;
	/** Delay between polls. Default 20ms. */
	intervalMs?: number;
}

/**
 * Repeatedly evaluate `predicate` until it returns true (or a truthy value),
 * then resolve. Rejects if `predicate` stays false past `timeoutMs`, rather
 * than hanging or resolving. `predicate` may be sync or async.
 */
export async function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
	{ timeoutMs = 5000, intervalMs = 20 }: WaitForConditionOptions = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() >= deadline) {
			throw new Error(`waitForCondition: predicate still false after ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
