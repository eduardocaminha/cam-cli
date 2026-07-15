// Fixture (guard positive case): proves the guard is not a name-only grep
// for the historical "bunVersionOk" identifier -- a differently-named
// variable derived from Bun.version must still be caught.
import { expect, test } from 'bun:test';

const [maj] = Bun.version.split('.');
const runtimeIsModern = parseInt(maj ?? '0', 10) >= 2;

test.skipIf(!runtimeIsModern)('modern-runtime-only behavior', () => {
	expect(1).toBe(1);
});
