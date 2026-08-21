// test/next-release-version.test.ts
//
// Unit coverage for the deterministic next-release-version selector
// (GSHIP-665) the automatic release path in .github/workflows/release.yml
// uses to choose a tag after a CI-confirmed merge to main. Pre-1.0
// convention: always increment the highest valid tag's MINOR and reset
// PATCH to zero; MAJOR never moves on its own.

import { describe, expect, test } from 'bun:test';

import { nextReleaseVersion } from '../scripts/next-release-version.ts';

describe('nextReleaseVersion', () => {
	test('no tags at all starts the pre-1.0 convention at v0.1.0', () => {
		expect(nextReleaseVersion([])).toBe('v0.1.0');
	});

	test('invalid tags alone are ignored entirely, same as no tags', () => {
		expect(
			nextReleaseVersion(['not-a-tag', 'v1.2', 'v1.2.3.4', '1.2.3', 'v1.2.3-rc1', 'vX.Y.Z']),
		).toBe('v0.1.0');
	});

	test('increments MINOR and resets PATCH off the one existing tag', () => {
		expect(nextReleaseVersion(['v0.293.0'])).toBe('v0.294.0');
	});

	test('a historical PATCH release still only produces a MINOR bump going forward', () => {
		expect(nextReleaseVersion(['v0.1.0', 'v0.1.1'])).toBe('v0.2.0');
	});

	test('unsorted input still finds the true highest tag', () => {
		expect(nextReleaseVersion(['v0.2.0', 'v0.10.0', 'v0.1.0', 'v0.9.0'])).toBe('v0.11.0');
	});

	test('ordering is numeric, not lexicographic: v0.10.0 outranks v0.9.0', () => {
		expect(nextReleaseVersion(['v0.9.0', 'v0.10.0'])).toBe('v0.11.0');
	});

	test('MAJOR outranks MINOR regardless of list position', () => {
		expect(nextReleaseVersion(['v1.0.0', 'v0.999.0'])).toBe('v1.1.0');
	});

	test('valid tags mixed with invalid ones still resolve to the true highest', () => {
		expect(nextReleaseVersion(['garbage', 'v0.5.0', 'v2', 'v0.20.0', 'v0.20'])).toBe('v0.21.0');
	});
});
