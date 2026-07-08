import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { templatesContents } from '../../src/vendor/_generated.ts';

// Doc-gate (modeled on test/templates/orchestrator-boot.test.ts): asserts the
// CLEAN-with-findings shape in the exit report protocol is present in both
// the dev-mode persona (.claude/agents/subagent-reviewer.md) and the embedded
// template copy (templates/agents/subagent-reviewer.md, also mirrored into
// src/vendor/_generated.ts via bun run embed-vendor). US-001, CAM-232.
//
// Guards against a regression back to forcing `findings: []` on a CLEAN
// verdict: a CLEAN verdict means no BLOCKING findings, not no findings at
// all, so cosmetic SUGGESTIONs must still be carried into review-report.json.

const REPO_ROOT = join(import.meta.dir, '..', '..');
const DEV_COPY_PATH = join(REPO_ROOT, '.claude', 'agents', 'subagent-reviewer.md');
const TEMPLATE_KEY = 'agents/subagent-reviewer.md';

function devCopyContent(): string {
	return readFileSync(DEV_COPY_PATH, 'utf8');
}

function templateCopyContent(): string {
	return templatesContents[TEMPLATE_KEY] ?? '';
}

describe.each([
	['dev copy (.claude/agents/subagent-reviewer.md)', devCopyContent],
	['template copy (templates/agents/subagent-reviewer.md)', templateCopyContent],
])('%s: CLEAN verdict carries SUGGESTION findings', (_label, getContent) => {
	test('states that CLEAN means no blocking findings, not no findings', () => {
		const content = getContent();
		expect(content).toBeTruthy();
		expect(content).toContain('means no BLOCKING findings, not no findings');
	});

	test('the no-oracle CLEAN shape example carries a SUGGESTION finding, not an empty array', () => {
		const content = getContent();
		const noOracleIndex = content.indexOf('For a CLEAN verdict (no tmux oracle run)');
		const withOracleIndex = content.indexOf('For a CLEAN verdict (with tmux oracle run at Layer B)');
		expect(noOracleIndex).toBeGreaterThan(-1);
		expect(withOracleIndex).toBeGreaterThan(noOracleIndex);
		const noOracleBlock = content.slice(noOracleIndex, withOracleIndex);
		expect(noOracleBlock).toContain('"verdict": "CLEAN"');
		expect(noOracleBlock).toContain('"severity": "SUGGESTION"');
		expect(noOracleBlock).not.toContain('"findings": []');
	});

	test('the with-oracle CLEAN shape example carries a SUGGESTION finding, not an empty array', () => {
		const content = getContent();
		const withOracleIndex = content.indexOf('For a CLEAN verdict (with tmux oracle run at Layer B)');
		const fixesPendingIndex = content.indexOf('For a FIXES_PENDING verdict');
		expect(withOracleIndex).toBeGreaterThan(-1);
		expect(fixesPendingIndex).toBeGreaterThan(withOracleIndex);
		const withOracleBlock = content.slice(withOracleIndex, fixesPendingIndex);
		expect(withOracleBlock).toContain('"verdict": "CLEAN"');
		expect(withOracleBlock).toContain('"severity": "SUGGESTION"');
		expect(withOracleBlock).toContain('"artifactOfRecord": "scripts/cam/review-artifact.txt"');
		expect(withOracleBlock).not.toContain('"findings": []');
	});

	test('cosmetic SUGGESTIONs still do not block CLEAN (Output Format section unchanged)', () => {
		const content = getContent();
		expect(content).toContain('Cosmetic SUGGESTIONs');
		expect(content).toContain('Cosmetic SUGGESTIONs and "consider X" WARNINGs do NOT block CLEAN.');
	});
});
