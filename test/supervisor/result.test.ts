// test/supervisor/result.test.ts
//
// Unit tests for src/supervisor/result.ts (US-001: worker-report.json primary).
//
// readWorkerOutcome derives the outcome from worker-report.json (the EVENT,
// authoritative) when workerReportPath is provided and the file is valid.
// handoff.json and the CAM_IMPLEMENTER_STATUS sentinel are no longer outcome
// gates (US-001). For backward compat, when no valid report is present the
// function falls back to sentinel + handoff.json (state-primary).

import { describe, expect, test } from 'bun:test';
import { commitSubjectMatchesStory, readWorkerOutcome } from '../../src/supervisor/result.ts';
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

function fakePrdWithRequires(storyId: string, passes: boolean, requires: string | null): string {
	return JSON.stringify({
		userStories: [{ id: storyId, title: `Story ${storyId}`, passes, requires }],
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
	// US-001: The DONE-sentinel-vs-handoff mismatch->fail block was removed.
	// When sentinel names a different story than handoff (and no report is
	// present), handoff wins for story selection without raising a fail.
	// In this fixture prd only has US-004; handoff says US-003 (not in prd),
	// so the result is 'incomplete' (handoff set, prd not confirmed for US-003).
	test('sentinel story= mismatches handoff -> handoff wins, incomplete (mismatch block dropped, US-001)', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane('US-004'),
			readFile: makeReader({ [PRD_PATH]: fakePrd('US-004', true), [HANDOFF_PATH]: fakeHandoff('US-003') }),
		});
		// handoff says US-003; prd has US-004 (not US-003), so passes:false for US-003.
		expect(result.kind).toBe('incomplete');
		expect(result.storyId).toBe('US-003');
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
// US-001: worker-report.json PRIMARY behavioral contract
//
// When workerReportPath is provided and a valid report is present:
//   AC1 - report.story is the primary story signal (wins over handoff)
//   AC3 - stale/absent handoff.json does not change the named story
//   AC4 - a DONE sentinel that disagrees with the report is not a gate
// ---------------------------------------------------------------------------

const WORKER_REPORT_PATH_AC = '/fake/worker-report.json';

describe('readWorkerOutcome: US-001 report-primary contract', () => {
	// AC1: report naming story B wins over handoff naming story A.
	test('AC1: report.story B wins over handoff story A -> storyId = B', () => {
		const reportStory = 'US-007';
		const handoffStory = 'US-001';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH_AC,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(reportStory, true),
				[HANDOFF_PATH]: fakeHandoff(handoffStory), // handoff says a DIFFERENT story
				[WORKER_REPORT_PATH_AC]: fakeWorkerReport('DONE', reportStory),
			}),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(reportStory); // report wins, not handoff
	});

	// AC3: stale handoff (different story) does not affect result when report is present.
	test('AC3: stale handoff does not change named story when report is valid', () => {
		const reportStory = 'US-007';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH_AC,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(reportStory, true),
				// No handoff file at all
				[WORKER_REPORT_PATH_AC]: fakeWorkerReport('DONE', reportStory),
			}),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(reportStory);
	});

	// AC4: a DONE sentinel naming a different story than the report does not
	// produce a fail-on-mismatch; the report wins.
	test('AC4: DONE sentinel disagrees with report -> report wins, no fail', () => {
		const reportStory = 'US-007';
		const sentinelStory = 'US-006'; // sentinel says different story
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH_AC,
			capturedPaneText: donePane(sentinelStory),
			readFile: makeReader({
				[PRD_PATH]: fakePrd(reportStory, true),
				[WORKER_REPORT_PATH_AC]: fakeWorkerReport('DONE', reportStory),
			}),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(reportStory); // report wins
		// Must NOT be 'fail' due to the sentinel-vs-report disagreement.
	});

	// AC4 + AC2 combined: DONE report + passes:false -> incomplete (integrity check),
	// regardless of what the sentinel says.
	test('AC2: DONE report + prd passes:false -> incomplete (integrity check)', () => {
		const reportStory = 'US-007';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH_AC,
			capturedPaneText: donePane(reportStory),
			readFile: makeReader({
				[PRD_PATH]: fakePrd(reportStory, false), // passes:false
				[WORKER_REPORT_PATH_AC]: fakeWorkerReport('DONE', reportStory),
			}),
		});
		expect(result.kind).toBe('incomplete');
		expect(result.storyId).toBe(reportStory);
		expect(result.detail).toContain('finalize');
	});

	// AC5: BLOCKED from report -> kind 'blocked', storyId from report.
	test('AC5: BLOCKED_QUALITY from report -> blocked (not from sentinel)', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH_AC,
			capturedPaneText: '', // no sentinel
			readFile: makeReader({
				[WORKER_REPORT_PATH_AC]: fakeWorkerReport('BLOCKED_QUALITY', 'US-007'),
			}),
		});
		expect(result.kind).toBe('blocked');
		expect(result.storyId).toBe('US-007');
	});

	// AC5: PRD_COMPLETE from report -> pass, storyId undefined.
	test('AC5: PRD_COMPLETE from report -> pass, storyId undefined', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: WORKER_REPORT_PATH_AC,
			capturedPaneText: '',
			readFile: makeReader({
				[WORKER_REPORT_PATH_AC]: JSON.stringify({
					outcome: 'PRD_COMPLETE',
					story: 'none',
					gates: { typecheck: 'ok', tests: 'n/a' },
					notes: 'none',
				}),
			}),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// US-001: worker-report.json primary path (formerly "fallback")
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
// US-004: regression — report-first authority order
//
// These four tests pin the new authority contract from US-001 so that a
// future refactor that accidentally restores the old handoff-authoritative or
// sentinel-gate behavior will fail immediately at this named regression suite.
//
// Rules being pinned:
//   R1 (report-wins-over-handoff): when workerReportPath is provided and the
//      report is valid, report.story drives storyId — handoff is inert.
//   R2 (sentinel-non-override): a divergent DONE sentinel in the pane text
//      does NOT override the report and does NOT trigger a fail-on-mismatch.
//   R3 (DONE+passes:false->incomplete): a DONE report whose story is
//      passes:false in prd.json yields kind 'incomplete', never 'pass'.
//   R4 (DONE+passes:true->pass): a DONE report whose story is passes:true
//      yields kind 'pass' with that storyId.
// ---------------------------------------------------------------------------

const REG_REPORT_PATH = '/reg/worker-report.json';

describe('US-004: regression - report-first authority order', () => {
	// R1: report wins over handoff (handoff is inert when a valid report is present)
	test('R1: report.story wins over divergent handoff story - storyId must equal report.story', () => {
		const reportStory = 'US-R1-REPORT';
		const handoffStory = 'US-R1-HANDOFF'; // different story in handoff

		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: REG_REPORT_PATH,
			capturedPaneText: '', // no sentinel
			readFile: makeReader({
				[PRD_PATH]: fakePrd(reportStory, true),
				[HANDOFF_PATH]: fakeHandoff(handoffStory), // handoff names a DIFFERENT story
				[REG_REPORT_PATH]: fakeWorkerReport('DONE', reportStory),
			}),
		});

		// Report wins: outcome is determined by report.story, not handoff.
		expect(result.storyId).toBe(reportStory);
		expect(result.kind).toBe('pass');
	});

	// R1 variant: absent handoff does not change the named story either.
	test('R1-absent: absent handoff does not change storyId when report is present', () => {
		const reportStory = 'US-R1-ABSENT';

		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: REG_REPORT_PATH,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(reportStory, true),
				// HANDOFF_PATH absent (not in reader map)
				[REG_REPORT_PATH]: fakeWorkerReport('DONE', reportStory),
			}),
		});

		expect(result.storyId).toBe(reportStory);
		expect(result.kind).toBe('pass');
	});

	// R2: divergent sentinel does NOT override the report and must NOT produce fail-on-mismatch.
	test('R2: divergent DONE sentinel in pane text must not override report and must not fail', () => {
		const reportStory = 'US-R2-REPORT';
		const sentinelStory = 'US-R2-SENTINEL'; // sentinel names a completely different story

		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: REG_REPORT_PATH,
			capturedPaneText: donePane(sentinelStory), // DONE sentinel with wrong story
			readFile: makeReader({
				[PRD_PATH]: fakePrd(reportStory, true),
				[REG_REPORT_PATH]: fakeWorkerReport('DONE', reportStory),
			}),
		});

		// Report wins. Must NOT be 'fail' (no fail-on-mismatch).
		expect(result.storyId).toBe(reportStory);
		expect(result.kind).toBe('pass');
		expect(result.kind).not.toBe('fail');
	});

	// R3: DONE report + prd passes:false must yield 'incomplete', NEVER 'pass'.
	test('R3: DONE report + prd passes:false must yield incomplete, never pass', () => {
		const reportStory = 'US-R3-INCOMPLETE';

		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: REG_REPORT_PATH,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(reportStory, false), // passes:false - story NOT flipped
				[REG_REPORT_PATH]: fakeWorkerReport('DONE', reportStory),
			}),
		});

		expect(result.kind).toBe('incomplete');
		expect(result.kind).not.toBe('pass');
		expect(result.storyId).toBe(reportStory);
		expect(result.detail).toContain('finalize');
	});

	// R4: DONE report + prd passes:true must yield 'pass' with that storyId.
	test('R4: DONE report + prd passes:true must yield pass with storyId', () => {
		const reportStory = 'US-R4-PASS';

		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: REG_REPORT_PATH,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(reportStory, true), // passes:true
				[REG_REPORT_PATH]: fakeWorkerReport('DONE', reportStory),
			}),
		});

		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(reportStory);
	});
});

