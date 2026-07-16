// src/supervisor/plan-split-advisory.ts
//
// maybeEmitPlanSplitAdvisory() -- best-effort split-advisory emission after
// a successful plan (US-004, CAM-241/136).
//
// Computes computeSplitAdvisory's inputs (src/stats/split-advisory.ts, US-003)
// by reading:
//   - the just-planned issue's WSJF jobSize, from its issue spec file
//     (wsjf.jobSize, via issueFilePath, src/issues/backlog.ts)
//   - the generated prd.json's story count (userStories.length)
//   - historical { jobSize, total } records: aggregateTokensPerIssue's
//     per-issue token totals (US-001, src/stats/tokens.ts) joined with each
//     issue's own file's jobSize
// and, when the heuristic fires, emits a 'plan-split-advisory' event AND
// pushes an operator note via the caller-supplied notify function.
//
// Strictly non-gating (PRD AC-3): the whole function body is wrapped in a
// single try/catch so ANY read/parse/join failure -- including the
// caller-supplied notify/logEvent callbacks throwing -- is swallowed
// silently. This must never throw out of the plan phase, never change the
// plan/post-audit outcome, and never fail the loop. No project.toml knob
// (PRD AC-4): the threshold and bucketing stay the US-003 code constants in
// src/stats/split-advisory.ts; this module reads no config.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { issueFilePath } from '../issues/backlog.ts';
import { aggregateTokensPerIssue } from '../stats/tokens.ts';
import { computeSplitAdvisory, type HistoricalJobSizeRecord } from '../stats/split-advisory.ts';
import type { PlanSplitAdvisoryEventDetail, WorkerEventLogger } from './events.ts';

/** Read an issue file's `wsjf.jobSize` by id. Returns undefined on any read/parse/missing-field failure. */
function readIssueJobSize(cwd: string, id: string): number | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(cwd, issueFilePath(id)), 'utf8')) as {
			wsjf?: { jobSize?: unknown };
		};
		const jobSize = raw.wsjf?.jobSize;
		return typeof jobSize === 'number' ? jobSize : undefined;
	} catch {
		return undefined;
	}
}

export interface MaybeEmitPlanSplitAdvisoryOptions {
	/** Absolute path to the repo root. */
	cwd: string;
	/** prd.json's issueNumber, read verbatim by the caller (unknown until validated). */
	issueNumber: unknown;
	logEvent: WorkerEventLogger;
	/** Pushes an operator-facing note (the existing notify path, e.g. makeNotifyOrchestrator). */
	notify: (line: string) => void;
	/** Injectable for tests; defaults to reading .claude/cam-worker-events.jsonl. */
	readEventLog?: () => string;
}

/**
 * Compute and (when it fires) emit the plan-split advisory for the issue the
 * plan runner just generated stories for. See module doc for the
 * non-gating/no-throw contract; call this AFTER the post-audit outcome and
 * phase transition are already finalized.
 */
export function maybeEmitPlanSplitAdvisory(o: MaybeEmitPlanSplitAdvisoryOptions): void {
	try {
		if (typeof o.issueNumber !== 'number') return;
		const issueId = `CAM-${o.issueNumber}`;

		const currentJobSize = readIssueJobSize(o.cwd, issueId);
		if (currentJobSize === undefined) return;

		const prdRaw = JSON.parse(
			readFileSync(join(o.cwd, 'scripts/cam/prd.json'), 'utf8'),
		) as { userStories?: unknown[] };
		const storyCount = Array.isArray(prdRaw.userStories) ? prdRaw.userStories.length : 0;

		const readEventLog = o.readEventLog ?? (() => readFileSync(join(o.cwd, '.claude', 'cam-worker-events.jsonl'), 'utf8'));
		const summary = aggregateTokensPerIssue(readEventLog());

		const records: HistoricalJobSizeRecord[] = [];
		for (const rollup of summary.perIssue) {
			const jobSize = readIssueJobSize(o.cwd, rollup.issueNumber);
			if (jobSize !== undefined) records.push({ jobSize, total: rollup.total });
		}

		const result = computeSplitAdvisory(records, { jobSize: currentJobSize, storyCount });
		if (!result.advisory) return;

		const detail: PlanSplitAdvisoryEventDetail = {
			issueId,
			jobSize: currentJobSize,
			storyCount: result.storyCount,
			projectedTokens: result.projectedTokens,
			bucketMean: result.bucketMean,
			bucketMedian: result.bucketMedian,
			bucketSize: result.bucketSize,
		};
		o.logEvent({ ts: new Date().toISOString(), storyId: undefined, uuid: 'sidecar', kind: 'plan-split-advisory', detail });

		o.notify(
			`[cam] split advisory: ${issueId} (jobSize ${currentJobSize}, ${storyCount} stories) projects ` +
			`~${Math.round(result.projectedTokens)} tokens for this jobSize's historical bucket -- consider slicing.`,
		);
	} catch { /* best-effort: split advisory never gates or fails the plan phase */ }
}
