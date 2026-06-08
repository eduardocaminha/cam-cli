// test/supervisor/result.test.ts
//
// Unit tests for src/supervisor/result.ts.
//
// Coverage (all four outcome kinds):
//   - pass: sentinel DONE + handoff matches + prd passes:true
//   - fail: sentinel DONE but prd still passes:false
//   - fail: sentinel DONE but handoff/sentinel storyId mismatch
//   - fail: sentinel DONE but sentinel missing story= field
//   - fail: sentinel DONE but handoff missing lastCompletedStory.id
//   - fail: sentinel DONE but prd.json unreadable
//   - blocked: BLOCKED_OPERATOR_REQUIRED sentinel
//   - blocked: BLOCKED_QUALITY sentinel with reason=
//   - blocked: raw BLOCKED_ token without full sentinel
//   - pass: PRD_COMPLETE sentinel
//   - unknown: empty pane text (no signals)
//   - unknown: pane text with noise but no sentinel

import { describe, expect, test } from 'bun:test';
import { readWorkerOutcome } from '../../src/supervisor/result.ts';
import type { FileReader, WorkerOutcome } from '../../src/supervisor/result.ts';

// ---------------------------------------------------------------------------
// Fake fixture helpers
// ---------------------------------------------------------------------------

/** Minimal prd.json fixture with one story. */
function fakePrd(storyId: string, passes: boolean): string {
	return JSON.stringify({
		userStories: [
			{
				id: storyId,
				title: `Story ${storyId}`,
				passes,
			},
		],
	});
}

/** Minimal handoff.json fixture. */
function fakeHandoff(storyId: string): string {
	return JSON.stringify({
		lastCompletedStory: { id: storyId, title: `Story ${storyId}` },
		branchName: 'cam/test-branch',
		timestamp: '2026-06-08T00:00:00Z',
	});
}

/** FileReader that serves fake content for known paths, null for others. */
function makeReader(files: Record<string, string>): FileReader {
	return (path: string) => files[path] ?? null;
}

const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';

// Pane text sentinels
function donePane(storyId: string): string {
	return `Some implementer output here\nCAM_IMPLEMENTER_STATUS=DONE story=${storyId}\n`;
}

function blockedOpPane(storyId: string): string {
	return `Some output\nCAM_IMPLEMENTER_STATUS=BLOCKED_OPERATOR_REQUIRED story=${storyId} reason=needs-human\n`;
}

function blockedQualityPane(): string {
	return `Some output\nCAM_IMPLEMENTER_STATUS=BLOCKED_QUALITY story=US-007 reason=typecheck-failed\n`;
}

function prdCompletePane(): string {
	return `All stories pass.\nCAM_IMPLEMENTER_STATUS=PRD_COMPLETE\n`;
}

function noSentinelPane(): string {
	return `Worker started.\nDoing some work.\nProcess exited with code 0.\n`;
}

function rawBlockedPane(): string {
	return `Something went wrong.\nBLOCKED_QUALITY detected in output.\n`;
}

// ---------------------------------------------------------------------------
// Tests: pass outcome
// ---------------------------------------------------------------------------

describe('readWorkerOutcome: pass', () => {
	test('returns pass when sentinel DONE + handoff matches + prd passes:true', () => {
		const storyId = 'US-004';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, true),
				[HANDOFF_PATH]: fakeHandoff(storyId),
			}),
		});

		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain(storyId);
	});

	test('returns pass with undefined storyId for PRD_COMPLETE sentinel', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: prdCompletePane(),
			readFile: makeReader({}),
		});

		expect(result.kind).toBe('pass');
		expect(result.storyId).toBeUndefined();
		expect(result.detail).toContain('PRD_COMPLETE');
	});
});

// ---------------------------------------------------------------------------
// Tests: fail outcome
// ---------------------------------------------------------------------------

