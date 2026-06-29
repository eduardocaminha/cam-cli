// test/integration/worker-pane-geometry.test.ts
//
// Integration test (REAL tmux): proves the worker pane inherits the
// orchestrator pane's geometry even when a NON-orchestrator pane (the
// dashboard / right column) is the ACTIVE pane at split time.
//
// This is the discriminating oracle for the CAM-80 fix (US-001). A pure
// argv-shape test can only confirm that `-t <orchPaneId>` is passed; it
// cannot detect whether that actually affects the resulting geometry. Only a
// real tmux round-trip can measure actual pane dimensions and confirm the
// worker was born from the orchestrator column (wide), not from the active
// dashboard column (narrow).
//
// Isolation: tests run on a PRIVATE socket (cam-it-worker-geo), NEVER on
// -L cam (which may host a live cam run session). The server is torn down in
// afterEach.
//
// Pattern: mirrors test/integration/tmux-introspect.test.ts exactly (private
// socket, swapSocketSpawn adapter, test.skipIf(!tmuxAvailable), setup/teardown).
//
// Pre-fix vs post-fix:
//   Pre-fix (openPaneInSession targeting `<session>:0`, no pane id):
//     tmux splits from the ACTIVE pane (dashboard, ~57 cols) -> worker is
//     born ~57 cols wide in the bottom-right corner.
//   Post-fix (openPaneInSession targeting orchPaneId explicitly, -l 60%):
//     tmux splits from orchPaneId regardless of the active pane -> worker
//     is born ~162 cols wide in the orchestrator column.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';

import {
	openPaneInSession,
	clampDashboardWidth,
	type SpawnFn,
} from '../../src/tmux/session.ts';

const TEST_SOCK = 'cam-it-worker-geo';
const SESSION = 'worker-geo-test';
const WINDOW_WIDTH = 220;
const WINDOW_HEIGHT = 50;

const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

/** Run tmux on the private test socket directly (for setup/teardown). */
function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync('tmux', ['-L', TEST_SOCK, ...args], { stdio: 'pipe' });
}

/**
 * SpawnFn passed to the helpers. They emit argv like `['-L', 'cam', ...]`;
 * swap the socket name so the call lands on the private test socket instead
 * of the real `cam` one.
 */
const swapSocketSpawn: SpawnFn = (cmd, args, opts) => {
	const swapped = [...args];
	const lIdx = swapped.indexOf('-L');
	if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
	return spawnSync(cmd, swapped, { stdio: opts?.stdio ?? 'pipe' }) as ReturnType<SpawnFn>;
};

/** Read the pane geometry via real display-message. Semicolons as separator
 *  (tmux mangles a literal TAB to `_` in -F output, per CAM-55). */
function getGeometry(
	paneId: string,
): { width: number; height: number; left: number; top: number } {
	const out = tmuxRaw([
		'display-message',
		'-p',
		'-t',
		paneId,
		'#{pane_width};#{pane_height};#{pane_left};#{pane_top}',
	])
		.stdout.toString()
		.trim();
	const parts = out.split(';').map(Number);
	return {
		width: parts[0] ?? 0,
		height: parts[1] ?? 0,
		left: parts[2] ?? 0,
		top: parts[3] ?? 0,
	};
}

beforeEach(() => {
	if (!tmuxAvailable) return;
	// Kill any leftover server, then create a fresh one with a known geometry.
	tmuxRaw(['kill-server']);
	tmuxRaw([
		'new-session',
		'-d',
		'-s',
		SESSION,
		'-x',
		String(WINDOW_WIDTH),
		'-y',
		String(WINDOW_HEIGHT),
	]);
	Bun.sleepSync(200);
});

afterEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
});

