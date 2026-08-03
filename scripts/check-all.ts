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
// silent), and handed to the optional onSuiteOutput hook as one shared blob,
// so future coverage/skip-ratchet consumers can be fed from this single run
// instead of re-invoking the suite themselves. Every other gate keeps
// inherited stdio; pass/fail verdicts always come from spawnFn's own
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

export interface Gate {
	/** Short name printed in one-line output. */
	name: string;
	/** Executable passed as cmd to spawnFn. */
	cmd: string;
	/** Arguments passed to cmd. */
	args: string[];
}

/** Build a Gate from a space-separated command string (e.g. 'bunx tsc --noEmit'). */
function g(name: string, cmdStr: string): Gate {
	const parts = cmdStr.split(' ');
	return { name, cmd: parts[0] ?? '', args: parts.slice(1) };
}

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
	g('coverage', 'bun scripts/check-coverage.ts'),
	// --bun: run knip on Bun's own runtime, not a delegated system `node` (avoids a <20 node:util gap).
	g('dead-code', 'bunx --bun knip'),
	g('dup', 'bunx jscpd --config .jscpd.json src scripts'),
	g('ci-parity', 'bun run check:ci-parity'),
	g('agents-md', 'bun scripts/validate-agents-md.ts'),
	g('test-sleeps', 'bun scripts/check-test-sleeps.ts'),
	g('skip-ratchet', 'bun scripts/check-skip-ratchet.ts'),
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

/**
 * No-op for every gate except the suite ('test') gate: for that one gate,
 * echo its captured buffers and forward the combined blob to onSuiteOutput
 * (if provided). Extracted out of runGates to keep its cognitive complexity
 * under the noExcessiveCognitiveComplexity limit.
 */
function emitSuiteOutputIfApplicable(
	gate: Gate,
	result: { stdout?: Buffer; stderr?: Buffer },
	onSuiteOutput: ((output: string) => void) | undefined,
): void {
	if (gate.name !== SUITE_GATE_NAME) return;
	// Always echo (write-through), regardless of whether onSuiteOutput is set:
	// `onSuiteOutput?.(captureAndEchoSuiteOutput(result))` would short-circuit
	// the echo itself when onSuiteOutput is unset, since optional-chaining
	// calls never evaluate their arguments once the callee is nullish.
	const suiteOutput = captureAndEchoSuiteOutput(result);
	onSuiteOutput?.(suiteOutput);
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
	const results: GateResult[] = [];

	for (const gate of gates) {
		const start = Date.now();
		const result = spawnFn(gate.cmd, gate.args);
		emitSuiteOutputIfApplicable(gate, result, options.onSuiteOutput);
		const durationMs = Date.now() - start;
		const passed = result.success && result.exitCode === 0;

		if (!passed) anyFailed = true;
		const status: 'ok' | 'fail' = passed ? 'ok' : 'fail';
		results.push({ name: gate.name, status, durationMs });
		process.stdout.write(`${status} ${gate.name} (${formatDuration(durationMs)})\n`);

		if (!passed && bail) break;
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
