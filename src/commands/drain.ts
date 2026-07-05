// src/commands/drain.ts
//
// Implementation of `cam drain` — the runtime inter-cycle drain kill-switch.
//
// Flags:
//   --stop    Write the drain kill-switch marker (.claude/.cam-drain-stop).
//             The autonomous drain loop checks this marker at each safe cycle
//             boundary and stops when present. Does NOT SIGTERM the sidecar.
//   --clear   Remove the kill-switch marker (idempotent).
//   (none)    Print the current kill-switch status (set / not set).
//
// The kill-switch is DISTINCT from `cam stop`: `cam drain --stop` writes only
// the drain marker and sends no SIGTERM. `cam stop` clears it (among other
// markers) as part of full per-session cleanup.
//
// Fs seams are injectable so unit tests never touch the real filesystem.
//
// IMPORTANT INVARIANT: this file does NOT register a `--permission-mode` flag.
// `test/no-permission-mode-flag.test.ts` enforces this by scanning every file
// in `src/commands/`.

import { join } from 'node:path';
import process from 'node:process';

import {
	setDrainStop,
	clearDrainStop,
	isDrainStopSet,
	type DrainWriteFn,
	type DrainRemoveFn,
	type DrainExistsFn,
} from '../supervisor/drain-kill-switch.ts';
import {
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
} from '../logging/screen.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed arguments for `cam drain`. */
export type DrainFlag = 'stop' | 'clear';

export interface ParsedDrainArgs {
	flag: DrainFlag | null;
	help: boolean;
}

export interface DrainOptions {
	/** Override cwd; default `process.cwd()`. */
	cwd?: string;
	/** Parsed flag (stop / clear / null for status). */
	flag: DrainFlag | null;
	/** Injectable write function; tests inject a no-op. */
	writeFn?: DrainWriteFn;
	/** Injectable remove function; tests inject a no-op. */
	removeFn?: DrainRemoveFn;
	/** Injectable existence-check function; tests inject a controlled value. */
	existsFn?: DrainExistsFn;
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

/**
 * Parse `cam drain` arguments. Returns `{ help: true }` on `--help` / `-h`,
 * `{ flag: 'stop' }`, `{ flag: 'clear' }`, or `{ flag: null }` for status.
 * Returns `null` when an unknown flag is passed (caller should print usage).
 */
export function parseDrainArgs(argv: string[]): ParsedDrainArgs | null {
	if (argv.includes('--help') || argv.includes('-h')) {
		return { flag: null, help: true };
	}
	if (argv.length === 0) {
		return { flag: null, help: false };
	}
	if (argv.length === 1) {
		const flag = argv[0];
		if (flag === '--stop') return { flag: 'stop', help: false };
		if (flag === '--clear') return { flag: 'clear', help: false };
	}
	return null; // unknown / excess args
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the `cam drain` command. Returns exit code (always 0; the kill-switch is
 * forgiving by design — an idempotent flag-write never fails the caller).
 */
export function runDrain(options: DrainOptions): number {
	const cwd = options.cwd ?? process.cwd();
	const claudeDir = join(cwd, '.claude');

	emitTitle('cam drain');

	if (options.flag === 'stop') {
		setDrainStop(claudeDir, options.writeFn);
		emitSectionHeading('Kill-switch');
		emitOk('Drain kill-switch SET — loop will stop at the next safe cycle boundary');
		emitMutedHint('Run `cam drain --clear` to re-enable unattended draining');
	} else if (options.flag === 'clear') {
		clearDrainStop(claudeDir, options.removeFn);
		emitSectionHeading('Kill-switch');
		emitOk('Drain kill-switch CLEARED — unattended draining re-enabled');
	} else {
		// Status mode (no flag)
		const isSet = isDrainStopSet(claudeDir, options.existsFn);
		emitSectionHeading('Status');
		if (isSet) {
			emitOk('Drain kill-switch is SET (draining will stop at the next cycle boundary)');
			emitMutedHint('Run `cam drain --clear` to re-enable');
		} else {
			emitMutedHint('Drain kill-switch is not set (unattended draining is active)');
			emitMutedHint('Run `cam drain --stop` to pause at the next cycle boundary');
		}
	}

	emitTrailingBlank();
	return 0;
}
