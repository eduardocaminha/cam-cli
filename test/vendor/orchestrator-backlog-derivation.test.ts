import { describe, expect, test } from 'bun:test';

import { templatesContents } from '../../src/vendor/_generated.ts';

// Doc-gate (CAM-61 style, modeled on test/vendor/cam-ship-hygiene.test.ts):
// asserts over the embedded persona that the backlog derivation invariant is
// present. CAM-190 US-004.
//
// CAM-240 US-002: buildOrchestratorBootPrompt() is now spawned under
// `--agent subagent-orchestrator`, so the persona body IS the system prompt
// and buildOrchestratorBootPrompt() shrank to a minimal meta_loop-aware
// nudge; the backlog-derivation instruction lives ONLY in the embedded
// persona now (asserted below), not in the boot-prompt string.

const PERSONA_KEY = 'agents/subagent-orchestrator.md';

describe('embedded orchestrator persona: cam issue list backlog derivation (US-004)', () => {
	test('embedded persona instructs deriving the backlog via cam issue list / --json', () => {
		const content = templatesContents[PERSONA_KEY] ?? '';
		expect(content).toBeTruthy();
		expect(content).toContain('cam issue list');
		expect(content).toContain('cam issue list --json');
	});

	test('embedded persona prohibits raw scripts/cam/issues/*.json reads as a backlog-derivation fallback (US-004, CAM-222)', () => {
		const content = templatesContents[PERSONA_KEY] ?? '';
		expect(content).toContain('scripts/cam/issues/*.json');
		expect(content.toLowerCase()).toContain('never grep or read');
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

describe('embedded orchestrator persona: nextActions ephemeral-only + no-backlog-in-handoff hard rule (US-005)', () => {
	test('self-handoff section states nextActions is ephemeral, cycle-specific-only, never a backlog snapshot', () => {
		const content = templatesContents[PERSONA_KEY] ?? '';
		expect(content.toLowerCase()).toContain('never a backlog snapshot');
	});

	test('self-handoff section states the hard rule that no handoff field enumerates the backlog', () => {
		const content = templatesContents[PERSONA_KEY] ?? '';
		expect(content.toLowerCase()).toContain('no handoff field enumerates the backlog');
	});
});
