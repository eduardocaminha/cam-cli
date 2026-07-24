// test/config/claude-models.test.ts
//
// Unit tests for src/config/claude-models.ts (US-001, CAM-398): the canonical
// claude model vocabulary (CLAUDE_MODEL_ALIASES) and the STRICT typo-guard
// predicate (validateClaudeModel), plus a drift guard cross-checking
// ConfigScreen.tsx's MODEL_OPTIONS against CLAUDE_MODEL_ALIASES.

import { describe, expect, test } from 'bun:test';

import { CLAUDE_MODEL_ALIASES, validateClaudeModel } from '../../src/config/claude-models.ts';
import { MODEL_OPTIONS } from '../../src/ui/ConfigScreen.tsx';

describe('CLAUDE_MODEL_ALIASES', () => {
	test('contains exactly the ten doc-verified values', () => {
		expect([...CLAUDE_MODEL_ALIASES].sort() as string[]).toEqual(
			[
				'default',
				'best',
				'fable',
				'opus',
				'sonnet',
				'haiku',
				'opusplan',
				'sonnet[1m]',
				'opus[1m]',
				'opusplan[1m]',
			].sort(),
		);
	});
});

describe('validateClaudeModel (STRICT typo-guard)', () => {
	for (const alias of CLAUDE_MODEL_ALIASES) {
		test(`ok for alias "${alias}"`, () => {
			expect(validateClaudeModel(alias)).toEqual({ ok: true });
		});
	}

	test('ok for a claude-* full name', () => {
		expect(validateClaudeModel('claude-opus-4-8')).toEqual({ ok: true });
	});

	for (const bad of ['sonnett', 'gpt-5.6-sol', 'sonnet-4-5', '']) {
		test(`not-ok for "${bad}", message names the offending value`, () => {
			const result = validateClaudeModel(bad);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.message).toContain(bad);
			}
		});
	}

	test('never substring matches (e.g. "opus-extra" is not a member and is not a claude-* name)', () => {
		const result = validateClaudeModel('opus-extra');
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Drift guard: MODEL_OPTIONS (ConfigScreen.tsx, the picker) subset check
// against CLAUDE_MODEL_ALIASES (the fail-closed guard), so the picker can
// never offer an alias the guard would reject.
// ---------------------------------------------------------------------------

describe('MODEL_OPTIONS vs CLAUDE_MODEL_ALIASES (drift guard)', () => {
	test('every MODEL_OPTIONS value is a member of CLAUDE_MODEL_ALIASES', () => {
		const aliasSet = new Set<string>(CLAUDE_MODEL_ALIASES);
		expect(MODEL_OPTIONS.length).toBeGreaterThan(0);
		for (const option of MODEL_OPTIONS) {
			expect(aliasSet.has(option.value)).toBe(true);
		}
	});
});
