import { describe, expect, test } from 'bun:test';

import { hasVerification, validateSpec } from '../../src/issues/spec.ts';

describe('direct issue spec', () => {
	test('accepts the minimal scope plus verification contract', () => {
		expect(validateSpec({
			scope: 'A página mostra o estado do run.',
			verify: ['bun test test/web/run-api.test.ts'],
		})).toEqual({ ok: true, errors: [] });
	});

	test('keeps legacy acceptance criteria readable during backlog migration', () => {
		expect(validateSpec({
			scope: 'Legacy issue.',
			acceptanceCriteria: ['works [oracle: bun test]'],
			gotchas: [],
			domainTerms: [],
		})).toEqual({ ok: true, errors: [] });
	});

	test('requires an object, an outcome and at least one nonblank command', () => {
		expect(validateSpec(null)).toEqual({
			ok: false,
			errors: ['spec must be a non-null object'],
		});
		expect(validateSpec({ scope: '', verify: ['bun test'] })).toMatchObject({ ok: false });
		expect(validateSpec({ scope: 'Outcome', verify: [] })).toEqual({
			ok: false,
			errors: ['spec requires non-empty verify commands'],
		});
		expect(validateSpec({ scope: 'Outcome', verify: ['  '] })).toMatchObject({ ok: false });
	});

	test('plannability recognizes direct and legacy contracts only', () => {
		expect(hasVerification({ scope: 'new', verify: ['bun test'] })).toBe(true);
		expect(hasVerification({ scope: 'old', acceptanceCriteria: ['AC'] })).toBe(true);
		expect(hasVerification({ scope: 'missing' })).toBe(false);
		expect(hasVerification(undefined)).toBe(false);
	});
});
