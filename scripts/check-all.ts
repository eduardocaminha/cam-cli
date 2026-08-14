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
// The suite ('test') gate runs `bun test --coverage` with piped stdio,
// streamed live via async Bun.spawn rather than blocking Bun.spawnSync
// (US-R2-001, CAM-488 PRD): its stdout/stderr are teed chunk-by-chunk to the
// operator AS THE SUBPROCESS RUNS, so the ~134s run is genuinely not silent.
// (A prior spawnSync-based capture, US-001, preserved the output correctly
// but blocked the operator's pane in total silence for the whole run and
// only dumped everything at once on exit -- a post-hoc replay, not a tee;
// this story's fix replaces that shape with a real streaming tee.) The
// combined stdout+stderr text is still handed to the optional onSuiteOutput
// hook as one shared blob once the run completes. The coverage and
// skip-ratchet gates (US-002, CAM-488 PRD) are IN-PROCESS gates rather than
// spawned consumer scripts: they reach their verdict by calling
// checkCoverage()/checkSkipRatchet() directly, fed this same shared blob, so
// one check:all run costs one suite execution instead of three. Every other
// gate keeps inherited stdio and stays a spawned subprocess; pass/fail
// verdicts for spawn gates always come from spawnFn's own success/exitCode,
// never from the captured text. Because the suite gate now streams,
// spawnFn/runGates/runSpawnGate/executeGate are all async end to end.
//
// Usage: bun scripts/check-all.ts [--bail] [--json]
//   --bail  Stop at the first failing gate.
//   --json  Write gate results as JSON array to gate-results.json in cwd.
//           Each entry: { name, status ('ok'|'fail'), durationMs }.
//           Quiet per-gate lines are still printed to stdout.
//           Exit code is still aggregate (nonzero if any gate fails).
//
// Every run, flag or no flag, also appends one line to the gitignored
// .claude/cam-gate-history.jsonl -- { ts, results } -- so gate outcomes
// accumulate across runs and can answer which gates ever catch anything.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { ResourceUsage, SyncSubprocess } from 'bun';

import { checkCoverage, parseCoverageOutput } from './check-coverage.ts';
import { checkSkipRatchet } from './check-skip-ratchet.ts';

// ---------------------------------------------------------------------------
// Injectable dependency type
// ---------------------------------------------------------------------------

/**
 * Subset of Bun's spawn surface we need, ALWAYS async (US-R2-001, CAM-488
 * PRD): the real default streams and tees the suite gate live rather than
 * blocking synchronously for its whole run and replaying afterward, so every
 * spawnFn -- fake or real -- returns a Promise, even where the underlying
 * work (a non-suite gate's spawnSync) is itself synchronous.
 * Injectable so unit tests never shell out to a real subprocess.
 * Widened to 'pipe' | 'inherit' on both streams (rather than fixed
 * 'inherit','inherit') so the suite gate can be piped for capture while every
 * other gate keeps inherited stdio; stdout/stderr resolve to `Buffer | undefined`.
 */
export type SpawnFn = (cmd: string, args: string[]) => Promise<SyncSubprocess<'pipe' | 'inherit', 'pipe' | 'inherit'>>;

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
	g('typecheck', 'bun run typecheck'),
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
	g('test-tmpdir', 'bun scripts/check-test-tmpdir.ts'),
	// Derived .gitignore parity oracle (repo root vs templates/.gitignore).
	// It is driven from `bun test` as well (test/check-gitignore-parity-script.test.ts),
	// but a parity failure surfaced there reads as a test regression; naming it
	// in the spine makes the verdict legible as its own gate line.
	g('gitignore-parity', 'bash scripts/check-gitignore-parity.sh .'),
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
 * Fallback ResourceUsage for the (practically unreachable, since it is only
 * read after `await proc.exited`) case where Bun.Subprocess.resourceUsage()
 * still reports undefined.
 */
function emptyResourceUsage(): ResourceUsage {
	return {
		contextSwitches: { voluntary: 0, involuntary: 0 },
		cpuTime: { user: 0, system: 0, total: 0 },
		maxRSS: 0,
		messages: { sent: 0, received: 0 },
		ops: { in: 0, out: 0 },
		shmSize: 0,
		signalCount: 0,
		swapCount: 0,
	};
}

/**
 * Read a Bun ReadableStream<Uint8Array> chunk by chunk, writing each chunk
 * straight through to `sink` AS IT ARRIVES (the actual tee: US-R2-001,
 * CAM-488 PRD), while accumulating every chunk to return the full buffer once
 * the stream ends. This is what makes the suite gate's ~101s+ run produce
 * live output instead of a post-hoc replay dumped only after the subprocess
 * exits.
 */
