import { describe, expect, test } from 'bun:test';

import { buildOrchestratorBootPrompt } from '../../src/commands/run.ts';
import { templatesContents } from '../../src/vendor/_generated.ts';

// Doc-gate (CAM-61 style, modeled on test/vendor/cam-ship-hygiene.test.ts):
// asserts over the embedded persona AND over buildOrchestratorBootPrompt()
// that the backlog derivation invariant is present everywhere it must be.
// CAM-190 US-004.

const PERSONA_KEY = 'agents/subagent-orchestrator.md';

describe('orchestrator boot prompt: cam issue list backlog derivation (US-004)', () => {
	test('buildOrchestratorBootPrompt instructs deriving the backlog via cam issue list', () => {
		const prompt = buildOrchestratorBootPrompt();
		expect(prompt).toContain('cam issue list');
	});

	test('buildOrchestratorBootPrompt states the stage-filtered fallback for an unavailable/failing command', () => {
		const prompt = buildOrchestratorBootPrompt();
		expect(prompt).toContain('scripts/cam/issues/*.json');
		expect(prompt.toLowerCase()).toContain('filtered by stage');
	});
});

describe('embedded orchestrator persona: cam issue list backlog derivation (US-004)', () => {
	test('embedded persona instructs deriving the backlog via cam issue list', () => {
		const content = templatesContents[PERSONA_KEY] ?? '';
		expect(content).toBeTruthy();
		expect(content).toContain('cam issue list');
	});

	test('embedded persona states the stage-filtered fallback for an unavailable/failing command', () => {
		const content = templatesContents[PERSONA_KEY] ?? '';
		expect(content).toContain('scripts/cam/issues/*.json');
		expect(content.toLowerCase()).toContain('filtered by stage');
	});

	test('embedded persona greeting spec contains no per-issue enumeration', () => {
		const content = templatesContents[PERSONA_KEY] ?? '';
		// The greeting must carry exactly one backlog line with live per-stage
		// counts, and must explicitly forbid enumerating individual issues.
		expect(content).toContain('backlog:');
		expect(content.toLowerCase()).toContain('no per-issue list');
	});

	test('embedded persona routes backlog questions to a fresh cam issue list run, never memory/handoff', () => {
		const content = templatesContents[PERSONA_KEY] ?? '';
		expect(content).toContain('cam issue list');
		expect(content).toContain('never answer from memory or from the handoff');
	});
});
