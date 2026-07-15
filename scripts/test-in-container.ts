// scripts/test-in-container.ts
//
// On-demand in-container test harness (US-001, CAM-186 PRD).
//
// Ensures the cam-worker container is running (reusing the existing
// ensure-container path) and then runs `bun test` inside it via a
// non-interactive `docker exec` against /workspace.  Parses the Bun summary
// lines and failure blocks to extract pass/fail/skip counts and the names of
// any failing tests.
//
// Exit code: non-zero if and only if there are test FAILURES (fail count > 0).
// A run with only skips (fail count 0) exits 0.
//
// NOT a CI gate: this script is intentionally absent from the GATES manifest
// in scripts/check-all.ts and from .github/workflows/ci.yml.  macOS CI
// (macos-latest) has no Docker daemon -- the CAM-178 trap.  Run it locally
// before shipping any container-mode change.
//
// Usage: bun scripts/test-in-container.ts
//        bun run test:container       (package.json convenience alias)

import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { makeProductionEnsureContainerFn } from '../src/supervisor/ensure-container.ts';
import { DEFAULT_CONTAINER_NAME } from '../src/supervisor/worker-container.ts';

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
	 * Working directory for the production ensure-container factory.
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
 * Returns the parsed Bun summary and the exit code the caller should use:
 *   exitCode 1 when fail > 0, exitCode 0 otherwise (even with skips).
 *
 * The returned exitCode is derived from the parsed fail count, not from the
 * raw docker exec exit code, because `bun test` may exit non-zero on skips.
 */
export function runInContainerTests(options: RunInContainerTestsOptions = {}): {
	summary: BunTestSummary;
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

	// Re-derive exit code from parsed fail count (not from raw docker exit code).
	const exitCode = summary.fail > 0 ? 1 : 0;

	return { summary, exitCode };
}

// ---------------------------------------------------------------------------
// Production exec adapter
// ---------------------------------------------------------------------------

/**
 * Build the production docker exec fn.
 * Calls `docker exec <container> bun test` (no -it: non-interactive, capturable).
 */
function makeDefaultExecFn(): ExecBunTestFn {
	return (containerName: string) => {
		const r = spawnSync('docker', ['exec', containerName, 'bun', 'test'], {
			encoding: 'utf8',
		});
		const out = typeof r.stdout === 'string' ? r.stdout : '';
		const err = typeof r.stderr === 'string' ? r.stderr : '';
		return { output: out + err, exitCode: r.status ?? 1 };
	};
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const { summary, exitCode } = runInContainerTests();

	process.stdout.write(
		`pass: ${summary.pass}, fail: ${summary.fail}, skip: ${summary.skip}\n`,
	);
	if (summary.failingTests.length > 0) {
		process.stdout.write('failing tests:\n');
		for (const name of summary.failingTests) {
			process.stdout.write(`  ✗ ${name}\n`);
		}
	}

	process.exit(exitCode);
}
