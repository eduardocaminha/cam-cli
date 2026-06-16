// test/supervisor/ensure-worker-pane.test.ts
//
// Unit tests for the CAM-57 ensureWorkerPane self-heal logic.
//
// Coverage:
//   1. Implement branch: when isPaneAlive returns true, ensureWorkerPane is NOT
//      called (pane is already live, no new spawn, marker unchanged).
//   2. Implement branch: when isPaneAlive returns false, ensureWorkerPane IS
//      called, openPaneInSession is called (via spawn fake), the new id is used
//      for respawn-pane, and writeWorkerPaneMarker writes the new id.
//   3. Review branch (makeReviewDispatch): when ensureWorkerPane is injected and
//      returns a new id, respawn-pane uses that new id, not the static workerPaneId.
//   4. Review branch: when ensureWorkerPane is NOT injected, the static
//      workerPaneId is used unchanged (backward compat).
//   5. runSupervisor: backward compat - when ensureWorkerPane is absent,
//      workerPaneId from opts is used as-is for respawn-pane.

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
	IsPaneAlive,
	ReviewDispatch,
	WriteSessionMarker,
} from '../../src/supervisor/loop.ts';
import { makeReviewDispatch } from '../../src/supervisor/review.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrd(stories: Array<{ id: string; priority: number; passes: boolean }>): PrdSnapshot {
	return {
		userStories: stories.map((s) => ({
			id: s.id,
			priority: s.priority,
			passes: s.passes,
			requires: null,
		})),
		review: { roundsCompleted: 1, maxRounds: 3, lastVerdict: 'CLEAN' },
	};
}

/** Pane text that makes readWorkerOutcome return 'pass' for storyId. */
function donePane(storyId: string): string {
	return `Implemented something\nCAM_IMPLEMENTER_STATUS=DONE story=${storyId}\n`;
}

const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';
const STALE_PANE_ID = '%3';
const NEW_PANE_ID = '%99';

// Deterministic uuid counter
let uuidCounter = 0;
function fakeGenUuid(): string {
	uuidCounter++;
	return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
}

function makeHandoffFor(storyId: string) {
	return {
		lastCompletedStory: { id: storyId, title: `Story ${storyId}` },
		branchName: 'cam/test',
		timestamp: '2026-06-08T00:00:00Z',
	};
}

// ---------------------------------------------------------------------------
// Reset counter before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
	uuidCounter = 0;
});

// ---------------------------------------------------------------------------
// Test 1 & 2: implement branch with ensureWorkerPane
// ---------------------------------------------------------------------------

