// test/setup-collection-eof.test.ts
//
// Integration test for US-003 (CAM-104): the readline collection flow
// (collectViaReadline) resolves to the 'immediate' merge_mode default on EOF,
// never hangs.
//
// Why this is distinct from setup-readline-eof.test.ts (US-001):
//   US-001 proves the ask/askChoice PRIMITIVES resolve on EOF.
//   US-003 proves the INTEGRATION (the full collection flow returns
//   mergeMode='immediate' on EOF), the real path the build smoke triggers.
//
// Design constraints (per acceptance criteria):
//   - Does NOT spawn the binary.
//   - Does NOT require claude to be installed.
//   - No skip on claude-absence or any external tool.
//   - Timeout-bounded: Bun's 3rd test() arg is the per-test timeout in ms;
//     the test FAILS if the fn does not resolve before the timeout fires.

import { expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import { collectViaReadline } from '../src/commands/setup.ts';

// ---------------------------------------------------------------------------
// Stream helper
// ---------------------------------------------------------------------------

/** A Readable that immediately signals EOF (no data). */
function makeEofStream(): Readable {
	return new Readable({
		read() {
			this.push(null);
		},
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Timeout of 10 000 ms: the test FAILS (not just hangs) if collectViaReadline
// does not resolve within 10s, proving no hang in the collection flow.
test(
	'collectViaReadline returns mergeMode="immediate" on EOF',
	async () => {
		const result = await collectViaReadline(
			// mergeMode: undefined forces needsMerge=true -> readline branch
			{ mergeMode: undefined, projectMode: 'existing', issueSystem: 'none' },
			makeEofStream(),
		);
		expect(result.mergeMode).toBe('immediate');
	},
	10_000,
);

test(
	'collectViaReadline returns all pre-filled values when no question needs readline',
	async () => {
		// When every option is pre-filled, collectViaReadline returns them directly
		// without touching the input stream at all.
		const result = await collectViaReadline(
			{ projectMode: 'existing', issueSystem: 'none', mergeMode: 'ci-gated' },
			makeEofStream(),
		);
		expect(result.projectMode).toBe('existing');
		expect(result.issueSystem).toBe('none');
		expect(result.mergeMode).toBe('ci-gated');
	},
	10_000,
);

test(
	'collectViaReadline resolves within 5s on EOF (no hang guard)',
	async () => {
		const start = Date.now();
		await collectViaReadline(
			{ mergeMode: undefined, projectMode: 'existing', issueSystem: 'none' },
			makeEofStream(),
		);
		expect(Date.now() - start).toBeLessThan(5000);
	},
	10_000,
);
