// test/supervisor/plan/plan-runner-configpath-seam.test.ts
//
// Unit tests for US-002 (CAM-420): the `configPath` DI seam on
// RunPlanPhaseOptions, threaded into the four planner/auditor-resolution call
// sites (readPhaseBackend('planner'|'auditor', opts.configPath) and the two
// resolvePhaseModel({ ..., configPath: opts.configPath }) calls immediately
// below each) inside resolveAndSpawnPlanner / resolveAndSpawnAuditor
// (src/supervisor/plan-runner.ts).
//
// Modelled on test/supervisor/review.test.ts:2008's "AC5 regression:
// reviewer=codex resolved via the injected seam does not fail with
// codex-auth-failed" test (the reviewer-side sibling seam from CAM-405),
// adapted to the two plan-phase dispatch sites and
// plan-runner-model-resolution.test.ts's makeOpts fixture conventions.
//
// Coverage:
//   AC1/AC2: covered by the static grep oracles in prd.json (no runtime test
//     needed for "the field exists" / "the call sites pass it through").
//   AC3: covered implicitly -- every existing suite (plan-runner.test.ts,
//     plan-runner-model-resolution.test.ts, plan-runner-codex-auth.test.ts,
//     etc.) omits configPath and stays green, proving the omitted-seam path is
//     byte-for-byte unchanged.
//   AC4 (this file, two tests): a tmpdir project.toml selects codex for ONE
//     phase (planner in the first test, auditor in the second) plus a
//     [models.codex] pin for that same phase (gpt-5-codex), leaving the other
//     phase's key absent so it resolves the repo's own default ('claude') from
//     the SAME fixture file. Injecting a fake codexAuthCheckFn alongside
//     configPath proves resolution went through the FIXTURE (not the repo's
//     live scripts/cam/project.toml, which stays on 'claude' for both phases):
//     (a) the fake auth check was called, (b) the result kind is not
//     'codex-auth-failed', (c) the dispatched worker argv for that phase
//     carries the pinned codex model.
//
// .claude/agents/subagent-planner.md and subagent-auditor.md are already
// committed at the repo root (needed by CodexAdapter.buildSpawnArgv), so no
// per-test chdir/staging is needed for them -- only the configPath fixture
// changes (mirrors the review.ts US-006/CAM-398 "pre-existing configPath DI
// seam needs zero chdir" precedent, patterns.md line 987).
//
// red-sweep (issue AC7): this file was copied into a fresh git worktree of
// unmodified main (git worktree add <tmp> main; bun install
// --frozen-lockfile inside the worktree first), then run there with
// `bun test test/supervisor/plan/plan-runner-configpath-seam.test.ts`.
// Measured result on main: 2 fail / 0 pass, both failing at the
// `expect(authCheckCalled).toBe(true)` assertion with authCheckCalled still
// false. On main, RunPlanPhaseOptions has no configPath field, so the extra
// property on the opts literal is inert at runtime (Bun strips types, does
// not typecheck excess object properties); resolveAndSpawnPlanner /
// resolveAndSpawnAuditor call readPhaseBackend('planner'|'auditor') with NO
// second argument, so each resolves the worktree's own live
// scripts/cam/project.toml relative to process.cwd() (the worktree root,
// which the test does not chdir away from) instead of the tmpdir fixture.
// That live config selects the claude backend for both phases, so
// codexAuthPreflight's `backend !== 'codex'` short-circuit means the injected
// codexAuthCheckFn is NEVER invoked for either phase. On this branch (with
// the seam wired in) the same file is green (2 pass / 0 fail). The worktree
// was removed after the sweep (git worktree remove --force). This confirms
// both new tests are falsifiable regression guards, not tautologies.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	runPlanPhase,
	type RunPlanPhaseOptions,
	type PlanMutexState,
} from '../../../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../../../src/supervisor/loop.ts';
import type { IssueEntry } from '../../../src/issues/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-420',
	title: 'configPath seam test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-26T00:00:00Z',
	updatedAt: '2026-07-26T00:00:00Z',
};

const FAKE_UUID = 'aabbccdd-eeff-1122-3344-556677889900';

/**
 * Build opts where preflight/mutex/selectIssue are always happy, the pane
 * dies immediately (poll loops exit fast), and the auditor verdict report
 * (when reached) approves. Mirrors plan-runner-model-resolution.test.ts's
 * makeOpts, but leaves codexAuthCheckFn/configPath to the caller.
 */