export async function teeStream(stream: ReadableStream<Uint8Array>, sink: NodeJS.WritableStream): Promise<Buffer> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) {
		sink.write(chunk);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/**
 * Real streaming implementation of the suite ('test') gate: spawns via async
 * Bun.spawn (not spawnSync) with both streams piped, tees stdout/stderr live
 * via teeStream while the subprocess is still running, and only resolves the
 * combined result once the child actually exits. Replaces the previous
 * spawnSync-based capture, which blocked in silence for the whole ~101s+ run
 * and only echoed the captured buffers back afterward (US-R2-001, CAM-488
 * PRD finding: a post-hoc replay, not a tee, contradicting this file's own
 * prior comments and ADR-0056's stated consequence).
 */
export async function runStreamingSuiteGate(
	cmd: string,
	args: string[],
	cwd: string,
): Promise<SyncSubprocess<'pipe' | 'inherit', 'pipe' | 'inherit'>> {
	const proc = Bun.spawn([cmd, ...args], { cwd, stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' });

	const [stdout, stderr, exitCode] = await Promise.all([
		teeStream(proc.stdout, process.stdout),
		teeStream(proc.stderr, process.stderr),
		proc.exited,
	]);

	return {
		pid: proc.pid,
		stdout,
		stderr,
		exitCode,
		success: exitCode === 0,
		resourceUsage: proc.resourceUsage() ?? emptyResourceUsage(),
		signalCode: proc.signalCode ?? undefined,
	};
}

/** Outcome of running one gate: pass/fail plus any error strings to surface. */
interface GateOutcome {
	passed: boolean;
	errors: string[];
	/** Only set when this gate is the suite gate: its captured shared blob. */
	suiteOutput?: string;
}

/**
 * Await a spawn gate's subprocess and derive its pass/fail from spawnFn's own
 * success/exitCode. For the suite ('test') gate only, also decode its
 * captured buffers into the shared blob and forward it to onSuiteOutput (if
 * provided) AND to the caller via the returned `suiteOutput`, so runGates can
 * thread it to later in-process gates. Live echo is NOT this layer's job
 * (US-R2-001, CAM-488 PRD): the real default spawnFn tees the suite gate's
 * output straight to the operator itself, chunk-by-chunk, while the
 * subprocess is still running (runStreamingSuiteGate); by the time this
 * function sees `result`, any real-time echo has already happened or (for a
 * test fake standing in for a subprocess that never really ran) never needed
 * to happen at all.
 */
async function runSpawnGate(
	gate: Gate & { cmd: string; args: string[] },
	spawnFn: SpawnFn,
	onSuiteOutput: ((output: string) => void) | undefined,
): Promise<GateOutcome> {
	const result = await spawnFn(gate.cmd, gate.args);
	const passed = result.success && result.exitCode === 0;

	if (gate.name !== SUITE_GATE_NAME) return { passed, errors: [] };

	const suiteOutput = decodeCapturedOutput(result);
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
async function executeGate(
	gate: Gate,
	spawnFn: SpawnFn,
	suiteOutput: string,
	cwd: string,
	onSuiteOutput: ((output: string) => void) | undefined,
): Promise<GateOutcome> {
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
 * Real default spawnFn: inherited stdio via synchronous Bun.spawnSync for
 * every gate except the suite gate, which streams live via async Bun.spawn
 * and tees both streams to the operator as it runs (runStreamingSuiteGate,
 * US-R2-001, CAM-488 PRD) rather than blocking on a single spawnSync call and
 * replaying its captured buffers afterward (US-001's original shape).
 */
function makeDefaultSpawnFn(cwd: string): SpawnFn {
	return async (cmd, args) => {
		const isSuiteGate = cmd === 'bun' && args[0] === 'test' && args.includes('--coverage');
		if (isSuiteGate) return runStreamingSuiteGate(cmd, args, cwd);
		return Bun.spawnSync([cmd, ...args], { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
	};
}

/**
 * Execute each gate in order, print one quiet line per gate, return 0 if all
 * passed, 1 if any failed.
 *
 * When options.onResults is provided it is called once, after the last gate
 * (or after bail), with the full GateResult array.
 */
export async function runGates(options: RunGatesOptions = {}): Promise<number> {
	const gates = options.gates ?? GATES;
	const bail = options.bail ?? false;
	const cwd = options.cwd ?? process.cwd();
	const spawnFn: SpawnFn = options.spawnFn ?? makeDefaultSpawnFn(cwd);

	let anyFailed = false;
	let suiteOutput = '';
	const results: GateResult[] = [];

	for (const gate of gates) {
		const start = Date.now();
		const outcome = await executeGate(gate, spawnFn, suiteOutput, cwd, options.onSuiteOutput);
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
// Gate history
// ---------------------------------------------------------------------------

/** Gitignored append-only log of gate outcomes, one JSON line per check:all run. */
const GATE_HISTORY_PATH = join('.claude', 'cam-gate-history.jsonl');

/**
 * Append one `{ts, results}` line to the gate history.
 *
 * Instrumentation only: it answers "which gates have ever failed anything?"
 * over weeks of runs, so a failure to write must never change the suite's
 * verdict -- any error is swallowed.
 */
function appendHistoryLine(results: GateResult[]): void {
	try {
		const path = join(process.cwd(), GATE_HISTORY_PATH);
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), results }) + '\n');
	} catch {
		// Non-fatal: instrumentation must not fail the gate spine.
	}
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const bail = process.argv.includes('--bail');
	const jsonFlag = process.argv.includes('--json');

	const onResults = (results: GateResult[]) => {
		// Every run appends one line to the gate history, --json or not: the
		// worker runs check:all without --json, so gating gate-outcome data on
		// that flag threw away every worker run's results. Gitignored, never
		// committed -- a mid-cycle auto-commit on main is what puts the open PR
		// BEHIND (CAM-480).
		appendHistoryLine(results);
		if (!jsonFlag) return;
		const outPath = join(process.cwd(), 'gate-results.json');
		writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n');
	};

	const code = await runGates({ bail, onResults });
	process.exit(code);
}
