// src/commands/pause.ts
//
// Implementation of `cam pause` — the operator graceful brake.
//
// Writes the dedicated pause marker (.claude/.cam-pause). This is DISTINCT
// from the phase-derived `active` field in `.claude/cam-loop.local.md`: the
// sidecar re-stamps `active:true` every iteration, so storing the brake
// there would be silently clobbered. `cam resume` clears this marker as
// part of its recovery flow; `cam stop` also clears it as part of its full
// per-session marker cleanup.
//
// Fs seams are injectable so unit tests never touch the real filesystem.
//
// IMPORTANT INVARIANT: this file does NOT register a `--permission-mode`
// flag. `test/no-permission-mode-flag.test.ts` enforces this by scanning
// every file in `src/commands/`.

import { join } from 'node:path';
import process from 'node:process';

import { setPause, type PauseWriteFn } from '../supervisor/pause-marker.ts';
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

/** Parsed arguments for `cam pause`. */
export interface ParsedPauseArgs {
	help: boolean;
}

export interface PauseOptions {
	/** Override cwd; default `process.cwd()`. */
	cwd?: string;
	/** Injectable write function; tests inject a no-op. */
	writeFn?: PauseWriteFn;
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

/**
 * Parse `cam pause` arguments. Returns `{ help: true }` on `--help` / `-h`,
 * `{ help: false }` for the bare command. Returns `null` when an unexpected
 * argument is passed (caller should print usage).
 */
export function parsePauseArgs(argv: string[]): ParsedPauseArgs | null {
	if (argv.includes('--help') || argv.includes('-h')) {
		return { help: true };
	}
	if (argv.length === 0) {
		return { help: false };
	}
	return null; // unknown / excess args
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the `cam pause` command. Returns exit code (always 0; the brake is
 * forgiving by design — an idempotent marker-write never fails the caller).
 */
export function runPause(options: PauseOptions = {}): number {
	const cwd = options.cwd ?? process.cwd();
	const claudeDir = join(cwd, '.claude');

	emitTitle('cam pause');

	setPause(claudeDir, options.writeFn);
	emitSectionHeading('Brake');
	emitOk('Pause marker SET — this is a graceful operator brake, separate from loop state');
	emitMutedHint('Run `cam resume` to clear the pause and continue');

	emitTrailingBlank();
	return 0;
}
