// scripts/test-in-container.ts
//
// On-demand in-container test harness (US-001, CAM-186 PRD; waiver + exact
// skip-count assertion wired in US-006, CAM-424 PRD).
//
// Ensures the cam-worker container is running (reusing the existing
// ensure-container path) and then runs `bun test` inside it via a
// non-interactive `docker exec` against /workspace.  Parses the Bun summary
// lines and failure blocks to extract pass/fail/skip counts and the names of
// any failing tests.
//
// The container image (oven/bun:1.2-slim) has no tmux and no procps
// (pgrep/ps), by design -- .devcontainer/Dockerfile installs git and jq but
// deliberately not tmux. That absence is declared explicitly, once, on the
// exec'd process via `docker exec -e CAM_TEST_WAIVERS=...` (per `docker exec
// --help`: `-e, --env list` sets an environment variable scoped to the
// exec'd process only, never the container's persistent env) rather than
// left to silently skip.
//
// Exit code: non-zero if there are test FAILURES (fail count > 0), OR the
// observed skip count does not EXACTLY match the container lane's recorded
// expectation in test/helpers/lane-expectations.json. Skipping is a visible,
// counted act, not a silently-green outcome -- any drift (more or fewer
// skips than recorded) is a real signal and must fail the run.
//
// NOT a CI gate: this script is intentionally absent from the GATES manifest
// in scripts/check-all.ts and from .github/workflows/ci.yml.  macOS CI
// (macos-latest) has no Docker daemon -- the CAM-178 trap.  Run it locally
// before shipping any container-mode change.
//
// Usage: bun scripts/test-in-container.ts
//        bun run test:container       (package.json convenience alias)

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { makeProductionEnsureContainerFn } from '../src/supervisor/ensure-container.ts';
import { DEFAULT_CONTAINER_NAME } from '../src/supervisor/worker-container.ts';
import { checkSkipCount, EXPECTATIONS_PATH } from './check-skip-ratchet.ts';
import type { LaneExpectationsFile } from './check-skip-ratchet.ts';
import { WAIVER_ENV_VAR } from '../test/helpers/test-deps.ts';
import type { DepName } from '../test/helpers/test-deps.ts';

/**
 * The container lane's hard-dependency binaries that are absent by design in
 * the worker container image (oven/bun:1.2-slim has no tmux, no procps).
 * `ps` is NOT listed here: it is classified 'legitimate-environmental' in
 * test/helpers/test-deps.ts and therefore never needs an explicit waiver.
 */
