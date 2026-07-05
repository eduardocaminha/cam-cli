// test/integration/tmux-introspect.test.ts
//
// Integration test (REAL tmux): proves the session-introspection helpers parse
// ACTUAL tmux `-F` output, not the idealized output the unit fakes encode.
//
// This is the exact gap the CAM-55 operator smoke exposed. Two bugs shipped past
// 925 unit tests + 3 CLEAN review rounds because every unit fake returned the
// output the code EXPECTED, never what tmux actually produces:
//   1. orchestratorAlive checked `pane_current_command === 'claude'`, but the
//      orchestrator pane runs claude under a bash respawn-wrapper, so the command
//      is 'bash'. Identity must key on @cam_label.
//   2. tmux converts a literal TAB in a `-F` format string to '_', so the old
//      tab-separated parses in getOrchPaneId / isSessionStale never matched real
//      output. The separator is now ';'.
// Only a real tmux round-trip can catch this class. Skips when tmux is absent.
//
// Isolation: the helpers build argv via tmuxArgs() which hardcodes `-L cam`. The
// injected spawnFn rewrites the socket to a private test socket so this never
// touches a live `cam run` session.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';

import {
	orchestratorAlive,
	getOrchPaneId,
	isSessionStale,
	paneCountMutex,
	openPaneInSession,
	type SpawnFn,
} from '../../src/tmux/session.ts';

const TEST_SOCK = 'cam-it-introspect';
const SESSION = 'introspect';

const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

/** Run tmux on the private test socket directly (for setup/teardown). */
function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync('tmux', ['-L', TEST_SOCK, ...args], { stdio: 'pipe' });
}

/**
 * SpawnFn passed to the helpers. They emit argv like
 * `['-L', 'cam', 'list-panes', ...]`; swap the socket name so the call lands on
 * the private test socket instead of the real `cam` one.
 */
const swapSocketSpawn: SpawnFn = (cmd, args, opts) => {
	const swapped = [...args];
	const lIdx = swapped.indexOf('-L');
	if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
	return spawnSync(cmd, swapped, { stdio: opts?.stdio ?? 'ignore' }) as ReturnType<SpawnFn>;
};

function label(paneTarget: string, value: string): void {
	tmuxRaw(['set-option', '-p', '-t', paneTarget, '@cam_label', value]);
}

beforeEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
	// Default shell panes (NOT `cat`: isSessionStale treats a cat pane as a stale
	// placeholder). A plain shell keeps pane_current_command as the shell name.
	tmuxRaw(['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '10']);
	Bun.sleepSync(200);
});

afterEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
});

test.skipIf(!tmuxAvailable)(
	'orchestratorAlive is true for a real pane labeled orchestrator (command is the shell, not claude)',
	() => {
		label(`${SESSION}.0`, 'orchestrator');
		Bun.sleepSync(100);
		// The real pane_current_command here is a shell (sh/bash/zsh), never
		// 'claude' — exactly the wrapper case. Label-keyed detection must pass.
		expect(orchestratorAlive(SESSION, swapSocketSpawn)).toBe(true);
	},
);

test.skipIf(!tmuxAvailable)(
	'orchestratorAlive is false when no pane is labeled orchestrator',
	() => {
		label(`${SESSION}.0`, 'dashboard');
		Bun.sleepSync(100);
		expect(orchestratorAlive(SESSION, swapSocketSpawn)).toBe(false);
	},
);

test.skipIf(!tmuxAvailable)(
	'getOrchPaneId returns the real pane id of index 0 (semicolon-separated parse)',
	() => {
		label(`${SESSION}.0`, 'orchestrator');
		Bun.sleepSync(100);
		const expectedId = tmuxRaw(['list-panes', '-t', SESSION, '-F', '#{pane_index};#{pane_id}'])
			.stdout.toString()
			.split('\n')
			.find((l) => l.startsWith('0;'))
			?.replace(/^0;/, '')
			.trim();
		const got = getOrchPaneId(SESSION, swapSocketSpawn);
		// The tab-separated version returned null here (tmux emits '_' for a tab),
		// so a non-null id that matches the real pane id is the regression guard.
		expect(got).not.toBeNull();
		expect(got).toBe(expectedId ?? '<none>');
	},
);