describe('readWorkerOutcome: fail', () => {
	test('returns fail when prd still shows passes:false after DONE sentinel', () => {
		const storyId = 'US-004';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, false),
				[HANDOFF_PATH]: fakeHandoff(storyId),
			}),
		});

		expect(result.kind).toBe('fail');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('passes:false');
	});

	test('returns fail when sentinel story= does not match handoff lastCompletedStory.id', () => {
		const sentinelStoryId = 'US-004';
		const handoffStoryId = 'US-003'; // mismatch
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(sentinelStoryId),
			readFile: makeReader({
				[PRD_PATH]: fakePrd(sentinelStoryId, true),
				[HANDOFF_PATH]: fakeHandoff(handoffStoryId),
			}),
		});

		expect(result.kind).toBe('fail');
		expect(result.storyId).toBe(sentinelStoryId);
		expect(result.detail).toContain('mismatch');
	});

	test('returns fail when DONE sentinel missing story= field', () => {
		const paneText = 'CAM_IMPLEMENTER_STATUS=DONE\n'; // no story= part
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: paneText,
			readFile: makeReader({
				[PRD_PATH]: fakePrd('US-004', true),
				[HANDOFF_PATH]: fakeHandoff('US-004'),
			}),
		});

		expect(result.kind).toBe('fail');
		expect(result.detail).toContain('missing story= field');
	});

	test('returns fail when handoff.json is missing and sentinel is DONE', () => {
		const storyId = 'US-004';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, true),
				// HANDOFF_PATH not in files map -> null
			}),
		});

		expect(result.kind).toBe('fail');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('handoff.json has no lastCompletedStory.id');
	});

	test('returns fail when handoff.json has no lastCompletedStory', () => {
		const storyId = 'US-004';
		const handoffNoStory = JSON.stringify({
			branchName: 'cam/test',
			timestamp: '2026-06-08T00:00:00Z',
		});
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, true),
				[HANDOFF_PATH]: handoffNoStory,
			}),
		});

		expect(result.kind).toBe('fail');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('handoff.json has no lastCompletedStory.id');
	});

	test('returns fail when prd.json cannot be read', () => {
		const storyId = 'US-004';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({
				// PRD_PATH not in files map -> null
				[HANDOFF_PATH]: fakeHandoff(storyId),
			}),
		});

		expect(result.kind).toBe('fail');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('prd.json could not be read');
	});

	test('returns fail when story id not found in prd userStories', () => {
		const storyId = 'US-004';
		// prd has a different story id
		const prdDifferentStory = JSON.stringify({
			userStories: [{ id: 'US-999', title: 'Other', passes: true }],
		});
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({
				[PRD_PATH]: prdDifferentStory,
				[HANDOFF_PATH]: fakeHandoff(storyId),
			}),
		});

		expect(result.kind).toBe('fail');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('passes:false');
	});
});

// ---------------------------------------------------------------------------
// Tests: blocked outcome
// ---------------------------------------------------------------------------

describe('readWorkerOutcome: blocked', () => {
	test('returns blocked for BLOCKED_OPERATOR_REQUIRED sentinel', () => {
		const storyId = 'US-010';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: blockedOpPane(storyId),
			readFile: makeReader({}),
		});

		expect(result.kind).toBe('blocked');
		expect(result.detail).toContain('BLOCKED');
	});

	test('returns blocked for BLOCKED_QUALITY sentinel', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: blockedQualityPane(),
			readFile: makeReader({}),
		});

		expect(result.kind).toBe('blocked');
		expect(result.detail).toContain('BLOCKED');
	});

	test('returns blocked when pane has raw BLOCKED_ token without full sentinel', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: rawBlockedPane(),
			readFile: makeReader({}),
		});

		expect(result.kind).toBe('blocked');
		expect(result.storyId).toBeUndefined();
		expect(result.detail).toContain('BLOCKED');
	});
});

// ---------------------------------------------------------------------------
// Tests: unknown outcome
// ---------------------------------------------------------------------------

describe('readWorkerOutcome: unknown', () => {
	test('returns unknown when pane text is empty', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: '',
			readFile: makeReader({}),
		});

		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	test('returns unknown when pane has noise but no sentinel', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: noSentinelPane(),
			readFile: makeReader({}),
		});

		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
		expect(result.detail).toContain('No CAM_IMPLEMENTER_STATUS sentinel');
	});
});
