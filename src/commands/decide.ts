// src/commands/decide.ts
//
// Implementation of `cam decide <decision>` — the operator-decision gate
// resolver (US-002, CAM-241/153).
//
// Reads the active gate file written by the sidecar (src/supervisor/gate.ts),
// validates <decision> is a member of the gate's options[], and writes the
// decision back into the SAME gate file — the single source of truth the
// sidecar polls to resume deterministically. No split across the loop state
// file (.claude/cam-loop.local.md).
//
// DISTINCT from `cam resume` (src/commands/resume.ts, 4-mode interrupt
// recovery): `cam resume` reconciles loop state after an interrupt; `cam
// decide` resolves a live operator-decision gate. They target different
// files and different problems — do not overload one into the other.

import { join } from 'node:path';
import process from 'node:process';

import {
	GATE_FILENAME,
	GateFileError,
	readGateFile,
	writeGateFile,
} from '../supervisor/gate.ts';
import { printError } from '../logging/color.ts';
import { emitOk, emitTitle, emitTrailingBlank } from '../logging/screen.ts';

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

/** Parsed arguments for `cam decide`. */
export type ParsedDecideArgs = { decision: string; help: false } | { decision: null; help: true };

/**
 * Parse `cam decide <decision>` arguments. Returns `{ decision: null, help:
 * true }` on `--help`/`-h`, `{ decision: <value>, help: false }` for exactly
 * one positional arg, or `null` when the arg count is wrong (missing
 * decision or excess args — caller should print usage).
 */
export function parseDecideArgs(argv: string[]): ParsedDecideArgs | null {
	if (argv.includes('--help') || argv.includes('-h')) {
		return { decision: null, help: true };
	}
	if (argv.length !== 1) {
		return null;
	}
	const decision = argv[0];
	if (!decision) return null;
	return { decision, help: false };
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export interface DecideOptions {
	/** Override cwd; default `process.cwd()`. */
	cwd?: string;
	/** The operator's chosen decision (already parsed). */
	decision: string;
}

/**
 * Run `cam decide <decision>`. Reads the active gate file (fail-closed via
 * `readGateFile`), validates `decision` is a member of the gate's options[],
 * and writes it back into the SAME gate file. Exit codes:
 *   0 — decision recorded into the gate file.
 *   1 — no gate active, or decision not a member of options[] (gate file
 *       left unmodified in both cases).
 */
export function runDecide(options: DecideOptions): number {
	const cwd = options.cwd ?? process.cwd();
	const filePath = join(cwd, '.claude', GATE_FILENAME);

	let gate;
	try {
		gate = readGateFile(filePath);
	} catch (err) {
		if (err instanceof GateFileError) {
			printError('no gate active', 'the sidecar has not raised an operator-decision gate right now');
			return 1;
		}
		throw err;
	}

	if (!gate.options.includes(options.decision)) {
		printError(
			`invalid decision "${options.decision}"`,
			`valid options: ${gate.options.join(', ')}`,
		);
		return 1;
	}

	writeGateFile(filePath, { ...gate, decision: options.decision });

	emitTitle('cam decide');
	emitOk(`recorded decision "${options.decision}" for gate "${gate.gate}"`);
	emitTrailingBlank();
	return 0;
}
