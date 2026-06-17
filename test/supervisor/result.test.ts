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

	// CAM-35: the worker often emits the sentinel as prose wrapped in a markdown
	// code span. The trailing backtick must NOT be captured into the story id,
	// else it false-mismatches the clean handoff id and degrades a real pass to
	// fail. Regression for the dogfooding bug found on CAM-33.
	test('backtick-wrapped DONE sentinel does not spoof a story mismatch (CAM-35)', () => {
		const storyId = 'US-001';
		const pane = `Done.\n\`CAM_IMPLEMENTER_STATUS=DONE story=${storyId}\`\n`;
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: pane,
			readFile: makeReader({ [PRD_PATH]: fakePrd(storyId, true), [HANDOFF_PATH]: fakeHandoff(storyId) }),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
	});

	test('backtick-wrapped DONE preserves a review-round id US-RX-NNN (CAM-35)', () => {
		const storyId = 'US-R1-001';
		const pane = `Fixed the finding.\n\`CAM_IMPLEMENTER_STATUS=DONE story=${storyId}\`\n`;
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: pane,
			readFile: makeReader({ [PRD_PATH]: fakePrd(storyId, true), [HANDOFF_PATH]: fakeHandoff(storyId) }),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
	});

	test('backtick-wrapped PRD_COMPLETE still parses the status cleanly (CAM-35)', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: 'All stories pass.\n`CAM_IMPLEMENTER_STATUS=PRD_COMPLETE`\n',
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

	test('backtick-wrapped BLOCKED status still parses (CAM-35)', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText:
				'Stuck.\n`CAM_IMPLEMENTER_STATUS=BLOCKED_QUALITY story=US-007 reason=typecheck-failed`\n',
			readFile: makeReader({}),
		});
		expect(result.kind).toBe('blocked');
		expect(result.storyId).toBe('US-007');
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

// ---------------------------------------------------------------------------
// US-001: handoff lastCompletedStory is a bare string (handoff-string-coerced)
// ---------------------------------------------------------------------------

const WORKER_REPORT_PATH = '/fake/worker-report.json';

function fakeHandoffStringStory(storyId: string): string {
	return JSON.stringify({
		lastCompletedStory: storyId, // bare string, not {id, title}
		branchName: 'cam/test-branch',
		timestamp: '2026-06-17T00:00:00Z',
	});
}

function fakeWorkerReport(outcome: string, storyId: string): string {
	return JSON.stringify({
		outcome,
		story: storyId,
		gates: { typecheck: 'ok', tests: '5 pass / 0 fail' },
		notes: 'none',
	});
}

describe('readWorkerOutcome: handoff-string-coerced', () => {
	test('bare string lastCompletedStory + prd passes:true -> pass with handoff-string-coerced detail', () => {
		const storyId = 'US-001';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: '', // no sentinel: state-primary via coerced handoff
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, true),
				[HANDOFF_PATH]: fakeHandoffStringStory(storyId),
			}),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('handoff-string-coerced');
	});

	test('bare string lastCompletedStory + prd passes:false -> incomplete', () => {
		const storyId = 'US-001';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, false),
				[HANDOFF_PATH]: fakeHandoffStringStory(storyId),
			}),
		});
		expect(result.kind).toBe('incomplete');
		expect(result.storyId).toBe(storyId);
	});

	test('bare string lastCompletedStory + DONE sentinel corroborates -> sentinel DONE corroborates wins', () => {
		const storyId = 'US-005';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, true),
				[HANDOFF_PATH]: fakeHandoffStringStory(storyId),
			}),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
		// sentinel takes precedence over handoff-string-coerced in corroboration
		expect(result.detail).toContain('sentinel DONE corroborates');
	});
});

// ---------------------------------------------------------------------------
// US-001: worker-report.json fallback (worker-report-fallback)
// ---------------------------------------------------------------------------

describe('readWorkerOutcome: worker-report-fallback', () => {
	test('no handoff id, no DONE sentinel, worker-report DONE + prd passes:true -> pass', () => {
		const storyId = 'US-007';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH,
			capturedPaneText: '', // no sentinel (pane idle/truncated)
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, true),
				// no HANDOFF_PATH -> null
				[WORKER_REPORT_PATH]: fakeWorkerReport('DONE', storyId),
			}),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('worker-report-fallback');
	});

	test('no handoff id, no DONE sentinel, worker-report DONE + prd passes:false -> incomplete', () => {
		const storyId = 'US-007';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, false),
				[WORKER_REPORT_PATH]: fakeWorkerReport('DONE', storyId),
			}),
		});
		expect(result.kind).toBe('incomplete');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('worker-report-fallback');
	});

	test('no handoff id, no DONE sentinel, worker-report BLOCKED_ -> blocked with BLOCKED_ token in detail', () => {
		const storyId = 'US-007';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, false),
				[WORKER_REPORT_PATH]: fakeWorkerReport('BLOCKED_QUALITY', storyId),
			}),
		});
		expect(result.kind).toBe('blocked');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('BLOCKED_QUALITY');
		expect(result.detail).toContain('worker-report-fallback');
	});

	test('no handoff id, no DONE sentinel, no worker-report -> unknown (unchanged)', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH,
			capturedPaneText: '',
			readFile: makeReader({}), // no files at all
		});
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	test('workerReportPath absent -> unknown (no fallback attempted)', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			// workerReportPath not provided
			capturedPaneText: '',
			readFile: makeReader({
				// worker-report exists on disk but path not wired -> ignored
				[WORKER_REPORT_PATH]: fakeWorkerReport('DONE', 'US-007'),
			}),
		});
		expect(result.kind).toBe('unknown');
	});

	test('worker-report DONE + prd unreadable -> fail (worker-report-fallback)', () => {
		const storyId = 'US-007';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH,
			capturedPaneText: '',
			readFile: makeReader({
				// no prd, no handoff
				[WORKER_REPORT_PATH]: fakeWorkerReport('DONE', storyId),
			}),
		});
		expect(result.kind).toBe('fail');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('worker-report-fallback');
	});
});

