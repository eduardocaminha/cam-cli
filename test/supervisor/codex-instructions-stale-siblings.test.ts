// test/supervisor/codex-instructions-stale-siblings.test.ts
//
// Real-I/O regression test for stale pid-sibling pruning under the codex
// instructions dedicated parent (US-R1-002, CAM-510). writeCodexInstructionsFile
// previously reaped only inside its own <agentName>/<pid> leaf; an abandoned
// pid sibling (e.g. a killed supervisor process that never reached a dispatch
// terminal) was left behind forever, the largest of the five CAM-510 leak
// sites (measured 45,580 files / 1.87 GB). Mirrors
// test/supervisor/task-prompt-root-bounded.test.ts's stale-sibling shape.
//
// This file must never import `tmpdir` from `node:os` itself (GOTCHA 14,
// CAM-510): doing so would require a new entry in scripts/check-test-tmpdir.ts's
// allowlist.

import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { CodexAdapter } from '../../src/supervisor/backend-adapter.ts';

/** Mirrors the fixed parent name in src/supervisor/backend-adapter.ts. */
const CODEX_INSTRUCTIONS_PARENT_NAME = 'cam-cli-codex-instructions';

const SAMPLE_PROMPT = 'Implement per your AGENT.md.';
const SAMPLE_MODE = 'bypassPermissions';

describe('CodexAdapter instructions-file lifecycle — stale pid-sibling pruning (US-R1-002, CAM-510)', () => {
	test('an abandoned pid sibling directory (older than the stale threshold) under the agent dir is pruned on the next dispatch', () => {
		const originalTmpdir = process.env.TMPDIR;
		const scratchRoot = createTestTmpdir('cam-codex-instructions-stale-siblings-');
		const taskPromptClaudeDir = join(createTestTmpdir('cam-codex-instructions-stale-siblings-prompts-'), '.claude');
		try {
			process.env.TMPDIR = scratchRoot;

			// Plant an abandoned sibling pid directory under the agent dir, as if
			// a prior supervisor process died mid-dispatch without ever calling
			// removeCodexInstructionsFile.
			const agentDir = join(scratchRoot, CODEX_INSTRUCTIONS_PARENT_NAME, 'subagent-implementer');
			const staleSiblingDir = join(agentDir, '999999');
			mkdirSync(staleSiblingDir, { recursive: true });
			const leftoverFile = join(staleSiblingDir, 'abandoned-dispatch-uuid.md');
			writeFileSync(leftoverFile, 'leftover instructions body', 'utf8');
			const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
			utimesSync(staleSiblingDir, twoHoursAgo, twoHoursAgo);

			const adapter = new CodexAdapter();
			adapter.buildSpawnArgv('implementer', {
				uuid: 'fresh-dispatch-uuid',
				taskPrompt: SAMPLE_PROMPT,
				permissionMode: SAMPLE_MODE,
				claudeDir: taskPromptClaudeDir,
			});

			const remaining = readdirSync(agentDir);
			expect(remaining).not.toContain('999999');
			expect(remaining).toContain(String(process.pid));
			expect(existsSync(leftoverFile)).toBe(false);
		} finally {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});

	test('a sibling pid directory younger than the stale threshold survives (never reaps a still-live concurrent process)', () => {
		const originalTmpdir = process.env.TMPDIR;
		const scratchRoot = createTestTmpdir('cam-codex-instructions-stale-siblings-');
		const taskPromptClaudeDir = join(createTestTmpdir('cam-codex-instructions-stale-siblings-prompts-'), '.claude');
		try {
			process.env.TMPDIR = scratchRoot;

			const agentDir = join(scratchRoot, CODEX_INSTRUCTIONS_PARENT_NAME, 'subagent-implementer');
			const liveSiblingDir = join(agentDir, '424242');
			mkdirSync(liveSiblingDir, { recursive: true });
			const liveFile = join(liveSiblingDir, 'still-running-dispatch-uuid.md');
			writeFileSync(liveFile, 'still live instructions body', 'utf8');

			const adapter = new CodexAdapter();
			adapter.buildSpawnArgv('implementer', {
				uuid: 'fresh-dispatch-uuid',
				taskPrompt: SAMPLE_PROMPT,
				permissionMode: SAMPLE_MODE,
				claudeDir: taskPromptClaudeDir,
			});

			const remaining = readdirSync(agentDir);
			expect(remaining).toContain('424242');
			expect(existsSync(liveFile)).toBe(true);
		} finally {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});
});
