// test/ship-args.test.ts
//
// Unit tests for `cam ship --finalize` wiring (US-002 acceptance criteria).
//
// Coverage:
//   (a) parseShipArgs(['--finalize']) returns {help:false, finalize:true}.
//   (b) dispatchShip routes --finalize to finalizeFn (called exactly once)
//       and NEVER calls runShipFn. Proved via injected fakes, not grep.
//
// The --finalize path is in-process: no tmux session, no send-keys, no
// bootstrap. The behavioral oracle (bun test test/ship-args.test.ts) is the
// load-bearing assertion for AC5.

import { describe, expect, test } from 'bun:test';
import { parseShipArgs, dispatchShip, type ShipDispatchDeps } from '../index.ts';
import type { FinalizeCycleCloseResult } from '../src/commands/ship-finalize.ts';

// ---------------------------------------------------------------------------
// (a) parseShipArgs: --finalize flag
// ---------------------------------------------------------------------------

describe('parseShipArgs — --finalize flag', () => {
	test("parseShipArgs(['--finalize']) returns {help:false, finalize:true, bump:false}", () => {
		expect(parseShipArgs(['--finalize'])).toEqual({ help: false, finalize: true, bump: false });
	});

	test("parseShipArgs([]) returns {help:false, finalize:false, bump:false}", () => {
		expect(parseShipArgs([])).toEqual({ help: false, finalize: false, bump: false });
	});

	test("parseShipArgs(['--finalize', '--help']) returns {help:true, finalize:true, bump:false}", () => {
		expect(parseShipArgs(['--finalize', '--help'])).toEqual({ help: true, finalize: true, bump: false });
	});
});

// ---------------------------------------------------------------------------
// (b) dispatchShip: --finalize path calls finalizeFn once, runShipFn zero times
// ---------------------------------------------------------------------------

/** Minimal valid FinalizeCycleCloseResult for fake injection. */
function fakeResult(): FinalizeCycleCloseResult {
	return {
		issueId: 'CAM-72',
		issueBackend: 'none',
		issueLocalClosed: false,
		commitMessage: 'chore(cam): close CAM-72 + drop per-branch harness state (CAM-27 hygiene)',
	};
}

describe('dispatchShip — --finalize path', () => {
	test('calls finalizeFn exactly once on --finalize and returns 0', async () => {
		let finalizeCalled = 0;

		const deps: ShipDispatchDeps = {
			finalizeFn: () => {
				finalizeCalled++;
				return fakeResult();
			},
			runShipFn: async () => {
				// Should NEVER be called on the --finalize path.
				throw new Error('runShipFn must not be called when --finalize is set');
			},
		};

		const code = await dispatchShip({ help: false, finalize: true, bump: false }, deps);

		expect(code).toBe(0);
		expect(finalizeCalled).toBe(1);
	});

	test('runShipFn is invoked exactly zero times on --finalize path', async () => {
		let runShipCalled = 0;

		const deps: ShipDispatchDeps = {
			finalizeFn: () => fakeResult(),
			runShipFn: async () => {
				runShipCalled++;
				return 0;
			},
		};

		await dispatchShip({ help: false, finalize: true, bump: false }, deps);

		expect(runShipCalled).toBe(0);
	});

	test('without --finalize, calls runShipFn and NOT finalizeFn', async () => {
		let finalizeCalled = 0;
		let runShipCalled = 0;

		const deps: ShipDispatchDeps = {
			finalizeFn: () => {
				finalizeCalled++;
				return fakeResult();
			},
			runShipFn: async () => {
				runShipCalled++;
				return 0;
			},
		};

		const code = await dispatchShip({ help: false, finalize: false, bump: false }, deps);

		expect(code).toBe(0);
		expect(runShipCalled).toBe(1);
		expect(finalizeCalled).toBe(0);
	});

	test('returns 1 when finalizeFn throws', async () => {
		// Suppress stderr output from printError
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			const deps: ShipDispatchDeps = {
				finalizeFn: () => {
					throw new Error('git rm failed');
				},
			};

			const code = await dispatchShip({ help: false, finalize: true, bump: false }, deps);
			expect(code).toBe(1);
		} finally {
			process.stderr.write = original;
		}
	});
});
