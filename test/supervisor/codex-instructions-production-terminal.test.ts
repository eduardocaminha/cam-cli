// test/supervisor/codex-instructions-production-terminal.test.ts
//
// Real-terminal regression test for US-R1-001 (CAM-510 follow-up to US-003
// site 3 of 5, backend-adapter.ts:470). The prior AC6 test
// (test/supervisor/codex-instructions-reap.test.ts) only proved
// `removeCodexInstructionsFile` itself is idempotent and reaps -- it called
// the reaper directly, so it verified rmSync, not the dispatch lifecycle.
// This test drives the REAL production dispatch terminals instead
// (`runSupervisor` for the implementer, `makeReviewDispatch` for the
// reviewer) with backend = "codex", and asserts the codex instructions leaf
// directory holds ZERO files after each terminal fires. Never calls
// removeCodexInstructionsFile itself.
//
// GOTCHA 14 (CAM-510): never import `tmpdir` from `node:os` in this file --
// doing so would require a new entry in scripts/check-test-tmpdir.ts's
// allowlist. TMPDIR is redirected via process.env only, mirroring
// codex-instructions-reap.test.ts.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { runSupervisor } from '../../src/supervisor/loop.ts';
import type { RunSupervisorOptions } from '../../src/supervisor/loop.ts';
import { makeReviewDispatch } from '../../src/supervisor/review.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import type { WorkerReport } from '../../src/supervisor/worker-report.ts';
import { withVerifiedPanePid } from '../helpers/verified-pane-pid-spawn.ts';

/** Mirrors the fixed parent name in src/supervisor/backend-adapter.ts. */
const CODEX_INSTRUCTIONS_PARENT_NAME = 'cam-cli-codex-instructions';

/**
 * Stage a temp cwd with a codex-backed project.toml for `phaseKey` and a stub
 * `.claude/agents/<agentFileName>.md` so CodexAdapter.buildSpawnArgv can read
 * it on the authenticated (proceed) path. Mirrors
 * loop-model-resolution.test.ts's withClaudeShapedCodexCwd.
 */
function stageCodexCwd(phaseKey: 'implementer' | 'reviewer', agentFileName: string): string {
	const tmpDir = createTestTmpdir('cam-codex-instructions-production-terminal-cwd-');
	const camDir = join(tmpDir, 'scripts', 'cam');
	mkdirSync(camDir, { recursive: true });
	writeFileSync(join(camDir, 'project.toml'), `[backend]\n${phaseKey} = "codex"\n`);
	const agentsDir = join(tmpDir, '.claude', 'agents');
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, `${agentFileName}.md`), '# stub\n');
	return tmpDir;
}

/** Lists the survivors (should be empty) in this agent+pid's leaf directory. */
function survivingInstructionsFiles(scratchRoot: string, agentFileName: string): string[] {
	const leafDir = join(scratchRoot, CODEX_INSTRUCTIONS_PARENT_NAME, agentFileName, String(process.pid));
	return existsSync(leafDir) ? readdirSync(leafDir) : [];
}

describe('US-R1-001: codex instructions file is reaped by the REAL production dispatch terminal', () => {
	test('implementer: runSupervisor drives a codex dispatch to completion and the last file does not survive', async () => {
		const originalTmpdir = process.env.TMPDIR;
		const originalCwd = process.cwd();
		const scratchRoot = createTestTmpdir('cam-codex-instructions-production-terminal-scratch-');
		const tmpDir = stageCodexCwd('implementer', 'subagent-implementer');
		try {
			process.env.TMPDIR = scratchRoot;
			process.chdir(tmpDir);

			let prdCall = 0;
			const prdImpl: PrdSnapshot = { userStories: [{ id: 'US-001', priority: 1, passes: false, requires: null }] };
			const prdDone: PrdSnapshot = {
				userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }],
				review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
			};
			const fakeReport: WorkerReport = {
				outcome: 'DONE',
				story: 'US-001',
				gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
				notes: 'none',
			};

			const opts: RunSupervisorOptions = {
				spawn: withVerifiedPanePid(() => ({ stdout: '', exitCode: 0 })),
				capturePane: () => 'CAM_IMPLEMENTER_STATUS=DONE story=US-001\n',
				readPrd: () => {
					prdCall++;
					return prdCall <= 1 ? prdImpl : prdDone;
				},
				writePrd: () => {},
				readHandoff: () => ({ lastCompletedStory: { id: 'US-001', title: 'x' } }),
				clock: () => '2026-08-06T00:00:00Z',
				genUuid: () => 'production-terminal-implementer-uuid',
				reviewDispatch: async () => ({ status: 'ok', detail: 'unused' }),
				writeSessionMarker: () => {},
				isPaneAlive: () => true,
				workerPaneId: '%3',
				prdPath: '/fake/prd.json',
				handoffPath: '/fake/handoff.json',
				permissionMode: 'bypassPermissions',
				taskPrompt: 'Implement.',
				sleepFn: () => {},
				nowMs: () => 0,
				readWorkerReport: () => fakeReport,
				// Opt out of a fixture configPath: this helper stages its own
				// cwd-relative project.toml, matching loop-model-resolution.test.ts.
				configPath: undefined,
				codexAuthCheckFn: () => ({ authenticated: true }),
				codexModelsCacheReaderFn: () => ({ ok: true, slug: 'gpt-5.6-sol' }),
			};

			const result = await runSupervisor(opts);
			expect(result.status).toBe('complete');
			expect(survivingInstructionsFiles(scratchRoot, 'subagent-implementer')).toEqual([]);
		} finally {
			process.chdir(originalCwd);
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('reviewer: makeReviewDispatch drives a codex dispatch to a CLEAN verdict and the last file does not survive', async () => {
		const originalTmpdir = process.env.TMPDIR;
		const originalCwd = process.cwd();
		const scratchRoot = createTestTmpdir('cam-codex-instructions-production-terminal-scratch-');
		const tmpDir = stageCodexCwd('reviewer', 'subagent-reviewer');
		try {
			process.env.TMPDIR = scratchRoot;
			process.chdir(tmpDir);

			const dispatch = makeReviewDispatch({
				spawn: withVerifiedPanePid(() => ({ stdout: '', exitCode: 0 })),
				capturePane: () => '<review>CLEAN</review>',
				readPrd: () => ({ userStories: [], review: { roundsCompleted: 0, maxRounds: 3 } }),
				writePrd: () => {},
				workerPaneId: '%7',
				isPaneAlive: () => true,
				sleepFn: () => {},
				permissionMode: 'bypassPermissions',
				pollIntervalMs: 0,
				timeoutMs: 1,
				now: (() => {
					let time = 0;
					return () => ++time;
				})(),
				// Opt out of a fixture configPath: this helper stages its own
				// cwd-relative project.toml.
				configPath: undefined,
				codexAuthCheckFn: () => ({ authenticated: true }),
				codexModelsCacheReaderFn: () => ({ ok: true, slug: 'gpt-5.6-sol' }),
			});

			const result = await dispatch('production-terminal-reviewer-uuid');
			expect(result.status).toBe('ok');
			expect(survivingInstructionsFiles(scratchRoot, 'subagent-reviewer')).toEqual([]);
		} finally {
			process.chdir(originalCwd);
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			rmSync(scratchRoot, { recursive: true, force: true });
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
