// test/unit/dispatch-orch-pane-busy.test.ts
//
// US-001 (CAM-401): the busy-orch-pane send-anyway condition emits a
// dedicated 'orch-pane-busy' structured event (via the injected logEvent
// seam), in ADDITION TO (not replacing) the existing generic
// push-undelivered (reason: 'pane-not-idle') emission already relied on by
// downstream consumers.
//
// What we cover:
//   - the idle-gate timing out fires BOTH events, in order: 'push-undelivered'
//     (reason 'pane-not-idle', unchanged), then 'orch-pane-busy'
//   - 'orch-pane-busy' detail carries the exact paneId and idleTimeoutMs the
//     caller configured, so a reader can attribute the wedge without parsing
//     free text
//   - omitting logEvent stays a no-op (zero side effects), matching the
//     documented optional-seam contract
//   - the delivered-on-idle path (pane goes idle within budget) never emits
//     'orch-pane-busy'

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { sendKeysVerified, type CapturePaneFn } from '../../src/tmux/dispatch.ts';
import type { SpawnFn as TmuxSpawnFn } from '../../src/tmux/session.ts';
import type { WorkerEventKind, WorkerEventDetail } from '../../src/supervisor/events.ts';

interface TmuxCall {
	cmd: string;
	args: string[];
}

function makeSpawnFn(): TmuxSpawnFn & { calls: TmuxCall[] } {
	const calls: TmuxCall[] = [];
	const fn = ((cmd: string, args: string[]) => {
		calls.push({ cmd, args: [...args] });
		const base: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};
		return base;
	}) as TmuxSpawnFn & { calls: TmuxCall[] };
	fn.calls = calls;
	return fn;
}

describe('sendKeysVerified: orch-pane-busy event (US-001, CAM-401)', () => {
	test('idle-gate timeout emits push-undelivered AND orch-pane-busy, in that order', () => {
		const spawnFn = makeSpawnFn();
		const events: { kind: WorkerEventKind; detail: WorkerEventDetail }[] = [];
		const alwaysBusy: CapturePaneFn = () => '⠋ Busy forever\n';

		sendKeysVerified({
			paneId: '%3',
			text: '/cam-next',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: alwaysBusy,
			sleepFn: () => {},
			pollIntervalMs: 1,
			idleTimeoutMs: 5,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		expect(events).toHaveLength(2);
		expect(events[0]?.kind).toBe('push-undelivered');
		expect(events[0]?.detail).toEqual({ paneId: '%3', retriesExhausted: 1, reason: 'pane-not-idle' });
		expect(events[1]?.kind).toBe('orch-pane-busy');
		expect(events[1]?.detail).toEqual({ paneId: '%3', idleTimeoutMs: 5 });
	});

	test('orch-pane-busy detail carries the exact paneId and idleTimeoutMs configured', () => {
		const spawnFn = makeSpawnFn();
		const events: { kind: WorkerEventKind; detail: WorkerEventDetail }[] = [];

		sendKeysVerified({
			paneId: '%7',
			text: '/cam-review',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '⠋ still busy\n',
			sleepFn: () => {},
			pollIntervalMs: 1,
			idleTimeoutMs: 1_234,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		const busyEvent = events.find((e) => e.kind === 'orch-pane-busy');
		expect(busyEvent).toBeDefined();
		expect(busyEvent?.detail).toEqual({ paneId: '%7', idleTimeoutMs: 1_234 });
	});

	test('logEvent is optional: omitting it on the timeout path emits no event and does not throw', () => {
		const spawnFn = makeSpawnFn();

		expect(() => {
			sendKeysVerified({
				paneId: '%1',
				text: '/cam-ship',
				tmuxSpawnFn: spawnFn,
				capturePaneFn: () => '⠋ Busy forever\n',
				sleepFn: () => {},
				pollIntervalMs: 1,
				idleTimeoutMs: 5,
				// logEvent intentionally omitted.
			});
		}).not.toThrow();

		// send-keys still fires (fallback), regardless of logEvent being absent.
		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeDefined();
	});

	test('the delivered-on-idle path never emits orch-pane-busy', () => {
		const spawnFn = makeSpawnFn();
		const events: { kind: WorkerEventKind; detail: WorkerEventDetail }[] = [];

		sendKeysVerified({
			paneId: '%2',
			text: '/cam-plan 1',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ',
			sleepFn: () => {},
			pollIntervalMs: 1,
			idleTimeoutMs: 5_000,
			// A fixed geometry sample makes the post-send read match the baseline
			// (delivered on attempt 1), so the timeout/send-anyway path never fires.
			sampleGeometryFn: () => ({ cursorX: 2, cursorY: 0, paneWidth: 80, paneHeight: 1 }),
			visibleCaptureFn: () => '❯ ',
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		expect(events.find((e) => e.kind === 'orch-pane-busy')).toBeUndefined();
		expect(events.find((e) => e.kind === 'push-undelivered')).toBeUndefined();
	});
});