test.skipIf(!tmuxAvailable)(
	'worker pane spans the orchestrator column (wide) even when the dashboard pane is active',
	() => {
		// 1. Identify the orchestrator pane id (index 0, born with new-session).
		//    Semicolon-separated format: TABs are mangled to `_` by tmux.
		const listOut = tmuxRaw([
			'list-panes',
			'-t',
			SESSION,
			'-F',
			'#{pane_index};#{pane_id}',
		])
			.stdout.toString()
			.trim();
		const orchPaneId =
			listOut
				.split('\n')
				.find((l) => l.trim().startsWith('0;'))
				?.slice(2) // drop "0;" prefix
				.trim() ?? '';
		expect(orchPaneId).toMatch(/^%\d+$/);

		// 2. Create the right dashboard column (horizontal split from orch pane).
		//    Use the same clampDashboardWidth formula as ensureProjectSession so
		//    the geometry matches the real session layout.
		const dashWidth = clampDashboardWidth(WINDOW_WIDTH);
		const dashOut = tmuxRaw([
			'split-window',
			'-t',
			orchPaneId,
			'-h',
			'-l',
			String(dashWidth),
			'-d',
			'-P',
			'-F',
			'#{pane_id}',
			'cat',
		])
			.stdout.toString()
			.trim();
		const dashPaneId = dashOut;
		expect(dashPaneId).toMatch(/^%\d+$/);
		Bun.sleepSync(150);

		// 3. Make the DASHBOARD pane the ACTIVE pane (the recreate scenario in
		//    CAM-65/CAM-80: the worker is recreated while a non-orchestrator pane
		//    is focused). Without the CAM-80 fix, a bare `split-window -t
		//    <session>:0` would inherit the active pane's geometry (narrow).
		tmuxRaw(['select-pane', '-t', dashPaneId]);
		Bun.sleepSync(100);

		// 4. Open the worker pane through the PRODUCTION openPaneInSession path,
		//    passing orchPaneId as the explicit split target. This is the real
		//    production helper (src/tmux/session.ts) -- not a reimplementation.
		const workerPaneId = openPaneInSession(SESSION, ['cat'], swapSocketSpawn, orchPaneId);
		expect(workerPaneId).toMatch(/^%\d+$/);
		Bun.sleepSync(150);

		// 5. Measure pane geometries via real display-message round-trips.
		const orchGeo = getGeometry(orchPaneId);
		const dashGeo = getGeometry(dashPaneId);
		const workerGeo = getGeometry(workerPaneId);

		// All measurements must be non-zero (sanity guard).
		expect(orchGeo.width).toBeGreaterThan(0);
		expect(dashGeo.width).toBeGreaterThan(0);
		expect(workerGeo.width).toBeGreaterThan(0);

		// -----------------------------------------------------------------------
		// 6. Discriminating geometry assertions.
		//
		//    A. Worker width spans the orchestrator column.
		//       After a vertical split from orchPaneId, the worker and the (now
		//       shorter) orchestrator pane share the same column width exactly.
		//       Allow a tolerance of ±1 col for tmux border rounding.
		//       Pre-fix: splitting from the active dashboard yields worker_width
		//       ~= dashGeo.width (narrow, ~57). This assertion would FAIL pre-fix.
		// -----------------------------------------------------------------------
		expect(workerGeo.width).toBeGreaterThanOrEqual(orchGeo.width - 1);
		expect(workerGeo.width).toBeLessThanOrEqual(orchGeo.width + 1);

		// B. Worker is clearly wider than the dashboard column (the core oracle).
		//    At 220 cols: orch col ~162, dash col ~57 -> gap is > 100 cols.
		//    Pre-fix: worker_width ~= dashGeo.width (both narrow). This assertion
		//    would FAIL pre-fix when worker_width == dashGeo.width.
		expect(workerGeo.width).toBeGreaterThan(dashGeo.width + 5);

		// C. Worker and orchestrator share the same left edge (same column).
		//    After a vertical split of the orch column, both sub-panes start at
		//    column 0. The dashboard starts at the right (column ~163).
		//    Pre-fix: splitting from dashboard yields worker_left == dashGeo.left.
		expect(workerGeo.left).toBe(orchGeo.left);

		// D. Worker height is the lower ~60% share of the orchestrator column.
		//    split-window -l 60% allocates 60% of the parent column height to the
		//    NEW pane (the worker). Allow ±2 rows for tmux rounding.
		//    orchColumnHeight = orch.height + worker.height + 1 (divider row).
		const orchColumnHeight = orchGeo.height + workerGeo.height + 1;
		const expectedWorkerHeight = Math.round(orchColumnHeight * 0.6);
		expect(workerGeo.height).toBeGreaterThanOrEqual(expectedWorkerHeight - 2);
		expect(workerGeo.height).toBeLessThanOrEqual(expectedWorkerHeight + 2);

		// E. Worker is below the orchestrator pane (higher top offset).
		expect(workerGeo.top).toBeGreaterThan(orchGeo.top);
	},
);
