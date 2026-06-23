// scripts/check-debt-markers.ts
//
// Debt-marker gate (US-003, CAM-60 PRD).
//
// Scans src/ and scripts/ for (TODO/FIXME/HACK/XXX) markers and fails
// any marker that does not cite a tracker id (CAM-NNN, #N, or http(s) URL).
// Excludes vendor/, node_modules/, claude-code-harness/, and dist/ from the scan.
//
// Exports:
//   filterScannablePaths(paths) - drop excluded-dir entries
//   scanForMarkers(files)       - classify markers as cited/uncited
//
// Usage: bun scripts/check-debt-markers.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { Glob } from 'bun';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Directory segments whose files must be excluded from the scan.
 * Any path that includes one of these strings is dropped.
 * Pinned here per AC6: src/vendor/_generated.ts embeds literal marker
 * tokens in the auditor prompt and must never trip the gate.
 */
const EXCLUDED_DIRS = ['vendor/', 'node_modules/', 'claude-code-harness/', 'dist/'];

/**
 * Matches (TODO/FIXME/HACK/XXX) as standalone debt markers.
 *
 * - Negative lookbehind (?<!-) excludes hyphen-prefixed forms
 *   like US-XXX and CAM-XXX (common placeholder identifiers).
 * - Positive lookahead (?=[:\s]) requires the marker to be followed
 *   immediately by a colon or whitespace (standard comment style).
 *
 * Note: flags are reset per-line via lastIndex so the /g flag is
 * safe inside the scan loop.
 */
const MARKER_RE = /(?<!-)\b(TODO|FIXME|HACK|XXX)\b(?=[:\s])/g;

/** Matches a valid tracker reference: CAM-NNN, #N, or an https?:// URL. */
const CITED_RE = /CAM-\d+|#\d+|https?:\/\//;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** One entry per debt-marker occurrence found in the scanned files. */
export interface MarkerResult {
	/** Repo-relative file path (as returned by Glob.scanSync). */
	path: string;
	/** 1-indexed line number where the marker appears. */
	line: number;
	/** The matched marker keyword (TODO, FIXME, HACK, or XXX). */
	marker: string;
	/**
	 * True when the same line also contains at least one tracker reference
	 * (CAM-\d+, #\d+, or https?://).
	 */
	cited: boolean;
}

// ---------------------------------------------------------------------------
// Pure exported functions
// ---------------------------------------------------------------------------

/**
 * Filter a list of repo-relative file paths, keeping only those that do
 * not fall under an excluded directory segment.
 *
 * Excluded segments: vendor/, node_modules/, claude-code-harness/, dist/
 */
export function filterScannablePaths(paths: string[]): string[] {
	return paths.filter((p) => !EXCLUDED_DIRS.some((dir) => p.includes(dir)));
}

/**
 * Scan a list of in-memory file records for debt markers.
 *
 * Each file is supplied as { path, text }. The function does NOT read the
 * filesystem; callers inject content for full testability.
 *
 * Returns one MarkerResult per unique marker occurrence (per-line). When
 * cited is false the caller should fail the gate and print path:line.
 */
export function scanForMarkers(
	files: { path: string; text: string }[],
): MarkerResult[] {
	const results: MarkerResult[] = [];

	for (const { path, text } of files) {
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const lineText = lines[i] ?? '';
			MARKER_RE.lastIndex = 0;

			const seenMarkers = new Set<string>();
			let match: RegExpExecArray | null;

			while ((match = MARKER_RE.exec(lineText)) !== null) {
				const marker = match[1] ?? '';
				// Deduplicate same marker keyword appearing multiple times on one line
				if (seenMarkers.has(marker)) continue;
				seenMarkers.add(marker);

				const cited = CITED_RE.test(lineText);
				results.push({ path, line: i + 1, marker, cited });
			}
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const cwd = process.cwd();

	// Enumerate all TypeScript source files under src/ and scripts/
	const glob = new Glob('{src,scripts}/**/*.{ts,tsx}');
	const allPaths = [...glob.scanSync({ cwd })];
	const paths = filterScannablePaths(allPaths);

	const files = paths.map((p) => ({
		path: p,
		text: readFileSync(join(cwd, p), 'utf8'),
	}));

	const markers = scanForMarkers(files);
	const uncited = markers.filter((m) => !m.cited);

	for (const m of uncited) {
		process.stderr.write(
			`check:debt-markers: ${m.path}:${m.line}: uncited ${m.marker}` +
				` (add CAM-NNN, #N, or https://... on the same line)\n`,
		);
	}

	if (uncited.length > 0) {
		process.exit(1);
	}

	process.stdout.write('check:debt-markers: ok\n');
}
