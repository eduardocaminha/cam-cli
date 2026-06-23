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
// Usage: bun scripts/check-all.ts [--bail]

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Injectable dependency type
// ---------------------------------------------------------------------------

/**
 * Subset of node:child_process spawnSync we need.
 * Injectable so unit tests never shell out to a real subprocess.
 */
export type SpawnFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8'; stdio?: 'inherit' | 'pipe' },
) => SpawnSyncReturns<string>;

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
	g('test', 'bun test'),
	g('embed-vendor', 'bun scripts/generate-embedded-vendor.ts --check'),
	g('ci-parity', 'bun run check:ci-parity'),
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
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Execute each gate in order, print one quiet line per gate, return 0 if all
 * passed, 1 if any failed.
 */
export function runGates(options: RunGatesOptions = {}): number {
	const gates = options.gates ?? GATES;
	const bail = options.bail ?? false;
	const cwd = options.cwd ?? process.cwd();
	const spawnFn: SpawnFn = options.spawnFn ?? ((cmd, args, opts) => spawnSync(cmd, args, { ...opts, cwd, stdio: 'inherit' }));

	let anyFailed = false;

	for (const gate of gates) {
		const start = Date.now();
		const result = spawnFn(gate.cmd, gate.args, { encoding: 'utf8' });
		const durationMs = Date.now() - start;
		const exitCode = result.status ?? 1;
		const passed = exitCode === 0;

		if (!passed) anyFailed = true;
		const label = passed ? 'ok' : 'fail';
		process.stdout.write(`${label} ${gate.name} (${formatDuration(durationMs)})\n`);

		if (!passed && bail) break;
	}

	return anyFailed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const bail = process.argv.includes('--bail');
	const code = runGates({ bail });
	process.exit(code);
}
