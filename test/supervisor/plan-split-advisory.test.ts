// test/supervisor/plan-split-advisory.test.ts
//
// Unit tests for maybeEmitPlanSplitAdvisory (US-004, CAM-241/136).
//
// Coverage (matches AC1-AC3 of the story):
//   AC1: current jobSize read from the issue spec file, story count from
//        prd.json, historical records joined from aggregateTokensPerIssue +
//        each issue file's jobSize.
//   AC2: fires above threshold (event + notify), silent below threshold,
//        silent with no history at all.
//   AC3: never gates/throws -- a throwing notify/logEvent, a missing issue
//        file, a missing event log, and a non-numeric issueNumber all
//        return normally with no crash.
//
// Real filesystem I/O in a temp dir (per project test-quality convention:
// hit real I/O at wire boundaries, no tautological mock-call assertions).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { maybeEmitPlanSplitAdvisory } from '../../src/supervisor/plan-split-advisory.ts';
import { makeInMemoryEventLogger, type WorkerEvent } from '../../src/supervisor/events.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function writeIssueFile(cwd: string, id: string, jobSize: number): void {
	const numMatch = /-(\d+)$/.exec(id);
	const padded = numMatch ? numMatch[1]?.padStart(4, '0') : id;
	const prefix = id.slice(0, id.lastIndexOf('-'));
	mkdirSync(join(cwd, 'scripts/cam/issues'), { recursive: true });
	writeFileSync(
		join(cwd, 'scripts/cam/issues', `${prefix}-${padded}.json`),
		JSON.stringify({ id, title: 't', stage: 'specified', status: 'open', blockedBy: [], wsjf: { value: 1, timeCriticality: 1, riskReduction: 1, jobSize } }),
		'utf8',
	);
}

function writePrd(cwd: string, storyCount: number): void {
	mkdirSync(join(cwd, 'scripts/cam'), { recursive: true });
	writeFileSync(
		join(cwd, 'scripts/cam/prd.json'),
		JSON.stringify({ userStories: Array.from({ length: storyCount }, (_, i) => ({ id: `US-${i + 1}` })) }),
		'utf8',
	);
}

/** Builds a raw 'cycle-tokens' JSONL line for the given issue id and total. */
function cycleTokensLine(issueNumber: string, total: number): string {
	const detail = { cycleId: `cycle-${issueNumber}`, issueNumber, orchTokens: 0, workerTokens: total, total, recordedAt: '2026-07-01T00:00:00Z' };
	return JSON.stringify({ ts: '2026-07-01T00:00:00Z', storyId: undefined, uuid: 'cycle-close', kind: 'cycle-tokens', detail });
}

