import { describe, expect, test } from 'bun:test';

import { checkCoverage, parseCoverageOutput } from '../scripts/check-coverage.ts';

describe('coverage gate', () => {
	test('parses Bun aggregate coverage', () => {
		expect(parseCoverageOutput('All files | 81.25 | 90.50')).toEqual({
			functions: 81.25,
			lines: 90.5,
		});
	});

	test('missing aggregate row cannot pass a positive floor', () => {
		expect(parseCoverageOutput('no coverage table')).toEqual({ functions: 0, lines: 0 });
	});

	test('passes at the configured floors', () => {
		expect(checkCoverage({
			getCoverage: () => ({ functions: 80, lines: 85 }),
			readBudget: () => ({ floors: { functions: 80, lines: 85 } }),
		})).toEqual({ ok: true, errors: [] });
	});

	test('reports every metric below its floor', () => {
		const result = checkCoverage({
			getCoverage: () => ({ functions: 70, lines: 75 }),
			readBudget: () => ({ floors: { functions: 80, lines: 85 } }),
		});
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('functions');
		expect(result.errors.join('\n')).toContain('lines');
	});
});