function makeOpts(
	overrides: Partial<RunPlanPhaseOptions>,
	spawnCalls: string[][] = [],
): RunPlanPhaseOptions {
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
		...overrides,
	};
}

/** Extract all respawn-pane args arrays from recorded spawn calls. */
function respawnCalls(calls: string[][]): string[][] {
	return calls.filter((a) => a[2] === 'respawn-pane');
}

// ---------------------------------------------------------------------------
// AC4/AC6: codex regression tests, one planner, one auditor
// ---------------------------------------------------------------------------

describe('plan-runner US-002 (CAM-420): configPath seam on the planner/auditor resolution call sites', () => {
	test('planner site: planner=codex resolved via the injected configPath seam does not fail with codex-auth-failed', () => {
		const codexConfigDir = mkdtempSync(join(tmpdir(), 'cam-plan-configpath-seam-planner-'));
		const codexConfigPath = join(codexConfigDir, 'project.toml');
		writeFileSync(
			codexConfigPath,
			'[backend]\nplanner = "codex"\n\n[models.codex]\nplanner = "gpt-5-codex"\n',
		);
		try {
			const spawnCalls: string[][] = [];
			let authCheckCalled = false;
			const opts = makeOpts(
				{
					// The seam under test: plannerBackend resolves to 'codex' from THIS
					// fixture, not from the repo's live scripts/cam/project.toml (which
					// stays on 'claude'). Combined with the pre-existing
					// codexAuthCheckFn seam (US-002, CAM-352) faking an authenticated
					// codex, this proves the planner dispatch path can validate a
					// codex backend in CI without real codex auth.
					configPath: codexConfigPath,
					codexAuthCheckFn: () => {
						authCheckCalled = true;
						return { authenticated: true };
					},
				},
				spawnCalls,
			);

			const result = runPlanPhase(opts);

			// (a) the fake auth check was called.
			expect(authCheckCalled).toBe(true);
			// (b) the result kind is not 'codex-auth-failed'.
			expect(result.kind).not.toBe('codex-auth-failed');
			// (c) the spawned argv carries the pinned codex model.
			const calls = respawnCalls(spawnCalls);
			expect(calls.length).toBe(2);
			const plannerCmd = calls[0]?.[calls[0].length - 1] ?? '';
			expect(plannerCmd).toContain('gpt-5-codex');
		} finally {
			rmSync(codexConfigDir, { recursive: true, force: true });
		}
	});

	test('auditor site: auditor=codex resolved via the injected configPath seam does not fail with codex-auth-failed', () => {
		const codexConfigDir = mkdtempSync(join(tmpdir(), 'cam-plan-configpath-seam-auditor-'));
		const codexConfigPath = join(codexConfigDir, 'project.toml');
		writeFileSync(
			codexConfigPath,
			'[backend]\nauditor = "codex"\n\n[models.codex]\nauditor = "gpt-5-codex"\n',
		);
		try {
			const spawnCalls: string[][] = [];
			let authCheckCalled = false;
			const opts = makeOpts(
				{
					// The seam under test: auditorBackend resolves to 'codex' from THIS
					// fixture, not from the repo's live scripts/cam/project.toml (which
					// stays on 'claude'). The planner phase resolves to 'claude' from
					// the SAME fixture (no [backend].planner key), so only the
					// auditor's codex auth check is exercised.
					configPath: codexConfigPath,
					codexAuthCheckFn: () => {
						authCheckCalled = true;
						return { authenticated: true };
					},
				},
				spawnCalls,
			);

			const result = runPlanPhase(opts);

			// (a) the fake auth check was called.
			expect(authCheckCalled).toBe(true);
			// (b) the result kind is not 'codex-auth-failed'.
			expect(result.kind).not.toBe('codex-auth-failed');
			// (c) the spawned argv carries the pinned codex model.
			const calls = respawnCalls(spawnCalls);
			expect(calls.length).toBe(2);
			const auditorCmd = calls[1]?.[calls[1].length - 1] ?? '';
			expect(auditorCmd).toContain('gpt-5-codex');
		} finally {
			rmSync(codexConfigDir, { recursive: true, force: true });
		}
	});
});
