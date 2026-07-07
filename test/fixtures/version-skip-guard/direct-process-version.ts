// Fixture (guard positive case): direct process.version reference inline in
// a todoIf condition.
import { expect, test } from 'bun:test';

test.todoIf(process.version.startsWith('v16'))('node16-only behavior', () => {
	expect(1).toBe(1);
});
