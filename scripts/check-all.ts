// scripts/check-all.ts
//
// GATES-as-data manifest and gate-spine runner (US-001, CAM-59 PRD).
//
// Exports the ordered GATES manifest so other scripts can import it.
// Runs each gate in order; prints one quiet line per gate:
//
//   ok <name> (<Xs>)   -- gate passed
//   fail <name> (<Xs>) -- gate failed
//
// Exits 0 when all pass, nonzero when any fail.
//
// The suite ('test') gate runs `bun test --coverage` with piped stdio (US-001,
// CAM-488 PRD) instead of inherited stdio: its combined stdout+stderr is
// captured, echoed straight back to the operator (so the ~134s run is not
// silent), and handed to the optional onSuiteOutput hook as one shared blob.
// The coverage and skip-ratchet gates (US-002, CAM-488 PRD) are IN-PROCESS
// gates rather than spawned consumer scripts: they reach their verdict by
// calling checkCoverage()/checkSkipRatchet() directly, fed this same shared
// blob, so one check:all run costs one suite execution instead of three.
// Every other gate keeps inherited stdio and stays a spawned subprocess;
// pass/fail verdicts for spawn gates always come from spawnFn's own
// success/exitCode, never from the captured text.
//
// Usage: bun scripts/check-all.ts [--bail] [--json]
//   --bail  Stop at the first failing gate.
//   --json  Write gate results as JSON array to gate-results.json in cwd.
//           Each entry: { name, status ('ok'|'fail'), durationMs }.
//           Quiet per-gate lines are still printed to stdout.
//           Exit code is still aggregate (nonzero if any gate fails).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import type { SyncSubprocess } from 'bun';

import { checkCoverage, parseCoverageOutput } from './check-coverage.ts';
import { checkSkipRatchet } from './check-skip-ratchet.ts';

// ---------------------------------------------------------------------------
// Injectable dependency type
// ---------------------------------------------------------------------------

/**
 * Subset of Bun.spawnSync we need.
 * Injectable so unit tests never shell out to a real subprocess.
 * Widened to 'pipe' | 'inherit' on both streams (rather than fixed
 * 'inherit','inherit') so the suite gate can be piped for capture while every
 * other gate keeps inherited stdio; stdout/stderr resolve to `Buffer | undefined`.
 */
export type SpawnFn = (cmd: string, args: string[]) => SyncSubprocess<'pipe' | 'inherit', 'pipe' | 'inherit'>;

// ---------------------------------------------------------------------------
// GateResult type
// ---------------------------------------------------------------------------

/**
 * Result record for a single gate execution.
 * Emitted as part of the --json output array.
 */
export interface GateResult {
	/** Gate name (matches Gate.name). */
	name: string;
	/** 'ok' if exit code 0, 'fail' otherwise. */
	status: 'ok' | 'fail';
	/** Wall-clock time in milliseconds. */
	durationMs: number;
}

// ---------------------------------------------------------------------------
// GATES manifest
// ---------------------------------------------------------------------------

/**
 * A gate is EITHER a spawn gate (cmd/args passed to spawnFn) OR an in-process
 * gate (a `run` fn fed the shared suite-output blob, US-002, CAM-488 PRD) --
 * never both. `cmd`/`args` and `run` are declared optional on one flat
 * interface (rather than a discriminated union) so existing per-gate tests
 * that read `gate?.cmd`/`gate?.args` on a spawn gate keep their original,
 * ungated shape; `isInProcessGate`/`isSpawnGate` are the two runtime type
 * guards that narrow which shape a given gate actually is.
 */
export interface Gate {
	/** Short name printed in one-line output. */
	name: string;
	/** Executable passed as cmd to spawnFn. Present only on a spawn gate. */
	cmd?: string;
	/** Arguments passed to cmd. Present only on a spawn gate. */
	args?: string[];
	/**
	 * Reach a verdict from the shared suite output blob and cwd, in-process,
	 * instead of spawning a consumer script. Present only on an in-process
	 * gate. `cwd` is threaded through so the gate can still read its real
	 * budget/expectations file off disk: only the SUITE RUN itself is shared,
	 * every other production adapter (staged-diff read, lane-expectations
	 * read) stays wired to its real default.
	 */
	run?: (suiteOutput: string, cwd: string) => { ok: boolean; errors: string[] };
}

function isInProcessGate(gate: Gate): gate is Gate & { run: NonNullable<Gate['run']> } {
	return gate.run !== undefined;
}

function isSpawnGate(gate: Gate): gate is Gate & { cmd: string; args: string[] } {
	return gate.cmd !== undefined && gate.args !== undefined;
}

/** Build a spawn Gate from a space-separated command string (e.g. 'bunx tsc --noEmit'). */
function g(name: string, cmdStr: string): Gate {
	const parts = cmdStr.split(' ');
	return { name, cmd: parts[0] ?? '', args: parts.slice(1) };
}

/**
 * In-process coverage gate: reaches the same failure condition as
 * check-coverage.ts's CLI (floor-met + staged-diff tracker-ref checks), but
 * fed the shared suite blob for `getCoverage` instead of re-running the
 * suite. Every other check-coverage.ts dependency (the staged-diff reader
 * included) is intentionally left at its production default.
 */
