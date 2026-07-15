// scripts/record-golden.ts
//
// On-demand golden-fixture refresh harness (US-004, CAM-302 PRD).
//
// Refreshes the golden fixtures that mirror artifacts a live cam session
// actually writes to disk: scripts/cam/worker-report.json,
// scripts/cam/review-report.json, .claude/.cam-orch-handoff.json, and
// scripts/cam/handoff.json. Run this by hand, after a live `cam run` session
// has produced those files, so the committed fixtures under
// test/fixtures/golden/ stay honest against real on-wire shapes instead of
// drifting from hand-maintained guesses.
//
// Deliberately does NOT touch test/fixtures/golden/sentinel-*.txt,
// review-clean.txt, review-fixes-pending.txt, or transcript-usage.jsonl:
// those fixtures encode deliberate hand-crafted edge cases (markdown wrap,
// trailing punctuation, multi-turn transcript dedup) that a single live
// capture cannot faithfully reproduce; curate those by hand instead.
//
// NOT a CI gate: this script is intentionally absent from the GATES
// manifest in scripts/check-all.ts and from .github/workflows/ci.yml. It is
// on-demand only, run manually by the operator against a live session's
// on-disk artifacts -- wiring it into CI is a deferred canary-(A) upgrade.
//
// Usage: bun scripts/record-golden.ts
//        bun run record:golden       (package.json convenience alias)

import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { ORCH_HANDOFF_FILENAME } from '../src/orchestrator/handoff.ts';
import { REVIEW_REPORT_FILENAME } from '../src/supervisor/review-report.ts';
import { WORKER_REPORT_FILENAME } from '../src/supervisor/worker-report.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One golden fixture to refresh from a live on-disk source. */
export interface RefreshTarget {
	/** Fixture filename under test/fixtures/golden/. */
	fixtureName: string;
	/** Absolute path to the live artifact to copy from. */
	sourcePath: string;
}

/** Outcome of a refresh pass. */
export interface RefreshResult {
	/** Fixture names successfully copied. */
	refreshed: string[];
	/** Fixture names skipped because the live source did not exist on disk. */
	skipped: string[];
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Build the list of golden fixtures this harness knows how to refresh, and
 * the live on-disk path each one is copied from.
 *
 * @param cwd Project root (where scripts/cam/* ephemeral artifacts live).
 * @param claudeDir Project .claude dir (where the orch-handoff marker lives).
 */
export function buildRefreshTargets(cwd: string, claudeDir: string): RefreshTarget[] {
	return [
		{ fixtureName: 'worker-report.json', sourcePath: join(cwd, WORKER_REPORT_FILENAME) },
		{ fixtureName: 'review-report.json', sourcePath: join(cwd, REVIEW_REPORT_FILENAME) },
		{ fixtureName: 'orch-handoff.json', sourcePath: join(claudeDir, ORCH_HANDOFF_FILENAME) },
		{ fixtureName: 'handoff.json', sourcePath: join(cwd, 'scripts', 'cam', 'handoff.json') },
	];
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Copy each target's live source onto its golden fixture path, when the live
 * source exists on disk. Targets whose live source is absent (e.g. no `cam
 * run` session has produced that artifact yet) are reported as skipped
 * rather than erroring: this harness is on-demand and best-effort.
 */
export function refreshGoldenFixtures(
	targets: RefreshTarget[],
	goldenDir: string,
): RefreshResult {
	const refreshed: string[] = [];
	const skipped: string[] = [];

	for (const target of targets) {
		if (existsSync(target.sourcePath)) {
			copyFileSync(target.sourcePath, join(goldenDir, target.fixtureName));
			refreshed.push(target.fixtureName);
		} else {
			skipped.push(target.fixtureName);
		}
	}

	return { refreshed, skipped };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
	const cwd = process.cwd();
	const claudeDir = join(cwd, '.claude');
	const goldenDir = join(cwd, 'test', 'fixtures', 'golden');

	const targets = buildRefreshTargets(cwd, claudeDir);
	const { refreshed, skipped } = refreshGoldenFixtures(targets, goldenDir);

	process.stdout.write(`refreshed: ${refreshed.length > 0 ? refreshed.join(', ') : '(none)'}\n`);
	process.stdout.write(`skipped (no live source on disk): ${skipped.length > 0 ? skipped.join(', ') : '(none)'}\n`);
	if (skipped.length > 0) {
		process.stdout.write(
			'Run a live `cam run` session first so these artifacts exist on disk, then re-run this script.\n',
		);
	}
}
