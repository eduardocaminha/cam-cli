// scripts/check-test-sleeps.ts
//
// Test-sleep gate core (US-001, CAM-305 PRD).
//
// Scans test/ for fixed timed-sleep async waits that make tests flaky /
// slow (a fixed wait either always over- or under-shoots the real
// condition). Flags exactly two anchored forms:
//   (i)  Bun.sleepSync(<numeric literal>)
//   (ii) new Promise(<id> => setTimeout(<id>, <numeric literal>))
// Deliberately does NOT flag: injected/recorded clocks (sleepFn:,
// setTimeoutFn =, globalThis.setTimeout =, nowFn:), Bun.sleep( (async),
// bare callback schedulers (setTimeout(cb, n)), or variable-interval
// timers (setTimeout(resolve, intervalMs)) — those are legitimate
// poll/backoff primitives, not fixed sleeps.
//
// Exports:
//   filterScannablePaths(paths) - drop excluded-dir entries
//   scanForSleeps(files)        - classify sleeps as cited/uncited
//
// Usage: bun scripts/check-test-sleeps.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { Glob } from 'bun';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Directory segments whose files must be excluded from the scan.
 * Mirrors scripts/check-debt-markers.ts EXCLUDED_DIRS.
 */
const EXCLUDED_DIRS = ['vendor/', 'node_modules/', 'claude-code-harness/', 'dist/'];

/**
 * Matches `Bun.sleepSync(<numeric literal>)` as a call. Deliberately does
 * NOT match `Bun.sleep(` (the async, non-blocking form).
 */
const SLEEP_SYNC_RE = /Bun\.sleepSync\(\s*\d+(?:\.\d+)?\s*\)/g;

/**
 * Matches `new Promise(<id> => setTimeout(<id>, <numeric literal>))`,
 * anchored so the identifier bound by the Promise executor is the exact
 * same identifier passed as setTimeout's first argument, called directly
 * (not wrapped in another callback), with a numeric literal delay.
 *
 * This deliberately does NOT match:
 *  - `setTimeout(resolve, intervalMs)` (variable delay, not a literal)
 *  - `setTimeout(() => resolve(...), n)` (wrapped callback, not the bare id)
 *  - bare `setTimeout(cb, n)` outside a `new Promise(...)` executor
 */
const PROMISE_SETTIMEOUT_RE =
	/new\s+Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\(\s*\1\s*,\s*\d+(?:\.\d+)?\s*\)\s*\)/g;

/** Matches a valid tracker reference: CAM-NNN, #N, or an https?:// URL. */
const CITED_RE = /CAM-\d+|#\d+|https?:\/\//;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** One entry per fixed-sleep occurrence found in the scanned files. */
export interface SleepResult {
	/** Repo-relative file path (as returned by Glob.scanSync). */
	path: string;
	/** 1-indexed line number where the sleep appears. */
	line: number;
	/** Which anchored form matched. */
	kind: 'Bun.sleepSync' | 'setTimeout-promise';
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
 * Scan a list of in-memory file records for fixed timed-sleep async waits.
 *
 * Each file is supplied as { path, text }. The function does NOT read the
 * filesystem; callers inject content for full testability.
 *
 * Returns one SleepResult per unique match (per-line). When cited is false
 * the caller should fail the gate and print path:line.
 */
export function scanForSleeps(files: { path: string; text: string }[]): SleepResult[] {
	const results: SleepResult[] = [];

	for (const { path, text } of files) {
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const lineText = lines[i] ?? '';
			const cited = CITED_RE.test(lineText);

			SLEEP_SYNC_RE.lastIndex = 0;
			while (SLEEP_SYNC_RE.exec(lineText) !== null) {
				results.push({ path, line: i + 1, kind: 'Bun.sleepSync', cited });
			}

			PROMISE_SETTIMEOUT_RE.lastIndex = 0;
			while (PROMISE_SETTIMEOUT_RE.exec(lineText) !== null) {
				results.push({ path, line: i + 1, kind: 'setTimeout-promise', cited });
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

	// Enumerate all TypeScript test files under test/
	const glob = new Glob('test/**/*.{ts,tsx}');
	const allPaths = [...glob.scanSync({ cwd })];
	const paths = filterScannablePaths(allPaths);

	const files = paths.map((p) => ({
		path: p,
		text: readFileSync(join(cwd, p), 'utf8'),
	}));

	const sleeps = scanForSleeps(files);
	const uncited = sleeps.filter((s) => !s.cited);

	for (const s of uncited) {
		process.stderr.write(
			`check:test-sleeps: ${s.path}:${s.line}: fixed sleep (${s.kind}) — ` +
				`poll with test/helpers/wait-for-condition.ts instead of a fixed delay ` +
				`(add CAM-NNN, #N, or https://... on the same line to suppress)\n`,
		);
	}

	if (uncited.length > 0) {
		process.exit(1);
	}

	process.stdout.write('check:test-sleeps: ok\n');
}
