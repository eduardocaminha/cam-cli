// test/helpers/with-fake-clock.ts
//
// Shared fake-clock + stderr-capture helper (US-001, CAM-362). Two sites in
// test/dispatch.test.ts (the sendKeysWhenIdle default-deadline test and the
// CAM-373 idle-gate exactly-once test) each hand-rolled the same
// `Date.now`/`process.stderr.write` monkeypatch idiom, with the restore step
// living in a `finally` block at each call site rather than in one place.
// Duplicated monkeypatch-with-manual-restore is leak-prone if it's ever
// copied a third time and someone forgets (or mis-orders) the restore: this
// helper makes the restore unconditional and impossible to omit, by putting
// it in the ONE `finally` block the callback runs under, not in caller code.

/** Context handed to the `withFakeClock` callback. */
export interface FakeClockContext {
	/** Advance the fake clock by `ms` (mutates the value `Date.now()` returns). */
	advance(ms: number): void;
	/** Chunks captured from every `process.stderr.write` call so far, in order. */
	chunks: string[];
}

/**
 * Install a fake clock (`Date.now` returns a mutable counter starting at 0)
 * and a chunk-capturing `process.stderr.write` stub, run `callback` with a
 * context exposing `advance(ms)` and the captured `chunks`, then restore BOTH
 * globals in a `finally` block. Restoration is guaranteed even if `callback`
 * throws, so a test that fails mid-assertion cannot leak a patched
 * `Date.now`/`process.stderr.write` into later tests in the same process.
 */
export function withFakeClock(callback: (ctx: FakeClockContext) => void): void {
	const originalNow = Date.now;
	const originalWrite = process.stderr.write;
	let fakeNow = 0;
	const chunks: string[] = [];

	Date.now = () => fakeNow;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stderr.write;

	try {
		callback({
			advance(ms: number) {
				fakeNow += ms;
			},
			chunks,
		});
	} finally {
		Date.now = originalNow;
		process.stderr.write = originalWrite;
	}
}
