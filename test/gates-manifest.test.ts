import { expect, test } from 'bun:test';

import { GATES } from '../scripts/check-all.ts';

test('gate names are unique', () => {
	const names = GATES.map((gate) => gate.name);
	expect(new Set(names).size).toBe(names.length);
});