const CONTAINER_WAIVED_DEPS: readonly DepName[] = ['tmux', 'pgrep', 'uuidgen'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed counts and failing test names from `bun test` stdout/stderr. */
export interface BunTestSummary {
	/** Number of tests that passed. */
	pass: number;
	/** Number of tests that failed. */
	fail: number;
	/** Number of tests that were skipped. */
	skip: number;
	/** Names of failing tests extracted from per-file failure lines. */
	failingTests: string[];
}

/**
 * Injectable fn that ensures the cam-worker container is running.
 * Production: zero-arg thunk from makeProductionEnsureContainerFn.
 * Tests: no-op.
 */
export type EnsureContainerFn = () => void;

/**
 * Injectable fn that runs `bun test` non-interactively inside the container
 * and returns the combined stdout+stderr output with the raw process exit code.
 */
export type ExecBunTestFn = (containerName: string) => { output: string; exitCode: number };

/** Injectable fn that reads and parses test/helpers/lane-expectations.json. */
export type ReadExpectationsFn = () => LaneExpectationsFile;

/** Options for `runInContainerTests`. */
export interface RunInContainerTestsOptions {
	/**
	 * Container name to exec into.
	 * Defaults to DEFAULT_CONTAINER_NAME ('cam-worker').
	 */
	containerName?: string;
	/**
	 * Injectable ensure-container fn.
	 * When absent, the production factory is used (requires Docker daemon).
	 */
	ensureFn?: EnsureContainerFn;
	/**
	 * Injectable exec fn.
	 * When absent, a real `docker exec <container> bun test` call is made.
	 */
	execFn?: ExecBunTestFn;
	/**
	 * Injectable lane-expectations reader.
	 * When absent, a real read of test/helpers/lane-expectations.json (rooted
	 * at `cwd`) is made.
	 */
	readExpectations?: ReadExpectationsFn;
	/**
	 * Working directory for the production ensure-container factory and the
	 * default lane-expectations reader.
	 * Defaults to process.cwd().
	 */
	cwd?: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse stdout+stderr from `bun test` and return pass/fail/skip counts and
 * failing test names.
 *
 * Bun summary lines: ' N pass' / ' N fail' / ' N skip' (single leading space).
 * Failing test markers in non-TTY (docker-exec) capture path:
 *   '(fail) test name'          -- without CLAUDECODE=1
 *   '(fail) test name [Nms]'    -- with CLAUDECODE=1 (adds bracketed duration)
 *   '(todo) test name [Nms]'    -- todo tests (same format)
 * The ✗ glyph is a TTY-only marker; it is never emitted in non-interactive mode.
 *
 * noUncheckedIndexedAccess: all regex capture groups are guarded with ?? '0'.
 */
export function parseBunOutput(output: string): BunTestSummary {
	const lines = output.split('\n');
	let pass = 0;
	let fail = 0;
	let skip = 0;

	// Use a Set to deduplicate in case the same test name appears more than
	// once across multiple output blocks (defensive; typically each name
	// appears exactly once in the non-TTY capture path).
	const failingTestsSet = new Set<string>();

	for (const line of lines) {
		// Summary lines: ' N pass' / ' N fail' / ' N skip'
		const passM = /^ (\d+) pass/.exec(line);
		if (passM) {
			pass = parseInt(passM[1] ?? '0', 10);
			continue;
		}
		const failM = /^ (\d+) fail/.exec(line);
		if (failM) {
			fail = parseInt(failM[1] ?? '0', 10);
			continue;
		}
		const skipM = /^ (\d+) skip/.exec(line);
		if (skipM) {
			skip = parseInt(skipM[1] ?? '0', 10);
			continue;
		}

		// Failing test lines in non-TTY mode:
		//   '(fail) test name'         -- no duration
		//   '(fail) test name [2ms]'   -- CLAUDECODE=1 adds bracketed duration
		//   '(todo) test name [2ms]'   -- todo tests use the same pattern
		// The optional '[Nms]' suffix is stripped; the rest is the test name.
		const failLineM = /^\((fail|todo)\)\s+(.+?)(?:\s+\[\d+.*ms\])?\s*$/.exec(line);
		if (failLineM) {
			const name = failLineM[2]?.trim();
			if (name) failingTestsSet.add(name);
		}
	}

	return { pass, fail, skip, failingTests: [...failingTestsSet] };
}

// ---------------------------------------------------------------------------
// Core harness function (all deps injectable)
// ---------------------------------------------------------------------------

/**
 * Ensure the cam-worker container is running and execute `bun test` inside it.
 *
 * Returns the parsed Bun summary, the container lane's skip-count ratchet
 * check (against test/helpers/lane-expectations.json), and the exit code the
 * caller should use: exitCode 1 when fail > 0 OR the observed skip count
 * does not exactly match the recorded expectation; exitCode 0 only when both
 * hold.
 *
 * The returned exitCode is derived from the parsed fail count and the skip
 * ratchet check, not from the raw docker exec exit code, because `bun test`
 * may exit non-zero on skips alone.
 */
export function runInContainerTests(options: RunInContainerTestsOptions = {}): {
	summary: BunTestSummary;
	skipCheck: ReturnType<typeof checkSkipCount>;
	exitCode: number;
} {
	const containerName = options.containerName ?? DEFAULT_CONTAINER_NAME;
	const cwd = options.cwd ?? process.cwd();

	// Ensure the container is running via the existing ensure-container path.
	const ensureFn: EnsureContainerFn =
		options.ensureFn ?? makeProductionEnsureContainerFn(cwd);
	ensureFn();

	// Run `bun test` non-interactively inside the container.
	// The container WORKDIR is /workspace (Dockerfile line 72), so bun test
	// runs against the bind-mounted repo by default.
	// We do NOT reuse dockerExecWrap (src/supervisor/docker-exec.ts) -- that
	// helper adds `-it` for the TUI worker; here we need non-interactive exec
	// so stdout is capturable.
	const execFn: ExecBunTestFn = options.execFn ?? makeDefaultExecFn();
	const { output } = execFn(containerName);

	const summary = parseBunOutput(output);

	const readExpectations: ReadExpectationsFn =
		options.readExpectations ?? makeDefaultReadExpectations(cwd);
	const expectedSkips = readExpectations().lanes.container.expectedSkips;
	const skipCheck = checkSkipCount(summary.skip, expectedSkips, 'container');

	// Re-derive exit code from the parsed fail count AND the skip ratchet
	// check (not from the raw docker exit code).
	const exitCode = summary.fail > 0 || !skipCheck.ok ? 1 : 0;

	return { summary, skipCheck, exitCode };
}

// ---------------------------------------------------------------------------
// Production adapters
// ---------------------------------------------------------------------------

/**
 * Return the `docker exec` argument vector to run `bun test` inside the
 * named container, with the container lane's dependency waiver injected via
 * `-e`.
 *
 * Shape: `['exec', '-e', 'CAM_TEST_WAIVERS=tmux,pgrep,uuidgen', containerName, 'bun', 'test']`
 *
 * Why `-e` (mirrors buildFirewallExecArgv / buildAuthCheckExecArgv style):
 *   `docker exec --help` documents `-e, --env list` as scoped to the exec'd
 *   process only, never the container's persistent env -- exactly the
 *   per-run, per-invocation declaration this lane needs.
 */
export function buildContainerTestExecArgv(containerName: string): string[] {
	const waivers = CONTAINER_WAIVED_DEPS.join(',');
	return ['exec', '-e', `${WAIVER_ENV_VAR}=${waivers}`, containerName, 'bun', 'test'];
}

/**
 * Build the production docker exec fn.
 * Calls `docker exec -e CAM_TEST_WAIVERS=<...> <container> bun test`
 * (no -it: non-interactive, capturable).
 */
function makeDefaultExecFn(): ExecBunTestFn {
	return (containerName: string) => {
		const r = spawnSync('docker', buildContainerTestExecArgv(containerName), {
			encoding: 'utf8',
		});
		const out = typeof r.stdout === 'string' ? r.stdout : '';
		const err = typeof r.stderr === 'string' ? r.stderr : '';
		return { output: out + err, exitCode: r.status ?? 1 };
	};
}

/** Build the production lane-expectations reader, rooted at `cwd`. */
function makeDefaultReadExpectations(cwd: string): ReadExpectationsFn {
	return () => JSON.parse(readFileSync(join(cwd, EXPECTATIONS_PATH), 'utf8')) as LaneExpectationsFile;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const { summary, skipCheck, exitCode } = runInContainerTests();

	process.stdout.write(
		`pass: ${summary.pass}, fail: ${summary.fail}, skip: ${summary.skip}\n`,
	);
	if (summary.failingTests.length > 0) {
		process.stdout.write('failing tests:\n');
		for (const name of summary.failingTests) {
			process.stdout.write(`  ✗ ${name}\n`);
		}
	}
	process.stdout.write(`${skipCheck.message}\n`);

	process.exit(exitCode);
}