describe('runSupervisor ensureWorkerPane (implement branch)', () => {
	test('when ensureWorkerPane returns the same id (pane alive), respawn uses that id', async () => {
		const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
		const spawn: SpawnFn = (cmd, args) => {
			spawnCalls.push({ cmd, args });
			return { stdout: '', exitCode: 0 };
		};

		const prd = makePrd([{ id: 'US-001', priority: 1, passes: false }]);
		let handoff = makeHandoffFor('US-001');
		let prdState = { ...prd };

		const ensureWorkerPaneCalls: string[] = [];
		const ensureWorkerPane = () => {
			ensureWorkerPaneCalls.push('called');
			return STALE_PANE_ID; // same id, pane is "alive"
		};

		const capturePane: CapturePane = (paneId) => {
			if (paneId === STALE_PANE_ID) {
				// Simulate completed worker
				prdState.userStories![0]!.passes = true;
				return donePane('US-001');
			}
			return '';
		};

		const opts: RunSupervisorOptions = {
			spawn,
			capturePane,
			readPrd: () => prdState,
			writePrd: (p) => { prdState = p; },
			readHandoff: () => handoff,
			clock: () => '2026-06-16T00:00:00Z',
			genUuid: fakeGenUuid,
			reviewDispatch: () => ({ status: 'ok', detail: 'clean' }),
			writeSessionMarker: () => {},
			isPaneAlive: () => true,
			workerPaneId: STALE_PANE_ID,
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			permissionMode: 'bypassPermissions',
			taskPrompt: 'Implement.',
			sleepFn: () => {},
			nowMs: () => 0,
			ensureWorkerPane,
		};

		await runSupervisor(opts);

		// ensureWorkerPane must have been called before the respawn
		expect(ensureWorkerPaneCalls.length).toBeGreaterThanOrEqual(1);

		// The respawn-pane call must target STALE_PANE_ID (the id returned by
		// ensureWorkerPane in this scenario)
		const respawnCall = spawnCalls.find(
			(c) => c.cmd === 'tmux' && c.args.includes('respawn-pane'),
		);
		expect(respawnCall).toBeDefined();
		expect(respawnCall!.args).toContain(STALE_PANE_ID);
	});

	test('when ensureWorkerPane returns a NEW id (dead pane), respawn uses the new id', async () => {
		const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
		const spawn: SpawnFn = (cmd, args) => {
			spawnCalls.push({ cmd, args });
			return { stdout: '', exitCode: 0 };
		};

		const prd = makePrd([{ id: 'US-001', priority: 1, passes: false }]);
		let prdState = { ...prd };

		const ensureWorkerPaneCalls: string[] = [];
		const ensureWorkerPane = () => {
			ensureWorkerPaneCalls.push('called');
			return NEW_PANE_ID; // new id: pane was dead, a fresh one was created
		};

		const capturePane: CapturePane = (paneId) => {
			if (paneId === NEW_PANE_ID) {
				prdState.userStories![0]!.passes = true;
				return donePane('US-001');
			}
			return '';
		};

		const opts: RunSupervisorOptions = {
			spawn,
			capturePane,
			readPrd: () => prdState,
			writePrd: (p) => { prdState = p; },
			readHandoff: () => makeHandoffFor('US-001'),
			clock: () => '2026-06-16T00:00:00Z',
			genUuid: fakeGenUuid,
			reviewDispatch: () => ({ status: 'ok', detail: 'clean' }),
			writeSessionMarker: () => {},
			isPaneAlive: (id) => id === NEW_PANE_ID, // only new pane is alive
			workerPaneId: STALE_PANE_ID,
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			permissionMode: 'bypassPermissions',
			taskPrompt: 'Implement.',
			sleepFn: () => {},
			nowMs: () => 0,
			ensureWorkerPane,
		};

		await runSupervisor(opts);

		// ensureWorkerPane must have been called
		expect(ensureWorkerPaneCalls.length).toBeGreaterThanOrEqual(1);

		// The respawn-pane call MUST target NEW_PANE_ID, not STALE_PANE_ID
		const respawnCall = spawnCalls.find(
			(c) => c.cmd === 'tmux' && c.args.includes('respawn-pane'),
		);
		expect(respawnCall).toBeDefined();
		expect(respawnCall!.args).toContain(NEW_PANE_ID);
		expect(respawnCall!.args).not.toContain(STALE_PANE_ID);
	});

	test('backward compat: when ensureWorkerPane is absent, static workerPaneId is used', async () => {
		const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
		const spawn: SpawnFn = (cmd, args) => {
			spawnCalls.push({ cmd, args });
			return { stdout: '', exitCode: 0 };
		};

		const prd = makePrd([{ id: 'US-001', priority: 1, passes: false }]);
		let prdState = { ...prd };

		const capturePane: CapturePane = (paneId) => {
			if (paneId === STALE_PANE_ID) {
				prdState.userStories![0]!.passes = true;
				return donePane('US-001');
			}
			return '';
		};

		const opts: RunSupervisorOptions = {
			spawn,
			capturePane,
			readPrd: () => prdState,
			writePrd: (p) => { prdState = p; },
			readHandoff: () => makeHandoffFor('US-001'),
			clock: () => '2026-06-16T00:00:00Z',
			genUuid: fakeGenUuid,
			reviewDispatch: () => ({ status: 'ok', detail: 'clean' }),
			writeSessionMarker: () => {},
			isPaneAlive: () => true,
			workerPaneId: STALE_PANE_ID,
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			permissionMode: 'bypassPermissions',
			taskPrompt: 'Implement.',
			sleepFn: () => {},
			nowMs: () => 0,
			// ensureWorkerPane intentionally absent
		};

		await runSupervisor(opts);

		// The respawn-pane call must use the static STALE_PANE_ID from opts
		const respawnCall = spawnCalls.find(
			(c) => c.cmd === 'tmux' && c.args.includes('respawn-pane'),
		);
		expect(respawnCall).toBeDefined();
		expect(respawnCall!.args).toContain(STALE_PANE_ID);
	});
});

