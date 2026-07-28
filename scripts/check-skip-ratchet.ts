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
// Fail-open guard (US-R1-002, review round 1 finding on scripts/check-
// skip-ratchet.ts:138): a crashed / zero-test / garbage `bun test` run (e.g.
// 'error: Cannot find module ...\nbun: command crashed\n') has no ' N skip'
// line either, and was previously indistinguishable from a genuine clean
// 0-skip run -- the exact failure mode this gate exists to prevent. Before
// comparing skip counts, `checkSkipRatchet` now requires POSITIVE evidence
// the suite actually ran to completion: a 'Ran N tests across M files.' tally
// line, AND an observed ' N pass' count at or above the lane's recorded
// `passFloor` (test/helpers/lane-expectations.json). Either check failing
// reports a suite-did-not-run/suite-ran-partial failure instead of silently
// falling through to a 0-skip match.
//
// Too-tight-floor guard (US-001, CAM-447 PRD): a `passFloor` recorded with
// little or no headroom below the observed pass count is itself a defect --
// the gate would go red on the very next test added anywhere in the suite,
// forcing a re-record every few cycles. `checkSuiteRan` now also rejects a
// POSITIVE `passFloor` (0 means "no floor declared" and is exempt) whose gap
// to the observed pass count is below `MIN_PASS_FLOOR_HEADROOM`, with a
// message naming the too-tight failure distinctly ('too tight', never the
// crashed-run wording above) since the operator response is the opposite:
// re-record the floor lower, not investigate a broken run.
//
// Lane selection: 'host' is the default. The container lane is selected via
// the explicit CAM_TEST_LANE=container env var -- the same explicit-
// declaration mechanism as CAM_TEST_WAIVERS (test/helpers/test-deps.ts),
// never by sniffing the environment.
//
// Exports:
//   parseSkipCount(output)                  - parse the skip line, 0 if absent
//   parsePassCount(output)                  - parse the pass line, null if absent
//   suiteRanToCompletion(output)            - true iff the 'Ran N tests...' tally line is present
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
 * Minimum gap, in passing tests, a recorded `passFloor` must keep below the
 * currently observed pass count (US-001, CAM-447 PRD).
 *
 * Anti-churn rationale: a suite only ever grows (adding tests only widens the
 * gap between a fixed floor and the live count), so once a lane's floor is
 * re-recorded with real headroom under this constant, the rule is satisfied
 * for good -- it never needs re-tightening again on its own. The failure mode
 * this guards against is the opposite: a floor recorded AT or just below the
 * observed count (zero or near-zero headroom) turns green today and red on
 * the very next test added anywhere in the suite, forcing an immediate
 * re-record and restarting the churn. Pinning a required headroom means the
 * rule fires (and is fixed) exactly once, rather than every few cycles.
 */
export const MIN_PASS_FLOOR_HEADROOM = 50;

/**
 * Matches Bun's skip-summary line (e.g. ' 3 skip'). Bun omits this line
 * entirely when the count is zero; callers must treat a non-match as zero,
 * never as a parse failure.
 */
const SKIP_LINE_RE = /^ (\d+) skip/m;

/** Matches Bun's pass-summary line (e.g. ' 5720 pass'). Present on every completed run, including all-fail runs. */
const PASS_LINE_RE = /^ (\d+) pass/m;

/**
 * Matches Bun's final completion tally (e.g. 'Ran 5720 tests across 341
 * files. [12.34s]'). Only printed once the run reaches the end of the
 * suite; a crash, missing module, or other abort before that point never
 * prints this line, which is exactly the positive-evidence signal this gate
 * needs before trusting a 0-skip (or any) comparison.
 */
const RAN_LINE_RE = /^Ran \d+ tests? across \d+ files?\./m;

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

/**
 * Parse the ' N pass' summary line out of `bun test` output.
 * Returns null when the line is absent -- unlike the skip line, Bun always
 * prints a pass line for any run that reaches completion (even ' 0 pass'),
 * so a missing pass line is itself evidence the run never completed.
 */
export function parsePassCount(output: string): number | null {
	const m = PASS_LINE_RE.exec(output);
	return m ? parseInt(m[1] ?? '0', 10) : null;
}

/**
 * True iff `output` contains Bun's final completion tally line
 * ('Ran N tests across M files.'). This is the positive-evidence marker that
 * the suite actually ran to completion rather than crashing or aborting
 * before printing a summary.
 */
export function suiteRanToCompletion(output: string): boolean {
	return RAN_LINE_RE.test(output);
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

/**
 * Verify `output` carries positive evidence the suite ran to completion,
 * before any skip-count comparison is trusted.
 *
 * Returns a failing `SkipRatchetResult` when any check fails, in order:
 *   1. no 'Ran N tests across M files.' completion tally line, or
 *   2. an observed pass count below the lane's recorded `passFloor`
 *      (including the case where no pass line was parsed at all), or
 *   3. (applicability guard: only when `passFloor > 0`) an observed pass
 *      count that clears the floor but by less than
 *      `MIN_PASS_FLOOR_HEADROOM` -- the floor was re-recorded too tight and
 *      will go red on the very next test added anywhere in the suite. A
 *      recorded floor of 0 means "no floor declared" and is exempt from this
 *      check (the below-floor comparison above is already vacuous at 0).
 * Returns `null` when the suite ran cleanly and the caller should proceed to
 * the skip-count comparison.
 */
export function checkSuiteRan(output: string, passFloor: number, lane: Lane): SkipRatchetResult | null {
	if (!suiteRanToCompletion(output)) {
		return {
			ok: false,
			message:
				`${lane} lane: suite did not report a completion tally ` +
				`('Ran N tests across M files.'); treating as a crashed or ` +
				`partial run, not a clean run. Raw output (first 300 chars): ` +
				`${output.slice(0, 300)}`,
		};
	}

	const observedPass = parsePassCount(output);
	if (observedPass === null || observedPass < passFloor) {
		return {
			ok: false,
			message:
				`${lane} lane: observed ${observedPass ?? 0} pass, below recorded ` +
				`passFloor ${passFloor} (${EXPECTATIONS_PATH}); suite likely crashed ` +
				`or ran only a subset. Update ${EXPECTATIONS_PATH} if this drop is intentional.`,
		};
	}

	const headroom = observedPass - passFloor;
	if (passFloor > 0 && headroom < MIN_PASS_FLOOR_HEADROOM) {
		return {
			ok: false,
			message:
				`${lane} lane: recorded passFloor ${passFloor} is too tight against ` +
				`observed ${observedPass} pass (headroom ${headroom}, below the required ` +
				`${MIN_PASS_FLOOR_HEADROOM}); re-record ${EXPECTATIONS_PATH} with a lower ` +
				`floor that leaves real headroom, so adding tests doesn't retrigger this check.`,
		};
	}

	return null;
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
	const laneExpectation = expectations.lanes[lane];
	const output = getSuiteOutput();

	const suiteRanResult = checkSuiteRan(output, laneExpectation.passFloor, lane);
	if (suiteRanResult) return suiteRanResult;

	const observedSkips = parseSkipCount(output);
	return checkSkipCount(observedSkips, laneExpectation.expectedSkips, lane);
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
