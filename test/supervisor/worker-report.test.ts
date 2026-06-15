// test/supervisor/worker-report.test.ts
//
// Unit tests for src/supervisor/worker-report.ts (US-003).
//
// Coverage:
//   1. WORKER_REPORT_FILENAME is the expected path.
//   2. formatWorkerReportSummary renders one-liners for DONE and BLOCKED cases.
//   3. buildWorkerReportSendKeysArgv produces the correct argv shape:
//        tmux -L cam send-keys -t <pane> <summary> Enter
//      NO -l (it would make Enter literal), Enter as a separate trailing key, one atomic call.
//   4. Metacharacter safety: a payload containing {, }, ", and ; is kept verbatim
//      in the argv as a single element (NO -l: tmux sends a single non-key arg literally).

import { describe, expect, test } from 'bun:test';
import {
	type WorkerReport,
	WORKER_REPORT_FILENAME,
	formatWorkerReportSummary,
	buildWorkerReportSendKeysArgv,
} from '../../src/supervisor/worker-report.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('WORKER_REPORT_FILENAME', () => {
	test('is scripts/cam/worker-report.json', () => {
		expect(WORKER_REPORT_FILENAME).toBe('scripts/cam/worker-report.json');
	});
});

// ---------------------------------------------------------------------------
// formatWorkerReportSummary
// ---------------------------------------------------------------------------

describe('formatWorkerReportSummary', () => {
	test('renders expected one-liner for DONE outcome', () => {
		const report: WorkerReport = {
			outcome: 'DONE',
			story: 'US-003',
			gates: { typecheck: 'ok', tests: '42 pass / 0 fail' },
			notes: 'none',
		};
		expect(formatWorkerReportSummary(report)).toBe(
			'[cam] US-003 DONE: typecheck ok, 42 pass / 0 fail',
		);
	});

	test('renders one-liner for BLOCKED_QUALITY outcome', () => {
		const report: WorkerReport = {
			outcome: 'BLOCKED_QUALITY',
			story: 'US-005',
			gates: { typecheck: 'fail: 3 errors', tests: '10 pass / 2 fail' },
			notes: 'tsc errors in new module',
		};
		expect(formatWorkerReportSummary(report)).toBe(
			'[cam] US-005 BLOCKED_QUALITY: typecheck fail: 3 errors, 10 pass / 2 fail',
		);
	});

	test('renders one-liner for PRD_COMPLETE (no story)', () => {
		const report: WorkerReport = {
			outcome: 'PRD_COMPLETE',
			story: 'none',
			gates: { typecheck: 'n/a', tests: 'n/a' },
			notes: 'no stories to implement',
		};
		expect(formatWorkerReportSummary(report)).toBe(
			'[cam] none PRD_COMPLETE: typecheck n/a, n/a',
		);
	});
});

// ---------------------------------------------------------------------------
// buildWorkerReportSendKeysArgv
// ---------------------------------------------------------------------------

describe('buildWorkerReportSendKeysArgv', () => {
	const ORCH_PANE = '%0';
	const SUMMARY = '[cam] US-003 DONE: typecheck ok, 5 pass / 0 fail';

	test('argv has exactly 7 elements (no -l)', () => {
		const argv = buildWorkerReportSendKeysArgv(ORCH_PANE, SUMMARY);
		expect(argv).toHaveLength(7);
	});

	test('starts with -L cam send-keys', () => {
		const argv = buildWorkerReportSendKeysArgv(ORCH_PANE, SUMMARY);
		expect(argv[0]).toBe('-L');
		expect(argv[1]).toBe('cam');
		expect(argv[2]).toBe('send-keys');
	});

	test('-t <orchPane> is at positions 3 and 4', () => {
		const argv = buildWorkerReportSendKeysArgv(ORCH_PANE, SUMMARY);
		expect(argv[3]).toBe('-t');
		expect(argv[4]).toBe(ORCH_PANE);
	});

	test('does NOT use -l (regression: -l would make "Enter" literal and never submit)', () => {
		// memory: sendkeys-literal-enter-gotcha. `-l` makes EVERY arg literal, so
		// "Enter" would be typed as the text "Enter" and the summary never submits.
		const argv = buildWorkerReportSendKeysArgv(ORCH_PANE, SUMMARY);
		expect(argv).not.toContain('-l');
	});

	test('summary is at position 5, verbatim', () => {
		const argv = buildWorkerReportSendKeysArgv(ORCH_PANE, SUMMARY);
		expect(argv[5]).toBe(SUMMARY);
	});

	test('Enter is the last element (separate recognised key, not in summary)', () => {
		const argv = buildWorkerReportSendKeysArgv(ORCH_PANE, SUMMARY);
		expect(argv.at(-1)).toBe('Enter');
		// Enter must NOT be concatenated to the summary string (atomicity invariant).
		const summaryArg = argv[5] ?? '';
		expect(summaryArg).not.toContain('Enter');
	});

	test('custom pane target (%3) is forwarded correctly', () => {
		const argv = buildWorkerReportSendKeysArgv('%3', 'test summary');
		expect(argv[4]).toBe('%3');
	});

	test('metachar safety: payload with {, }, ", ; is kept verbatim as a single argv element (US-003 AC)', () => {
		// A report payload with JSON metacharacters must land verbatim. Without -l,
		// the summary is a SINGLE non-key-name argv element, so tmux sends its
		// characters literally (no -l needed; -l would break Enter submission).
		const dangerousPayload = '[cam] US-003 DONE: {"outcome":"DONE"}; ok';
		const argv = buildWorkerReportSendKeysArgv('%0', dangerousPayload);
		const summaryArg = argv[5] ?? '';
		expect(summaryArg).toBe(dangerousPayload);
		expect(summaryArg).toContain('{');
		expect(summaryArg).toContain('}');
		expect(summaryArg).toContain('"');
		expect(summaryArg).toContain(';');
		expect(argv).not.toContain('-l');
	});

	test('text and Enter are in the SAME argv array (one atomic tmux call)', () => {
		// The invariant: both the summary text and the Enter keystroke must be
		// passed as arguments to the SAME send-keys call (not two separate calls).
		// In this function, both are elements of the same returned array.
		const argv = buildWorkerReportSendKeysArgv('%0', 'any summary');
		const enterIdx = argv.indexOf('Enter');
		const summaryIdx = argv.indexOf('any summary');
		// Both must be present in the same array (not separate calls)
		expect(enterIdx).toBeGreaterThan(-1);
		expect(summaryIdx).toBeGreaterThan(-1);
		// Enter must come after the summary
		expect(enterIdx).toBeGreaterThan(summaryIdx);
	});
});