// ---------------------------------------------------------------------------
// Test 3 & 4: makeReviewDispatch with ensureWorkerPane
// ---------------------------------------------------------------------------

describe('makeReviewDispatch ensureWorkerPane (review branch)', () => {
	function makeReviewPrd(): PrdSnapshot {
		return {
			userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }],
			review: { roundsCompleted: 0, maxRounds: 3, lastVerdict: undefined },
		};
	}

	test('when ensureWorkerPane is injected and returns new id, respawn uses new id', () => {
		const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
		const fakeSpawn: SpawnFn = (cmd, args) => {
			spawnCalls.push({ cmd, args });
			return { stdout: '', exitCode: 0 };
		};

		let prdState = makeReviewPrd();

		const ensureWorkerPaneCalls: string[] = [];
		const ensureWorkerPane = () => {
			ensureWorkerPaneCalls.push('called');
			return NEW_PANE_ID;
		};

		const reviewDispatch = makeReviewDispatch({
			spawn: fakeSpawn,
			capturePane: (id) => (id === NEW_PANE_ID ? '<review>CLEAN</review>' : ''),
			readPrd: () => prdState,
			writePrd: (p) => { prdState = p; },
			workerPaneId: STALE_PANE_ID,
			isPaneAlive: (id) => id === NEW_PANE_ID,
			sleepFn: () => {},
			permissionMode: 'bypassPermissions',
			pollIntervalMs: 0,
			timeoutMs: 60_000,
			now: () => 0,
			ensureWorkerPane,
		});

		const result = reviewDispatch('test-uuid-1');

		// ensureWorkerPane called at the top of the dispatch
		expect(ensureWorkerPaneCalls.length).toBeGreaterThanOrEqual(1);

		// respawn-pane must target NEW_PANE_ID
		const respawnCall = spawnCalls.find(
			(c) => c.cmd === 'tmux' && c.args.includes('respawn-pane'),
		);
		expect(respawnCall).toBeDefined();
		expect(respawnCall!.args).toContain(NEW_PANE_ID);
		expect(respawnCall!.args).not.toContain(STALE_PANE_ID);

		// And the result should be ok (CLEAN verdict from NEW_PANE_ID)
		expect(result.status).toBe('ok');
	});

	test('when ensureWorkerPane is NOT injected, static workerPaneId is used', () => {
		const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
		const fakeSpawn: SpawnFn = (cmd, args) => {
			spawnCalls.push({ cmd, args });
			return { stdout: '', exitCode: 0 };
		};

		let prdState = makeReviewPrd();

		const reviewDispatch = makeReviewDispatch({
			spawn: fakeSpawn,
			capturePane: (id) => (id === STALE_PANE_ID ? '<review>CLEAN</review>' : ''),
			readPrd: () => prdState,
			writePrd: (p) => { prdState = p; },
			workerPaneId: STALE_PANE_ID,
			isPaneAlive: (id) => id === STALE_PANE_ID,
			sleepFn: () => {},
			permissionMode: 'bypassPermissions',
			pollIntervalMs: 0,
			timeoutMs: 60_000,
			now: () => 0,
			// ensureWorkerPane intentionally absent
		});

		const result = reviewDispatch('test-uuid-2');

		// respawn-pane must use static STALE_PANE_ID
		const respawnCall = spawnCalls.find(
			(c) => c.cmd === 'tmux' && c.args.includes('respawn-pane'),
		);
		expect(respawnCall).toBeDefined();
		expect(respawnCall!.args).toContain(STALE_PANE_ID);

		expect(result.status).toBe('ok');
	});
});