// ---------------------------------------------------------------------------
// US-006: absent / malformed / stale report falls safely to failure nets
//
// AC1: staleness guard on PRIMARY path — a report whose story != expectedStoryId
//      is rejected and yields no pass or blocked outcome (falls to 'unknown').
// AC2: absent or malformed (unparseable / wrong-shape / missing discriminators)
//      report yields 'unknown' (non-committal), keeping pane-died/timeout nets
//      as the terminal signal; no false 'pass'.
// AC3: stale report (clearWorkerReport failed / crash-after-write) does not
//      finalize: integrity check + staleness guard together prevent false-pass.
// ---------------------------------------------------------------------------

const US006_REPORT_PATH = '/us006/worker-report.json';

describe('readWorkerOutcome: US-006 absent / malformed / stale report safety nets', () => {
	// AC2: absent report with workerReportPath provided -> 'unknown'
	test('AC2: absent report file (null from readFile) with workerReportPath -> unknown', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: US006_REPORT_PATH,
			expectedStoryId: 'US-010',
			capturedPaneText: '',
			readFile: makeReader({}), // no files -> readFile returns null for all paths
		});
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	// AC2: malformed JSON -> 'unknown'
	test('AC2: malformed JSON report -> unknown (JSON.parse fails)', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: US006_REPORT_PATH,
			expectedStoryId: 'US-010',
			capturedPaneText: '',
			readFile: makeReader({ [US006_REPORT_PATH]: '{ not valid json !!!' }),
		});
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	// AC2: wrong-shape report (empty object, no story/outcome) -> 'unknown'
	test('AC2: wrong-shape report (empty object {}) -> unknown', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: US006_REPORT_PATH,
			expectedStoryId: 'US-010',
			capturedPaneText: '',
			readFile: makeReader({ [US006_REPORT_PATH]: '{}' }),
		});
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	// AC2: report has outcome but no story -> 'unknown'
	test('AC2: report missing story discriminator -> unknown', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: US006_REPORT_PATH,
			expectedStoryId: 'US-010',
			capturedPaneText: '',
			readFile: makeReader({
				[US006_REPORT_PATH]: JSON.stringify({
					outcome: 'DONE',
					// story field absent
					gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
					notes: 'none',
				}),
			}),
		});
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	// AC2: report has story but no outcome -> 'unknown'
	test('AC2: report missing outcome discriminator -> unknown', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: US006_REPORT_PATH,
			expectedStoryId: 'US-010',
			capturedPaneText: '',
			readFile: makeReader({
				[US006_REPORT_PATH]: JSON.stringify({
					// outcome field absent
					story: 'US-010',
					gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
					notes: 'none',
				}),
			}),
		});
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	// AC2: top-level JSON array -> 'unknown'
	test('AC2: top-level JSON array report -> unknown', () => {
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: US006_REPORT_PATH,
			expectedStoryId: 'US-010',
			capturedPaneText: '',
			readFile: makeReader({ [US006_REPORT_PATH]: '[{"outcome":"DONE","story":"US-010"}]' }),
		});
		// isObject([...]) = false -> report null -> unknown
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	// AC1: staleness guard on PRIMARY path: stale DONE report -> unknown (no pass)
	test('AC1: stale DONE report (story != expectedStoryId) -> unknown, no pass', () => {
		const dispatchedStory = 'US-010';
		const staleStory = 'US-005';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: US006_REPORT_PATH,
			expectedStoryId: dispatchedStory,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(staleStory, true), // stale story passes in prd
				[US006_REPORT_PATH]: fakeWorkerReport('DONE', staleStory), // stale story in report
			}),
		});
		// The stale report must not produce a pass even though prd.passes=true for stale story.
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	// AC1: staleness guard on PRIMARY path: stale BLOCKED report -> unknown (no blocked from stale)
	test('AC1: stale BLOCKED report (story != expectedStoryId) -> unknown, not blocked', () => {
		const dispatchedStory = 'US-010';
		const staleStory = 'US-005';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: US006_REPORT_PATH,
			expectedStoryId: dispatchedStory,
			capturedPaneText: '',
			readFile: makeReader({
				[US006_REPORT_PATH]: fakeWorkerReport('BLOCKED_QUALITY', staleStory),
			}),
		});
		// Stale BLOCKED must not produce kind:'blocked' from the report alone.
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	// AC3: stale report (crashAfterWrite scenario) + prd.passes=true for stale story
	// -> no false-pass: integrity + staleness guard together prevent it.
	test('AC3: crash-after-write stale report does not finalize story (no false pass)', () => {
		const dispatchedStory = 'US-010'; // what the supervisor dispatched
		const staleStory = 'US-005'; // what the worker wrote before crashing

		// Worst case: prd shows passes:true for the stale story (it was done previously)
		// and the stale report claims DONE for it. This must still not produce a pass
		// for the dispatched story.
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: US006_REPORT_PATH,
			expectedStoryId: dispatchedStory,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(staleStory, true), // stale story already confirmed
				[US006_REPORT_PATH]: fakeWorkerReport('DONE', staleStory), // stale report
			}),
		});

		// Neither a pass for the stale story, nor a pass for the dispatched story.
		expect(result.kind).toBe('unknown');
		expect(result.storyId).toBeUndefined();
	});

	// AC1/AC3: fresh report for the CORRECT story is still accepted (regression guard).
	test('AC1/AC3: fresh report (story == expectedStoryId) + prd passes:true -> pass', () => {
		const dispatchedStory = 'US-010';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: US006_REPORT_PATH,
			expectedStoryId: dispatchedStory,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrd(dispatchedStory, true),
				[US006_REPORT_PATH]: fakeWorkerReport('DONE', dispatchedStory),
			}),
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(dispatchedStory);
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
	test('sidecar worker prompt echo does not match any sentinel', async () => {
		const { parseAnySentinel } = await import('../../src/supervisor/result.ts');
		// The sidecar injects this literal prompt to the implementer worker (host.ts:229).
		// Keeping it as a literal ensures the regression stays valid even though
		// DEFAULT_TASK_PROMPT is no longer exported from next.ts (US-001, CAM-78).
		const workerPrompt =
			'Implement the next user story from scripts/cam/prd.json per your AGENT.md.';
		expect(parseAnySentinel(workerPrompt)).toBeNull();
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

// ---------------------------------------------------------------------------
// US-001 (CAM-187): commit-existence gate
// ---------------------------------------------------------------------------
//
// readWorkerOutcome accepts an optional commitExistsForStory(storyId) callback
// and consults it before confirming a passes:true story as kind:'pass'. This
// covers both readWorkerOutcome resolution paths: the worker-report primary
// path (workerReportPath provided, report.outcome === 'DONE') and the
// handoff/sentinel fallback path (no workerReportPath, resolved via handoff).

const CG_REPORT_PATH = '/cg/worker-report.json';

describe('readWorkerOutcome: commit-existence gate (US-001, CAM-187)', () => {
	test('AC2 (worker-report path): passes:true but commitExistsForStory=false, requires=null -> NOT pass', () => {
		const storyId = 'US-020';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: CG_REPORT_PATH,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrdWithRequires(storyId, true, null),
				[CG_REPORT_PATH]: fakeWorkerReport('DONE', storyId),
			}),
			commitExistsForStory: () => false,
		});
		expect(result.kind).not.toBe('pass');
		expect(result.kind).toBe('no-commit');
		expect(result.storyId).toBe(storyId);
	});

	test('AC2 (fallback path): passes:true but commitExistsForStory=false, requires=null -> NOT pass', () => {
		const storyId = 'US-021';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({
				[PRD_PATH]: fakePrdWithRequires(storyId, true, null),
				[HANDOFF_PATH]: fakeHandoff(storyId),
			}),
			commitExistsForStory: () => false,
		});
		expect(result.kind).not.toBe('pass');
		expect(result.kind).toBe('no-commit');
		expect(result.storyId).toBe(storyId);
	});

	test('AC3 (worker-report path): passes:true and commitExistsForStory=true -> pass', () => {
		const storyId = 'US-022';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: CG_REPORT_PATH,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrdWithRequires(storyId, true, null),
				[CG_REPORT_PATH]: fakeWorkerReport('DONE', storyId),
			}),
			commitExistsForStory: () => true,
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
	});

	test('AC3 (fallback path): passes:true and commitExistsForStory=true -> pass', () => {
		const storyId = 'US-023';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({
				[PRD_PATH]: fakePrdWithRequires(storyId, true, null),
				[HANDOFF_PATH]: fakeHandoff(storyId),
			}),
			commitExistsForStory: () => true,
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
	});

	test('AC4: requires:"operator" story resolves to pass even when commitExistsForStory=false', () => {
		const storyId = 'US-024';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({
				[PRD_PATH]: fakePrdWithRequires(storyId, true, 'operator'),
				[HANDOFF_PATH]: fakeHandoff(storyId),
			}),
			commitExistsForStory: () => false,
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
	});

	test('AC4 (worker-report path): requires:"operator" story resolves to pass even when commitExistsForStory=false', () => {
		const storyId = 'US-025';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: CG_REPORT_PATH,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrdWithRequires(storyId, true, 'operator'),
				[CG_REPORT_PATH]: fakeWorkerReport('DONE', storyId),
			}),
			commitExistsForStory: () => false,
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
	});

	test('AC5: commitExistsForStory undefined -> no gate applied, behaves as before (worker-report path)', () => {
		const storyId = 'US-026';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			workerReportPath: CG_REPORT_PATH,
			capturedPaneText: '',
			readFile: makeReader({
				[PRD_PATH]: fakePrdWithRequires(storyId, true, null),
				[CG_REPORT_PATH]: fakeWorkerReport('DONE', storyId),
			}),
			// commitExistsForStory intentionally omitted
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
	});

	test('AC5: commitExistsForStory undefined -> no gate applied, behaves as before (fallback path)', () => {
		const storyId = 'US-027';
		const result = readWorkerOutcome({
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			capturedPaneText: donePane(storyId),
			readFile: makeReader({
				[PRD_PATH]: fakePrdWithRequires(storyId, true, null),
				[HANDOFF_PATH]: fakeHandoff(storyId),
			}),
			// commitExistsForStory intentionally omitted
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
	});
});

