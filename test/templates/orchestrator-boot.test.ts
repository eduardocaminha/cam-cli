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

	test('the shared do-not-delete rule covers this marker, and removal is owned by the next plan run', () => {
		const content = getContent();
		const blockerIndex = content.indexOf('plan preflight failed:');
		expect(blockerIndex).toBeGreaterThan(-1);
		// The shared "Do NOT delete the marker yourself" rule is stated once,
		// before all per-marker blocker paragraphs (US-001, CAM-265): it
		// covers this marker too, so it must appear before this blocker line,
		// not repeated after it.
		const sharedRuleIndex = content.indexOf('Do NOT delete the marker yourself');
		expect(sharedRuleIndex).toBeGreaterThan(-1);
		expect(sharedRuleIndex).toBeLessThan(blockerIndex);
		const afterBlocker = content.slice(blockerIndex);
		expect(afterBlocker).toContain('Removed by the next plan run');
		expect(afterBlocker).toContain('preflight-failed');
	});
});

// Invariance pin: the boot prompt (buildOrchestratorBootPrompt, src/commands/
// run.ts) no longer interpolates meta_loop -- the persisted prompt file is
// re-read verbatim on every respawn without re-running the generator, so
// config-derived content in it goes stale. The greeting fork therefore
// DEPENDS entirely on the persona doc: if a future edit removes the
// meta_loop-aware closing from the persona, the feature dies silently. This
// block pins its presence in both copies. Companion oracle:
// test/commands/run-boot-prompt-isolation.test.ts asserts the prompt side.
describe.each([
	['dev copy (.claude/agents/subagent-orchestrator.md)', devCopyContent],
	['template copy (templates/agents/subagent-orchestrator.md)', templateCopyContent],
])('%s: persona owns the meta_loop-aware greeting fork', (_label, getContent) => {
	test('the greeting closing is meta_loop-aware', () => {
		const content = getContent();
		expect(content).toContain('`meta_loop`-aware');
	});

	test('the auto branch is gated on container isolation', () => {
		const content = getContent();
		expect(content).toContain('worker_isolation = "container"');
	});

	test('the observe/off branch closes with the operator question', () => {
		const content = getContent();
		expect(content).toContain('What would you like to do?');
	});
});
