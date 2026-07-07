// Fixture (guard negative case): process.platform is NOT a toolchain
// version and must stay legal.
import { expect, test } from 'bun:test';

const isWindows = process.platform === 'win32';

test.skipIf(isWindows)('posix-only path handling', () => {
	expect(1).toBe(1);
});
