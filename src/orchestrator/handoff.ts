// src/orchestrator/handoff.ts
//
// CAM-23 US-002: orchestrator self-handoff read/write plumbing.
//
// When the orchestrator (the long-lived `cam run` session) crosses its token
// budget (US-001), it writes this handoff and exits so `cam run` respawns it
// fresh (US-003), reading the handoff back to rehydrate (US-004) instead of
// relying on Claude's silent auto-compaction. This module is plumbing only: the
// orchestrator AGENT populates the payload (instructed in US-004).
//
// The file lives at <claudeDir>/.cam-orch-handoff.json, alongside the existing
// .cam-orch-session / .cam-orchestrator-prompt.txt markers under the project's
// .claude dir. The schema is scripts/cam/orch-handoff.schema.json.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Current handoff schema version. The reader rejects any other version. */
export const ORCH_HANDOFF_SCHEMA_VERSION = 1;

/** Basename of the handoff file under the project's .claude dir. */
export const ORCH_HANDOFF_FILENAME = '.cam-orch-handoff.json';

/**
 * Shape of the orchestrator handoff. Required fields are validated on read;
 * optional fields carry the rehydration context. The index signature preserves
 * unknown top-level keys across a round-trip (forward compatibility): a newer
 * orchestrator may write extra fields that an older reader keeps intact.
 */
export interface OrchHandoffPayload {
	schemaVersion: number;
	writtenAt: string;
	reason: string;
	projectContext?: string;
	currentCycle?: string;
	keyDecisions?: string[];
	openState?: string;
	openQuestions?: string[];
	nextActions?: string[];
	[key: string]: unknown;
}

/** Absolute path of the handoff file for a given project .claude dir. */
function handoffPath(claudeDir: string): string {
	return join(claudeDir, ORCH_HANDOFF_FILENAME);
}

/**
 * Write the orchestrator handoff atomically: serialize to a sibling tmp file,
 * then rename over the final path. A crash mid-write therefore never leaves a
 * half-written file that would poison the respawn rehydration.
 */
export function writeOrchHandoff(claudeDir: string, payload: OrchHandoffPayload): void {
	mkdirSync(claudeDir, { recursive: true });
	const finalPath = handoffPath(claudeDir);
	const tmpPath = `${finalPath}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
	renameSync(tmpPath, finalPath);
}

/**
 * Read the orchestrator handoff. Returns null when the file is absent (no
 * handoff pending). Throws a clear error when the file exists but is malformed
 * JSON, carries an unknown schemaVersion, or is missing a required field, so a
 * forward-incompatible or corrupt handoff fails loud rather than silently
 * dropping context. Unknown top-level keys are preserved on the returned object.
 */
export function readOrchHandoff(claudeDir: string): OrchHandoffPayload | null {
	const path = handoffPath(claudeDir);

	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch {
		return null; // absent: no handoff pending
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`orch-handoff: ${path} is not valid JSON`);
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`orch-handoff: ${path} is not a JSON object`);
	}

	const obj = parsed as Record<string, unknown>;

	if (obj['schemaVersion'] !== ORCH_HANDOFF_SCHEMA_VERSION) {
		throw new Error(
			`orch-handoff: unsupported schemaVersion ${String(obj['schemaVersion'])} in ${path} (expected ${ORCH_HANDOFF_SCHEMA_VERSION})`,
		);
	}
	if (typeof obj['writtenAt'] !== 'string') {
		throw new Error(`orch-handoff: ${path} is missing a required field: writtenAt`);
	}
	if (typeof obj['reason'] !== 'string') {
		throw new Error(`orch-handoff: ${path} is missing a required field: reason`);
	}

	// Forward compatibility: return the whole parsed object so unknown keys
	// survive the round-trip.
	return obj as OrchHandoffPayload;
}
