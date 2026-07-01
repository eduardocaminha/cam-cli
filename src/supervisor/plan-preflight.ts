// src/supervisor/plan-preflight.ts
//
// Deterministic plan pre-flight checks (US-004, CAM-117).
//
// Ports the LLM-driven Step 0 of cam-plan.md into a pure, testable TS module:
//   1. git checkout main
//   2. git pull origin main
//   3. Prune merged cam/* local branches (best-effort; skipped when gh absent)
//   4. git status --porcelain (non-empty output => halt, step 'clean-tree')
//   5. bun run typecheck
//   6. bun test
//
// Every binary call routes through the injected spawnFn so unit tests can
// assert argv shapes without shelling out. Follows the discriminated-union
// pattern from preflight-container.ts.
//
// noUncheckedIndexedAccess: no direct array indexing in required-step flow;
// the prune loop uses for-of (element is string) and filter (removes empty).

/**
 * Injectable spawn seam. Accepts a binary name and its argument array;
 * returns the combined stdout and exit code.
 *
 * The production implementation wraps node:child_process spawnSync with cwd
 * closed over. Unit tests inject a fake that records calls and returns
 * configurable responses without shelling out.
 *
 * spawnSync does NOT throw on non-zero exit; always check exitCode directly
 * (US-R1-001 pattern: `(result.exitCode ?? 1) !== 0`).
 */
export type PlanPreflightSpawnFn = (bin: string, args: string[]) => { stdout: string; exitCode: number };

/** Options for runPlanPreflight. */
export interface RunPlanPreflightOptions {
	/**
	 * Project working directory. Not used by the pure function itself; present
	 * for the production caller to build a cwd-aware spawnFn closure.
	 */
	cwd: string;

	/** Injectable spawn seam; every git/bun/gh call routes through this. */
	spawnFn: PlanPreflightSpawnFn;

	/**
	 * Whether the `gh` CLI is available on PATH. Defaults to
	 * `Bun.which('gh') !== null` at call time.
	 * Inject `false` in tests to skip the prune step without real gh calls.
	 */
	ghAvailable?: boolean;
}

/**
 * Discriminated union returned by runPlanPreflight.
 *
 * - `{ ok: true }` — all checks passed; safe to spawn the planner.
 * - `{ ok: false; step: string; detail: string }` — the first failing required
 *   step. `step` is one of: 'git-checkout-main', 'git-pull', 'clean-tree',
 *   'typecheck', 'bun-test'. `detail` is the raw stdout of the failing call
 *   (trimmed) for human-readable diagnosis.
 */
export type PlanPreflightResult = { ok: true } | { ok: false; step: string; detail: string };

/**
 * Run the deterministic plan pre-flight checks.
 *
 * Steps run in order; the FIRST required step that fails halts immediately
 * (no later step is run). The prune step (3) is best-effort: any failure is
 * silently swallowed and pre-flight continues.
 */
export function runPlanPreflight(opts: RunPlanPreflightOptions): PlanPreflightResult {
	const { spawnFn } = opts;
	const ghAvailable = opts.ghAvailable ?? (Bun.which('gh') !== null);

	// Step 1: git checkout main
	const checkout = spawnFn('git', ['checkout', 'main']);
	if ((checkout.exitCode ?? 1) !== 0) {
		return { ok: false, step: 'git-checkout-main', detail: checkout.stdout.trim() };
	}

	// Step 2: git pull origin main
	const pull = spawnFn('git', ['pull', 'origin', 'main']);
	if ((pull.exitCode ?? 1) !== 0) {
		return { ok: false, step: 'git-pull', detail: pull.stdout.trim() };
	}

	// Step 3: prune merged cam/* local branches (best-effort)
	if (ghAvailable) {
		pruneMergedCamBranches(spawnFn);
	}

	// Step 4: clean working tree check
	// git status --porcelain exits 0 for both clean and dirty trees; the
	// signal is the output: empty = clean, non-empty = dirty/untracked.
	const status = spawnFn('git', ['status', '--porcelain']);
	if (status.stdout.trim().length > 0) {
		return { ok: false, step: 'clean-tree', detail: status.stdout.trim() };
	}

	// Step 5: typecheck
	const typecheck = spawnFn('bun', ['run', 'typecheck']);
	if ((typecheck.exitCode ?? 1) !== 0) {
		return { ok: false, step: 'typecheck', detail: typecheck.stdout.trim() };
	}

	// Step 6: bun test
	const tests = spawnFn('bun', ['test']);
	if ((tests.exitCode ?? 1) !== 0) {
		return { ok: false, step: 'bun-test', detail: tests.stdout.trim() };
	}

	return { ok: true };
}

/**
 * Best-effort prune of local cam/* branches whose GitHub PR has been merged.
 *
 * Mirrors cam-plan.md Step 0.2:
 *   git for-each-ref --format=%(refname:short) refs/heads/cam/
 *   gh pr list --head <b> --state merged --json number --jq .[0].number
 *   git branch -D <b>  # only when gh reports a merged PR
 *
 * All errors are silently swallowed; this step never halts pre-flight.
 */
function pruneMergedCamBranches(spawnFn: PlanPreflightSpawnFn): void {
	try {
		const forEachRef = spawnFn('git', [
			'for-each-ref',
			'--format=%(refname:short)',
			'refs/heads/cam/',
		]);
		if ((forEachRef.exitCode ?? 1) !== 0) return;

		const branches = forEachRef.stdout
			.trim()
			.split('\n')
			.filter((b) => b.length > 0);

		for (const branch of branches) {
			try {
				const prCheck = spawnFn('gh', [
					'pr',
					'list',
					'--head',
					branch,
					'--state',
					'merged',
					'--json',
					'number',
					'--jq',
					'.[0].number',
				]);
				// gh outputs the PR number when merged, empty string when not merged.
				if (prCheck.exitCode === 0 && prCheck.stdout.trim().length > 0) {
					spawnFn('git', ['branch', '-D', branch]);
				}
			} catch {
				// best-effort: per-branch errors are silently ignored
			}
		}
	} catch {
		// best-effort: any top-level prune error is silently ignored
	}
}
