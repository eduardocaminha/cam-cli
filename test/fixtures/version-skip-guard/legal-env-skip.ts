// Fixture (guard negative case): process.env is NOT a toolchain version and
// must stay legal.
import { expect, test } from 'bun:test';

test.skipIf(!process.env['CI'])('ci-only smoke test', () => {
	expect(1).toBe(1);
});
