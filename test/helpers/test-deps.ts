// test/helpers/test-deps.ts
//
// Centralized dependency-probe helper (US-001, CAM-424).
//
// Before this module, 46+ call sites across test/** each hand-rolled their
// own `Bun.which('x') !== null` / `spawnSync('x', ['--version'])` probe and
// silently decided, on their own, whether an absent binary was fine to skip
// on. That is a scattered, unauditable predicate: nothing forces the author
// to say WHY absence is fine, and nothing distinguishes "this binary is a
// real hard dependency of cam itself, its absence is a defect" from "this
// binary is known-legitimately-absent in one narrow environment".
//
// This module centralizes that decision for the 7 binaries the suite
// depends on (tmux, git, jq, pgrep, ps, uuidgen, bun):
//   - each is probed exactly ONCE, at module load (never per-test);
//   - each carries an explicit classification: 'hard-dependency' (expected
//     present on any real dev/CI host; absence is a real toolchain gap) or
//     'legitimate-environmental' (a documented, narrow case where absence
//     is expected and not a red flag -- currently only `ps`, see below);
//   - absence of a hard-dependency is a FAILURE unless explicitly waived via
//     the CAM_TEST_WAIVERS env var (comma-separated binary names), which is
//     a visible, falsifiable opt-in -- never a silent skip.
//
// `depPreflight` is the pure decision fn callers actually consume. Its DI
// seam (`available`/`waived`, both destructure-defaulted to the real probed
// snapshot) mirrors codexAuthPreflight's `authCheck = codexAuthCheck`
// pattern (src/supervisor/codex-auth.ts, CAM-352): the seam lets tests
// inject an absence that cannot be reproduced by real I/O (macOS dev boxes
// and CI both always have these /usr/bin binaries present), while the
// production default wires straight through to the real probe + real env
// read. This is ADR-0039-compliant: DI-injected absence stands in for real
// I/O exactly where the real-I/O route is unavailable.

/** The 7 external binaries this test suite depends on. */
export type DepName = 'tmux' | 'git' | 'jq' | 'pgrep' | 'ps' | 'uuidgen' | 'bun';

/**
 * 'hard-dependency': expected present on any real dev/CI host; absence is a
 * genuine toolchain gap and should fail loudly unless explicitly waived.
 * 'legitimate-environmental': a documented, narrow case where absence is
 * expected and does not indicate a real problem.
 */
export type DepClassification = 'hard-dependency' | 'legitimate-environmental';

/** Static classification data + probe result for one dependency. */
export interface DepInfo {
	name: DepName;
	/** Once-probed availability (Bun.which(name) !== null), snapshotted at module load. */
	available: boolean;
	classification: DepClassification;
	/** Why this dependency carries the classification above. */
	rationale: string;
	/** Actionable install hint surfaced when a hard-dependency is absent. */
	installHint: string;
}

const DEP_NAMES: readonly DepName[] = ['tmux', 'git', 'jq', 'pgrep', 'ps', 'uuidgen', 'bun'];

/** Static classification/rationale/install-hint data, keyed by dependency name. */
const DEP_METADATA: Record<
	DepName,
	Pick<DepInfo, 'classification' | 'rationale' | 'installHint'>
> = {
	tmux: {
		classification: 'hard-dependency',
		rationale:
			'every cam session runs inside a tmux split (scripts/cam/CLAUDE.md: ' +
			'"External processes" lists tmux as a runtime dependency alongside claude ' +
			'and git); tmux is a hard runtime dependency, not an optional extra.',
		installHint:
			'tmux not found on PATH; install it (`brew install tmux` on macOS, ' +
			'`apt-get install tmux` on Debian/Ubuntu) before running this suite.',
	},
	git: {
		classification: 'hard-dependency',
		rationale:
			'cam shells out to git for every worktree/branch/commit operation; there ' +
			'is no git-less code path.',
		installHint:
			'git not found on PATH; install it (`brew install git` on macOS, ' +
			'`apt-get install git` on Debian/Ubuntu) before running this suite.',
	},
	jq: {
		classification: 'hard-dependency',
		rationale:
			'jq backs multiple cam commands and init-firewall.sh JSON manipulation; ' +
			'it is installed in the worker container image itself (.devcontainer/Dockerfile), ' +
			'so its absence anywhere test-relevant is a real toolchain gap.',
		installHint:
			'jq not found on PATH; install it (`brew install jq` on macOS, ' +
			'`apt-get install jq` on Debian/Ubuntu) before running this suite.',
	},
	pgrep: {
		classification: 'hard-dependency',
		rationale:
			'pgrep backs the orchestrator recycle-watcher child-pid resolution path, ' +
			'which runs on the host; absence there is a real host toolchain gap, not ' +
			'an expected environment (contrast with `ps`, below).',
		installHint:
			'pgrep not found on PATH; install procps (ships by default on macOS, ' +
			'`apt-get install procps` on Debian/Ubuntu) before running this suite.',
	},
	ps: {
		classification: 'legitimate-environmental',
		rationale:
			'ps is absent in oven/bun:1.2-slim (no procps package installed in the ' +
			'worker container image); the production recycle-watcher runs on the ' +
			'host, not inside the worker container, so a container test environment ' +
			'lacking ps does not reflect a host toolchain gap.',
		installHint:
			'ps not found on PATH; install procps (`apt-get install procps` on ' +
			'Debian/Ubuntu) if you need to exercise this path outside the worker container.',
	},
	uuidgen: {
		classification: 'hard-dependency',
		rationale:
			'uuidgen mints the session id used to correlate a worker with its Claude ' +
			'Code transcript file; there is no fallback id source.',
		installHint:
			'uuidgen not found on PATH; install it (ships by default on macOS, ' +
			'`apt-get install uuid-runtime` on Debian/Ubuntu) before running this suite.',
	},
	bun: {
		classification: 'hard-dependency',
		rationale:
			'bun is the runtime cam itself is built, run, and tested on; there is no ' +
			'code path that runs without it.',
		installHint: 'bun not found on PATH; install it from https://bun.sh before running this suite.',
	},
};

