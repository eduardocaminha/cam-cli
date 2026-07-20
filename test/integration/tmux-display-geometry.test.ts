// test/integration/tmux-display-geometry.test.ts
//
// Integration test (REAL tmux): proves sampleCursorGeometry parses ACTUAL
// tmux `display-message` output, not the idealized output a unit fake
// encodes (same class of gap as test/integration/tmux-introspect.test.ts).
//
// Isolation: tests run on a PRIVATE socket (cam-it-display-msg), never on
// `-L cam` (which may host a live `cam run` session). The server is torn
// down in afterEach.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';

import { sampleCursorGeometry, type CursorGeometry } from '../../src/tmux/display-message.ts';
import type { SpawnFn } from '../../src/tmux/session.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';

const TEST_SOCK = 'cam-it-display-msg';
const SESSION = 'display-msg-test';

const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

/** Run tmux on the private test socket directly (for setup/teardown). */
function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync('tmux', ['-L', TEST_SOCK, ...args], { stdio: 'pipe' });
}

/**
 * SpawnFn passed to the helpers. They emit argv like
 * `['-L', 'cam', 'display-message', ...]`; swap the socket name so the call
 * lands on the private test socket instead of the real `cam` one.
 */
const swapSocketSpawn: SpawnFn = (cmd, args, opts) => {
	const swapped = [...args];
	const lIdx = swapped.indexOf('-L');
	if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
	return spawnSync(cmd, swapped, { stdio: opts?.stdio ?? 'pipe' }) as ReturnType<SpawnFn>;
};

function paneIds(session: string): string[] {
	return tmuxRaw(['list-panes', '-t', session, '-F', '#{pane_id}'])
		.stdout.toString()
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

beforeEach(async () => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
	tmuxRaw(['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24']);
	await waitForCondition(() => tmuxRaw(['has-session', '-t', SESSION]).status === 0);
});

afterEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
});

test.skipIf(!tmuxAvailable)(
	'sampleCursorGeometry reads a parseable, in-bounds coordinate from a real 80x24 pane',
	async () => {
		const [paneId] = paneIds(SESSION);
		expect(paneId).toMatch(/^%\d+$/);

		await waitForCondition(() => sampleCursorGeometry(paneId!, swapSocketSpawn) !== null);
		const geo: CursorGeometry | null = sampleCursorGeometry(paneId!, swapSocketSpawn);

		expect(geo).not.toBeNull();
		expect(geo!.paneWidth).toBe(80);
		expect(geo!.paneHeight).toBe(24);
		expect(geo!.cursorX).toBeGreaterThanOrEqual(0);
		expect(geo!.cursorX).toBeLessThan(geo!.paneWidth);
		expect(geo!.cursorY).toBeGreaterThanOrEqual(0);
		expect(geo!.cursorY).toBeLessThan(geo!.paneHeight);
	},
);
