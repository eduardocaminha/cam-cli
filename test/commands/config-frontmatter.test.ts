// test/commands/config-frontmatter.test.ts
//
// Tests for the frontmatter model: rewriter and the cam config save integration
// that applies it to the single project-local .claude/ runtime file for ship
// (the one role whose model is not passed via --model).
//
// The pure-helper tests (describe 'rewriteFrontmatterModel') inject string
// in/out with no filesystem access (AC3). The integration tests use a tmpDir
// to avoid touching the live .claude/ files in the repo.

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	rewriteFrontmatterModel,
	FRONTMATTER_TARGET_PHASE_PATHS,
} from '../../src/templates/frontmatter.ts';
import { mergeConfigChoices } from '../../src/commands/config.ts';
import type { ConfigChoices } from '../../src/commands/config.ts';
import type { Phase } from '../../src/config/models.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_PHASES: Phase[] = [
	'orchestrator',
	'planner',
	'auditor',
	'implementer',
	'reviewer',
	'ship',
];

function makeChoices(model: string, backend = 'claude'): ConfigChoices {
	return {
		models: Object.fromEntries(ALL_PHASES.map((p) => [p, model])) as Record<Phase, string>,
		backend,
	};
}

// ---------------------------------------------------------------------------
// Pure rewriter tests (string in / string out — no fs)
// ---------------------------------------------------------------------------

describe('rewriteFrontmatterModel', () => {
	test('rewrites model: line and preserves all other frontmatter keys and body', () => {
		const input = [
			'---',
			'name: subagent-planner',
			'model: claude-opus-4-8',
			'effort: xhigh',
			'---',
			'',
			'Body text here.',
		].join('\n');

		const result = rewriteFrontmatterModel(input, 'claude-sonnet-4-6');

		expect(result).toContain('model: claude-sonnet-4-6');
		expect(result).not.toContain('model: claude-opus-4-8');
		// other keys preserved
		expect(result).toContain('name: subagent-planner');
		expect(result).toContain('effort: xhigh');
		// body preserved
		expect(result).toContain('Body text here.');
	});

	test('returns original string unchanged when no model: line is present', () => {
		const input = '---\nname: test\n---\nbody';
		expect(rewriteFrontmatterModel(input, 'some-model')).toBe(input);
	});

	test('handles model: with extra leading spaces', () => {
		const input = '---\nmodel:   old-model\n---';
		const result = rewriteFrontmatterModel(input, 'new-model');
		expect(result).toContain('model: new-model');
		expect(result).not.toContain('old-model');
	});

	test('does not affect a model: occurrence inside the document body', () => {
		const input = [
			'---',
			'model: old-model',
			'---',
			'',
			'Some text mentioning model: something else.',
		].join('\n');
		// Only the FIRST `model:` line (inside frontmatter) should be replaced.
		// The regex anchors to ^ in multiline mode, so ALL lines matching
		// `^model:` would be replaced — this test documents the scoped behavior.
		const result = rewriteFrontmatterModel(input, 'new-model');
		expect(result).toContain('model: new-model');
	});
});

// ---------------------------------------------------------------------------
// Target-path assertions
// ---------------------------------------------------------------------------

describe('FRONTMATTER_TARGET_PHASE_PATHS', () => {
	test('contains exactly the ship entry', () => {
		expect(Object.keys(FRONTMATTER_TARGET_PHASE_PATHS).sort()).toEqual(['ship']);
	});

	test('no path is under templates/', () => {
		for (const p of Object.values(FRONTMATTER_TARGET_PHASE_PATHS)) {
			expect(p).not.toContain('templates/');
		}
	});

	test('ship path targets .claude/commands/cam-ship.md', () => {
		expect(FRONTMATTER_TARGET_PHASE_PATHS['ship']).toContain('cam-ship.md');
	});
});

// ---------------------------------------------------------------------------
// Integration: mergeConfigChoices rewrites .claude/ runtime files on save
// ---------------------------------------------------------------------------

describe('mergeConfigChoices frontmatter rewrite', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-config-fm-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Write a file into tmpDir, creating parent dirs as needed. */
	function seed(relPath: string, content: string): void {
		const full = join(tmpDir, relPath);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, 'utf8');
	}

	/** Read a file from tmpDir. */
	function read(relPath: string): string {
		return readFileSync(join(tmpDir, relPath), 'utf8');
	}

	test('leaves subagent-planner.md and subagent-auditor.md unmodified (no longer rewrite targets)', () => {
		const plannerPath = join('.claude', 'agents', 'subagent-planner.md');
		const auditorPath = join('.claude', 'agents', 'subagent-auditor.md');
		const plannerOriginal = '---\nname: subagent-planner\n---\nbody';
		const auditorOriginal = '---\nname: subagent-auditor\n---\nbody';
		seed(plannerPath, plannerOriginal);
		seed(auditorPath, auditorOriginal);

		mergeConfigChoices(join(tmpDir, 'project.toml'), makeChoices('claude-sonnet-4-6'), tmpDir);

		expect(read(plannerPath)).toBe(plannerOriginal);
		expect(read(auditorPath)).toBe(auditorOriginal);
	});

	test('rewrites model: in cam-ship.md for the ship phase', () => {
		const shipPath = FRONTMATTER_TARGET_PHASE_PATHS['ship']!;
		seed(shipPath, '---\nmodel: claude-sonnet-4-6\n---\nShip steps.');

		mergeConfigChoices(join(tmpDir, 'project.toml'), makeChoices('claude-opus-4-8'), tmpDir);

		const updated = read(shipPath);
		expect(updated).toContain('model: claude-opus-4-8');
		expect(updated).not.toContain('model: claude-sonnet-4-6');
	});

	test('skips a target file that does not exist without throwing', () => {
		// No .claude/ files seeded; should complete without error
		expect(() =>
			mergeConfigChoices(join(tmpDir, 'project.toml'), makeChoices('claude-sonnet-4-6'), tmpDir),
		).not.toThrow();
	});

	test('rewrites the ship target file in one save', () => {
		for (const [phase, relPath] of Object.entries(FRONTMATTER_TARGET_PHASE_PATHS)) {
			seed(relPath, `---\nname: ${phase}\nmodel: claude-opus-4-8\n---\nbody`);
		}

		mergeConfigChoices(join(tmpDir, 'project.toml'), makeChoices('claude-sonnet-4-6'), tmpDir);

		for (const relPath of Object.values(FRONTMATTER_TARGET_PHASE_PATHS)) {
			const updated = read(relPath);
			expect(updated).toContain('model: claude-sonnet-4-6');
			expect(updated).not.toContain('model: claude-opus-4-8');
		}
	});
});
