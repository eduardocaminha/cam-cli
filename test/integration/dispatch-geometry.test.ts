// test/integration/dispatch-geometry.test.ts
//
// Integration test (REAL tmux): drives `sendKeysVerified`'s cursor-geometry
// delivery oracle (US-002, CAM-359) end to end against a real tmux pane, on
// both the UNDELIVERED and DELIVERED direction, including an exact
// wrap-boundary-length payload.
//
// Argv-shape unit tests (test/dispatch.test.ts) inject a scripted
// `sampleGeometryFn` and structurally cannot catch a defect in the geometry
// oracle's real interaction with tmux's own cursor tracking -- every
// regression in this issue's history (CAM-358) was found by a real-tmux
// probe, not a unit test. See test/fixtures/dispatch-geometry/raw-echo.ts
// for the receiver fixture and why it models an EAGER wrap (explicit
// `\r\n` on row-fill) rather than relying on the pty's own deferred-wrap
// behavior.
//
// Isolation: tests run on a PRIVATE socket (cam-it-dispatch-geometry), never
// on `-L cam` (which may host a live `cam run` session). The server is torn
// down in afterEach. Pane is pinned to `new-session -x 80` per AC6.

import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sendKeysVerified } from '../../src/tmux/dispatch.ts';
import type { SpawnFn } from '../../src/tmux/session.ts';
import type { WorkerEventDetail, WorkerEventKind } from '../../src/supervisor/events.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';

const TEST_SOCK = 'cam-it-dispatch-geometry';
const SESSION = 'dispatch-geometry-test';
const PANE_WIDTH = 80;
const PANE_HEIGHT = 24;

const FIXTURE_PATH = fileURLToPath(
	new URL('../fixtures/dispatch-geometry/raw-echo.ts', import.meta.url),
);

const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

/** Run tmux on the private test socket directly (for setup/teardown). */
function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync('tmux', ['-L', TEST_SOCK, ...args], { stdio: 'pipe' });
}

/**
 * SpawnFn passed to `sendKeysVerified`. It emits argv like
 * `['-L', 'cam', ...]`; swap the socket name so every call (send-keys,
 * capture-pane, display-message) lands on the private test socket instead
 * of the real `cam` one. Records every `send-keys` call for the assertions.
 */
function makeSwapSocketSpawn(sendKeysCalls: string[][]): SpawnFn {
	return (cmd, args, opts) => {
		const swapped = [...args];
		const lIdx = swapped.indexOf('-L');
		if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
		if (swapped.includes('send-keys')) sendKeysCalls.push(swapped);
		return spawnSync(cmd, swapped, { stdio: opts?.stdio ?? 'pipe' }) as ReturnType<SpawnFn>;
	};
}

/** Boot a fresh session with the raw-echo fixture as the pane's command. */
async function bootPane(mode: 'submit' | 'drop'): Promise<void> {
	tmuxRaw(['kill-server']);
	tmuxRaw([
		'new-session',
		'-d',
		'-s',
		SESSION,
		'-x',
		String(PANE_WIDTH),
		'-y',
		String(PANE_HEIGHT),
		`bun ${FIXTURE_PATH} ${mode} ${PANE_WIDTH}`,
	]);
	await waitForCondition(() => tmuxRaw(['has-session', '-t', SESSION]).status === 0);
}

function paneId(): string {
	const out = tmuxRaw(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])
		.stdout.toString()
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	const id = out[0];
	if (id === undefined) throw new Error('no pane found on test session');
	return id;
}

afterEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
});

test.skipIf(!tmuxAvailable)(
	'UNDELIVERED wrapping payload: send-keys attempted maxAttempts times, exactly one push-undelivered event (AC6)',
	async () => {
		await bootPane('drop');
		const id = paneId();
		const sendKeysCalls: string[][] = [];
		const spawnFn = makeSwapSocketSpawn(sendKeysCalls);
		const events: Array<{ kind: WorkerEventKind; detail: WorkerEventDetail }> = [];

		// 205 chars: long enough to wrap several times on an 80-col pane, but
		// deliberately NOT a multiple of paneWidth (arbitrarily long, not the
		// exact-boundary case covered separately by AC8).
		const payload = 'x'.repeat(205);

		sendKeysVerified({
			paneId: id,
			text: payload,
			tmuxSpawnFn: spawnFn,
			idleTimeoutMs: 100,
			maxAttempts: 3,
			retryBaseMs: 20,
			retryMaxMs: 50,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		expect(sendKeysCalls).toHaveLength(3);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
		expect(events[0]?.detail).toEqual({ paneId: id, retriesExhausted: 3 });
	},
	20_000,
);

test.skipIf(!tmuxAvailable)(
	'DELIVERED payload: exactly ONE send-keys call, ZERO push-undelivered events (AC7)',
	async () => {
		await bootPane('submit');
		const id = paneId();
		const sendKeysCalls: string[][] = [];
		const spawnFn = makeSwapSocketSpawn(sendKeysCalls);
		const events: Array<{ kind: WorkerEventKind; detail: WorkerEventDetail }> = [];

		const payload = '[cam] US-002 DONE: typecheck ok, 5 pass / 0 fail';

		sendKeysVerified({
			paneId: id,
			text: payload,
			tmuxSpawnFn: spawnFn,
			idleTimeoutMs: 100,
			maxAttempts: 3,
			retryBaseMs: 20,
			retryMaxMs: 50,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(0);
	},
	20_000,
);

test.skipIf(!tmuxAvailable)(
	'wrap-boundary-exact payload (length === paneWidth): UNDELIVERED direction retries maxAttempts times with one push-undelivered event (AC8)',
	async () => {
		await bootPane('drop');
		const id = paneId();
		const sendKeysCalls: string[][] = [];
		const spawnFn = makeSwapSocketSpawn(sendKeysCalls);
		const events: Array<{ kind: WorkerEventKind; detail: WorkerEventDetail }> = [];

		// Exactly PANE_WIDTH chars: the fixture's eager wrap lands the cursor at
		// column 0 of the NEXT row, colliding with the baseline's column 0 on
		// the X axis alone (the row/Y axis is what correctly discriminates it
		// as undelivered -- the scenario the full-pair comparison exists for).
		const payload = 'y'.repeat(PANE_WIDTH);
		expect(payload.length).toBe(PANE_WIDTH);

		sendKeysVerified({
			paneId: id,
			text: payload,
			tmuxSpawnFn: spawnFn,
			idleTimeoutMs: 100,
			maxAttempts: 3,
			retryBaseMs: 20,
			retryMaxMs: 50,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		expect(sendKeysCalls).toHaveLength(3);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
	},
	20_000,
);

test.skipIf(!tmuxAvailable)(
	'wrap-boundary-exact payload (length === paneWidth): DELIVERED direction holds too (AC8)',
	async () => {
		await bootPane('submit');
		const id = paneId();
		const sendKeysCalls: string[][] = [];
		const spawnFn = makeSwapSocketSpawn(sendKeysCalls);
		const events: Array<{ kind: WorkerEventKind; detail: WorkerEventDetail }> = [];

		const payload = 'z'.repeat(PANE_WIDTH);
		expect(payload.length).toBe(PANE_WIDTH);

		sendKeysVerified({
			paneId: id,
			text: payload,
			tmuxSpawnFn: spawnFn,
			idleTimeoutMs: 100,
			maxAttempts: 3,
			retryBaseMs: 20,
			retryMaxMs: 50,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(0);
	},
	20_000,
);
