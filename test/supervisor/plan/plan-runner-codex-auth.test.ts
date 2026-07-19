// test/supervisor/plan/plan-runner-codex-auth.test.ts
//
// Unit tests for the codex auth preflight seam in plan-runner.ts
// (US-002, CAM-352): fail-closed codexAuthPreflight wired immediately before
// the planner AND auditor respawn-pane calls.
//
// Acceptance criteria proved (mirrors plan-runner-container.test.ts's
// container-preflight describe-block shape):
//   AC1: codexAuthPreflight runs immediately before both the planner and the
//        auditor respawn-pane call (grep-level coverage lives in
//        plan-runner.ts itself; here we prove behavior).
//   AC2: backend=codex + unauthenticated -> returns kind='codex-auth-failed'
//        with an actionable 'codex login' reason; respawn-pane never called
//        for the blocked phase; escalateFn fires fire-and-forget.
//   AC3: backend=codex + authenticated -> dispatch proceeds unchanged.
//   AC5: the shared codexAuthPreflight fn from US-001 is reused (no inline
//        duplicate), proved indirectly via the 'codex login' message text.
//
// readPhaseBackend/readPhaseModel are not injectable through
// RunPlanPhaseOptions; they always read scripts/cam/project.toml relative to
// process.cwd() (same constraint as loop.test.ts's codex-ceiling test and
// review.test.ts's codex-auth-preflight tests), so every codex-backend test
// below stages a temp cwd.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	runPlanPhase,
	type RunPlanPhaseOptions,
	type PlanMutexState,
} from '../../../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../../../src/supervisor/loop.ts';
import type { IssueEntry } from '../../../src/issues/types.ts';
import type { CodexAuthCheck } from '../../../src/supervisor/codex-auth.ts';
import { waitForCondition } from '../../helpers/wait-for-condition.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-42',
	title: 'Codex auth preflight test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-19T00:00:00Z',
	updatedAt: '2026-07-19T00:00:00Z',
};

const FAKE_UUID = 'aabbccdd-eeff-1122-3344-556677889900';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AuthOpts {
	codexAuthCheckFn?: CodexAuthCheck;
	escalateFn?: RunPlanPhaseOptions['escalateFn'];
}

/**
 * Build opts where preflight/mutex/selectIssue are always happy, the pane
 * dies immediately (poll loops exit fast), and the auditor verdict report
 * (when reached) approves. codexAuthCheckFn/escalateFn forwarded from `auth`.
 */
function makeOpts(auth: AuthOpts = {}, spawnCalls: string[][] = []): RunPlanPhaseOptions {
	const spawnFn: SpawnFn = (_cmd, args) => {
		spawnCalls.push([...args]);
		return { stdout: '', exitCode: 0 };
	};

	return {
		spawnFn,
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
		codexAuthCheckFn: auth.codexAuthCheckFn,
		escalateFn: auth.escalateFn,
	};
}

/** Extract all respawn-pane args arrays from recorded spawn calls. */
function respawnCalls(calls: string[][]): string[][] {
	return calls.filter((a) => a[2] === 'respawn-pane');
}

/**
 * Stage a temp cwd with a project.toml resolving BOTH the planner and
 * auditor backends to 'codex' with a non-claude-alias model, plus stub
 * .claude/agents/subagent-{planner,auditor}.md files so CodexAdapter.
 * buildSpawnArgv can read them on the authenticated (proceed) path.
 */
