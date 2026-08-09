// src/supervisor/headless-log.ts
//
// Persists one append-only log file per headless dispatch, keyed by the
// dispatch uuid, so a headless run is auditable after the fact (US-002,
// CAM-516). Every raw stdout line is written verbatim, in arrival order.
//
// Lives under `.claude/`, next to the other supervisor-owned observability
// artifacts (`.claude/cam-worker-events.jsonl` is the precedent, see
// scripts/cam/patterns.md "Single-source outcome contract and 5-concern
// model", CAM-77); gitignored via the `.claude/cam-headless-dispatch-*.jsonl`
// entry added to both .gitignore and templates/.gitignore alongside this
// story.
//
// Writer choice: `appendFileSync` (node:fs), the sanctioned synchronous
// point-write carve-out of the Bun-only invariant (scripts/cam/CLAUDE.md
// curated block; precedent: `makeFileEventLogger`, src/supervisor/events.ts).
// `appendFileSync` never truncates an existing file, so opening a second
// writer against a path an earlier writer already wrote to preserves the
// earlier bytes and appends after them -- append-only in the strong sense
// this story's AC4 requires, with no extra bookkeeping needed.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Writer handle returned by {@link openHeadlessDispatchLog}. */
export interface HeadlessDispatchLogWriter {
	/** Absolute path to this dispatch's log file. */
	path: string;
	/** Appends one raw stdout line verbatim (a trailing newline is added). */
	appendLine: (line: string) => void;
}

/**
 * Resolve the per-dispatch log file path, keyed by the dispatch uuid.
 */
export function headlessDispatchLogPath(claudeDir: string, uuid: string): string {
	return join(claudeDir, `cam-headless-dispatch-${uuid}.jsonl`);
}

/**
 * Open (or reopen) an append-only writer for one dispatch's log file,
 * creating `claudeDir` if it does not exist yet. Safe to call more than once
 * for the same uuid (e.g. across process restarts): each returned writer
 * only ever appends, so bytes written by a prior writer are preserved.
 */
export function openHeadlessDispatchLog(claudeDir: string, uuid: string): HeadlessDispatchLogWriter {
	const path = headlessDispatchLogPath(claudeDir, uuid);
	mkdirSync(claudeDir, { recursive: true });
	return {
		path,
		appendLine: (line: string) => {
			appendFileSync(path, `${line}\n`, 'utf8');
		},
	};
}
