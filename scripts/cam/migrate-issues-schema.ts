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

import { spawnSync } from "node:child_process";
import type {
	IssueEntry,
	IssueStage,
	IssueStatus,
} from "../../src/issues/types.ts";
import { issueFilePath } from "../../src/issues/backlog.ts";
import {
	commitTreeToMain,
	type FileWrite,
	type SpawnFn,
} from "../../src/git/on-main.ts";

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
// migrateIssuesToDir: atomic migration from issues.local.json to per-file dir
// ---------------------------------------------------------------------------

const ISSUES_LOCAL_PATH = "scripts/cam/issues.local.json";
const COMMIT_MSG_MIGRATE = "chore(cam): migrate issues.local.json to per-file dir";

export interface MigrateIssuesToDirResult {
	/** True when issues.local.json was already absent (migration already done). */
	noOp: boolean;
	/** Number of issue files written (0 on no-op). */
	issueCount: number;
	/** 7-char short sha of the new commit (absent on no-op). */
	sha?: string;
}

/**
 * Read the live main issues.local.json, write one CAM-NNNN.json per issue,
 * and delete issues.local.json -- all in ONE atomic multi-file commit.
 *
 * Idempotent: if issues.local.json is absent on main (migration already ran),
 * returns { noOp: true } immediately without creating any commit.
 *
 * Filename convention: 4-digit zero-padded (CAM-0090.json); id field inside
 * the JSON is unpadded (CAM-90).
 *
 * @param cwd     Absolute path to the git repo root.
 * @param spawnFn Injectable spawnSync (defaults to node:child_process.spawnSync).
 */
export function migrateIssuesToDir(
	cwd: string,
	spawnFn: SpawnFn = spawnSync,
): MigrateIssuesToDirResult {
	// Check whether issues.local.json exists on main.
	const showResult = spawnFn(
		"git",
		["-C", cwd, "show", `main:${ISSUES_LOCAL_PATH}`],
		{ encoding: "utf8" },
	);

	if ((showResult.status ?? 1) !== 0) {
		// issues.local.json absent on main: migration already happened, no-op.
		return { noOp: true, issueCount: 0 };
	}

	// Parse the source file.
	const raw = JSON.parse(showResult.stdout ?? "{}") as IssuesLocalJson;
	const issueArray: RawEntry[] = raw.issues ?? [];

	// Build FileWrite[] -- one JSON file per issue.
	// id field is preserved unpadded; filename uses 4-digit zero-padding.
	const files: FileWrite[] = issueArray.map((entry) => {
		const path = issueFilePath(entry.id);
		const content = JSON.stringify(entry, null, 2) + "\n";
		return { path, content };
	});

	// Read current main SHA for the CAS baseline.
	const revParseResult = spawnFn(
		"git",
		["-C", cwd, "rev-parse", "main"],
		{ encoding: "utf8" },
	);
	const mainSha = (revParseResult.stdout ?? "").trim();

	// Atomic commit: N file writes + deletion of issues.local.json.
	const sha = commitTreeToMain(
		cwd,
		files,
		COMMIT_MSG_MIGRATE,
		mainSha,
		spawnFn,
		"cam-migrate-",
		[ISSUES_LOCAL_PATH],
	);

	return { noOp: false, issueCount: files.length, sha };
}

// ---------------------------------------------------------------------------
// CLI entrypoint (only when run directly)
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const args = process.argv.slice(2);

	if (args[0] === "--dir-migrate") {
		// Dir migration mode: move issues.local.json -> per-file dir atomically.
		const cwd = args[1] ?? process.cwd();
		const result = migrateIssuesToDir(cwd);
		if (result.noOp) {
			console.log("No-op: issues.local.json already absent on main (already migrated).");
		} else {
			console.log(
				`Migrated ${result.issueCount} issues to per-file dir. Commit: ${result.sha}`,
			);
		}
	} else {
		// Schema migration mode (original): rewrite entries to new schema.
		const filePath = args[0];
		if (!filePath) {
			console.error(
				"Usage: bun scripts/cam/migrate-issues-schema.ts <path-to-issues.local.json>",
			);
			console.error(
				"       bun scripts/cam/migrate-issues-schema.ts --dir-migrate [cwd]",
			);
			process.exit(1);
		}
		const raw = await Bun.file(filePath).json();
		const migrated = migrateBacklog(raw);
		await Bun.write(filePath, JSON.stringify(migrated, null, 2) + "\n");
		console.log(`Migrated ${migrated.issues.length} issues in ${filePath}`);
	}
}
