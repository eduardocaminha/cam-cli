// test/supervisor/pause-resume.test.ts
//
// Unit tests for resuming after a cooperative pause halt (US-002, CAM-360,
// AC4): once the pause marker is cleared (`cam resume`), a re-entered
// runSupervisor call must dispatch the remaining unpassed stories starting
// from prd.json's current on-disk state -- NOT re-plan or lose track of
// already-completed stories. The pure loop has no "planning" call of its
// own, so proving this is really proving: (a) a paused halt never mutates
// prd.json, and (b) a fresh runSupervisor invocation over the SAME prd.json
// snapshot dispatches exactly the next unpassed story, same as if pause had
// never happened.

import { describe, expect, test, beforeEach } from 'bun:test';
import { runSupervisor } from '../../src/supervisor/loop.ts';
import type {
	RunSupervisorOptions,
	SpawnFn,
	CapturePane,
	ReadPrd,
	WritePrd,
	ReadHandoff,
	ClockFn,
	ReviewDispatch,
	WriteSessionMarker,
	IsPaneAlive,
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';

// ---------------------------------------------------------------------------
// Fake builder helpers (mirrors test/supervisor/pause-halt.test.ts)
// ---------------------------------------------------------------------------

function makePrd(opts: {
	stories: Array<{ id: string; priority: number; passes: boolean; requires?: string }>;
	review?: PrdSnapshot['review'];
}): PrdSnapshot {
	return {
		userStories: opts.stories.map((s) => ({
			id: s.id,
			priority: s.priority,
			passes: s.passes,
			requires: s.requires ?? null,
		})),
		review: opts.review,
	};
}

function makeHandoff(storyId: string) {
	return {
		lastCompletedStory: { id: storyId, title: `Story ${storyId}` },
		branchName: 'cam/test',
		timestamp: '2026-06-08T00:00:00Z',
	};
}

function donePane(storyId: string): string {
	return `Implemented something\nCAM_IMPLEMENTER_STATUS=DONE story=${storyId}\n`;
}

let uuidCounter = 0;
function fakeGenUuid(): string {
	uuidCounter++;
	return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
}

const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';
const WORKER_PANE_ID = '%3';

function makeBaseOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	const spawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
	const capturePane: CapturePane = (_paneId) => '';
	const readPrd: ReadPrd = () => null;
	const writePrd: WritePrd = (_prd) => {};
	const readHandoff: ReadHandoff = () => null;
	const clock: ClockFn = () => '2026-06-08T00:00:00Z';
	const reviewDispatch: ReviewDispatch = (_uuid) => ({ status: 'ok', detail: 'review ok' });
	const writeSessionMarker: WriteSessionMarker = (_storyId, _uuid) => {};
	const isPaneAlive: IsPaneAlive = (_paneId) => true;

	return {
		spawn,
		capturePane,
		readPrd,
		writePrd,
		readHandoff,
		clock,
		genUuid: fakeGenUuid,
		reviewDispatch,
		writeSessionMarker,
		isPaneAlive,
		workerPaneId: WORKER_PANE_ID,
		prdPath: PRD_PATH,
		handoffPath: HANDOFF_PATH,
		permissionMode: 'bypassPermissions',
		taskPrompt: 'Implement the next story from the PRD.',
		sleepFn: (_ms: number) => {},
		nowMs: () => 0,
		...overrides,
	};
}

beforeEach(() => {
	uuidCounter = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSupervisor US-002 (CAM-360): resume after pause dispatches remaining stories', () => {
	test('paused call never touches prd.json/writePrd; a subsequent resumed call dispatches the next unpassed story', async () => {
		// prd.json on disk: US-001 already done, US-002 still pending. This is
		// the SAME snapshot both calls read -- proving the resumed call needs no
		// re-plan, just a fresh read of already-persisted state.
		const prdOnDisk = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: false },
			],
		});

		let writePrdCalls = 0;

		// --- Call 1: paused ---
		const pausedOpts = makeBaseOpts({
			isPaused: () => true,
			readPrd: () => prdOnDisk,
			writePrd: (_prd) => { writePrdCalls++; },
		});
		const pausedResult = await runSupervisor(pausedOpts);

		expect(pausedResult.status).toBe('paused');
		expect(pausedResult.iterations).toBe(0);
		expect(writePrdCalls).toBe(0); // no state mutation while paused

		// --- Call 2: resumed (marker cleared -> isPaused now false) ---
		const dispatchedStoryIds = new Set<string>();
		const prd_002done = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: true },
			],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		let prdReadCount = 0;
		const resumedOpts = makeBaseOpts({
			isPaused: () => false,
			// First read (top of iter 1) still shows US-002 pending: this is the
			// exact prd.json snapshot the paused call above also saw, proving
			// resume picks up from persisted state rather than re-planning.
			readPrd: () => { prdReadCount++; return prdReadCount === 1 ? prdOnDisk : prd_002done; },
			readHandoff: () => makeHandoff('US-002'),
			capturePane: (_paneId) => donePane('US-002'),
			writeSessionMarker: (storyId, _uuid) => { dispatchedStoryIds.add(storyId); },
		});
		const resumedResult = await runSupervisor(resumedOpts);

		expect(resumedResult.status).toBe('complete');
		expect(dispatchedStoryIds.has('US-002')).toBe(true);
		expect(dispatchedStoryIds.has('US-001')).toBe(false); // already-passed story is never re-dispatched
	});
});
