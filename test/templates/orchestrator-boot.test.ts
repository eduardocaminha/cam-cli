import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { templatesContents } from '../../src/vendor/_generated.ts';

// Doc-gate (modeled on test/vendor/orchestrator-backlog-derivation.test.ts):
// asserts boot step 9 (read the preflight-failed marker) and its opening-
// blocker section are present in both the dev-mode persona
// (.claude/agents/subagent-orchestrator.md) and the embedded template copy
// (templates/agents/subagent-orchestrator.md, also mirrored into
// src/vendor/_generated.ts via bun run embed-vendor). US-005, CAM-215.

const REPO_ROOT = join(import.meta.dir, '..', '..');
const DEV_COPY_PATH = join(REPO_ROOT, '.claude', 'agents', 'subagent-orchestrator.md');
const TEMPLATE_KEY = 'agents/subagent-orchestrator.md';

function devCopyContent(): string {
	return readFileSync(DEV_COPY_PATH, 'utf8');
}

function templateCopyContent(): string {
	return templatesContents[TEMPLATE_KEY] ?? '';
}

describe.each([
	['dev copy (.claude/agents/subagent-orchestrator.md)', devCopyContent],
	['template copy (templates/agents/subagent-orchestrator.md)', templateCopyContent],
])('%s: boot step 9 reads the preflight-failed marker', (_label, getContent) => {
	test('boot step 9 references the marker filename, after steps 7 and 8', () => {
		const content = getContent();
		expect(content).toBeTruthy();
		const step7Index = content.indexOf('.cam-ship-stalled.json');
		const step8Index = content.indexOf('.cam-plan-escalated.json');
		const step9Index = content.indexOf('.cam-plan-preflight-failed.json');
		expect(step7Index).toBeGreaterThan(-1);
		expect(step8Index).toBeGreaterThan(step7Index);
		expect(step9Index).toBeGreaterThan(step8Index);
	});

	test('boot step 9 reads the step and detail fields', () => {
		const content = getContent();
		expect(content).toContain('`step`');
		expect(content).toContain('`detail`');
	});

	test('opening-blocker section surfaces step plus detail', () => {
		const content = getContent();
		expect(content).toContain('plan preflight failed:');
	});

	test('opening-blocker section documents the (+N more) multi-line detail truncation rule', () => {
		const content = getContent();
		expect(content).toContain('+N more');
	});

	test('opening-blocker section instructs not to delete the marker; removal is owned by the next plan run', () => {
		const content = getContent();
		const blockerIndex = content.indexOf('plan preflight failed:');
		expect(blockerIndex).toBeGreaterThan(-1);
		const afterBlocker = content.slice(blockerIndex);
		expect(afterBlocker).toContain('Do NOT delete the marker yourself');
		expect(afterBlocker).toContain('only removed by the next plan run');
	});
});