const coverageGate: Gate = {
	name: 'coverage',
	run: (suiteOutput, cwd) => {
		const result = checkCoverage({ cwd, getCoverage: () => parseCoverageOutput(suiteOutput) });
		return { ok: result.ok, errors: result.errors };
	},
};

/**
 * In-process skip-ratchet gate: reaches the same failure condition as
 * check-skip-ratchet.ts's CLI (suite-ran-to-completion, pass-floor headroom,
 * skip-count delta), but fed the shared suite blob for `getSuiteOutput`
 * instead of re-running the suite. Every other check-skip-ratchet.ts
 * dependency (the lane-expectations reader included) is intentionally left
 * at its production default.
 */
const skipRatchetGate: Gate = {
	name: 'skip-ratchet',
	run: (suiteOutput, cwd) => {
		const result = checkSkipRatchet({ cwd, getSuiteOutput: () => suiteOutput });
		return { ok: result.ok, errors: result.ok ? [] : [result.message] };
	},
};

/**
 * Ordered gate-spine manifest.
 * Importable by other scripts so they share one canonical list.
 */
export const GATES: Gate[] = [
	g('typecheck', 'bunx tsc --noEmit'),
	g('test', 'bun test --coverage'),
	g('embed-vendor', 'bun scripts/generate-embedded-vendor.ts --check'),
	g('lint', 'bunx biome lint --error-on-warnings'),
	g('file-size', 'bun scripts/check-file-sizes.ts'),
	g('debt-markers', 'bun scripts/check-debt-markers.ts'),
	g('version-skips', 'bun scripts/check-version-skips.ts'),
	coverageGate,
	// --bun: run knip on Bun's own runtime, not a delegated system `node` (avoids a <20 node:util gap).
	g('dead-code', 'bunx --bun knip'),
	g('dup', 'bunx jscpd --config .jscpd.json src scripts'),
	g('ci-parity', 'bun run check:ci-parity'),
	g('agents-md', 'bun scripts/validate-agents-md.ts'),
	g('test-sleeps', 'bun scripts/check-test-sleeps.ts'),
	skipRatchetGate,
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunGatesOptions {
	/** Gate list to execute. Defaults to the GATES manifest. */
	gates?: Gate[];
	/** Stop at first failing gate. Default: false. */
	bail?: boolean;
	/** Injectable spawn function. Default: real spawnSync with stdio inherit. */
	spawnFn?: SpawnFn;
	/** Working directory for subprocess calls. Default: process.cwd(). */
	cwd?: string;
	/**
	 * Called with per-gate results after all gates run (or after bail).
	 * Used by --json mode to capture the structured output without coupling
	 * the runner to a specific output medium (file, stdout, test capture).
	 */
	onResults?: (results: GateResult[]) => void;
	/**
	 * Called once, immediately after the suite ('test') gate runs, with its
	 * combined stdout+stderr blob (decodeCapturedOutput's output: stdout-
	 * decoded text followed by stderr-decoded text). Lets downstream
	 * consumers (coverage, skip-ratchet) reuse this single `bun test
	 * --coverage` run instead of re-invoking the suite themselves.
	 */
	onSuiteOutput?: (output: string) => void;
}

/** Name of the manifest entry whose output is captured and shared (US-001, CAM-488 PRD). */
const SUITE_GATE_NAME = 'test';

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Decode a spawn result's captured stdout+stderr Buffers into one combined
 * blob: stdout-decoded text FOLLOWED BY stderr-decoded text, in that order.
 * `bun test --coverage` writes its summary and coverage table to stderr (not
 * stdout), so a stdout-only capture would yield an empty blob for downstream
 * consumers. A missing (`undefined`) buffer decodes to an empty string
 * rather than throwing.
 */
export function decodeCapturedOutput(result: { stdout?: Buffer; stderr?: Buffer }): string {
	const decoder = new TextDecoder();
	const stdout = result.stdout ? decoder.decode(result.stdout) : '';
	const stderr = result.stderr ? decoder.decode(result.stderr) : '';
	return stdout + stderr;
}

/**
 * Echo the suite gate's captured buffers back to the operator (write-through,
 * so the ~134s run is not silent), then return the combined blob.
 */
function captureAndEchoSuiteOutput(result: { stdout?: Buffer; stderr?: Buffer }): string {
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	return decodeCapturedOutput(result);
}

/** Outcome of running one gate: pass/fail plus any error strings to surface. */
interface GateOutcome {
	passed: boolean;
	errors: string[];
	/** Only set when this gate is the suite gate: its captured shared blob. */
	suiteOutput?: string;
}

/**
 * Spawn a spawn gate's subprocess and derive its pass/fail from spawnFn's own
 * success/exitCode. For the suite ('test') gate only, also echo its captured
 * buffers (write-through, so the ~134s run is not silent) and forward the
 * combined blob to onSuiteOutput (if provided) AND to the caller via the
 * returned `suiteOutput`, so runGates can thread it to later in-process
 * gates.
 */
function runSpawnGate(
	gate: Gate & { cmd: string; args: string[] },
	spawnFn: SpawnFn,
	onSuiteOutput: ((output: string) => void) | undefined,
): GateOutcome {
	const result = spawnFn(gate.cmd, gate.args);
	const passed = result.success && result.exitCode === 0;

	if (gate.name !== SUITE_GATE_NAME) return { passed, errors: [] };

	// Always echo (write-through), regardless of whether onSuiteOutput is set:
	// `onSuiteOutput?.(captureAndEchoSuiteOutput(result))` would short-circuit
	// the echo itself when onSuiteOutput is unset, since optional-chaining
	// calls never evaluate their arguments once the callee is nullish.
	const suiteOutput = captureAndEchoSuiteOutput(result);
	onSuiteOutput?.(suiteOutput);
	return { passed, errors: [], suiteOutput };
}

/**
 * Run an in-process gate's `run` fn against the shared suite blob and cwd.
 * `gate.run` is arbitrary gate-owned code (e.g. checkCoverage/checkSkipRatchet
 * do readFileSync + JSON.parse on real budget/expectations files) and can
 * throw (ENOENT, malformed JSON, etc.). A throw here must not escape and
 * abort the rest of the spine (US-R1-002, CAM-488 PRD): map it to a failed
 * GateResult instead, mirroring how a spawned gate's non-zero exit is
 * already a contained failure rather than a process-ending exception.
 */
function runInProcessGate(gate: Gate & { run: NonNullable<Gate['run']> }, suiteOutput: string, cwd: string): GateOutcome {
	try {
		const { ok, errors } = gate.run(suiteOutput, cwd);
		return { passed: ok, errors };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { passed: false, errors: [message] };
	}
}

/**
 * Dispatch one gate to its executor by shape (in-process vs spawn), falling
 * back to a defensive failure for a malformed gate that is neither. Extracted
 * out of runGates to keep its cognitive complexity under the
 * noExcessiveCognitiveComplexity limit.
 */
function executeGate(
	gate: Gate,
	spawnFn: SpawnFn,
	suiteOutput: string,
	cwd: string,
	onSuiteOutput: ((output: string) => void) | undefined,
): GateOutcome {
	if (isInProcessGate(gate)) return runInProcessGate(gate, suiteOutput, cwd);
	if (isSpawnGate(gate)) return runSpawnGate(gate, spawnFn, onSuiteOutput);
	return { passed: false, errors: [`gate '${gate.name}' has neither cmd/args nor run`] };
}

/**
 * Push a gate's GateResult and print its quiet status line plus any error
 * strings. Extracted out of runGates to keep its cognitive complexity under
 * the noExcessiveCognitiveComplexity limit.
 */
function reportGateOutcome(gate: Gate, outcome: GateOutcome, durationMs: number, results: GateResult[]): void {
	const status: 'ok' | 'fail' = outcome.passed ? 'ok' : 'fail';
	results.push({ name: gate.name, status, durationMs });
	process.stdout.write(`${status} ${gate.name} (${formatDuration(durationMs)})\n`);
	for (const error of outcome.errors) process.stderr.write(`  ${gate.name}: ${error}\n`);
}

/**
 * Real spawnSync-backed default: inherited stdio for every gate except the
 * suite gate, which is piped on both streams so its output can be captured
 * and shared (US-001, CAM-488 PRD).
 */
function makeDefaultSpawnFn(cwd: string): SpawnFn {
	return (cmd, args) => {
		const stdio: 'pipe' | 'inherit' = cmd === 'bun' && args[0] === 'test' && args.includes('--coverage') ? 'pipe' : 'inherit';
		return Bun.spawnSync([cmd, ...args], { cwd, stdin: 'inherit', stdout: stdio, stderr: stdio });
	};
}

/**
 * Execute each gate in order, print one quiet line per gate, return 0 if all
 * passed, 1 if any failed.
 *
 * When options.onResults is provided it is called once, after the last gate
 * (or after bail), with the full GateResult array.
 */
export function runGates(options: RunGatesOptions = {}): number {
	const gates = options.gates ?? GATES;
	const bail = options.bail ?? false;
	const cwd = options.cwd ?? process.cwd();
	const spawnFn: SpawnFn = options.spawnFn ?? makeDefaultSpawnFn(cwd);

	let anyFailed = false;
	let suiteOutput = '';
	const results: GateResult[] = [];

	for (const gate of gates) {
		const start = Date.now();
		const outcome = executeGate(gate, spawnFn, suiteOutput, cwd, options.onSuiteOutput);
		if (outcome.suiteOutput !== undefined) suiteOutput = outcome.suiteOutput;
		reportGateOutcome(gate, outcome, Date.now() - start, results);

		if (!outcome.passed) {
			anyFailed = true;
			if (bail) break;
		}
	}

	options.onResults?.(results);

	return anyFailed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const bail = process.argv.includes('--bail');
	const jsonFlag = process.argv.includes('--json');

	const onResults = jsonFlag
		? (results: GateResult[]) => {
				const outPath = join(process.cwd(), 'gate-results.json');
				writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n');
			}
		: undefined;

	const code = runGates({ bail, onResults });
	process.exit(code);
}
