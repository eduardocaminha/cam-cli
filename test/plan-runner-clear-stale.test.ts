// test/plan-runner-clear-stale.test.ts
//
// Unit test: proves that a stale plan-verdict-report.json written BEFORE
// runPlanPhase does NOT contaminate the run (Bug 2 fix, US-002, CAM-155).
//
// Acceptance criteria proved:
//   AC3: a plan-verdict-report.json with verdict 'APPROVE' written before
//        runPlanPhase does NOT survive the call: after the clear,
//        readPlanVerdictFn() returns null (the stale file was deleted by
//        clearStalePlanArtifactsFn before preflight ran).
//
//   AC1: the clear runs BEFORE preflight -- proved by injecting a preflight
//        that fails immediately, so the function returns 'preflight-failed'
//        right after the clear and before any pane spawn. Both files are
//        gone after the call.

import { afterAll, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPlanPhase } from '../src/supervisor/plan-runner.ts';
import { makeReadPlanVerdict, PLAN_VERDICT_REPORT_FILENAME } from '../src/supervisor/plan-verdict-report.ts';

// ---------------------------------------------------------------------------
// Generic backend fixture (US-008, CAM-420): isolates this suite's
// planner/auditor backend resolution from the repo's real project.toml, so a
// codex planner/auditor config cannot break these generic-backend tests.
// ---------------------------------------------------------------------------

const GENERIC_PLAN_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cam-plan-runner-clear-stale-fixture-'));
const GENERIC_PLAN_CONFIG_PATH = join(GENERIC_PLAN_CONFIG_DIR, 'project.toml');
writeFileSync(GENERIC_PLAN_CONFIG_PATH, '[backend]\nplanner = "claude"\nauditor = "claude"\n');

afterAll(() => {
	rmSync(GENERIC_PLAN_CONFIG_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Minimal fake for SpawnFn (never called: preflight fails before any spawn).
// ---------------------------------------------------------------------------
const noopSpawnFn = (): { stdout: string; exitCode: number } => ({ stdout: '', exitCode: 0 });

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test(
	'stale plan-verdict-report.json is cleared before preflight and does not contaminate the run (AC3)',
	() => {
		// 1. Set up a fresh temp working directory mimicking the repo root.
		const cwd = mkdtempSync(join(tmpdir(), 'cam-plan-runner-clear-'));
		mkdirSync(join(cwd, 'scripts', 'cam'), { recursive: true });

		const verdictPath = join(cwd, PLAN_VERDICT_REPORT_FILENAME);
		const prdPath = join(cwd, 'scripts', 'cam', 'prd.json');

		// 2. Write a stale plan-verdict-report.json with APPROVE verdict.
		writeFileSync(
			verdictPath,
			JSON.stringify({
				verdict: 'APPROVE',
				summary: 'stale from previous run',
				findings: [],
			}),
		);

		// 3. Write a stale prd.json (also cleared by clearStalePlanArtifactsFn).
		writeFileSync(
			prdPath,
			JSON.stringify({ branchName: 'stale-branch', userStories: [] }),
		);

		// 4. Confirm the stale report IS readable BEFORE the run.
		const readPlanVerdictFn = makeReadPlanVerdict(cwd);
		expect(readPlanVerdictFn()).not.toBeNull();
		expect(existsSync(prdPath)).toBe(true);

		// 5. Build clearStalePlanArtifactsFn (mirrors sidecar.ts production wiring).
		//    Best-effort: no-op on missing, never throws.
		const clearStalePlanArtifactsFn = (): void => {
			try {
				if (existsSync(verdictPath)) unlinkSync(verdictPath);
			} catch { /* best-effort */ }
			try {
				if (existsSync(prdPath)) unlinkSync(prdPath);
			} catch { /* best-effort */ }
		};

		// 6. Run runPlanPhase with a preflight that fails immediately.
		//    The function should: (a) call clearStalePlanArtifactsFn, then
		//    (b) call preflightFn, then (c) return 'preflight-failed'.
		//    No pane spawn occurs (noopSpawnFn is never called for a spawn).
		const result = runPlanPhase({
			spawnFn: noopSpawnFn,
			isPaneAlive: () => false,
			sleepFn: () => {},
			genUuid: () => 'test-uuid-0000-0000-0000-000000000000',
			selectIssueFn: () => null,
			readPlanVerdictFn,
			preflightFn: () => ({ ok: false, step: 'test-step', detail: 'forced-fail-for-test' }),
			clock: Date.now,
			plannerPaneId: '%2',
			paneCountMutexFn: () => 'available',
			clearStalePlanArtifactsFn,
			configPath: GENERIC_PLAN_CONFIG_PATH,
		});

		// 7. The run must return 'preflight-failed' (clear runs before preflight).
		expect(result.kind).toBe('preflight-failed');

		// 8. AC3: readPlanVerdictFn now returns null -- the stale APPROVE is gone.
		expect(readPlanVerdictFn()).toBeNull();

		// 9. prd.json was also cleared.
		expect(existsSync(prdPath)).toBe(false);
	},
);