function probe(name: DepName): boolean {
	return Bun.which(name) !== null;
}

// Probed exactly once, at module load: every caller shares this frozen
// snapshot instead of re-probing per-test.
const DEPS: Record<DepName, DepInfo> = Object.fromEntries(
	DEP_NAMES.map((name) => [name, { name, available: probe(name), ...DEP_METADATA[name] }]),
) as Record<DepName, DepInfo>;

/** The once-probed snapshot + classification for `name`. */
export function getDepInfo(name: DepName): DepInfo {
	return DEPS[name];
}

/** Shorthand for `getDepInfo(name).available`. */
export function isAvailable(name: DepName): boolean {
	return DEPS[name].available;
}

/**
 * Precomputed `isAvailable('git')`, exported for the ~25 test files that
 * gate `test.skipIf(!gitAvailable)(...)` on git's presence (US-003,
 * CAM-424). Centralizes the probe in this module instead of each call site
 * hand-rolling its own `spawnSync('git', ['--version'], ...)` check.
 */
export const gitAvailable: boolean = isAvailable('git');

/**
 * Precomputed `isAvailable(name)` convenience bindings for the remaining 6
 * tracked binaries, exported for the test files that gate
 * `test.skipIf(!xAvailable)(...)` on their presence (US-004, CAM-424).
 * Mirrors `gitAvailable` above: centralizes the probe here instead of each
 * call site hand-rolling its own `spawnSync(name, ['--version'|'-V'], ...)`
 * check.
 */
export const tmuxAvailable: boolean = isAvailable('tmux');
export const jqAvailable: boolean = isAvailable('jq');
export const pgrepAvailable: boolean = isAvailable('pgrep');
export const psAvailable: boolean = isAvailable('ps');
export const uuidgenAvailable: boolean = isAvailable('uuidgen');
export const bunAvailable: boolean = isAvailable('bun');

// ---------------------------------------------------------------------------
// Waiver reader
// ---------------------------------------------------------------------------

/** The explicit, named env var callers declare a dependency waiver through. */
export const WAIVER_ENV_VAR = 'CAM_TEST_WAIVERS';

/** Parses a comma-separated CAM_TEST_WAIVERS value into a trimmed name set. */
export function parseWaivers(raw: string | undefined): Set<string> {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0),
	);
}

/** Is `name` explicitly waived via CAM_TEST_WAIVERS in `env` (defaults to process.env)? */
export function isWaived(name: DepName, env: NodeJS.ProcessEnv = process.env): boolean {
	return parseWaivers(env[WAIVER_ENV_VAR]).has(name);
}

// ---------------------------------------------------------------------------
// Pure preflight-decision function
// ---------------------------------------------------------------------------

/** Injectable availability check (DI seam for {@link depPreflight}). */
export type DepAvailabilityCheck = (name: DepName) => boolean;

/** Injectable waiver check (DI seam for {@link depPreflight}). */
export type DepWaiverCheck = (name: DepName) => boolean;

export interface DepPreflightOptions {
	name: DepName;
	/** Injectable availability check. Defaults to the real probed snapshot ({@link isAvailable}). */
	available?: DepAvailabilityCheck;
	/** Injectable waiver check. Defaults to the real env-var reader ({@link isWaived}). */
	waived?: DepWaiverCheck;
}

/** The dependency is present; the caller proceeds normally. */
export interface DepPreflightAvailable {
	kind: 'available';
}

/** The dependency is absent, but proceeding by skipping is allowed (either it is
 * legitimate-environmental, or it is a hard-dependency covered by an explicit waiver). */
export interface DepPreflightSkip {
	kind: 'skip';
	reason: string;
}

/** The dependency is a hard-dependency, absent, and NOT waived: this is a real failure. */
export interface DepPreflightFail {
	kind: 'fail';
	message: string;
}

export type DepPreflightResult = DepPreflightAvailable | DepPreflightSkip | DepPreflightFail;

/**
 * Fail-closed dependency preflight decision fn.
 *
 * - dependency available: `{ kind: 'available' }`, `waived` is never invoked.
 * - dependency absent, classified 'legitimate-environmental': `{ kind: 'skip', reason }`,
 *   `waived` is never invoked (no waiver is needed for a documented environmental gap).
 * - dependency absent, classified 'hard-dependency', explicitly waived: `{ kind: 'skip', reason }`.
 * - dependency absent, classified 'hard-dependency', NOT waived: `{ kind: 'fail', message }`,
 *   naming the binary with an actionable install hint plus the waiver escape hatch.
 */
export function depPreflight(opts: DepPreflightOptions): DepPreflightResult {
	const { name, available = isAvailable, waived = isWaived } = opts;
	const info = getDepInfo(name);

	if (available(name)) {
		return { kind: 'available' };
	}

	if (info.classification === 'legitimate-environmental') {
		return { kind: 'skip', reason: info.rationale };
	}

	if (waived(name)) {
		return { kind: 'skip', reason: `${name} waived via ${WAIVER_ENV_VAR}=${name}` };
	}

	return {
		kind: 'fail',
		message:
			`${name} is a hard dependency and was not found on PATH. ${info.installHint} ` +
			`If this absence is a known, legitimate environment gap, declare it explicitly ` +
			`via ${WAIVER_ENV_VAR}=${name}.`,
	};
}
