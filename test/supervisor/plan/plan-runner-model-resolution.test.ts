// test/supervisor/plan/plan-runner-model-resolution.test.ts
//
// Unit tests for US-005 (CAM-398): wiring `resolvePhaseModel` into BOTH
// plan-phase dispatch sites in src/supervisor/plan-runner.ts -- the planner
// site (resolveAndSpawnPlanner) and the auditor site (resolveAndSpawnAuditor).
// Mirrors test/supervisor/loop-model-resolution.test.ts's conventions (US-004).
//
// Coverage:
//   AC2: both sites are wired -- a not-ok planner resolution aborts the
//        planner site through the existing ResolveAndSpawnResult { ok: false,
//        reason } shape (surfaced as kind='codex-auth-failed', the site's
//        pre-existing abort discriminator); a not-ok auditor resolution
//        (with the planner resolving fine) aborts the auditor site the same
//        way, AFTER the planner respawn-pane already fired.
//   AC3: a codex-backed dispatch whose config carries only a claude-shaped
//        flat model, with an injected cacheReader resolving 'gpt-5.6-sol',
//        spawns argv containing 'gpt-5.6-sol' and never the claude alias.
//   AC4: a not-ok resolution aborts before any spawn: actionable message,
//        escalateFn fires, no respawn-pane invocation recorded for that phase.
//   AC5: the cacheReader reaches both sites through an injectable option seam
//        (codexModelsCacheReaderFn) mirroring codexAuthCheckFn -- defaults to
//        the production reader when omitted, and a claude-backed dispatch
//        never invokes it.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createTestTmpdir } from '../../helpers/test-tmpdir';
import { join } from 'node:path';
import {
	runPlanPhase,
	type RunPlanPhaseOptions,
	type PlanMutexState,
} from '../../../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../../../src/supervisor/loop.ts';
import type { IssueEntry } from '../../../src/issues/types.ts';
import type { CodexModelsCacheReader } from '../../../src/config/codex-models-cache.ts';
import { waitForCondition } from '../../helpers/wait-for-condition.ts';
import { withVerifiedPanePid } from '../../helpers/verified-pane-pid-spawn.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-42',
	title: 'Model resolution test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-23T00:00:00Z',
	updatedAt: '2026-07-23T00:00:00Z',
};

const FAKE_UUID = 'aabbccdd-eeff-1122-3344-556677889900';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolutionOpts {
	codexModelsCacheReaderFn?: RunPlanPhaseOptions['codexModelsCacheReaderFn'];
	escalateFn?: RunPlanPhaseOptions['escalateFn'];
}

/**
 * Build opts where preflight/mutex/selectIssue are always happy, the pane
 * dies immediately (poll loops exit fast), and the auditor verdict report
 * (when reached) approves. codexAuthCheckFn always reports authenticated so
 * only the model-resolution seam is under test here (mirrors
 * plan-runner-codex-auth.test.ts's makeOpts).
 */
function makeOpts(res: ResolutionOpts = {}, spawnCalls: string[][] = []): RunPlanPhaseOptions {
	const spawnFn: SpawnFn = (_cmd, args) => {
		spawnCalls.push([...args]);
		return { stdout: '', exitCode: 0 };
	};

	return {
		spawnFn: withVerifiedPanePid(spawnFn),
		isPaneAlive: () => false, // pane dies immediately; both poll loops exit fast
		sleepFn: () => {},
		genUuid: () => FAKE_UUID,
		selectIssueFn: () => MOCK_ISSUE,
		readPlanVerdictFn: () => ({ verdict: 'APPROVE', summary: 'ok', findings: [] }),
		preflightFn: () => ({ ok: true }),
		clock: (() => { let t = 0; return () => (t += 100); })(),
		plannerPaneId: '%3',
		paneCountMutexFn: () => 'available' as PlanMutexState,
		pollIntervalMs: 1,
		plannerTimeoutMs: 999_999,
		auditorTimeoutMs: 999_999,
		codexAuthCheckFn: () => ({ authenticated: true }),
		codexModelsCacheReaderFn: res.codexModelsCacheReaderFn,
		escalateFn: res.escalateFn,
	};
}