test.skipIf(!tmuxAvailable)(
	'isSessionStale: 2 labeled panes -> alive; stray 3rd pane -> stale; labeled worker -> alive',
	() => {
		// Label by pane_id (%N), NOT pane index: tmux inserts a new split adjacent
		// to the active pane and renumbers indices, so an index target would hit
		// the wrong pane. pane_ids are stable for the pane's lifetime.
		const p0 = tmuxRaw(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])
			.stdout.toString().trim().split('\n')[0];
		const p1 = tmuxRaw(['split-window', '-t', SESSION, '-d', '-P', '-F', '#{pane_id}'])
			.stdout.toString().trim();
		Bun.sleepSync(150);
		label(p0!, 'orchestrator');
		label(p1, 'dashboard');
		Bun.sleepSync(100);
		expect(isSessionStale(SESSION, swapSocketSpawn)).toBe(false); // 2-pane: alive

		// Add a stray, UNLABELED 3rd pane (e.g. a leftover shell).
		const p2 = tmuxRaw(['split-window', '-t', SESSION, '-d', '-P', '-F', '#{pane_id}'])
			.stdout.toString().trim();
		Bun.sleepSync(150);
		expect(isSessionStale(SESSION, swapSocketSpawn)).toBe(true); // stray 3rd: stale

		// Label the 3rd pane as a legitimate worker.
		label(p2, 'implementer');
		Bun.sleepSync(100);
		expect(isSessionStale(SESSION, swapSocketSpawn)).toBe(false); // labeled worker: alive
	},
);

test.skipIf(!tmuxAvailable)(
	'teardownWorkerPaneFn kill-pane cycle: 3 panes -> 2 (available) -> 3 after recreate (CAM-188 anchor)',
	() => {
		// Reproduces the lifecycle that the production teardownWorkerPaneFn enables:
		// kill-pane reduces count to 2 -> paneCountMutex reports 'available'
		// -> ensureWorkerPane / openPaneInSession brings it back to 3.
		// This is the real-tmux anchor that unit fakes cannot provide (they encode
		// the idealized kill/mutex state, masking any wrong tmux argv).

		// 1. Create a 3-pane session (orch + dashboard + worker).
		const p0 = tmuxRaw(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])
			.stdout.toString().trim().split('\n')[0]!;
		const p1 = tmuxRaw(['split-window', '-t', SESSION, '-v', '-d', '-P', '-F', '#{pane_id}'])
			.stdout.toString().trim();
		const p2 = tmuxRaw(['split-window', '-t', SESSION, '-v', '-d', '-P', '-F', '#{pane_id}'])
			.stdout.toString().trim();
		Bun.sleepSync(150);
		label(p0, 'orchestrator');
		label(p1, 'dashboard');
		label(p2, 'implementer');
		Bun.sleepSync(100);

		// Verify we start with 3 panes -> mutex is 'busy'.
		expect(paneCountMutex(SESSION, swapSocketSpawn)).toBe('busy');

		// 2. Simulate teardownWorkerPaneFn: kill-pane on the worker pane.
		// The production closure calls spawnSync('tmux', ['-L', 'cam', 'kill-pane', '-t', id]).
		// Here we use the private test socket via swapSocketSpawn-style argv.
		const killResult = spawnSync('tmux', ['-L', TEST_SOCK, 'kill-pane', '-t', p2], { stdio: 'pipe' });
		expect(killResult.status).toBe(0); // kill-pane must succeed
		Bun.sleepSync(150);

		// 3. After teardown: count = 2, mutex = 'available'.
		expect(paneCountMutex(SESSION, swapSocketSpawn)).toBe('available');

		// 4. Recreate the worker pane via openPaneInSession (mirrors ensureWorkerPane).
		const newWorkerId = openPaneInSession(SESSION, ['cat'], swapSocketSpawn, p0);
		Bun.sleepSync(150);
		expect(newWorkerId).toMatch(/^%\d+$/);

		// 5. After recreation: count = 3 again, mutex = 'busy'.
		expect(paneCountMutex(SESSION, swapSocketSpawn)).toBe('busy');
	},
);
