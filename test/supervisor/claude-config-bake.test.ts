// test/supervisor/claude-config-bake.test.ts
//
// File-assert tests for the claude onboarding + /workspace trust config baked
// into the cam-worker image (US-001, CAM-179).
//
// These tests mirror the acceptance-criteria oracles:
//   AC1 - claude-config.json parses as JSON with exactly the five required keys
//   AC2 - Dockerfile COPY of claude-config.json to /home/bun/.claude.json is present,
//         with no --chown flag and no extra chown line for it
//   AC3 - The COPY appears BEFORE the `ARG HOST_UID` line in the Dockerfile
//   AC4 - This test file contains `ARG HOST_UID` (self-referential file-assert oracle)
//
// The .devcontainer/ directory is NOT embedded/vendored, so no embed-vendor step.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const DEVCONTAINER_DIR = join(ROOT, '.devcontainer');

const dockerfileContent = readFileSync(join(DEVCONTAINER_DIR, 'Dockerfile'), 'utf8');
const configRaw = readFileSync(join(DEVCONTAINER_DIR, 'claude-config.json'), 'utf8');

// ---------------------------------------------------------------------------
// AC1: claude-config.json parses and contains exactly the five required keys
// ---------------------------------------------------------------------------

describe('claude-config.json shape (AC1)', () => {
	let config: Record<string, unknown>;

	test('parses as valid JSON', () => {
		config = JSON.parse(configRaw) as Record<string, unknown>;
		expect(config).toBeTruthy();
	});

	test('hasCompletedOnboarding is true', () => {
		const parsed = JSON.parse(configRaw) as Record<string, unknown>;
		expect(parsed['hasCompletedOnboarding']).toBe(true);
	});

	test('theme is "dark"', () => {
		const parsed = JSON.parse(configRaw) as Record<string, unknown>;
		expect(parsed['theme']).toBe('dark');
	});

	test('bypassPermissionsModeAccepted is true', () => {
		const parsed = JSON.parse(configRaw) as Record<string, unknown>;
		expect(parsed['bypassPermissionsModeAccepted']).toBe(true);
	});

	test('projects["/workspace"].hasTrustDialogAccepted is true', () => {
		const parsed = JSON.parse(configRaw) as Record<string, unknown>;
		const projects = parsed['projects'] as Record<string, Record<string, unknown>>;
		expect(projects['/workspace']?.['hasTrustDialogAccepted']).toBe(true);
	});

	test('projects["/workspace"].hasCompletedProjectOnboarding is true', () => {
		const parsed = JSON.parse(configRaw) as Record<string, unknown>;
		const projects = parsed['projects'] as Record<string, Record<string, unknown>>;
		expect(projects['/workspace']?.['hasCompletedProjectOnboarding']).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC2: Dockerfile COPY is present, no --chown flag, no extra chown for it
// ---------------------------------------------------------------------------

describe('Dockerfile COPY directive (AC2)', () => {
	test('contains COPY .devcontainer/claude-config.json /home/bun/.claude.json', () => {
		expect(dockerfileContent).toContain(
			'COPY .devcontainer/claude-config.json /home/bun/.claude.json',
		);
	});

	test('COPY line does not use --chown flag', () => {
		const copyLine = dockerfileContent
			.split('\n')
			.find((line) => line.includes('claude-config.json'));
		expect(copyLine).toBeDefined();
		expect(copyLine).not.toContain('--chown');
	});

	test('no extra chown line targeting .claude.json', () => {
		expect(dockerfileContent).not.toMatch(/chown[^#\n]*.claude\.json/);
	});
});

// ---------------------------------------------------------------------------
// AC3: COPY appears BEFORE ARG HOST_UID in the Dockerfile
// ---------------------------------------------------------------------------

describe('COPY is positioned before ARG HOST_UID (AC3)', () => {
	test('claude-config.json COPY index is less than ARG HOST_UID directive index', () => {
		const copyIdx = dockerfileContent.indexOf('claude-config.json');
		// Use '\nARG HOST_UID' to match the directive line only, not occurrences of
		// the string inside comments (which would give a false-earlier index).
		const argIdx = dockerfileContent.indexOf('\nARG HOST_UID');
		expect(copyIdx).toBeGreaterThan(-1);
		expect(argIdx).toBeGreaterThan(-1);
		expect(copyIdx).toBeLessThan(argIdx);
	});
});

// ---------------------------------------------------------------------------
// AC4: self-referential file-assert: this file contains `ARG HOST_UID`
// (mirrors the oracle: grep -q 'ARG HOST_UID' test/supervisor/claude-config-bake.test.ts)
// ---------------------------------------------------------------------------

describe('self-referential oracle (AC4)', () => {
	test('this test file contains the string ARG HOST_UID', () => {
		const selfContent = readFileSync(
			join(import.meta.dir, 'claude-config-bake.test.ts'),
			'utf8',
		);
		expect(selfContent).toContain('ARG HOST_UID');
	});
});