function makeOpts(cwd: string, issueNumber: unknown, notifications: string[], events: WorkerEvent[]) {
	const { logger } = makeInMemoryEventLogger();
	return {
		cwd,
		issueNumber,
		logEvent: (e: WorkerEvent): void => {
			events.push(e);
			logger(e);
		},
		notify: (line: string): void => {
			notifications.push(line);
		},
	};
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('maybeEmitPlanSplitAdvisory', () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'cam-split-advisory-'));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	test('AC2: fires above threshold -- emits plan-split-advisory event AND notifies', () => {
		writeIssueFile(cwd, 'CAM-1', 5);
		writeIssueFile(cwd, 'CAM-2', 5);
		writeIssueFile(cwd, 'CAM-3', 5);
		writeIssueFile(cwd, 'CAM-136', 5);
		writePrd(cwd, 4);
		// bucket [100, 100, 1000] -> median 100, mean 400 -> 400 > 150 -> fires
		const eventLog = [
			cycleTokensLine('CAM-1', 100),
			cycleTokensLine('CAM-2', 100),
			cycleTokensLine('CAM-3', 1000),
		].join('\n');

		const notifications: string[] = [];
		const events: WorkerEvent[] = [];
		maybeEmitPlanSplitAdvisory({
			...makeOpts(cwd, 136, notifications, events),
			readEventLog: () => eventLog,
		});

		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain('CAM-136');
		expect(notifications[0]).toContain('split advisory');

		const advisoryEvents = events.filter((e) => e.kind === 'plan-split-advisory');
		expect(advisoryEvents).toHaveLength(1);
		expect(advisoryEvents[0]?.detail).toMatchObject({
			issueId: 'CAM-136',
			jobSize: 5,
			storyCount: 4,
			bucketSize: 3,
			bucketMedian: 100,
			projectedTokens: 400,
		});
	});

	test('AC2: stays silent when projection is below threshold -- no event, no notify', () => {
		writeIssueFile(cwd, 'CAM-1', 5);
		writeIssueFile(cwd, 'CAM-2', 5);
		writeIssueFile(cwd, 'CAM-3', 5);
		writeIssueFile(cwd, 'CAM-136', 5);
		writePrd(cwd, 2);
		// bucket [100, 100, 100] -> median 100, mean 100 -> not > 150
		const eventLog = [
			cycleTokensLine('CAM-1', 100),
			cycleTokensLine('CAM-2', 100),
			cycleTokensLine('CAM-3', 100),
		].join('\n');

		const notifications: string[] = [];
		const events: WorkerEvent[] = [];
		maybeEmitPlanSplitAdvisory({
			...makeOpts(cwd, 136, notifications, events),
			readEventLog: () => eventLog,
		});

		expect(notifications).toHaveLength(0);
		expect(events.filter((e) => e.kind === 'plan-split-advisory')).toHaveLength(0);
	});

	test('AC2: no historical data at all -- no event, no notify', () => {
		writeIssueFile(cwd, 'CAM-136', 5);
		writePrd(cwd, 1);

		const notifications: string[] = [];
		const events: WorkerEvent[] = [];
		maybeEmitPlanSplitAdvisory({
			...makeOpts(cwd, 136, notifications, events),
			readEventLog: () => '',
		});

		expect(notifications).toHaveLength(0);
		expect(events).toHaveLength(0);
	});

	test('AC1: historical records exclude other-jobSize issues from the bucket', () => {
		writeIssueFile(cwd, 'CAM-1', 8); // different jobSize -- must not leak into the bucket
		writeIssueFile(cwd, 'CAM-2', 5);
		writeIssueFile(cwd, 'CAM-3', 5);
		writeIssueFile(cwd, 'CAM-4', 5);
		writeIssueFile(cwd, 'CAM-136', 5);
		writePrd(cwd, 3);
		const eventLog = [
			cycleTokensLine('CAM-1', 999999), // would blow the threshold if it leaked in
			cycleTokensLine('CAM-2', 100),
			cycleTokensLine('CAM-3', 100),
			cycleTokensLine('CAM-4', 100),
		].join('\n');

		const notifications: string[] = [];
		const events: WorkerEvent[] = [];
		maybeEmitPlanSplitAdvisory({
			...makeOpts(cwd, 136, notifications, events),
			readEventLog: () => eventLog,
		});

		// jobSize-5 bucket is [100, 100, 100] -> below threshold -> silent.
		expect(notifications).toHaveLength(0);
		expect(events).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// AC3: never gates/throws
	// -------------------------------------------------------------------------

	test('AC3: non-numeric issueNumber -- returns normally, no event, no notify', () => {
		const notifications: string[] = [];
		const events: WorkerEvent[] = [];
		expect(() =>
			maybeEmitPlanSplitAdvisory({
				...makeOpts(cwd, undefined, notifications, events),
				readEventLog: () => '',
			}),
		).not.toThrow();
		expect(notifications).toHaveLength(0);
		expect(events).toHaveLength(0);
	});

	test('AC3: missing issue file -- returns normally, no event, no notify', () => {
		writePrd(cwd, 1);
		const notifications: string[] = [];
		const events: WorkerEvent[] = [];
		expect(() =>
			maybeEmitPlanSplitAdvisory({
				...makeOpts(cwd, 999, notifications, events),
				readEventLog: () => '',
			}),
		).not.toThrow();
		expect(notifications).toHaveLength(0);
		expect(events).toHaveLength(0);
	});

	test('AC3: missing prd.json -- returns normally, no event, no notify', () => {
		writeIssueFile(cwd, 'CAM-136', 5);
		const notifications: string[] = [];
		const events: WorkerEvent[] = [];
		expect(() =>
			maybeEmitPlanSplitAdvisory({
				...makeOpts(cwd, 136, notifications, events),
				readEventLog: () => cycleTokensLine('CAM-1', 100),
			}),
		).not.toThrow();
		expect(notifications).toHaveLength(0);
		expect(events).toHaveLength(0);
	});

	test('AC3: a throwing notify -- swallowed, function returns normally', () => {
		writeIssueFile(cwd, 'CAM-1', 5);
		writeIssueFile(cwd, 'CAM-2', 5);
		writeIssueFile(cwd, 'CAM-3', 5);
		writeIssueFile(cwd, 'CAM-136', 5);
		writePrd(cwd, 4);
		const eventLog = [
			cycleTokensLine('CAM-1', 100),
			cycleTokensLine('CAM-2', 100),
			cycleTokensLine('CAM-3', 1000),
		].join('\n');

		expect(() =>
			maybeEmitPlanSplitAdvisory({
				cwd,
				issueNumber: 136,
				logEvent: () => {},
				notify: () => {
					throw new Error('tmux pane gone');
				},
				readEventLog: () => eventLog,
			}),
		).not.toThrow();
	});

	test('AC3: a throwing logEvent -- swallowed, function returns normally', () => {
		writeIssueFile(cwd, 'CAM-1', 5);
		writeIssueFile(cwd, 'CAM-2', 5);
		writeIssueFile(cwd, 'CAM-3', 5);
		writeIssueFile(cwd, 'CAM-136', 5);
		writePrd(cwd, 4);
		const eventLog = [
			cycleTokensLine('CAM-1', 100),
			cycleTokensLine('CAM-2', 100),
			cycleTokensLine('CAM-3', 1000),
		].join('\n');

		expect(() =>
			maybeEmitPlanSplitAdvisory({
				cwd,
				issueNumber: 136,
				logEvent: () => {
					throw new Error('disk full');
				},
				notify: () => {},
				readEventLog: () => eventLog,
			}),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Wiring oracle: runPostPlanActions (src/commands/sidecar.ts) calls
// maybeEmitPlanSplitAdvisory strictly AFTER exitPhaseAfterPlan, per AC3
// (the advisory must never precede/affect the post-audit outcome or phase
// transition).
// ---------------------------------------------------------------------------

describe('wiring: runPostPlanActions calls maybeEmitPlanSplitAdvisory after exitPhaseAfterPlan', () => {
	const sidecarSrc = readFileSync(resolve(import.meta.dir, '../../src/commands/sidecar.ts'), 'utf8');

	test('sidecar.ts imports maybeEmitPlanSplitAdvisory from plan-split-advisory.ts', () => {
		expect(sidecarSrc).toContain("import { maybeEmitPlanSplitAdvisory } from '../supervisor/plan-split-advisory.ts';");
	});

	test('runPostPlanActions calls maybeEmitPlanSplitAdvisory after exitPhaseAfterPlan', () => {
		const fnMatch = sidecarSrc.match(/function runPostPlanActions[\s\S]*?^\}/m);
		expect(fnMatch).not.toBeNull();
		const body = fnMatch?.[0] ?? '';
		const exitPhaseIdx = body.indexOf('exitPhaseAfterPlan(');
		const advisoryIdx = body.indexOf('maybeEmitPlanSplitAdvisory(');
		expect(exitPhaseIdx).toBeGreaterThan(-1);
		expect(advisoryIdx).toBeGreaterThan(exitPhaseIdx);
	});

	test('the call site threads cwd, issueNumber, logEvent, and a notify closure', () => {
		const fnMatch = sidecarSrc.match(/function runPostPlanActions[\s\S]*?^\}/m);
		const body = fnMatch?.[0] ?? '';
		const callMatch = body.match(/maybeEmitPlanSplitAdvisory\(\{[\s\S]*?\n\t\}\);/);
		expect(callMatch).not.toBeNull();
		const call = callMatch?.[0] ?? '';
		expect(call).toContain('cwd: o.cwd');
		expect(call).toContain('issueNumber,');
		expect(call).toContain('logEvent: o.logEvent');
		expect(call).toContain('notify: makeNotifyOrchestrator(');
	});
});
