// src/issues/backlog.ts
//
// readBacklogFromMain() -- read all per-issue files from main's
// scripts/cam/issues/ directory via one git ls-tree + one git cat-file --batch,
// sorted numerically by id suffix.
//
// Design:
//   - O(1) subprocesses regardless of N (one ls-tree + one cat-file --batch).
//   - Read-from-main invariant: always reads from the `main` ref, never the
//     working tree, so a just-filed issue is visible from any branch.
//   - Returns [] when the directory is absent or empty (cat-file not called).
//   - Unparseable JSON entries are silently skipped.
//   - Fail-closed on the cat-file --batch read itself (US-001, CAM-307): an
//     ample 256 MiB maxBuffer prevents truncation at Node's 1 MiB spawnSync
//     default, and a spawn error / non-zero exit status THROWS rather than
//     parsing a truncated buffer, so the highest-id issues are never silently
//     dropped and allocateId never re-mints a colliding id.
//
// GIT CONTRACT (cat-file --batch framing):
//   Input (stdin): one object name per line (e.g. `main:scripts/cam/issues/CAM-001.json`).
//   Output per object: `<oid> SP <type> SP <size> LF <contents> LF`
//   Parse: read the header line, take exactly <size> BYTES of content,
//   skip the trailing LF byte.  <size> is always in bytes (not characters).
//
// CAM-90 US-002, US-003.

import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import type { IssueEntry } from './types.ts';

// ---------------------------------------------------------------------------
// Injectable SpawnFn type
// ---------------------------------------------------------------------------

/**
 * Minimal spawnSync-compatible type for readBacklogFromMain.
 * Supports stdin via `input` (required for git cat-file --batch).
 */
export type BacklogSpawnFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8'; input?: string; maxBuffer?: number },
) => SpawnSyncReturns<string>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parses the numeric id suffix from "PREFIX-<N>" (e.g. "CAM-12" -> 12).
 * Returns Infinity for non-numeric or missing suffix, sorting those entries last.
 */
export function numericIdSuffix(id: string): number {
	const suffix = id.split('-').at(-1);
	if (suffix === undefined) return Infinity;
	const n = Number(suffix);
	return Number.isNaN(n) ? Infinity : n;
}

/**
 * Parses the framed output of `git cat-file --batch`.
 *
 * Each object is framed as:
 *   <oid> SP <type> SP <size> LF <contents> LF
 *
 * `<size>` is the BYTE length of the blob contents (git contract). This
 * function therefore operates on a raw Buffer so that slicing is byte-accurate.
 * Multi-byte UTF-8 characters (e.g. Portuguese accents: ção, migração) are
 * decoded correctly per-blob via `Buffer.subarray(...).toString('utf8')`.
 *
 * Returns raw content strings for each "blob" object found. Lines whose type
 * is not "blob" (e.g. "missing") are silently skipped.
 */
