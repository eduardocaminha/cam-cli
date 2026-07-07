// Fixture (guard positive case): direct Bun.version reference inline in the
// skipIf condition, no intermediate variable. Consumed by
// test/check-version-skips.test.ts via readFileSync; not a real test file
// (bun test's default glob does not match plain .ts files without a
// .test./.spec. suffix, so this is never executed as a test).
import { expect, test } from 'bun:test';

test.skipIf(Bun.version.startsWith('1.2'))('some ink stdin test', () => {
	expect(1).toBe(1);
});