// ---------------------------------------------------------------------------
// US-001 (CAM-187): commitSubjectMatchesStory pure matcher
// ---------------------------------------------------------------------------

describe('commitSubjectMatchesStory (US-001, CAM-187)', () => {
	test('matches the standard feat convention', () => {
		expect(commitSubjectMatchesStory('feat: US-001 - Add commit-existence gate', 'US-001')).toBe(true);
	});

	test('matches a review-fix id with internal hyphens (US-R1-003)', () => {
		expect(commitSubjectMatchesStory('feat: US-R1-003 - Correct the offending edge case', 'US-R1-003')).toBe(
			true,
		);
	});

	test('tolerates extra whitespace around the separators', () => {
		expect(commitSubjectMatchesStory('feat:   US-002   -   Title here', 'US-002')).toBe(true);
	});

	test('rejects a subject that only mentions the id incidentally (wrong prefix)', () => {
		expect(commitSubjectMatchesStory('chore: mention US-001 in the README', 'US-001')).toBe(false);
	});

	test('rejects a subject that mentions the id after other words following feat:', () => {
		expect(commitSubjectMatchesStory('feat: implement US-001 - Title', 'US-001')).toBe(false);
	});

	test('rejects a longer id that shares this id as a prefix (US-0010 vs US-001)', () => {
		expect(commitSubjectMatchesStory('feat: US-0010 - Some other story', 'US-001')).toBe(false);
	});

	test('rejects a subject naming a different story, even if this story is mentioned in the title', () => {
		expect(commitSubjectMatchesStory('feat: US-002 - Fix reference to US-001', 'US-001')).toBe(false);
	});

	test('rejects a bare fix: prefix (not the feat: completion convention)', () => {
		expect(commitSubjectMatchesStory('fix: US-001 - correct an edge case', 'US-001')).toBe(false);
	});
});
