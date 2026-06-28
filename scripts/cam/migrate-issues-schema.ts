/**
 * Migration script: rewrites every existing issue to the new schema.
 *
 * Mapping rules (US-005, CAM-106):
 *   old state in {closed, done, canceled} -> stage: 'shipped'
 *   old state === 'open'                  -> stage: 'idea'
 *   derives status: open->open; canceled/abandoned->abandoned; closed/done->open
 *   sets blockedBy: [] when absent
 *   DROPS the ad-hoc priority field entirely
 *   does NOT set wsjf/rank/spec
 *
 * Idempotency: entries that already have stage and no state/priority are
 * passed through unchanged.
 *
 * CLI usage: bun scripts/cam/migrate-issues-schema.ts <path-to-issues.local.json>
 */

import type {
	IssueEntry,
	IssueStage,
	IssueStatus,
} from "../../src/issues/types.ts";

// Local shape of issues.local.json -- IssuesLocalJson was removed from
// issues/types.ts in US-002 (replaced by the per-file dir primitive).
interface IssuesLocalJson {
	next_id: number;
	issues: IssueEntry[];
}

// ---------------------------------------------------------------------------
// Internal raw-entry type (old schema shape on disk)
// ---------------------------------------------------------------------------

interface RawEntry {
	id: string;
	title: string;
	description?: string;
	state?: string;
	stage?: string;
	status?: string;
	blockedBy?: unknown;
	createdAt: string;
	priority?: unknown;
	closedAt?: string;
	wsjf?: unknown;
	rank?: unknown;
	spec?: unknown;
}

// ---------------------------------------------------------------------------
// Stage / status derivation
// ---------------------------------------------------------------------------

function deriveStage(state: string | undefined): IssueStage {
	return state === "open" ? "idea" : "shipped";
}

function deriveStatus(state: string | undefined): IssueStatus {
	return state === "canceled" || state === "abandoned" ? "abandoned" : "open";
}

// ---------------------------------------------------------------------------
// Pure per-entry transform
// ---------------------------------------------------------------------------

function migrateEntry(raw: RawEntry): IssueEntry {
	// Idempotency guard: already at new schema (has stage, no state, no priority)
	if (
		typeof raw.stage === "string" &&
		!("state" in raw) &&
		!("priority" in raw)
	) {
		return raw as unknown as IssueEntry;
	}

	const stage: IssueStage =
		typeof raw.stage === "string"
			? (raw.stage as IssueStage)
			: deriveStage(raw.state);

	const status: IssueStatus = deriveStatus(raw.state);

	const blockedBy: string[] = Array.isArray(raw.blockedBy) ? raw.blockedBy : [];

	const entry: IssueEntry = {
		id: raw.id,
		title: raw.title,
		stage,
		status,
		blockedBy,
		createdAt: raw.createdAt,
	};

	if (typeof raw.description === "string") {
		entry.description = raw.description;
	}
	if (raw.wsjf !== undefined) {
		entry.wsjf = raw.wsjf as IssueEntry["wsjf"];
	}
	if (typeof raw.rank === "number") {
		entry.rank = raw.rank;
	}
	if (raw.spec !== null && raw.spec !== undefined) {
		entry.spec = raw.spec as IssueEntry["spec"];
	}

	return entry;
}

// ---------------------------------------------------------------------------
// Public API: pure transform over the whole file
// ---------------------------------------------------------------------------

export function migrateBacklog(raw: unknown): IssuesLocalJson {
	const file = raw as { next_id: number; issues: RawEntry[] };
	return {
		next_id: file.next_id,
		issues: file.issues.map(migrateEntry),
	};
}

// ---------------------------------------------------------------------------
// CLI entrypoint (only when run directly)
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const filePath = process.argv[2];
	if (!filePath) {
		console.error("Usage: bun scripts/cam/migrate-issues-schema.ts <path>");
		process.exit(1);
	}
	const raw = await Bun.file(filePath).json();
	const migrated = migrateBacklog(raw);
	await Bun.write(filePath, JSON.stringify(migrated, null, 2) + "\n");
	console.log(`Migrated ${migrated.issues.length} issues in ${filePath}`);
}
