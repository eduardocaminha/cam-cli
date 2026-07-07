// Fixture (guard positive case): mirrors the real cam/pr-66 incident shape
// (patterns.md CAM-186/CAM-201) -- a module-level const derived from
// Bun.version (bunVersionOk), consumed by a differently-named boolean, then
// used in skipIf. A name-only grep for "bunVersionOk" would not generalize;
// the guard must trace the derivation chain instead.
import { expect, it } from 'bun:test';

const [_bunMajorStr, _bunMinorStr] = Bun.version.split('.');
const bunVersionOk =
	parseInt(_bunMajorStr ?? '0', 10) > 1 || parseInt(_bunMinorStr ?? '0', 10) >= 3;

it.skipIf(!bunVersionOk)('ink stdin state flushes after one tick', () => {
	expect(1).toBe(1);
});
