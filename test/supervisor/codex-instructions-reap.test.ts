// test/supervisor/codex-instructions-reap.test.ts
//
// Real-I/O regression test for the bounded, mode-restricted, terminal-reaped
// codex instructions file lifecycle (US-003, CAM-510, site 3 of 5).
// Redirects process.env.TMPDIR at a repo-local scratch root (createTestTmpdir,
// restored in finally) and drives the REAL production CodexAdapter seam. This
// file must never import `tmpdir` from `node:os` itself (GOTCHA 14, CAM-510):
// doing so would require a new entry in scripts/check-test-tmpdir.ts's
// allowlist.

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { CodexAdapter, removeCodexInstructionsFile } from '../../src/supervisor/backend-adapter.ts';

/** Mirrors the fixed parent name in src/supervisor/backend-adapter.ts. */
const CODEX_INSTRUCTIONS_PARENT_NAME = 'cam-cli-codex-instructions';

const SAMPLE_UUID = 'reap-lifecycle-uuid-0001';
const SAMPLE_PROMPT = 'Implement per your AGENT.md.';
const SAMPLE_MODE = 'bypassPermissions';

/** Extracts the path passed to `-c model_instructions_file=<path>`. */
function extractInstructionsFile(argv: string): string {
	const match = argv.match(/-c model_instructions_file=(\S+)/);
	if (!match?.[1]) throw new Error(`no model_instructions_file found in argv: ${argv}`);
	return match[1];
}

describe('CodexAdapter instructions-file lifecycle — bounded, 0600, terminal-reaped (US-003, CAM-510)', () => {
	test('AC5/AC6: the temp root gains at most ONE top-level entry, the file is 0600 while alive, and ZERO instructions files for that agent survive after the dispatch terminal', () => {
		const originalTmpdir = process.env.TMPDIR;
		const scratchRoot = createTestTmpdir('cam-codex-instructions-reap-');
		// The task-prompt-file half of a dispatch (US-001, CAM-433) lives under
		// its own already-bounded directory (task-prompt-file.ts). Pinning it
		// OUTSIDE the redirected TMPDIR root isolates this test's topology
		// assertions to the codex-instructions site under test.
		const taskPromptClaudeDir = join(createTestTmpdir('cam-codex-instructions-reap-prompts-'), '.claude');
		try {
			process.env.TMPDIR = scratchRoot;

			// --- Drive a complete dispatch ---------------------------------
			const adapter = new CodexAdapter();
			const argv = adapter.buildSpawnArgv('implementer', {
				uuid: SAMPLE_UUID,
				taskPrompt: SAMPLE_PROMPT,
				permissionMode: SAMPLE_MODE,
				claudeDir: taskPromptClaudeDir,
			});
			const instructionsFile = extractInstructionsFile(argv);

			// While alive: exactly one top-level entry under the redirected temp
			// root (the fixed parent), with agent/pid/uuid nested BELOW it.
			const topLevel = readdirSync(scratchRoot);
			expect(topLevel).toEqual([CODEX_INSTRUCTIONS_PARENT_NAME]);
			expect(existsSync(instructionsFile)).toBe(true);
			expect(instructionsFile).toBe(
				join(scratchRoot, CODEX_INSTRUCTIONS_PARENT_NAME, 'subagent-implementer', String(process.pid), `${SAMPLE_UUID}.md`),
			);

			// While alive: mode 0600, never the previous world-readable 0644.
			const mode = statSync(instructionsFile).mode & 0o777;
			expect(mode).toBe(0o600);

			// While alive: content is the frontmatter-stripped agent body, never
			// empty (sanity: this really is the confidential body, not a stub).
			expect(readFileSync(instructionsFile, 'utf8').length).toBeGreaterThan(0);

			// --- Dispatch terminal: mandatory explicit removal -------------
			// The removeTaskPromptFile half of the task-prompt-file pattern:
			// reap-before-write alone bounds mid-run accumulation but always
			// leaves the LAST dispatch's file (up to 200 KB of the user's git
			// diff, CAM-354) behind.
			removeCodexInstructionsFile('subagent-implementer', SAMPLE_UUID);

			expect(existsSync(instructionsFile)).toBe(false);
			// Idempotent: a second terminal call for the same completed dispatch
			// must not throw.
			expect(() => removeCodexInstructionsFile('subagent-implementer', SAMPLE_UUID)).not.toThrow();
		} finally {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});

	test('reap-before-write: a stale sibling instructions file for the same agent+pid does not survive the next dispatch', () => {
		const originalTmpdir = process.env.TMPDIR;
		const scratchRoot = createTestTmpdir('cam-codex-instructions-reap-');
		const taskPromptClaudeDir = join(createTestTmpdir('cam-codex-instructions-reap-prompts-'), '.claude');
		try {
			process.env.TMPDIR = scratchRoot;

			const adapter = new CodexAdapter();
			const firstArgv = adapter.buildSpawnArgv('implementer', {
				uuid: 'first-dispatch-uuid',
				taskPrompt: SAMPLE_PROMPT,
				permissionMode: SAMPLE_MODE,
				claudeDir: taskPromptClaudeDir,
			});
			const firstFile = extractInstructionsFile(firstArgv);
			expect(existsSync(firstFile)).toBe(true);

			const secondArgv = adapter.buildSpawnArgv('implementer', {
				uuid: 'second-dispatch-uuid',
				taskPrompt: SAMPLE_PROMPT,
				permissionMode: SAMPLE_MODE,
				claudeDir: taskPromptClaudeDir,
			});
			const secondFile = extractInstructionsFile(secondArgv);

			// Reaping before the second write removes the first dispatch's file
			// even though its own terminal-removal was never called.
			expect(existsSync(firstFile)).toBe(false);
			expect(existsSync(secondFile)).toBe(true);

			const leafDir = join(scratchRoot, CODEX_INSTRUCTIONS_PARENT_NAME, 'subagent-implementer', String(process.pid));
			expect(readdirSync(leafDir)).toEqual(['second-dispatch-uuid.md']);
		} finally {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});

	test('scoping: a different agent (reviewer) never reaps or is reaped by an implementer dispatch (GOTCHA 8)', () => {
		const originalTmpdir = process.env.TMPDIR;
		const scratchRoot = createTestTmpdir('cam-codex-instructions-reap-');
		const taskPromptClaudeDir = join(createTestTmpdir('cam-codex-instructions-reap-prompts-'), '.claude');
		try {
			process.env.TMPDIR = scratchRoot;

			const adapter = new CodexAdapter();
			const implementerArgv = adapter.buildSpawnArgv('implementer', {
				uuid: 'implementer-uuid',
				taskPrompt: SAMPLE_PROMPT,
				permissionMode: SAMPLE_MODE,
				claudeDir: taskPromptClaudeDir,
			});
			const reviewerArgv = adapter.buildSpawnArgv('reviewer', { uuid: 'reviewer-uuid', claudeDir: taskPromptClaudeDir });

			const implementerFile = extractInstructionsFile(implementerArgv);
			const reviewerFile = extractInstructionsFile(reviewerArgv);

			expect(existsSync(implementerFile)).toBe(true);
			expect(existsSync(reviewerFile)).toBe(true);

			removeCodexInstructionsFile('subagent-reviewer', 'reviewer-uuid');
			expect(existsSync(reviewerFile)).toBe(false);
			// The implementer's still-live file is untouched by the reviewer's
			// terminal cleanup.
			expect(existsSync(implementerFile)).toBe(true);
		} finally {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});
});
