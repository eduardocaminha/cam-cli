// test/preflight-deps.test.ts
//
// Fail-loud preflight for the suite's hard dependencies (US-002, CAM-424).
//
// Route rationale (AC13, per handoff.json notes): package.json's "test"
// script is plain `bun test`, and Bun's [test].preload FAILURE/abort
// semantics (what happens if a preload script's top-level code throws) are
// not documented, only its success-path Global Setup/Teardown shape is
// (https://bun.sh/docs/test/lifecycle). A bunfig.toml now exists
// (US-R1-002, CAM-508) wiring test/helpers/reap-preload.ts's `afterAll`
// scratch-dir teardown, but that is an unrelated, already-proven-safe
// success-path hook, not a preload throw -- it doesn't change the
// uncertainty this file's design avoids. So this file is deliberately just
// a set of ordinary `test()` blocks -- one per hard dependency -- that fail
// via a normal assertion when that dependency is absent and unwaived. No
// preload throw, no reliance on filename sort order.
//
// Each test calls depPreflight({ name }) with NO injected `available`/
// `waived` -- i.e. the real production default wiring (Bun.which(name) probe
// + real CAM_TEST_WAIVERS env read, see test-deps.ts). That is what makes
// this file a real-I/O fail-loud gate: run the suite on a host missing tmux
// (see the AC3 oracle in the PRD, which does real PATH surgery to prove
// this), and the "tmux" test below fails with an actionable message naming
// the binary and how to install it (e.g. `brew install tmux`), instead of a
// partial run silently presenting as green.
//
// `ps` is intentionally excluded: it is classified 'legitimate-environmental'
// in test-deps.ts (absent in the oven/bun:1.2-slim worker container, which is
// expected there), not a hard dependency this preflight should fail loudly
// on.

import { describe, expect, test } from 'bun:test';
import { depPreflight, getDepInfo, type DepName } from './helpers/test-deps.ts';

/** The hard dependencies this suite fails loudly on when absent+unwaived. `ps` is excluded (see header). */
const HARD_DEPENDENCIES: readonly DepName[] = ['tmux', 'git', 'jq', 'pgrep', 'uuidgen', 'bun'];

describe('preflight: hard dependencies are present on PATH (or explicitly waived)', () => {
	for (const name of HARD_DEPENDENCIES) {
		test(`${name} is available on PATH, or waived via CAM_TEST_WAIVERS=${name}`, () => {
			// Real production wiring: real Bun.which(name) probe, real env read.
			// No DI injection here -- this is the actual fail-loud gate.
			const result = depPreflight({ name });
			if (result.kind === 'fail') {
				// A plain thrown assertion failure: this is what makes `bun test`
				// exit non-zero on a host missing a hard dependency. The message
				// carries the binary name plus its actionable install hint, e.g.
				// tmux's hint reads "...install it (`brew install tmux` on macOS,
				// `apt-get install tmux` on Debian/Ubuntu)...".
				throw new Error(result.message);
			}
			expect(result.kind).not.toBe('fail');
		});
	}
});

describe('preflight tests are unit-covered through the DI seam (AC4)', () => {
	for (const name of HARD_DEPENDENCIES) {
		test(`${name}: absent + unwaived fails, naming the binary with its install hint`, () => {
			const result = depPreflight({ name, available: () => false, waived: () => false });
			expect(result.kind).toBe('fail');
			if (result.kind === 'fail') {
				expect(result.message).toContain(name);
				expect(result.message).toContain(getDepInfo(name).installHint);
			}
		});

		test(`${name}: absent + waived passes (skip-allowed)`, () => {
			const result = depPreflight({ name, available: () => false, waived: () => true });
			expect(result.kind).toBe('skip');
		});

		test(`${name}: present passes regardless of waiver state`, () => {
			const result = depPreflight({
				name,
				available: () => true,
				waived: () => {
					throw new Error('waived() must not be invoked when the dependency is available');
				},
			});
			expect(result.kind).toBe('available');
		});
	}

	// tmux's install hint literally names `brew install tmux`: keep an explicit
	// assertion on it (not just the generic getDepInfo() round-trip above) so
	// this file is directly grep-able for the actionable macOS install command.
	test('tmux install hint names the macOS and Debian/Ubuntu install commands', () => {
		const result = depPreflight({ name: 'tmux', available: () => false, waived: () => false });
		expect(result.kind).toBe('fail');
		if (result.kind === 'fail') {
			expect(result.message).toMatch(/brew install tmux/);
			expect(result.message).toMatch(/apt-get install tmux/);
		}
	});
});
