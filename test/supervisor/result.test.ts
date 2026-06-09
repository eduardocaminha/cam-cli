// test/supervisor/result.test.ts
//
// Unit tests for src/supervisor/result.ts (CAM-32 state-primary outcome).
//
// readWorkerOutcome derives the outcome from durable state (handoff.json +
// prd.json) PRIMARILY; the pane sentinel is corroboration, never a gate. This
// keeps a successful worker from being misreported when the pane dies (BUG 1)
// or the worker truncates before emitting the sentinel (BUG 2).

import { describe, expect, test } from 'bun:test';
import { readWorkerOutcome } from '../../src/supervisor/result.ts';
import type { FileReader } from '../../src/supervisor/result.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakePrd(storyId: string, passes: boolean): string {
	return JSON.stringify({ userStories: [{ id: storyId, title: `Story ${storyId}`, passes }] });
}

function fakeHandoff(storyId: string): string {
	return JSON.stringify({
		lastCompletedStory: { id: storyId, title: `Story ${storyId}` },
		branchName: 'cam/test-branch',
		timestamp: '2026-06-08T00:00:00Z',
	});
}

function makeReader(files: Record<string, string>): FileReader {
	return (path: string) => files[path] ?? null;
}

const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';

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
// pass
// ---------------------------------------------------------------------------

describe('readWorkerOutcome: pass', () => {
	test('sentinel DONE + handoff + prd passes:true', () => {
		const storyId = 'US-004';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({ [PRD_PATH]: fakePrd(storyId, true), [HANDOFF_PATH]: fakeHandoff(storyId) }),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
	});

	test('state-primary: NO sentinel but handoff + prd passes:true (BUG 1, pane died)', () => {
		const storyId = 'US-011';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: '', // pane died before capture: no sentinel
			readFile: makeReader({ [PRD_PATH]: fakePrd(storyId, true), [HANDOFF_PATH]: fakeHandoff(storyId) }),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('state-primary');
	});

	test('DONE sentinel missing story= resolves via handoff + prd passes:true', () => {
		const storyId = 'US-004';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: 'CAM_IMPLEMENTER_STATUS=DONE\n',
			readFile: makeReader({ [PRD_PATH]: fakePrd(storyId, true), [HANDOFF_PATH]: fakeHandoff(storyId) }),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
	});

	test('handoff missing but DONE sentinel + prd passes:true resolves via sentinel', () => {
		const storyId = 'US-004';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({ [PRD_PATH]: fakePrd(storyId, true) }), // no handoff
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
	});

	test('PRD_COMPLETE sentinel -> pass with undefined storyId', () => {
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
// incomplete (worker implemented the story but did not finalize, BUG 2)
// ---------------------------------------------------------------------------

describe('readWorkerOutcome: incomplete', () => {
	test('DONE + handoff but prd still passes:false -> incomplete', () => {
		const storyId = 'US-004';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({ [PRD_PATH]: fakePrd(storyId, false), [HANDOFF_PATH]: fakeHandoff(storyId) }),
		});
		expect(result.kind).toBe('incomplete');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('finalize');
	});

	test('NO sentinel + handoff but prd passes:false -> incomplete (the real CAM-32 case)', () => {
		const storyId = 'US-011';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: '', // worker truncated: no sentinel emitted
			readFile: makeReader({ [PRD_PATH]: fakePrd(storyId, false), [HANDOFF_PATH]: fakeHandoff(storyId) }),
		});
		expect(result.kind).toBe('incomplete');
		expect(result.storyId).toBe(storyId);
	});

	test('handoff story not present in prd userStories -> incomplete', () => {
		const storyId = 'US-004';
		const prdOther = JSON.stringify({ userStories: [{ id: 'US-999', title: 'Other', passes: true }] });
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({ [PRD_PATH]: prdOther, [HANDOFF_PATH]: fakeHandoff(storyId) }),
		});
		expect(result.kind).toBe('incomplete');
		expect(result.storyId).toBe(storyId);
	});
});

// ---------------------------------------------------------------------------
// fail
// ---------------------------------------------------------------------------

describe('readWorkerOutcome: fail', () => {
	test('sentinel story= mismatches handoff lastCompletedStory.id', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane('US-004'),
			readFile: makeReader({ [PRD_PATH]: fakePrd('US-004', true), [HANDOFF_PATH]: fakeHandoff('US-003') }),
		});
		expect(result.kind).toBe('fail');
		expect(result.detail).toContain('mismatch');
	});

	test('completed story known but prd.json unreadable -> fail', () => {
		const storyId = 'US-004';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({ [HANDOFF_PATH]: fakeHandoff(storyId) }), // no prd
		});
		expect(result.kind).toBe('fail');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('prd.json could not be read');
	});
});

// ---------------------------------------------------------------------------
// blocked
// ---------------------------------------------------------------------------

describe('readWorkerOutcome: blocked', () => {
	test('BLOCKED_OPERATOR_REQUIRED sentinel', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: blockedOpPane('US-010'),
			readFile: makeReader({}),
		});
		expect(result.kind).toBe('blocked');
		expect(result.detail).toContain('BLOCKED');
	});

	test('BLOCKED_QUALITY sentinel', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: blockedQualityPane(),
			readFile: makeReader({}),
		});
		expect(result.kind).toBe('blocked');
	});

	test('raw BLOCKED_ token without full sentinel', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: rawBlockedPane(),
			readFile: makeReader({}),
		});
		expect(result.kind).toBe('blocked');
		expect(result.storyId).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// unknown
// ---------------------------------------------------------------------------

describe('readWorkerOutcome: unknown', () => {
	test('empty pane + no handoff -> unknown', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: '',
			readFile: makeReader({}),
		});
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	test('pane noise, no sentinel, no handoff -> unknown', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: noSentinelPane(),
			readFile: makeReader({}),
		});
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
		expect(result.detail).toContain('No completed story');
	});
});
