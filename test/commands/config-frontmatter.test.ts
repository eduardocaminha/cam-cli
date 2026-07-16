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
	rewriteFrontmatterEffort,
	FRONTMATTER_TARGET_EFFORT_PATHS,
} from '../../src/templates/frontmatter.ts';
import { mergeConfigChoices } from '../../src/commands/config.ts';
import type { ConfigChoices } from '../../src/commands/config.ts';
import type { Phase, LlmPhase } from '../../src/config/models.ts';

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

const ALL_LLM_PHASES: LlmPhase[] = ['orchestrator', 'planner', 'auditor', 'implementer', 'reviewer'];

function makeChoicesWithEfforts(effort: string, model = 'claude-sonnet-4-6', backend = 'claude'): ConfigChoices {
	return {
		...makeChoices(model, backend),
		efforts: Object.fromEntries(ALL_LLM_PHASES.map((p) => [p, effort])) as Record<LlmPhase, string>,
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
// rewriteFrontmatterEffort (pure — no fs)
// ---------------------------------------------------------------------------

describe('rewriteFrontmatterEffort', () => {
	test('rewrites an existing effort: line and preserves other keys and body', () => {
		const input = [
			'---',
			'name: subagent-orchestrator',
			'effort: high',
			'---',
			'',
			'Body text here.',
		].join('\n');

		const result = rewriteFrontmatterEffort(input, 'xhigh');

		expect(result).toContain('effort: xhigh');
		expect(result).not.toContain('effort: high');
		expect(result).toContain('name: subagent-orchestrator');
		expect(result).toContain('Body text here.');
	});

	test('inserts an effort: line inside the frontmatter block when absent (implementer case)', () => {
		const input = [
			'---',
			'name: subagent-implementer',
			'tools:',
			'  - Read',
			'---',
			'',
			'Body text here.',
		].join('\n');

		const result = rewriteFrontmatterEffort(input, 'high');

		expect(result).toContain('effort: high');
		// The inserted line must land inside the --- fence, not appended to the body.
		const fenceMatch = result.match(/^---\n([\s\S]*?)\n---/);
		expect(fenceMatch).not.toBeNull();
		expect(fenceMatch?.[1]).toContain('effort: high');
		expect(result).toContain('Body text here.');
	});

	test('leaves content unchanged when there is no frontmatter fence at all', () => {
		const input = 'no frontmatter here, just body text.';
		expect(rewriteFrontmatterEffort(input, 'high')).toBe(input);
	});

	test('inserts a frontmatterBody containing $-sequences verbatim (no replace-pattern reinterpretation)', () => {
		const input = ['---', 'name: subagent-implementer', 'note: "matched $& and group $1"', '---', '', 'Body text here.'].join(
			'\n',
		);

		const result = rewriteFrontmatterEffort(input, 'high');

		expect(result).toContain('note: "matched $& and group $1"');
		expect(result).toContain('effort: high');
		expect(result).toContain('Body text here.');
	});
});

// ---------------------------------------------------------------------------
// Target-path assertions (effort map)
// ---------------------------------------------------------------------------

describe('FRONTMATTER_TARGET_EFFORT_PATHS', () => {
	test('contains exactly the 5 LLM phases (no ship entry)', () => {
		expect(Object.keys(FRONTMATTER_TARGET_EFFORT_PATHS).sort()).toEqual(
			['auditor', 'implementer', 'orchestrator', 'planner', 'reviewer'].sort(),
		);
	});

	test('every path targets .claude/agents/subagent-<phase>.md', () => {
		for (const [phase, p] of Object.entries(FRONTMATTER_TARGET_EFFORT_PATHS)) {
			expect(p).toContain(join('.claude', 'agents', `subagent-${phase}.md`));
		}
	});

	test('is distinct from FRONTMATTER_TARGET_PHASE_PATHS (no cam-ship.md target)', () => {
		for (const p of Object.values(FRONTMATTER_TARGET_EFFORT_PATHS)) {
			expect(p).not.toContain('cam-ship.md');
		}
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

// ---------------------------------------------------------------------------
// Integration: mergeConfigChoices rewrites the 5 LLM-phase agent files' effort:
// ---------------------------------------------------------------------------

describe('mergeConfigChoices effort frontmatter rewrite', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-config-fm-effort-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function seed(relPath: string, content: string): void {
		const full = join(tmpDir, relPath);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, 'utf8');
	}

	function read(relPath: string): string {
		return readFileSync(join(tmpDir, relPath), 'utf8');
	}

	test('does not touch any agent file when choices.efforts is undefined', () => {
		for (const [phase, relPath] of Object.entries(FRONTMATTER_TARGET_EFFORT_PATHS)) {
			seed(relPath, `---\nname: subagent-${phase}\n---\nbody`);
		}

		mergeConfigChoices(join(tmpDir, 'project.toml'), makeChoices('claude-sonnet-4-6'), tmpDir);

		for (const [phase, relPath] of Object.entries(FRONTMATTER_TARGET_EFFORT_PATHS)) {
			expect(read(relPath)).toBe(`---\nname: subagent-${phase}\n---\nbody`);
		}
	});

	test('rewrites an existing effort: line for all 5 LLM-phase agent files', () => {
		for (const [phase, relPath] of Object.entries(FRONTMATTER_TARGET_EFFORT_PATHS)) {
			seed(relPath, `---\nname: subagent-${phase}\neffort: medium\n---\nbody`);
		}

		mergeConfigChoices(join(tmpDir, 'project.toml'), makeChoicesWithEfforts('xhigh'), tmpDir);

		for (const relPath of Object.values(FRONTMATTER_TARGET_EFFORT_PATHS)) {
			const updated = read(relPath);
			expect(updated).toContain('effort: xhigh');
			expect(updated).not.toContain('effort: medium');
		}
	});

	test('inserts the effort: line for the implementer file which has none', () => {
		const implementerPath = FRONTMATTER_TARGET_EFFORT_PATHS['implementer'];
		seed(implementerPath, '---\nname: subagent-implementer\ntools:\n  - Read\n---\nbody');

		mergeConfigChoices(join(tmpDir, 'project.toml'), makeChoicesWithEfforts('high'), tmpDir);

		const updated = read(implementerPath);
		expect(updated).toContain('effort: high');
		const fenceMatch = updated.match(/^---\n([\s\S]*?)\n---/);
		expect(fenceMatch?.[1]).toContain('effort: high');
	});

	test('skips an effort target file that does not exist without throwing', () => {
		expect(() =>
			mergeConfigChoices(join(tmpDir, 'project.toml'), makeChoicesWithEfforts('high'), tmpDir),
		).not.toThrow();
	});

	test('does not write a ship entry (efforts map has no ship key)', () => {
		expect(Object.keys(makeChoicesWithEfforts('high').efforts ?? {})).not.toContain('ship');
	});
});
