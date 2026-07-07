// test/renovate-config.test.ts
//
// Validates renovate.json (US-008, CAM-153 toolchain-parity PRD): parses as
// JSON, declares coverage for the four toolchain-pin managers (bun-version,
// asdf, dockerfile, github-actions), none of them disabled, automerge:true
// present on patch/minor/major update types, and no ignoreTests escape hatch
// (automerge must stay gated on the required CI status check).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RENOVATE_CONFIG_PATH = join(import.meta.dir, '..', 'renovate.json');

interface RenovatePackageRule {
	matchManagers?: string[];
	matchUpdateTypes?: string[];
	enabled?: boolean;
	automerge?: boolean;
}

interface RenovateConfig {
	$schema?: string;
	packageRules?: RenovatePackageRule[];
}

const REQUIRED_MANAGERS = ['bun-version', 'asdf', 'dockerfile', 'github-actions'];

function readConfig(): RenovateConfig {
	const raw = readFileSync(RENOVATE_CONFIG_PATH, 'utf8');
	return JSON.parse(raw) as RenovateConfig;
}

describe('renovate.json', () => {
	test('parses as valid JSON', () => {
		expect(() => readConfig()).not.toThrow();
	});

	test('declares the renovate config schema', () => {
		const config = readConfig();
		expect(typeof config.$schema).toBe('string');
		expect(config.$schema).toContain('renovate-schema.json');
	});

	test('does not raw-disable ignoreTests anywhere in the file', () => {
		const raw = readFileSync(RENOVATE_CONFIG_PATH, 'utf8');
		expect(raw).not.toContain('ignoreTests');
	});

	for (const manager of REQUIRED_MANAGERS) {
		test(`covers the ${manager} manager, not disabled`, () => {
			const config = readConfig();
			const rules = config.packageRules ?? [];
			const matching = rules.filter((rule) => (rule.matchManagers ?? []).includes(manager));
			expect(matching.length).toBeGreaterThan(0);
			for (const rule of matching) {
				expect(rule.enabled).not.toBe(false);
			}
		});

		test(`enables automerge:true for patch, minor, and major on ${manager}`, () => {
			const config = readConfig();
			const rules = config.packageRules ?? [];
			const matching = rules.filter((rule) => (rule.matchManagers ?? []).includes(manager));
			expect(matching.length).toBeGreaterThan(0);
			for (const rule of matching) {
				expect(rule.automerge).toBe(true);
				expect(rule.matchUpdateTypes ?? []).toContain('patch');
				expect(rule.matchUpdateTypes ?? []).toContain('minor');
				expect(rule.matchUpdateTypes ?? []).toContain('major');
			}
		});
	}
});