async function withCodexBackendCwd<T>(fn: () => T | Promise<T>): Promise<T> {
	const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-codex-auth-'));
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
		return await fn();
	} finally {
		process.chdir(prevCwd);
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// AC2: fail-closed on planner phase
// ---------------------------------------------------------------------------

describe('plan-runner codex auth: AC2 - fail-closed on planner preflight failure', () => {
	test('returns kind=codex-auth-failed, phase=planner, actionable codex login reason', async () => {
		await withCodexBackendCwd(() => {
			const opts = makeOpts({ codexAuthCheckFn: () => ({ authenticated: false }) });

			const result = runPlanPhase(opts);

			expect(result.kind).toBe('codex-auth-failed');
			if (result.kind === 'codex-auth-failed') {
				expect(result.phase).toBe('planner');
				expect(result.reason).toContain('codex login');
			}
		});
	});

	test('no respawn-pane call when planner codex auth preflight fails', async () => {
		await withCodexBackendCwd(() => {
			const spawnCalls: string[][] = [];
			const opts = makeOpts({ codexAuthCheckFn: () => ({ authenticated: false }) }, spawnCalls);

			runPlanPhase(opts);

			expect(respawnCalls(spawnCalls).length).toBe(0);
		});
	});

	test('escalateFn called fire-and-forget when planner codex auth preflight fails', async () => {
		await withCodexBackendCwd(async () => {
			let escalateCalled = 0;
			const opts = makeOpts({
				codexAuthCheckFn: () => ({ authenticated: false }),
				escalateFn: async () => { escalateCalled++; },
			});

			runPlanPhase(opts);
			await waitForCondition(() => escalateCalled > 0);

			expect(escalateCalled).toBe(1);
		});
	});
});

// ---------------------------------------------------------------------------
// AC2 continued: fail-closed on auditor phase
// ---------------------------------------------------------------------------

describe('plan-runner codex auth: AC2 continued - fail-closed on auditor preflight failure', () => {
	test('returns kind=codex-auth-failed with phase=auditor when auditor auth check fails, planner WAS spawned', async () => {
		await withCodexBackendCwd(() => {
			let callCount = 0;
			// First call (planner) -> authenticated; second call (auditor) -> not.
			const codexAuthCheckFn: CodexAuthCheck = () => {
				callCount++;
				return { authenticated: callCount === 1 };
			};
			const spawnCalls: string[][] = [];
			const opts = makeOpts({ codexAuthCheckFn }, spawnCalls);

			const result = runPlanPhase(opts);

			expect(result.kind).toBe('codex-auth-failed');
			if (result.kind === 'codex-auth-failed') {
				expect(result.phase).toBe('auditor');
				expect(result.reason).toContain('codex login');
			}
			// Exactly ONE respawn-pane (planner) was issued before the auditor
			// auth preflight blocked.
			expect(respawnCalls(spawnCalls).length).toBe(1);
		});
	});

	test('auditor escalateFn called fire-and-forget', async () => {
		await withCodexBackendCwd(async () => {
			let escalateCalled = 0;
			let callCount = 0;
			const opts = makeOpts({
				codexAuthCheckFn: () => {
					callCount++;
					return { authenticated: callCount === 1 };
				},
				escalateFn: async () => { escalateCalled++; },
			});

			runPlanPhase(opts);
			await waitForCondition(() => escalateCalled > 0);

			expect(escalateCalled).toBe(1);
		});
	});
});

// ---------------------------------------------------------------------------
// AC3: authenticated -> dispatch proceeds unchanged
// ---------------------------------------------------------------------------

describe('plan-runner codex auth: AC3 - authenticated proceeds unchanged', () => {
	test('both planner and auditor respawn-pane issued when codexAuthCheckFn always reports authenticated', async () => {
		await withCodexBackendCwd(() => {
			const spawnCalls: string[][] = [];
			const opts = makeOpts({ codexAuthCheckFn: () => ({ authenticated: true }) }, spawnCalls);

			const result = runPlanPhase(opts);

			expect(result.kind).not.toBe('codex-auth-failed');
			expect(respawnCalls(spawnCalls).length).toBe(2);
		});
	});
});

// ---------------------------------------------------------------------------
// AC4: claude backend (default) -> codexAuthCheckFn never invoked
// ---------------------------------------------------------------------------

describe('plan-runner codex auth: AC4 - claude backend never invokes codexAuthCheckFn', () => {
	test('claude backend (repo default project.toml) -> codexAuthCheckFn never called, dispatch unchanged', () => {
		// No withCodexBackendCwd: the repo's own scripts/cam/project.toml resolves
		// the planner/auditor backends to 'claude' by default.
		let authCheckCalled = false;
		const spawnCalls: string[][] = [];
		const opts = makeOpts(
			{
				codexAuthCheckFn: () => {
					authCheckCalled = true;
					return { authenticated: false };
				},
			},
			spawnCalls,
		);

		const result = runPlanPhase(opts);

		expect(authCheckCalled).toBe(false);
		expect(result.kind).not.toBe('codex-auth-failed');
		expect(respawnCalls(spawnCalls).length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Absent codexAuthCheckFn: falls back to codexAuthPreflight's own default
// (real ~/.codex/auth.json check) only when backend=codex; host default
// claude backend never touches this seam at all (already proved above).
// ---------------------------------------------------------------------------

describe('plan-runner codex auth: absent seam is backward compatible', () => {
	test('absent codexAuthCheckFn + claude backend -> unaffected (backward compat)', () => {
		const spawnCalls: string[][] = [];
		const opts = makeOpts({}, spawnCalls);

		const result = runPlanPhase(opts);

		expect(result.kind).not.toBe('codex-auth-failed');
		expect(respawnCalls(spawnCalls).length).toBe(2);
	});
});
