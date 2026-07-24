// test/supervisor/codex-auth-claude-shape.test.ts
//
// Unit tests for the SUPERSET "claude-shaped" predicate isClaudeAliasModel
// (US-001, CAM-398). This is THE decision fn for whether a flat
// [models].<phase> value is claude-shaped on the codex path; it must stay
// strictly broader than validateClaudeModel's STRICT typo-guard.

import { describe, expect, test } from 'bun:test';

import { CLAUDE_MODEL_ALIASES } from '../../src/config/claude-models.ts';
import { isClaudeAliasModel } from '../../src/supervisor/codex-auth.ts';

describe('isClaudeAliasModel (SUPERSET claude-shaped predicate)', () => {
	for (const alias of CLAUDE_MODEL_ALIASES) {
		test(`true for CLAUDE_MODEL_ALIASES member "${alias}"`, () => {
			expect(isClaudeAliasModel(alias)).toBe(true);
		});
	}

	test('true for a claude-* full name', () => {
		expect(isClaudeAliasModel('claude-opus-4-8')).toBe(true);
	});

	for (const legacy of ['sonnet-4-5', 'my-opus-model']) {
		test(`true for legacy dashed non-prefixed match "${legacy}"`, () => {
			expect(isClaudeAliasModel(legacy)).toBe(true);
		});
	}

	for (const codexModel of ['gpt-5-codex', 'gpt-5.6-sol', 'codex-auto-review']) {
		test(`false for non-claude-shaped codex model "${codexModel}"`, () => {
			expect(isClaudeAliasModel(codexModel)).toBe(false);
		});
	}
});
