// test/stop-report-fields.test.ts
//
// Unit tests for US-005 acceptance criteria:
//   (A) sidecar self-exit (US-003) emits a 'sidecar-exit' event with
//       detail.reason === 'session-absent' via the injected logEvent sink.
//   (B) performStop populates sidecarKilled and markersRemoved correctly
//       under US-001 (sidecar pid present + alive) and US-002 (markers present).

import { describe, expect, test } from 'bun:test';
import { runSidecarLoop, type RunSidecarLoopOptions, type RunSupervisorOptions } from '../src/supervisor/loop.ts';
import { makeInMemoryEventLogger } from '../src/supervisor/events.ts';
import type { KillFn, SpawnSyncFn } from '../src/commands/stop.ts';
import { performStop } from '../src/commands/stop.ts';

// ---------------------------------------------------------------------------
// Helpers shared across tests
// ---------------------------------------------------------------------------

/** Fake SpawnSyncFn that returns exit-1 for everything (tmux unavailable). */
const noTmuxSpawn: SpawnSyncFn = () => ({
	pid: 1,
	output: ['', '', ''] as (string | null)[],
	stdout: '',
	stderr: '',
	status: 1,
	signal: null,
});

/** Minimal RunSupervisorOptions that never does any real I/O. */
function makeDummySupervisorOpts(): RunSupervisorOptions {
	return {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-06-17T00:00:00Z',
		reviewDispatch: () => ({ status: 'ok', detail: '' }),
		writeSessionMarker: () => {},
		isPaneAlive: () => true,
		workerPaneId: '%2',
		prdPath: '/fake/prd.json',
		handoffPath: '/fake/handoff.json',
		permissionMode: 'bypassPermissions',
		taskPrompt: 'test',
		sleepFn: () => {},
		nowMs: () => 0,
	};
}

// ---------------------------------------------------------------------------
// (A) sidecar self-exit emits 'sidecar-exit' event
// ---------------------------------------------------------------------------

describe('runSidecarLoop — sidecar-exit event on session-gone', () => {
	test('emits sidecar-exit event with detail.reason=session-absent via injected logEvent', async () => {
		const { logger, events } = makeInMemoryEventLogger();

		// hasSessionFn: true on first call (latch sessionSeen), false on second (trigger exit).
		const sessionResponses = [true, false];
		let sessionCalls = 0;
		let sleepCount = 0;

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false,
			clearActive: () => {},
			sleep: () => {
				sleepCount += 1;
				if (sleepCount > 5) throw new Error('safety-valve: loop did not exit');
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: false as const, holderPid: 99 }),
			hasSessionFn: () => {
				const response = sessionResponses[sessionCalls] ?? false;
				sessionCalls += 1;
				return response;
			},
			idlePollMs: 1,
			logEvent: logger,
		};

		// Should resolve cleanly after session goes absent.
		await expect(runSidecarLoop(opts)).resolves.toBeUndefined();

		// Exactly one 'sidecar-exit' event must have been emitted.
		const exitEvents = events.filter((e) => e.kind === 'sidecar-exit');
		expect(exitEvents.length).toBe(1);

		const ev = exitEvents[0];
		expect(ev).toBeDefined();
		expect(ev!.kind).toBe('sidecar-exit');
		expect(ev!.uuid).toBe('sidecar');
		expect(ev!.storyId).toBeUndefined();
		// detail must carry reason: 'session-absent'
		const detail = ev!.detail as Record<string, unknown>;
		expect(detail['reason']).toBe('session-absent');
	});

	test('no event emitted when hasSessionFn is absent (sidecar runs until killed)', async () => {
		const { logger, events } = makeInMemoryEventLogger();

		const ESCAPE = Symbol('escape');
		let sleepCount = 0;

		const opts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: () => false,
			clearActive: () => {},
			sleep: () => {
				sleepCount += 1;
				if (sleepCount >= 3) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: false as const, holderPid: 99 }),
			// hasSessionFn NOT wired
			idlePollMs: 1,
			logEvent: logger,
		};

		try {
			await runSidecarLoop(opts);
		} catch (e) {
			if (e !== ESCAPE) throw e;
		}

		// No sidecar-exit event since hasSessionFn is absent.
		const exitEvents = events.filter((e) => e.kind === 'sidecar-exit');
		expect(exitEvents.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// (B) performStop populates sidecarKilled and markersRemoved
// ---------------------------------------------------------------------------

describe('performStop — sidecarKilled and markersRemoved fields', () => {
	test('sidecarKilled:true and markersRemoved populated when sidecar pid alive + markers present', () => {
		const FAKE_PID = 54321;
		const killCalls: Array<{ pid: number; signal: string }> = [];
		const killFn: KillFn = (pid, signal) => {
			killCalls.push({ pid, signal });
		};

		// Track which paths were unlinked.
		const unlinkedPaths: string[] = [];

		// Simulate: state file present, one marker present (.cam-supervisor.lock).
		const fakeCwd = '/fake/cwd';
		const presentPaths = new Set([
			`${fakeCwd}/.claude/cam-loop.local.md`,
			`${fakeCwd}/.claude/.cam-supervisor.lock`,
		]);

		const report = performStop({
			cwd: fakeCwd,
			spawnSyncFn: noTmuxSpawn,
			existsSyncFn: (p) => presentPaths.has(p),
			unlinkSyncFn: (p) => {
				unlinkedPaths.push(p);
			},
			sidecarPidReader: () => FAKE_PID,
			sidecarPidAliveFn: () => true,
			sidecarPidRemover: () => {},
			killFn,
		});

		// sidecarKilled must be true (pid was alive, SIGTERM sent).
		expect(report.sidecarKilled).toBe(true);
		expect(killCalls).toEqual([{ pid: FAKE_PID, signal: 'SIGTERM' }]);

		// markersRemoved must contain the relative paths of unlinked markers.
		// STATE_FILE_PATH = '.claude/cam-loop.local.md' (relative to cwd).
		expect(report.markersRemoved).toContain('.claude/cam-loop.local.md');
		// SUPERVISOR_LOCK_FILE basename: confirm .claude prefix from relative().
		expect(report.markersRemoved.some((p) => p.includes('.cam-supervisor.lock'))).toBe(true);
		// Both paths were actually unlinked.
		expect(report.markersRemoved.length).toBe(2);
		expect(unlinkedPaths.length).toBe(2);
	});

	test('markersRemoved empty when no markers are present', () => {
		const report = performStop({
			cwd: '/fake/cwd-empty',
			spawnSyncFn: noTmuxSpawn,
			existsSyncFn: () => false,
			unlinkSyncFn: () => {},
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			killFn: () => {},
		});

		expect(report.sidecarKilled).toBe(false);
		expect(report.markersRemoved).toEqual([]);
	});
});
