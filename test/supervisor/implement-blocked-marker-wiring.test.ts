// test/supervisor/implement-blocked-marker-wiring.test.ts
//
// Tests for the runSupervisor wiring of the durable implement-blocked marker
// writer (US-005, CAM-195, Defect 2). The pure marker I/O helpers (read/write/
// remove, never throw) are covered separately in
// test/supervisor/implement-blocked-marker.test.ts.

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
	ImplementBlockedWriterParams,
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';

/** Build a prd snapshot with N stories, optionally some already passing. */
function makePrd(opts: {
	stories: Array<{ id?: string; priority: number; passes: boolean; requires?: string }>;
	review?: PrdSnapshot['review'];
	issueNumber?: number;
}): PrdSnapshot {
	return {
		issueNumber: opts.issueNumber,
		userStories: opts.stories.map((s) => ({
			id: s.id,
			priority: s.priority,
			passes: s.passes,
			requires: s.requires ?? null,
		})),
		review: opts.review,
	};
}

/** Pane text with BLOCKED sentinel. */
function blockedPane(storyId: string): string {
	return `Some output\nCAM_IMPLEMENTER_STATUS=BLOCKED_QUALITY story=${storyId} reason=tests_failed\n`;
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

describe('runSupervisor US-005: durable implement-blocked marker writer wiring (CAM-195, Defect 2)', () => {
	test('story-level blocked terminal: writeImplementBlockedMarkerFn called once with issueId/story/reason', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
			issueNumber: 195,
		});
		const calls: ImplementBlockedWriterParams[] = [];
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => blockedPane('US-001'),
			writeImplementBlockedMarkerFn: (params) => { calls.push(params); },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.issueId).toBe('195');
		expect(calls[0]?.story).toBe('US-001');
		expect(typeof calls[0]?.reason).toBe('string');
		expect(calls[0]?.reason.length).toBeGreaterThan(0);
	});

	test('blocked-no-implementable path: writeImplementBlockedMarkerFn called with story: null', async () => {
		const prd = makePrd({
			// No `id` on the pending story -> decideNextAction's degenerate guard.
			stories: [{ priority: 1, passes: false }],
			issueNumber: 195,
		});
		const calls: ImplementBlockedWriterParams[] = [];
		const opts = makeBaseOpts({
			readPrd: () => prd,
			writeImplementBlockedMarkerFn: (params) => { calls.push(params); },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.issueId).toBe('195');
		expect(calls[0]?.story).toBeNull();
	});

	test('prd unreadable on the very first iteration: writeImplementBlockedMarkerFn NOT called (no issueId ever known)', async () => {
		const calls: ImplementBlockedWriterParams[] = [];
		const opts = makeBaseOpts({
			readPrd: () => null,
			writeImplementBlockedMarkerFn: (params) => { calls.push(params); },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(calls).toHaveLength(0);
	});

	test('complete terminal: writeImplementBlockedMarkerFn NOT called', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
			issueNumber: 195,
		});
		const calls: ImplementBlockedWriterParams[] = [];
		const opts = makeBaseOpts({
			readPrd: () => prd,
			writeImplementBlockedMarkerFn: (params) => { calls.push(params); },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(calls).toHaveLength(0);
	});

	test('absent writeImplementBlockedMarkerFn: backward compatible, no crash on a blocked terminal', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
			issueNumber: 195,
		});
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => blockedPane('US-001'),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
	});
});
