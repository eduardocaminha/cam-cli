// test/integration/dispatch-geometry.test.ts
//
// Integration test (REAL tmux): drives `sendKeysVerified`'s cursor-geometry
// delivery oracle (US-002, CAM-359; prompt-row discriminator US-001,
// CAM-364, replacing the tail-matching backstop from US-R1-001) end to end
// against a real tmux pane, on both the UNDELIVERED and DELIVERED
// direction, including both the char-wrap and word-wrap boundary-length
// payloads.
//
// Argv-shape unit tests (test/dispatch.test.ts) inject a scripted
// `sampleGeometryFn` and structurally cannot catch a defect in the geometry
// oracle's real interaction with tmux's own cursor tracking -- every
// regression in this issue's history (CAM-358) was found by a real-tmux
// probe, not a unit test. See test/fixtures/dispatch-geometry/raw-echo.ts
// for the receiver fixture and its bottom-anchored, pinned-cursor_y model
// (corrected in the review round 1 fix, US-R1-001, from an earlier version
// that modeled an eager downward wrap not present in a real Ink composer;
// corrected AGAIN in US-002, CAM-364, for the word-wrap trailing-space
// collision shape that a real Ink TUI actually produces, which the fixture's
// char-wrap-only model did not reproduce).
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
async function bootPane(mode: 'submit' | 'drop', wrapMode: 'char' | 'word' = 'char'): Promise<void> {
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
		`bun ${FIXTURE_PATH} ${mode} ${PANE_WIDTH} ${PANE_HEIGHT} ${wrapMode}`,
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
	'UNDELIVERED wrapping payload: exactly one physical send-keys call (send-once guard, US-001, CAM-375), exactly one push-undelivered event with retriesExhausted maxAttempts (AC6)',
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

		// Send-once guard (US-001, CAM-375): exactly one physical send despite
		// maxAttempts (3) VERIFY attempts against the real (never-delivered) pane.
		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
		expect(events[0]?.detail).toEqual({ paneId: id, retriesExhausted: 3, reason: 'retries-exhausted' });
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
	'wrap-boundary-exact payload (length === paneWidth): UNDELIVERED direction verifies maxAttempts times but sends exactly once (send-once guard, US-001, CAM-375), with one push-undelivered event (AC8)',
	async () => {
		await bootPane('drop');
		const id = paneId();
		const sendKeysCalls: string[][] = [];
		const spawnFn = makeSwapSocketSpawn(sendKeysCalls);
		const events: Array<{ kind: WorkerEventKind; detail: WorkerEventDetail }> = [];

		// Exactly PANE_WIDTH chars: under the fixture's corrected (pinned
		// cursor_y) model this lands the trailing row's leftover length back
		// at exactly the 2-char prompt width, colliding with the baseline on
		// BOTH axes -- the real production residue class (review round 1 fix,
		// US-R1-001) that a Y-axis discriminator never actually covered. The
		// prompt-row discriminator (`cursorRowStartsWithPrompt`, US-001,
		// CAM-364) is what correctly resolves this as undelivered now.
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

		// Send-once guard (US-001, CAM-375): exactly one physical send despite
		// maxAttempts (3) VERIFY attempts against the real (never-delivered) pane.
		expect(sendKeysCalls).toHaveLength(1);
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

test.skipIf(!tmuxAvailable)(
	'wrap-boundary collision generalizes past the first multiple (length === 2*paneWidth): still correctly UNDELIVERED (review round 1 fix, US-R1-001)',
	async () => {
		await bootPane('drop');
		const id = paneId();
		const sendKeysCalls: string[][] = [];
		const spawnFn = makeSwapSocketSpawn(sendKeysCalls);
		const events: Array<{ kind: WorkerEventKind; detail: WorkerEventDetail }> = [];

		// A SECOND multiple of PANE_WIDTH: proves the collision (and its
		// resolution via the content backstop) is not a fluke of the minimal
		// case covered by AC8 above, but a genuine periodicity in the
		// production cursor_x-mod-paneWidth model.
		const payload = 'w'.repeat(PANE_WIDTH * 2);
		expect(payload.length % PANE_WIDTH).toBe(0);

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

		// Send-once guard (US-001, CAM-375): exactly one physical send despite
		// maxAttempts (3) VERIFY attempts against the real (never-delivered) pane.
		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
	},
	20_000,
);

// PROMPT is 2 chars in the fixture (matching production's glyph + NBSP);
// word-wrap row capacity there is `paneWidth - 2*PROMPT.length` (US-002,
// CAM-364). A filler payload that exactly fills that capacity followed by
// one trailing space reproduces the REAL wrap-boundary collision: the
// cursor row goes BLANK (not the old char-wrap model's 2-real-character
// remnant), landing cursor_x back at the empty-composer baseline column.
const WORD_WRAP_COLLISION_PAYLOAD = `${'x'.repeat(PANE_WIDTH - 2 * 2)} `;

test.skipIf(!tmuxAvailable)(
	'word-wrap collision payload (trailing space at the real wrap boundary): UNDELIVERED direction correctly retries and reports push-undelivered, never misread as delivered (US-002, CAM-364)',
	async () => {
		await bootPane('drop', 'word');
		const id = paneId();
		const sendKeysCalls: string[][] = [];
		const spawnFn = makeSwapSocketSpawn(sendKeysCalls);
		const events: Array<{ kind: WorkerEventKind; detail: WorkerEventDetail }> = [];

		sendKeysVerified({
			paneId: id,
			text: WORD_WRAP_COLLISION_PAYLOAD,
			tmuxSpawnFn: spawnFn,
			idleTimeoutMs: 100,
			maxAttempts: 3,
			retryBaseMs: 20,
			retryMaxMs: 50,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		// Send-once guard (US-001, CAM-375): exactly one physical send despite
		// maxAttempts (3) VERIFY attempts against the real (never-delivered) pane.
		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('push-undelivered');
	},
	20_000,
);

test.skipIf(!tmuxAvailable)(
	'word-wrap collision payload (trailing space at the real wrap boundary): DELIVERED direction still resolves in ONE send (US-002, CAM-364)',
	async () => {
		await bootPane('submit', 'word');
		const id = paneId();
		const sendKeysCalls: string[][] = [];
		const spawnFn = makeSwapSocketSpawn(sendKeysCalls);
		const events: Array<{ kind: WorkerEventKind; detail: WorkerEventDetail }> = [];

		sendKeysVerified({
			paneId: id,
			text: WORD_WRAP_COLLISION_PAYLOAD,
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
	'pane-not-idle timeout path (real tmux, non-idle pane): exactly ONE send-keys call, one push-undelivered event (reason pane-not-idle, retriesExhausted 1) plus one orch-pane-busy event (US-003, CAM-373; US-001, CAM-401)',
	async () => {
		// A real long-lived foreground command (never renders a `>`/`❯` idle
		// prompt, nor exits) so `isOrchPaneIdle` genuinely reads false for the
		// entire idle-gate poll window -- this drives the real
		// `waitForIdlePane` timeout path, not a faked pane-content string.
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
			"bash -c 'echo BUSY; sleep 100'",
		]);
		await waitForCondition(() => tmuxRaw(['has-session', '-t', SESSION]).status === 0);
		const id = paneId();
		const sendKeysCalls: string[][] = [];
		const spawnFn = makeSwapSocketSpawn(sendKeysCalls);
		const events: Array<{ kind: WorkerEventKind; detail: WorkerEventDetail }> = [];

		sendKeysVerified({
			paneId: id,
			text: '[cam] US-003 DONE: pane-not-idle probe',
			tmuxSpawnFn: spawnFn,
			// Explicitly short override: never waits anywhere near the 30s
			// production default (IDLE_WAIT_DEADLINE_MS).
			idleTimeoutMs: 100,
			pollIntervalMs: 20,
			maxAttempts: 3,
			retryBaseMs: 20,
			retryMaxMs: 50,
			logEvent: (kind, detail) => events.push({ kind, detail }),
		});

		expect(sendKeysCalls).toHaveLength(1);
		expect(events).toHaveLength(2);
		expect(events[0]?.kind).toBe('push-undelivered');
		expect(events[0]?.detail).toEqual({ paneId: id, retriesExhausted: 1, reason: 'pane-not-idle' });
		expect(events[1]?.kind).toBe('orch-pane-busy');
		expect(events[1]?.detail).toEqual({ paneId: id, idleTimeoutMs: 100 });
	},
	20_000,
);
