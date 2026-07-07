// Fixture (guard positive case): single-hop derived variable (a boolean
// built directly from Bun.version, no intermediate destructure step).
import { expect, it } from 'bun:test';

const bunOk = Bun.version.split('.')[0] === '1';

it.skipIf(!bunOk)('some ink stdin test', () => {
	expect(1).toBe(1);
});
