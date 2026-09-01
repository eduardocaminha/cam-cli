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

	test('accepts one optional project diagnostic command and rejects extra configuration', () => {
		expect(readProjectVerificationManifest(JSON.stringify({
			version: 1,
			verify: ['bun test'],
			diagnostic: { command: 'bun run diagnose' },
		}))).toMatchObject({ diagnostic: { command: 'bun run diagnose' } });
		for (const diagnostic of [null, {}, { command: '' }, { command: '  ' }, { command: 42 }, { command: 'bun test', extra: true }]) {
			expect(() => readProjectVerificationManifest(JSON.stringify({
				version: 1, verify: ['bun test'], diagnostic,
			}))).toThrow('project verification manifest has invalid diagnostic command');
		}
	});
});
