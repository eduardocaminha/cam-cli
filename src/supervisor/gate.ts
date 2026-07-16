// src/supervisor/gate.ts
//
// Durable operator-decision gate marker (US-001, CAM-241/153).
//
// Written by the sidecar when it reaches an operator-decision point (phase
// awaiting-operator + a generic gate discriminator + the valid options +
// free-text context), resolved by the operator via `cam decide <decision>`
// which fills in `decision`, and polled by the sidecar to resume
// deterministically. Mirrors the existing durable-marker family verbatim
// (src/supervisor/plan-escalation.ts, src/supervisor/implement-blocked-marker.ts,
// src/release/merge-watch.ts SHIP_STALLED_FILENAME): a plain JSON file under
// .claude/, write/remove helpers that never throw.
//
// Unlike the existing marker family (which exposes only a lenient reader
// that returns null on any problem), the gate file additionally needs a
// FAIL-CLOSED reader: `cam decide` must never silently accept a malformed or
// partially-written gate file as if it were valid (that could let an
// operator's decision be written against stale/corrupt options[]). So this
// module exports two readers:
//   - `readGateFile` (fail-closed): throws `GateFileError` on absent,
//     malformed, or partially-written input. Never returns a
//     partially-parsed object.
//   - `readGateFileLenient`: wraps `readGateFile` in try/catch and returns
//     null on ANY failure (absent or otherwise), mirroring the existing
//     marker family's null-on-any-problem contract -- for callers (e.g. the
//     sidecar's poll loop, a boot-read surface) where "no gate active" and
//     "gate file unreadable" are both simply "nothing to act on yet".
//
// This module does NOT wire the gate into the sidecar poll loop or the
// `cam decide` command itself (US-002/US-003 do that); it only provides the
// filename constant, the type, and the I/O helpers.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

/** Filename of the durable operator-decision gate (relative to the `.claude/` dir). */
export const GATE_FILENAME = '.cam-gate.json';

/**
 * Durable operator-decision gate payload.
 *   - gate: discriminator naming which gate is active (e.g.
 *     'in-progress-work-conflict'). Consumers dispatch generically on this
 *     field, never hard-coding a single gate kind.
 *   - options: the valid decision strings the operator may choose between.
 *   - context: free-text explanation surfaced to the operator.
 *   - decision: the operator's resolved choice, absent until `cam decide`
 *     writes it. Must be a member of `options` once populated (validated by
 *     the caller, e.g. `cam decide`, not by this module).
 */
export interface CamGate {
	gate: string;
	options: string[];
	context: string;
	decision?: string;
}

/**
 * Thrown by `readGateFile` (the fail-closed reader) when the target file is
 * absent, contains malformed JSON, a non-object / array value, or is missing
 * / mistyping any required field (gate: string, options: string[], context:
 * string, decision: string | undefined).
 */
export class GateFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GateFileError';
	}
}

/** Shape-guard: is `value` a valid `CamGate`? Validates discriminator fields, not just typeof. */
function isCamGate(value: Record<string, unknown>): boolean {
	if (typeof value['gate'] !== 'string') return false;
	if (typeof value['context'] !== 'string') return false;
	if (!Array.isArray(value['options']) || !value['options'].every((o) => typeof o === 'string')) {
		return false;
	}
	const decision = value['decision'];
	if (decision !== undefined && typeof decision !== 'string') return false;
	return true;
}

/**
 * Fail-closed validating reader.
 *
 * Reads and validates the gate file at `filePath`. Throws `GateFileError`
 * when the file is absent, contains malformed JSON, a non-object / array
 * value, or is missing / mistyping any required field -- NEVER returns a
 * partially-parsed object. Callers that need "no gate active" to be a
 * benign, non-throwing outcome should use `readGateFileLenient` instead.
 */
export function readGateFile(filePath: string): CamGate {
	if (!existsSync(filePath)) {
		throw new GateFileError(`gate file absent: ${filePath}`);
	}
	let raw: string;
	try {
		raw = readFileSync(filePath, 'utf8');
	} catch (err) {
		throw new GateFileError(`gate file unreadable: ${filePath}: ${String(err)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new GateFileError(`gate file is not valid JSON: ${filePath}: ${String(err)}`);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new GateFileError(`gate file is not a JSON object: ${filePath}`);
	}
	const obj = parsed as Record<string, unknown>;
	if (!isCamGate(obj)) {
		throw new GateFileError(`gate file is missing or mistyping a required field: ${filePath}`);
	}
	const gate: CamGate = {
		gate: obj['gate'] as string,
		options: obj['options'] as string[],
		context: obj['context'] as string,
	};
	if (obj['decision'] !== undefined) gate.decision = obj['decision'] as string;
	return gate;
}

/**
 * Lenient reader. Wraps `readGateFile` and returns null on ANY failure
 * (absent, malformed, partially-written, or otherwise) instead of throwing.
 * Mirrors the existing durable-marker family's null-on-any-problem contract
 * (readPlanEscalatedMarker / readImplementBlockedMarker). Never throws.
 */
export function readGateFileLenient(filePath: string): CamGate | null {
	try {
		return readGateFile(filePath);
	} catch {
		return null;
	}
}

/**
 * Write the gate file to a persistent file (durable, not consume-on-read;
 * mirrors writePlanEscalatedMarker / writeImplementBlockedMarker). Overwrites
 * any previous gate. Never throws.
 */
export function writeGateFile(filePath: string, gate: CamGate): void {
	try {
		writeFileSync(filePath, JSON.stringify(gate, null, 2), 'utf8');
	} catch {
		/* best-effort: a failed write just means the gate is not durable this tick */
	}
}

/**
 * Remove the gate file. Silent no-op when the file is already absent. Never
 * throws (mirrors removePlanEscalatedMarker / removeImplementBlockedMarker).
 */
export function removeGateFile(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		/* best-effort: file may already be absent */
	}
}
