import { describe, expect, test } from 'bun:test';

import { readProjectVerificationManifest } from '../../src/runtime/project-verification.ts';

describe('project verification manifest', () => {
	test('preserves prepare presence so absent fallback and explicit empty differ', () => {
		expect(readProjectVerificationManifest(JSON.stringify({
			version: 1,
			verify: ['bun test'],
		}))).toEqual({ version: 1, verify: ['bun test'] });
		expect(readProjectVerificationManifest(JSON.stringify({
			version: 1,
			prepare: [],
			verify: ['bun test'],
		}))).toEqual({ version: 1, prepare: [], verify: ['bun test'] });
		expect(readProjectVerificationManifest(JSON.stringify({
			version: 1,
			prepare: ['npm ci', 'python3 -m venv .venv'],
			verify: ['npm test'],
		}))).toEqual({
			version: 1,
			prepare: ['npm ci', 'python3 -m venv .venv'],
			verify: ['npm test'],
		});
	});

	test('rejects malformed preparation without weakening verification', () => {
		for (const prepare of [null, 'npm ci', [42], [''], ['   ']]) {
			expect(() => readProjectVerificationManifest(JSON.stringify({
				version: 1,
				prepare,
				verify: ['npm test'],
			}))).toThrow('project verification manifest has invalid preparation commands');
		}
	});
});
