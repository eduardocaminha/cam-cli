// test/integration/supervisor-outcome-cam58.test.ts
//
// Integration test: reproduces the CAM-56 dogfood false-terminal failure end-to-end.
//
// Drives the REAL readWorkerOutcome (src/supervisor/result.ts) and REAL
// makeHasPendingStories (src/commands/sidecar.ts) against real tmp-dir
// filesystems. No shadow re-implementation of either function (the "fakes lie"
// invariant, CAM-55): fakes encode idealized output that matches the buggy code,
// so they cannot catch real call-graph bugs.
//
// Three scenarios covering the CAM-56/CAM-58 regression:
//   1. false-terminal repro: string lastCompletedStory + empty pane + DONE
//      worker-report => kind:pass storyId:'US-001' (NOT 'unknown', NOT 'blocked').
//   2. review-dispatch repro: all non-operator stories pass + no verdict =>
//      makeHasPendingStories returns true (review must still run).
//   3. terminal-stop: all non-operator stories pass + CLEAN verdict =>
//      makeHasPendingStories returns false (loop exits cleanly).

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeHasPendingStories } from '../../src/commands/sidecar.ts';
import { readWorkerOutcome } from '../../src/supervisor/result.ts';

// ---------------------------------------------------------------------------
// Tmp-dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam58-test-'));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Write content to a file in the tmp dir; return the absolute path. */
function writeTmpFile(name: string, content: string): string {
	const p = join(tmpDir, name);
	writeFileSync(p, content, 'utf8');
	return p;
}

/**
 * Real filesystem reader adapter for readWorkerOutcome.
 * Wraps readFileSync so all reads are real disk I/O (not in-memory fakes),
 * which ensures that any future refactor breaking the file-read path is caught.
 */
function realFileReader(p: string): string | null {
	try {
		return readFileSync(p, 'utf8');
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Scenario 1: false-terminal repro (CAM-56 dogfood failure)
//
// The exact failure shape from CAM-56:
//   - handoff.json.lastCompletedStory is a bare STRING (the worker wrote it
//     before US-001 landed the {id, title} schema correction).
//   - The supervisor captured an empty pane (DONE sentinel had scrolled out of
//     the visible region before capture-pane ran).
//   - worker-report.json exists with outcome=DONE story=US-001.
//   - prd.json already has US-001 passes:true.
//
// Before the US-001 string-coercion fix, readWorkerOutcome returned
// kind:'unknown' here (handoff.lastCompletedStory.id was undefined because
// rawStory was a string, not an object). After the fix, kind:'pass' is returned
// via the handoff-string-coerced path.
// ---------------------------------------------------------------------------

test('Scenario 1 (false-terminal repro): string lastCompletedStory + empty pane + DONE worker-report => kind:pass storyId:US-001', () => {
	const handoffPath = writeTmpFile(
		'handoff.json',
		JSON.stringify({
			lastCompletedStory: 'US-001', // bare string: the pre-fix CAM-56 shape
			branchName: 'cam/CAM-58-supervisor-outcome-worker-report',
			timestamp: '2026-06-17T00:00:00Z',
		}),
	);

	const prdPath = writeTmpFile(
		'prd.json',
		JSON.stringify({
			userStories: [{ id: 'US-001', title: 'Test story', passes: true }],
		}),
	);

	const workerReportPath = writeTmpFile(
		'worker-report.json',
		JSON.stringify({
			outcome: 'DONE',
			story: 'US-001',
			gates: { typecheck: 'ok', tests: '10 pass / 0 fail' },
			notes: 'none',
		}),
	);

	const result = readWorkerOutcome({
		prdPath,
		handoffPath,
		workerReportPath,
		// Empty pane: DONE sentinel scrolled out of capture region (CAM-56 shape).
		capturedPaneText: '',
		readFile: realFileReader,
	});

	expect(result.kind).toBe('pass');
	expect(result.storyId).toBe('US-001');
});

// ---------------------------------------------------------------------------
// Scenario 2: review-dispatch repro
//
// All non-operator stories pass, but prd.review.lastVerdict is null (review
// has not yet run). makeHasPendingStories must return true so the sidecar
// triggers the review cycle.
// ---------------------------------------------------------------------------

test('Scenario 2 (review-dispatch repro): all non-op stories pass + no verdict => makeHasPendingStories returns true', () => {
	const prdPath = writeTmpFile(
		'prd.json',
		JSON.stringify({
			userStories: [
				{ id: 'US-001', title: 'Implemented story', passes: true },
				// Operator story: must NOT block the loop from reaching review.
				{ id: 'US-OP-1', title: 'Operator ceremony', passes: false, requires: 'operator' },
			],
			review: { lastVerdict: null },
		}),
	);

	const hasPendingStories = makeHasPendingStories(prdPath);
	expect(hasPendingStories()).toBe(true);
});

// ---------------------------------------------------------------------------
// Scenario 3: terminal-stop
//
// All non-operator stories pass AND prd.review.lastVerdict is 'CLEAN'.
// makeHasPendingStories must return false so the sidecar exits the loop.
// ---------------------------------------------------------------------------

test('Scenario 3 (terminal-stop): all non-op stories pass + CLEAN verdict => makeHasPendingStories returns false', () => {
	const prdPath = writeTmpFile(
		'prd.json',
		JSON.stringify({
			userStories: [
				{ id: 'US-001', title: 'Implemented story', passes: true },
				// Operator story still pending: must NOT prevent terminal state.
				{ id: 'US-OP-1', title: 'Operator ceremony', passes: false, requires: 'operator' },
			],
			review: { lastVerdict: 'CLEAN' },
		}),
	);

	const hasPendingStories = makeHasPendingStories(prdPath);
	expect(hasPendingStories()).toBe(false);
});
