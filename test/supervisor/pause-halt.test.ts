// test/supervisor/pause-halt.test.ts
//
// Unit tests for the cooperative pause brake (US-002, CAM-360):
// RunSupervisorOptions.isPaused, consulted at the top of the inner
// story-loop boundary (loop.ts, the very first statement inside
// `outer: while`), before the loop reads prd.json or dispatches the next
// story's worker.
//
// Coverage:
//   1. isPaused true from the start halts before any dispatch: 'paused'
//      status, 0 iterations, prd.json never read, no worker spawned.
//   2. Halting on pause does not invoke any teardown/marker seam and does
//      not touch onProgress's terminal emission -- distinct from every other
//      terminal status, which always calls finishTerminal.
//   3. isPaused flips true mid-run, at the story-loop boundary BEFORE the
//      next story is dispatched (after a prior story already completed).
//   4. isPaused absent (undefined): loop behavior is byte-for-byte
//      unchanged (backward compatible).
//   5. Production wiring smoke: buildSupervisorOptions(cwd).opts.isPaused
//      reflects the real `.cam-pause` marker file (host.ts, US-002).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { buildSupervisorOptions } from '../../src/supervisor/host.ts';
import { setPause, clearPause } from '../../src/supervisor/pause-marker.ts';

// ---------------------------------------------------------------------------
// Fake builder helpers (mirrors test/supervisor/loop.test.ts's local pattern)
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

describe('runSupervisor US-002 (CAM-360): cooperative pause brake', () => {
	test('isPaused true from the start: returns paused, 0 iterations, prd.json never read, no dispatch', async () => {
		let readPrdCalls = 0;
		let spawnCalls = 0;
		const opts = makeBaseOpts({
			isPaused: () => true,
			readPrd: () => { readPrdCalls++; return makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] }); },
			spawn: (_cmd, _args) => { spawnCalls++; return { stdout: '', exitCode: 0 }; },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('paused');
		expect(result.iterations).toBe(0);
		expect(result.lastOutcome).toBeNull();
		expect(readPrdCalls).toBe(0);
		expect(spawnCalls).toBe(0);
	});

	test('paused halt does not invoke teardownWorkerPaneFn, marker writers, or the onProgress terminal emission', async () => {
		let teardownCount = 0;
		let writeMarkerCount = 0;
		let removeMarkerCount = 0;
		let terminalProgressCount = 0;

		const opts = makeBaseOpts({
			isPaused: () => true,
			teardownWorkerPaneFn: () => { teardownCount++; },
			writeImplementBlockedMarkerFn: () => { writeMarkerCount++; },
			removeImplementBlockedMarkerFn: () => { removeMarkerCount++; },
			onProgress: (payload) => { if (payload.terminalStatus !== undefined) terminalProgressCount++; },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('paused');
		// The distinguishing assertion (AC3): unlike every other terminal status
		// (complete/blocked/awaiting-operator/max-iterations), a paused halt never
		// runs finishTerminal, so none of its side-effect seams fire.
		expect(teardownCount).toBe(0);
		expect(writeMarkerCount).toBe(0);
		expect(removeMarkerCount).toBe(0);
		expect(terminalProgressCount).toBe(0);
	});

	test('halts at the story-loop boundary BEFORE dispatching the next story (mid-run pause)', async () => {
		// Story US-001 completes on iteration 1 (worker DONE sentinel). Before
		// iteration 2 (which would dispatch US-002), isPaused flips true: the
		// loop must halt WITHOUT ever spawning a worker for US-002.
		const prd_bothIncomplete = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: false },
				{ id: 'US-002', priority: 2, passes: false },
			],
		});
		const prd_001done = makePrd({
			stories: [
				{ id: 'US-001', priority: 1, passes: true },
				{ id: 'US-002', priority: 2, passes: false },
			],
		});

		const prds: PrdSnapshot[] = [
			prd_bothIncomplete, // iter 1 top -> implement US-001
			prd_001done,        // iter 1 fileReader (outcome check)
		];
		let prdCallCount = 0;
		let pauseCallCount = 0;
		const spawnedStoryLabels: string[] = [];

		const opts = makeBaseOpts({
			isPaused: () => {
				pauseCallCount++;
				// false on iteration 1's entry check; true from iteration 2 onward.
				return pauseCallCount > 1;
			},
			readPrd: () => prds[prdCallCount++] ?? null,
			readHandoff: () => makeHandoff('US-001'),
			capturePane: (_paneId) => donePane('US-001'),
			spawn: (_cmd, args) => {
				if (args.includes('implementer')) spawnedStoryLabels.push('dispatch');
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('paused');
		expect(result.iterations).toBe(1); // only US-001's iteration ran
		expect(pauseCallCount).toBe(2); // checked at the top of iter 1 AND iter 2
		expect(spawnedStoryLabels).toHaveLength(1); // US-001 dispatched, US-002 never dispatched
	});

	test('isPaused absent: loop reaches complete unchanged (backward compatible)', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		const opts = makeBaseOpts({
			readPrd: () => prd,
			// isPaused deliberately omitted.
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
	});
});

describe('buildSupervisorOptions US-002 (CAM-360): production isPaused wiring reads the real marker', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'cam-pause-host-'));
		mkdirSync(join(dir, '.claude'), { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('opts.isPaused() is false with no marker, true once setPause writes it, false again after clearPause', () => {
		const { opts } = buildSupervisorOptions(dir);
		const claudeDir = join(dir, '.claude');

		expect(opts.isPaused?.()).toBe(false);

		setPause(claudeDir);
		expect(opts.isPaused?.()).toBe(true);

		clearPause(claudeDir);
		expect(opts.isPaused?.()).toBe(false);
	});
});
