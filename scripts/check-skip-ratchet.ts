// scripts/check-skip-ratchet.ts
//
// Per-lane skip-count ratchet gate (US-005, CAM-424 PRD).
//
// Runs `bun test`, parses the Bun summary's ' N skip' line, and compares the
// observed skip count against the current lane's recorded expectation in
// test/helpers/lane-expectations.json. ANY delta (increase or decrease)
// fails the gate with a message naming the signed delta, so a future silent
// skip can never pass unnoticed and the triage evidence in the lane file
// stays truthful.
//
// Parser constraint (swept): Bun omits the ' N skip' summary line entirely
// when the count is zero -- it never prints ' 0 skip'. A MISSING line is
// therefore treated as zero, not as "unparseable".
//
// Lane selection: 'host' is the default. The container lane is selected via
// the explicit CAM_TEST_LANE=container env var -- the same explicit-
// declaration mechanism as CAM_TEST_WAIVERS (test/helpers/test-deps.ts),
// never by sniffing the environment.
//
// Exports:
//   parseSkipCount(output)                  - parse the skip line, 0 if absent
//   resolveLane(env)                        - 'host' (default) or 'container'
//   checkSkipCount(observed, expected, lane) - pure comparison + message
//   checkSkipRatchet(options)               - full check, DI-injectable
//
// Usage: bun scripts/check-skip-ratchet.ts
//        CAM_TEST_LANE=container bun scripts/check-skip-ratchet.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The two lanes test/helpers/lane-expectations.json records expectations for. */
export type Lane = 'host' | 'container';

/** Per-lane recorded expectation. */
export interface LaneExpectation {
	expectedSkips: number;
	passFloor: number;
}

/** Shape of test/helpers/lane-expectations.json. */
export interface LaneExpectationsFile {
	lanes: {
		host: LaneExpectation;
		container: LaneExpectation;
	};
	triage: {
		hardDependency: number;
		legitimateEnvironmental: number;
	};
}

/** Injectable fn that returns the combined stdout+stderr of a `bun test` run. */
export type GetSuiteOutputFn = () => string;

/** Injectable fn that reads and parses the lane-expectations file. */
export type ReadExpectationsFn = () => LaneExpectationsFile;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Explicit lane-declaration env var. Mirrors CAM_TEST_WAIVERS's explicitness. */
export const LANE_ENV_VAR = 'CAM_TEST_LANE';

/** Repo-relative path to the lane-expectations file. */
export const EXPECTATIONS_PATH = 'test/helpers/lane-expectations.json';

/**
 * Matches Bun's skip-summary line (e.g. ' 3 skip'). Bun omits this line
 * entirely when the count is zero; callers must treat a non-match as zero,
 * never as a parse failure.
 */
const SKIP_LINE_RE = /^ (\d+) skip/m;

// ---------------------------------------------------------------------------
// Pure parsing / resolution functions
// ---------------------------------------------------------------------------

/**
 * Parse the ' N skip' summary line out of `bun test` output.
 * Returns 0 when the line is absent (Bun's zero-skip convention), never
 * throws on unrelated output.
 */
export function parseSkipCount(output: string): number {
	const m = SKIP_LINE_RE.exec(output);
	return m ? parseInt(m[1] ?? '0', 10) : 0;
}

/** Resolve the current lane from an env object. Defaults to 'host'; never sniffs. */
export function resolveLane(env: NodeJS.ProcessEnv = process.env): Lane {
	return env[LANE_ENV_VAR] === 'container' ? 'container' : 'host';
}

/** Result of comparing an observed skip count against a lane's recorded expectation. */
export interface SkipRatchetResult {
	ok: boolean;
	message: string;
}

/**
 * Compare `observedSkips` against `expectedSkips` for `lane`.
 *
 * Any delta (increase OR decrease) fails: the recorded expectation is meant
 * to be a truthful, current snapshot, so a decrease (an improvement) must be
 * reflected by editing the lane file, exactly like an increase (a
 * regression) must be fixed or explicitly re-recorded.
 */
export function checkSkipCount(observedSkips: number, expectedSkips: number, lane: Lane): SkipRatchetResult {
	if (observedSkips === expectedSkips) {
		return {
			ok: true,
			message: `${lane} lane: ${observedSkips} skip (matches recorded expectation)`,
		};
	}

	const delta = observedSkips - expectedSkips;
	const signedDelta = delta > 0 ? `+${delta}` : `${delta}`;
	return {
		ok: false,
		message:
			`${lane} lane: observed ${observedSkips} skip, expected ${expectedSkips} ` +
			`(delta ${signedDelta}). Update ${EXPECTATIONS_PATH} if this change is ` +
			`intentional, or fix the regression if it is not.`,
	};
}

// ---------------------------------------------------------------------------
// Default real-world adapters
// ---------------------------------------------------------------------------

function makeDefaultGetSuiteOutput(cwd: string): GetSuiteOutputFn {
	return () => {
		const r = Bun.spawnSync(['bun', 'test'], { cwd });
		return new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
	};
}

function makeDefaultReadExpectations(path: string): ReadExpectationsFn {
	return () => JSON.parse(readFileSync(path, 'utf8')) as LaneExpectationsFile;
}

// ---------------------------------------------------------------------------
// Core check function (all deps injectable)
// ---------------------------------------------------------------------------

/**
 * Run the skip-count ratchet check with injectable dependencies.
 *
 * Production callers supply no options (or just `lane`); tests inject an
 * in-memory suite-output fake and expectations reader so no real `bun test`
 * subprocess or filesystem read happens in unit tests.
 */
export function checkSkipRatchet(
	options: {
		getSuiteOutput?: GetSuiteOutputFn;
		readExpectations?: ReadExpectationsFn;
		lane?: Lane;
		cwd?: string;
	} = {},
): SkipRatchetResult {
	const cwd = options.cwd ?? process.cwd();
	const lane = options.lane ?? resolveLane();
	const getSuiteOutput = options.getSuiteOutput ?? makeDefaultGetSuiteOutput(cwd);
	const readExpectations =
		options.readExpectations ?? makeDefaultReadExpectations(join(cwd, EXPECTATIONS_PATH));

	const expectations = readExpectations();
	const observedSkips = parseSkipCount(getSuiteOutput());
	const expectedSkips = expectations.lanes[lane].expectedSkips;

	return checkSkipCount(observedSkips, expectedSkips, lane);
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const result = checkSkipRatchet();

	if (!result.ok) {
		process.stderr.write(`check:skip-ratchet: ${result.message}\n`);
		process.exit(1);
	}

	process.stdout.write(`check:skip-ratchet: ${result.message}\n`);
}