/** Extract all respawn-pane args arrays from recorded spawn calls. */
function respawnCalls(calls: string[][]): string[][] {
	return calls.filter((a) => a[2] === 'respawn-pane');
}

/**
 * Stage a temp cwd resolving BOTH the planner and auditor backends to
 * 'codex' with a claude-SHAPED flat model (so the codex-auto-resolution
 * cacheReader path fires, per resolvePhaseModel's precedence), plus stub
 * .claude/agents/subagent-{planner,auditor}.md files so CodexAdapter.
 * buildSpawnArgv can read them on the authenticated (proceed) path. Mirrors
 * plan-runner-codex-auth.test.ts's withCodexBackendCwd, but with a
 * claude-shaped model instead of a non-claude-shaped pin.
 */
async function withClaudeShapedCodexCwd<T>(fn: () => T | Promise<T>): Promise<T> {
	const tmpDir = createTestTmpdir('cam-plan-model-resolution-');
	const camDir = join(tmpDir, 'scripts', 'cam');
	mkdirSync(camDir, { recursive: true });
	writeFileSync(
		join(camDir, 'project.toml'),
		'[backend]\nplanner = "codex"\nauditor = "codex"\n\n[models]\nplanner = "sonnet"\nauditor = "sonnet"\n',
	);
	const agentsDir = join(tmpDir, '.claude', 'agents');
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, 'subagent-planner.md'), '# stub\n');
	writeFileSync(join(agentsDir, 'subagent-auditor.md'), '# stub\n');
	const prevCwd = process.cwd();
	process.chdir(tmpDir);
	try {
		return await fn();
	} finally {
		process.chdir(prevCwd);
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// AC3: codex-backed dispatch, claude-shaped flat model, injected cacheReader
// ---------------------------------------------------------------------------

describe('plan-runner model resolution: AC3 - resolved slug reaches argv, never the claude alias', () => {
	test('planner site: dispatched cmd contains the resolved slug, never the claude alias', async () => {
		await withClaudeShapedCodexCwd(async () => {
			let cacheReaderCalled = false;
			const spawnCalls: string[][] = [];
			const opts = makeOpts(
				{
					codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => {
						cacheReaderCalled = true;
						return { ok: true, slug: 'gpt-5.6-sol' };
					},
				},
				spawnCalls,
			);

			await runPlanPhase(opts);

			expect(cacheReaderCalled).toBe(true);
			const calls = respawnCalls(spawnCalls);
			expect(calls.length).toBe(2);
			const plannerCmd = calls[0]?.[calls[0].length - 1] ?? '';
			expect(plannerCmd).toContain('gpt-5.6-sol');
			expect(plannerCmd).not.toMatch(/\bsonnet\b/i);
			expect(plannerCmd).not.toMatch(/\bopus\b/i);
		});
	});

	test('auditor site: dispatched cmd contains the resolved slug, never the claude alias', async () => {
		await withClaudeShapedCodexCwd(async () => {
			const spawnCalls: string[][] = [];
			const opts = makeOpts(
				{
					codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => ({ ok: true, slug: 'gpt-5.6-sol' }),
				},
				spawnCalls,
			);

			await runPlanPhase(opts);

			const calls = respawnCalls(spawnCalls);
			expect(calls.length).toBe(2);
			const auditorCmd = calls[1]?.[calls[1].length - 1] ?? '';
			expect(auditorCmd).toContain('gpt-5.6-sol');
			expect(auditorCmd).not.toMatch(/\bsonnet\b/i);
			expect(auditorCmd).not.toMatch(/\bopus\b/i);
		});
	});
});

// ---------------------------------------------------------------------------
// AC2 + AC4: not-ok resolution aborts before any spawn, at both sites
// ---------------------------------------------------------------------------

describe('plan-runner model resolution: AC2/AC4 - not-ok resolution aborts before spawn', () => {
	test('planner site: kind=codex-auth-failed, phase=planner, actionable message, no respawn-pane, escalateFn fires', async () => {
		await withClaudeShapedCodexCwd(async () => {
			let escalateCalled = false;
			const spawnCalls: string[][] = [];
			const opts = makeOpts(
				{
					codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => ({
						ok: false,
						reason: 'models_cache.json missing',
					}),
					escalateFn: async () => { escalateCalled = true; },
				},
				spawnCalls,
			);

			const result = await runPlanPhase(opts);

			expect(result.kind).toBe('codex-auth-failed');
			if (result.kind === 'codex-auth-failed') {
				expect(result.phase).toBe('planner');
				expect(result.reason).toContain('models_cache.json missing');
			}
			expect(respawnCalls(spawnCalls).length).toBe(0);
			await waitForCondition(() => escalateCalled);
			expect(escalateCalled).toBe(true);
		});
	});

	test('auditor site: planner resolves fine (respawned), auditor model resolution fails -> abort, no auditor respawn-pane, escalateFn fires', async () => {
		await withClaudeShapedCodexCwd(async () => {
			let escalateCalled = false;
			let callCount = 0;
			const spawnCalls: string[][] = [];
			const opts = makeOpts(
				{
					codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => {
						callCount++;
						// First call (planner) resolves; second call (auditor) fails.
						return callCount === 1
							? { ok: true, slug: 'gpt-5.6-sol' }
							: { ok: false, reason: 'models_cache.json missing' };
					},
					escalateFn: async () => { escalateCalled = true; },
				},
				spawnCalls,
			);

			const result = await runPlanPhase(opts);

			expect(result.kind).toBe('codex-auth-failed');
			if (result.kind === 'codex-auth-failed') {
				expect(result.phase).toBe('auditor');
				expect(result.reason).toContain('models_cache.json missing');
			}
			// Exactly ONE respawn-pane (planner) was issued before the auditor
			// model resolution blocked.
			expect(respawnCalls(spawnCalls).length).toBe(1);
			await waitForCondition(() => escalateCalled);
			expect(escalateCalled).toBe(true);
		});
	});
});

// ---------------------------------------------------------------------------
// AC5: injectable seam mirrors codexAuthCheckFn; defaults when absent;
// claude-backed dispatch never invokes it.
// ---------------------------------------------------------------------------

describe('plan-runner model resolution: AC5 - injectable seam, default fallback, claude-backend bypass', () => {
	test('absent codexModelsCacheReaderFn on a codex dispatch with a non-claude-shaped pin never falls through to the cacheReader (backward compat, no crash)', async () => {
		const tmpDir = createTestTmpdir('cam-plan-model-resolution-pin-');
		const camDir = join(tmpDir, 'scripts', 'cam');
		mkdirSync(camDir, { recursive: true });
		writeFileSync(
			join(camDir, 'project.toml'),
			'[backend]\nplanner = "codex"\nauditor = "codex"\n\n[models]\nplanner = "gpt-5-codex"\nauditor = "gpt-5-codex"\n',
		);
		const agentsDir = join(tmpDir, '.claude', 'agents');
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, 'subagent-planner.md'), '# stub\n');
		writeFileSync(join(agentsDir, 'subagent-auditor.md'), '# stub\n');
		const prevCwd = process.cwd();
		process.chdir(tmpDir);
		try {
			const spawnCalls: string[][] = [];
			const opts = makeOpts({}, spawnCalls); // codexModelsCacheReaderFn intentionally absent

			const result = await runPlanPhase(opts);

			expect(result.kind).not.toBe('codex-auth-failed');
			expect(respawnCalls(spawnCalls).length).toBe(2);
		} finally {
			process.chdir(prevCwd);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('claude-backed dispatch (repo default project.toml) never invokes the injected cacheReader', async () => {
		// No chdir: the repo's own scripts/cam/project.toml resolves the
		// planner/auditor backends to 'claude' by default.
		let cacheReaderCalled = false;
		const spawnCalls: string[][] = [];
		const opts = makeOpts(
			{
				codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => {
					cacheReaderCalled = true;
					return { ok: true, slug: 'gpt-5.6-sol' };
				},
			},
			spawnCalls,
		);

		const result = await runPlanPhase(opts);

		expect(result.kind).not.toBe('codex-auth-failed');
		expect(respawnCalls(spawnCalls).length).toBe(2);
		expect(cacheReaderCalled).toBe(false);
	});
});
