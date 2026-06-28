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
//
// GIT CONTRACT (cat-file --batch framing):
//   Input (stdin): one object name per line (e.g. `main:scripts/cam/issues/CAM-001.json`).
//   Output per object: `<oid> SP <type> SP <size> LF <contents> LF`
//   Parse: read the header line, take exactly <size> characters of content,
//   skip the trailing LF.
//
// CAM-90 US-002.

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
	options: { encoding: 'utf8'; input?: string },
) => SpawnSyncReturns<string>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parses the numeric id suffix from "PREFIX-<N>" (e.g. "CAM-12" -> 12).
 * Returns Infinity for non-numeric or missing suffix, sorting those entries last.
 */
function numericIdSuffix(id: string): number {
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
 * Returns raw content strings for each "blob" object found. Lines whose type
 * is not "blob" (e.g. "missing") are silently skipped.
 */
function parseBatchOutput(output: string): string[] {
	const results: string[] = [];
	let pos = 0;
	while (pos < output.length) {
		const nl = output.indexOf('\n', pos);
		if (nl === -1) break;
		const header = output.slice(pos, nl);
		pos = nl + 1;

		// Header format: "<oid> <type> <size>" or "<name> missing"
		const parts = header.split(' ');
		if (parts.length < 3 || parts[1] !== 'blob') continue;

		const sizeStr = parts[2];
		const size = sizeStr !== undefined ? parseInt(sizeStr, 10) : NaN;
		if (Number.isNaN(size)) continue;

		// Read exactly <size> characters of content, then skip the trailing LF.
		const content = output.slice(pos, pos + size);
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
	const refs = paths.map((p) => `main:${p}`).join('\n');
	const catResult = spawn(
		'git',
		['-C', cwd, 'cat-file', '--batch'],
		{ encoding: 'utf8', input: refs },
	);

	// Parse framed output into raw content strings.
	const contents = parseBatchOutput(catResult.stdout ?? '');

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
