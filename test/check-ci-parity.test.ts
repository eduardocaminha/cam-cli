// test/check-ci-parity.test.ts
//
// Unit tests for scripts/check-ci-parity.ts (US-002, CAM-59 PRD).
//
// All parsing is offline: fixtures are YAML files under test/fixtures/.
// No shell-out to real GitHub Actions or live network calls.
//
// Coverage:
//   extractBunRunScripts: pulls 'bun run X' script names from run: steps.
//   checkParity: aligned workflow passes; unknown script fails; missing gate fails.
//   checkParityFromFile: missing ci.yml path returns a clear non-crash error.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	checkBunVersionPin,
	checkParity,
	checkParityFromFile,
	extractBunRunScripts,
} from '../scripts/check-ci-parity.ts';
import { GATES, type Gate } from '../scripts/check-all.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

function loadFixture(name: string): string {
	return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// extractBunRunScripts
// ---------------------------------------------------------------------------

describe('extractBunRunScripts', () => {
	test('extracts bun run script names from all run: steps', () => {
		const yaml = loadFixture('aligned.yml');
		const scripts = extractBunRunScripts(yaml);
		expect(scripts).toContain('check:all');
	});

	test('returns empty array for empty YAML', () => {
		expect(extractBunRunScripts('')).toEqual([]);
	});

	test('does not include bun install (not a bun run command)', () => {
		const yaml = loadFixture('aligned.yml');
		const scripts = extractBunRunScripts(yaml);
		expect(scripts).not.toContain('install');
	});

	test('captures unknown-script fixture scripts', () => {
		const yaml = loadFixture('unknown-script.yml');
		const scripts = extractBunRunScripts(yaml);
		expect(scripts).toContain('check:all');
		expect(scripts).toContain('mystery-script');
	});

	test('captures missing-gate fixture scripts', () => {
		const yaml = loadFixture('missing-gate.yml');
		const scripts = extractBunRunScripts(yaml);
		expect(scripts).toContain('typecheck');
		expect(scripts).toContain('test');
		expect(scripts).not.toContain('embed-vendor');
		expect(scripts).not.toContain('check:all');
	});
});

// ---------------------------------------------------------------------------
// checkParity: aligned workflow
// ---------------------------------------------------------------------------

describe('checkParity - aligned workflow', () => {
	test('passes when CI has bun run check:all (spine covers all gates)', () => {
		const yaml = loadFixture('aligned.yml');
		const result = checkParity(yaml, GATES);
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test('passes with injected single-gate manifest when spine is present', () => {
		const yaml = loadFixture('aligned.yml');
		const singleGate: Gate[] = [{ name: 'typecheck', cmd: 'bunx', args: ['tsc', '--noEmit'] }];
		const result = checkParity(yaml, singleGate);
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// checkParity: unknown-script workflow
// ---------------------------------------------------------------------------

describe('checkParity - unknown-script workflow', () => {
	test('fails when CI invokes a script not in the GATES manifest', () => {
		const yaml = loadFixture('unknown-script.yml');
		const result = checkParity(yaml, GATES);
		expect(result.ok).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	test('error message names the drifted script (mystery-script)', () => {
		const yaml = loadFixture('unknown-script.yml');
		const result = checkParity(yaml, GATES);
		const allErrors = result.errors.join('\n');
		expect(allErrors).toContain('mystery-script');
	});

	test('does not report check:all as unknown (it is allowlisted)', () => {
		const yaml = loadFixture('unknown-script.yml');
		const result = checkParity(yaml, GATES);
		for (const err of result.errors) {
			expect(err).not.toContain("'bun run check:all'");
		}
	});
});

// ---------------------------------------------------------------------------
// checkParity: missing-gate workflow
// ---------------------------------------------------------------------------

describe('checkParity - missing-gate workflow', () => {
	test('fails when a manifest gate is not covered by CI', () => {
		const yaml = loadFixture('missing-gate.yml');
		const result = checkParity(yaml, GATES);
		expect(result.ok).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	test('error message names the missing gate (embed-vendor)', () => {
		const yaml = loadFixture('missing-gate.yml');
		const result = checkParity(yaml, GATES);
		const allErrors = result.errors.join('\n');
		expect(allErrors).toContain('embed-vendor');
	});

	test('does not report typecheck or test as unknown (both are gate names)', () => {
		const yaml = loadFixture('missing-gate.yml');
		const result = checkParity(yaml, GATES);
		for (const err of result.errors) {
			expect(err).not.toContain("'bun run typecheck'");
			expect(err).not.toContain("'bun run test'");
		}
	});
});

// ---------------------------------------------------------------------------
// checkBunVersionPin: passing shapes
// ---------------------------------------------------------------------------

describe('checkBunVersionPin - passing workflow shapes', () => {
	test('passes when setup-bun pins via bun-version-file: .bun-version and the pin file is valid', () => {
		const yaml = loadFixture('bun-pin-aligned.yml');
		const result = checkBunVersionPin(yaml, '1.3.13');
		expect(result.ok).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// checkBunVersionPin: failing shapes
// ---------------------------------------------------------------------------

describe('checkBunVersionPin - failing workflow shapes', () => {
	test('fails when the setup-bun step lacks bun-version-file', () => {
		const yaml = loadFixture('bun-pin-missing.yml');
		const result = checkBunVersionPin(yaml, '1.3.13');
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('bun-version-file: .bun-version');
	});

	test('fails when the setup-bun step floats via bun-version: latest', () => {
		const yaml = loadFixture('bun-pin-floating.yml');
		const result = checkBunVersionPin(yaml, '1.3.13');
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('floats via');
	});

	test('fails when there is no oven-sh/setup-bun step at all', () => {
		const yaml = loadFixture('bun-pin-no-step.yml');
		const result = checkBunVersionPin(yaml, '1.3.13');
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('no oven-sh/setup-bun step');
	});

	test('fails when the .bun-version pin file is absent/malformed (pinnedBunVersion is null)', () => {
		const yaml = loadFixture('bun-pin-aligned.yml');
		const result = checkBunVersionPin(yaml, null);
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('.bun-version is missing or malformed');
	});

	test('does not throw on empty YAML and reports a clear error', () => {
		const result = checkBunVersionPin('', '1.3.13');
		expect(result.ok).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// checkParityFromFile: bun-version-file pin is enforced end-to-end
// ---------------------------------------------------------------------------

describe('checkParityFromFile - bun-version-file pin enforcement', () => {
	test('passes against the real ci.yml (which pins bun-version-file: .bun-version)', () => {
		const realCiYml = join(import.meta.dir, '..', '.github', 'workflows', 'ci.yml');
		const result = checkParityFromFile(realCiYml, GATES);
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// checkParityFromFile: missing ci.yml
// ---------------------------------------------------------------------------

describe('checkParityFromFile - missing ci.yml', () => {
	test('returns ok:false when ci.yml does not exist', () => {
		const result = checkParityFromFile('/nonexistent/path/does-not-exist/ci.yml', GATES);
		expect(result.ok).toBe(false);
	});

	test('error message contains "ci.yml not found" when file is missing', () => {
		const result = checkParityFromFile('/nonexistent/path/does-not-exist/ci.yml', GATES);
		expect(result.errors.length).toBeGreaterThan(0);
		const allErrors = result.errors.join('\n');
		expect(allErrors).toContain('ci.yml not found');
	});

	test('does not throw when ci.yml is missing (non-crash requirement)', () => {
		expect(() => {
			checkParityFromFile('/nonexistent/path/does-not-exist/ci.yml', GATES);
		}).not.toThrow();
	});
});
