import { describe, expect, test } from 'bun:test';

import { EVIDENCE_LIMITS, fingerprintSpec, hasVerification, validateSpec } from '../../src/issues/spec.ts';

describe('direct issue spec', () => {
	test('fingerprints the normalized executable contract deterministically', () => {
		const base = { scope: ' Outcome ', verify: [' bun test one ', 'bun test two'] };
		const fingerprint = fingerprintSpec(base);
		expect(fingerprintSpec(base)).toBe(fingerprint);
		expect(fingerprintSpec({ scope: 'Outcome', verify: ['bun test one', 'bun test two'] }))
			.toBe(fingerprint);
		expect(fingerprintSpec({ scope: 'Changed', verify: base.verify })).not.toBe(fingerprint);
		expect(fingerprintSpec({ scope: base.scope, verify: ['changed', base.verify[1]!] }))
			.not.toBe(fingerprint);
		expect(fingerprintSpec({ scope: base.scope, verify: [base.verify[0]!, 'changed'] }))
			.not.toBe(fingerprint);
		expect(fingerprintSpec({ scope: 'Outcome' }))
			.toBe(fingerprintSpec({ scope: 'Outcome', verify: [] }));
	});

	test('accepts the minimal scope plus verification contract', () => {
		expect(validateSpec({
			scope: 'A página mostra o estado do run.',
			verify: ['bun test test/web/run-api.test.ts'],
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

	test('plannability recognizes the direct contract only', () => {
		expect(hasVerification({ scope: 'new', verify: ['bun test'] })).toBe(true);
		expect(hasVerification({ scope: 'missing' })).toBe(false);
		expect(hasVerification(undefined)).toBe(false);
	});

	// GSHIP-629: the spec's executable premise, symmetric to verify.
	describe('evidence', () => {
		test('accepts a spec whose evidence commands and outputs are both non-empty', () => {
			expect(validateSpec({
				scope: 'A spec backed by measurement.',
				verify: ['bun test'],
				evidence: [
					{ command: 'ls src/domain-models | wc -l', output: '3' },
					{ command: 'git log --oneline -1', output: 'abc1234 seed' },
				],
			})).toEqual({ ok: true, errors: [] });
		});

		test('a spec with no evidence field is unaffected -- every already-filed issue lacks it', () => {
			expect(validateSpec({
				scope: 'A spec with no evidence at all.',
				verify: ['bun test'],
			})).toEqual({ ok: true, errors: [] });
		});

		test('rejects more than the maximum number of evidence items', () => {
			const tooMany = Array.from(
				{ length: EVIDENCE_LIMITS.maxItems + 1 },
				(_unused, index) => ({ command: `cmd ${index}`, output: `out ${index}` }),
			);
			const result = validateSpec({ scope: 'Outcome.', verify: ['bun test'], evidence: tooMany });
			expect(result.ok).toBe(false);
			expect(result.errors).toContain(
				`evidence accepts at most ${EVIDENCE_LIMITS.maxItems} items`,
			);
		});

		test('rejects an evidence item with an empty command or output', () => {
			expect(validateSpec({
				scope: 'Outcome.',
				verify: ['bun test'],
				evidence: [{ command: '  ', output: 'observed' }],
			})).toMatchObject({ ok: false });
			expect(validateSpec({
				scope: 'Outcome.',
				verify: ['bun test'],
				evidence: [{ command: 'ls', output: '  ' }],
			})).toMatchObject({ ok: false });
		});

		test('rejects a command or output past the size limit', () => {
			const longCommand = 'x'.repeat(EVIDENCE_LIMITS.command + 1);
			const longOutput = 'y'.repeat(EVIDENCE_LIMITS.output + 1);
			expect(validateSpec({
				scope: 'Outcome.',
				verify: ['bun test'],
				evidence: [{ command: longCommand, output: 'fine' }],
			})).toMatchObject({ ok: false });
			expect(validateSpec({
				scope: 'Outcome.',
				verify: ['bun test'],
				evidence: [{ command: 'fine', output: longOutput }],
			})).toMatchObject({ ok: false });
		});

		test('is part of the approved executable fingerprint', () => {
			const base = { scope: 'Outcome.', verify: ['bun test'] };
			const withEvidence = {
				...base,
				evidence: [{ command: 'ls', output: 'a\nb' }],
			};
			expect(fingerprintSpec(withEvidence)).not.toBe(fingerprintSpec(base));
			expect(fingerprintSpec({
				...withEvidence,
				evidence: [{ command: ' ls ', output: ' a\nb ' }],
			})).toBe(fingerprintSpec(withEvidence));
			expect(fingerprintSpec({
				...withEvidence,
				evidence: [{ command: 'pwd', output: 'a\nb' }],
			})).not.toBe(fingerprintSpec(withEvidence));
			expect(fingerprintSpec({
				...withEvidence,
				evidence: [{ command: 'ls', output: 'changed' }],
			})).not.toBe(fingerprintSpec(withEvidence));
		});
	});
});