function parseBatchOutput(outputBytes: Buffer): string[] {
	const results: string[] = [];
	let pos = 0;
	while (pos < outputBytes.length) {
		// Locate the next LF byte (0x0A) that terminates the header.
		// Buffer.indexOf is byte-accurate; 0x0A is never a UTF-8 continuation
		// byte (those are always >= 0x80), so this scan is safe.
		const nl = outputBytes.indexOf(0x0a, pos);
		if (nl === -1) break;
		const header = outputBytes.subarray(pos, nl).toString('utf8');
		pos = nl + 1;

		// Header format: "<oid> <type> <size>" or "<name> missing"
		const parts = header.split(' ');
		if (parts.length < 3 || parts[1] !== 'blob') continue;

		const sizeStr = parts[2];
		const size = sizeStr !== undefined ? parseInt(sizeStr, 10) : NaN;
		if (Number.isNaN(size)) continue;

		// Read exactly <size> BYTES of content, then skip the trailing LF byte.
		// Decoding each slice individually ensures multi-byte UTF-8 characters
		// in the blob are reconstructed correctly.
		const content = outputBytes.subarray(pos, pos + size).toString('utf8');
		pos += size + 1;
		results.push(content);
	}
	return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read all issue files from `main:scripts/cam/issues/` via:
 *   1. `git ls-tree -r --name-only main scripts/cam/issues/` -- enumerate paths.
 *   2. `git cat-file --batch` (stdin: one `main:<path>` per line) -- read blobs.
 *
 * Parses each blob as an IssueEntry (unparseable entries are skipped silently).
 * Returns entries sorted numerically ascending by the id's numeric suffix.
 *
 * Always reads from the `main` ref (never the working tree), preserving the
 * read-from-main cross-branch invariant.
 *
 * Fail-closed (US-001, CAM-307): throws if the `git cat-file --batch` spawn
 * reports an error or a non-zero exit status, instead of silently parsing a
 * truncated buffer. Callers that need this to be non-fatal (e.g. a
 * best-effort sidecar sweep) must wrap the call in their own try/catch.
 *
 * @param cwd   Absolute path to the git repo root.
 * @param spawn Injectable spawnSync (defaults to node:child_process.spawnSync).
 */
export function readBacklogFromMain(
	cwd: string,
	spawn: BacklogSpawnFn = spawnSync,
): IssueEntry[] {
	// Step 1: enumerate paths under scripts/cam/issues/ on main.
	const lsResult = spawn(
		'git',
		['-C', cwd, 'ls-tree', '-r', '--name-only', 'main', 'scripts/cam/issues/'],
		{ encoding: 'utf8' },
	);
	const paths = (lsResult.stdout ?? '')
		.split('\n')
		.map((p) => p.trim())
		.filter(Boolean);

	if (paths.length === 0) return [];

	// Step 2: read ALL blobs in a single cat-file --batch call.
	// maxBuffer is set to an ample 256 MiB so a growing backlog blob is never
	// silently truncated at Node's 1 MiB spawnSync default.
	const refs = paths.map((p) => `main:${p}`).join('\n');
	const catResult = spawn(
		'git',
		['-C', cwd, 'cat-file', '--batch'],
		{ encoding: 'utf8', input: refs, maxBuffer: 256 * 1024 * 1024 },
	);

	// Fail-closed: a truncated/errored batch read must never be silently
	// parsed as if it were complete (that would drop the highest-id issues
	// and cause allocateId to re-mint colliding ids). Throw loudly instead.
	if (catResult.error) {
		throw new Error(
			`readBacklogFromMain: git cat-file --batch failed: ${catResult.error.message}`,
		);
	}
	if (catResult.status !== 0) {
		throw new Error(
			`readBacklogFromMain: git cat-file --batch exited with status ${String(catResult.status)}: ${catResult.stderr ?? ''}`,
		);
	}

	// Convert the UTF-8-decoded string to a Buffer so that parseBatchOutput can
	// slice by byte offset (matching the byte-length <size> reported by git).
	// This round-trip is lossless for valid UTF-8 JSON content.
	const rawBytes = Buffer.from(catResult.stdout ?? '', 'utf8');
	const contents = parseBatchOutput(rawBytes);

	// Parse each content string as IssueEntry; skip malformed entries silently.
	const entries: IssueEntry[] = [];
	for (const content of contents) {
		try {
			const parsed = JSON.parse(content) as IssueEntry;
			entries.push(parsed);
		} catch {
			// Silently skip unparseable issue files.
		}
	}

	// Sort numerically ascending by the id's numeric suffix.
	entries.sort((a, b) => numericIdSuffix(a.id) - numericIdSuffix(b.id));
	return entries;
}

// ---------------------------------------------------------------------------
// issueFilePath
// ---------------------------------------------------------------------------

/**
 * Derive the repo-relative path for a per-issue JSON file from its id.
 *
 * Convention: 4-digit zero-padded numeric suffix in the filename, unpadded id
 * field inside the JSON (mirrors writeIssueFile in src/issues/alloc.ts).
 *
 * Examples:
 *   'CAM-1'    -> 'scripts/cam/issues/CAM-0001.json'
 *   'CAM-90'   -> 'scripts/cam/issues/CAM-0090.json'
 *   'CAM-1000' -> 'scripts/cam/issues/CAM-1000.json'
 */
export function issueFilePath(id: string): string {
	const lastDash = id.lastIndexOf('-');
	if (lastDash === -1) return `scripts/cam/issues/${id}.json`;
	const prefix = id.slice(0, lastDash);
	const n = parseInt(id.slice(lastDash + 1), 10);
	if (Number.isNaN(n)) return `scripts/cam/issues/${id}.json`;
	return `scripts/cam/issues/${prefix}-${String(n).padStart(4, '0')}.json`;
}

// ---------------------------------------------------------------------------
// allocateId
// ---------------------------------------------------------------------------

/**
 * Derive the next issue id as max(parsed ids on main) + 1.
 * Returns 1 when the backlog directory is empty (no issues yet).
 *
 * No stored counter: allocation is derived fresh from the committed backlog on
 * every call, so a stale in-memory counter can never cause id collisions.
 *
 * Design: callers that need CAS-safe allocation MUST call allocateId INSIDE
 * their retry rebuild closure so that a CAS loser re-derives the max from the
 * freshly-advanced main ref.  See writeIssueFile (src/issues/alloc.ts).
 *
 * @param cwd   Absolute path to the git repo root.
 * @param spawn Injectable spawnSync (defaults to node:child_process.spawnSync).
 */
export function allocateId(
	cwd: string,
	spawn: BacklogSpawnFn = spawnSync,
): number {
	const entries = readBacklogFromMain(cwd, spawn);
	let max = 0;
	for (const entry of entries) {
		const n = numericIdSuffix(entry.id);
		if (n !== Infinity && n > max) {
			max = n;
		}
	}
	return max > 0 ? max + 1 : 1;
}
