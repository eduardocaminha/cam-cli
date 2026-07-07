// Fixture (guard positive case): process.versions reference inline in a
// skipUnless condition. `skipUnless` is not part of bun:test's real public
// API (the guard treats it as a textual pattern per the story's acceptance
// criteria, not a runtime-verified call); suppress the resulting type error.
import { expect, test } from 'bun:test';

// @ts-expect-error -- skipUnless is a guard-detected form only, see comment above.
test.skipUnless(process.versions.bun !== undefined)('bun-only api', () => {
	expect(1).toBe(1);
});