// ---------------------------------------------------------------------------
// US-004: staleness guard — worker-report fallback only trusts a report whose
// story matches the expected dispatched story (expectedStoryId).
// ---------------------------------------------------------------------------

describe('readWorkerOutcome: staleness guard (US-004)', () => {
	test('DONE report + expectedStoryId matches -> fallback taken, pass (prd passes:true)', () => {
		const storyId = 'US-007';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH,
			expectedStoryId: storyId,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, true),
				[WORKER_REPORT_PATH]: fakeWorkerReport('DONE', storyId),
			}),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('worker-report-fallback');
	});

	test('DONE report + expectedStoryId MISMATCH -> fallback rejected -> unknown', () => {
		const dispatchedStory = 'US-007';
		const staleStory = 'US-005'; // leftover from a prior run
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH,
			expectedStoryId: dispatchedStory,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(staleStory, true),
				[WORKER_REPORT_PATH]: fakeWorkerReport('DONE', staleStory),
			}),
		});
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	test('BLOCKED_* report + expectedStoryId MISMATCH -> fallback rejected -> unknown', () => {
		const dispatchedStory = 'US-007';
		const staleStory = 'US-005';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH,
			expectedStoryId: dispatchedStory,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(staleStory, false),
				[WORKER_REPORT_PATH]: fakeWorkerReport('BLOCKED_QUALITY', staleStory),
			}),
		});
		// Stale BLOCKED_* must NOT produce kind:blocked for the dispatched story
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	test('expectedStoryId undefined + DONE report -> fallback used (graceful degradation, US-001 behavior)', () => {
		const storyId = 'US-007';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH,
			// expectedStoryId NOT provided
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, true),
				[WORKER_REPORT_PATH]: fakeWorkerReport('DONE', storyId),
			}),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('worker-report-fallback');
	});

	test('expectedStoryId undefined + BLOCKED_* report -> fallback used, kind:blocked (graceful degradation)', () => {
		const storyId = 'US-007';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH,
			// expectedStoryId NOT provided
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(storyId, false),
				[WORKER_REPORT_PATH]: fakeWorkerReport('BLOCKED_QUALITY', storyId),
			}),
		});
		expect(result.kind).toBe('blocked');
		expect(result.storyId).toBe(storyId);
		expect(result.detail).toContain('BLOCKED_QUALITY');
		expect(result.detail).toContain('worker-report-fallback');
	});
});

// ---------------------------------------------------------------------------
// CAM-42 / US-002: TUI prompt-echo must never match a sentinel
// ---------------------------------------------------------------------------
//
// In interactive (TUI) dispatch the worker pane echoes the initial task
// prompt. If that echo matched parseAnySentinel, the poll loop would declare
// completion the instant the worker STARTS. These fixtures pin the production
// prompt wording (and the documented cam-next.md variant that names the
// sentinel) as non-matching.

describe('parseAnySentinel prompt-echo regression (CAM-42 US-002)', () => {
	test('DEFAULT_TASK_PROMPT echo does not match any sentinel', async () => {
		const { DEFAULT_TASK_PROMPT } = await import('../../src/commands/next.ts');
		const { parseAnySentinel } = await import('../../src/supervisor/result.ts');
		expect(parseAnySentinel(DEFAULT_TASK_PROMPT)).toBeNull();
	});

	test('documented prompt wording naming CAM_IMPLEMENTER_STATUS= (no value) does not match', async () => {
		const { parseAnySentinel } = await import('../../src/supervisor/result.ts');
		const echo = [
			'Implement the next user story from scripts/cam/prd.json per your AGENT.md.',
			'Branch: cam/CAM-42-interactive-workers',
			'Return with one of the CAM_IMPLEMENTER_STATUS= lines on your last line.',
		].join('\n');
		expect(parseAnySentinel(echo)).toBeNull();
	});

	test('a real sentinel line still matches after the prompt echo', async () => {
		const { parseAnySentinel } = await import('../../src/supervisor/result.ts');
		const pane = [
			'Return with one of the CAM_IMPLEMENTER_STATUS= lines on your last line.',
			'...work happens...',
			'CAM_IMPLEMENTER_STATUS=DONE story=US-001',
		].join('\n');
		const match = parseAnySentinel(pane);
		expect(match).not.toBeNull();
		expect(match?.source).toBe('implementer');
	});
});
