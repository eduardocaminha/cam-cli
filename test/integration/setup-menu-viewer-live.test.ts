// test/integration/setup-menu-viewer-live.test.ts
//
// Real-tmux integration test for CAM-510 US-R2-004: every existing test for
// buildConfigLogCapCommand (test/setup-config-log.test.ts) spawns the
// generated snippet directly under an explicit `bash` (spawnSync('bash',
// ['-c', command])), but production never runs it that way -- it is
// embedded, through several nested shell-parse layers (buildSetupMenuScript's
// own double-quoted `tmux split-window` argument, the literal single quotes
// wrapped around the cap command inside that argument, and the fresh shell
// `tmux pipe-pane -o` itself later spawns to run it), inside the real `v|V`
// case arm of the generated setup-menu script. Nothing in any prior
// CAM-510 diff crossed that tmux boundary. This test composes
// buildSetupMenuScript()'s actual output, executes it under real tmux
// exactly as spawnSetupTmux's inside-tmux branch does (src/commands/
// setup.ts), presses the real 'v' key (no Enter -- the script's `read
// -rsn1` reads one raw keystroke, matching a real interactive terminal),
// and drives real output through a real config pane -- proving the viewer
// pane this arm creates stays alive, the underlying log genuinely stays
// capped (not just "looks capped once the writer has already exited", the
// CAM-510 site-4 lesson already recorded in scripts/cam/patterns.md), and
// the viewer keeps advancing across (not freezing at) a real rotate.
//
// Writing this test caught two real production defects, both real-tmux-only
// and invisible to every prior bash-spawn test in
// test/setup-config-log.test.ts, both fixed by this story and both
// documented in scripts/cam/patterns.md:
//   1. bash's `read -rsn1 -t 2 key` leaves `key` at its PREVIOUS value on a
//      timeout with no new input, instead of clearing it -- one 'v' keypress
//      re-triggered the v|V arm on every single 2s poll forever, flooding
//      the window with new viewer splits until tmux ran out of space.
//   2. buildConfigLogCapCommand's `$(wc -c < LOG)` ceiling check was being
//      evaluated ONE TIME, EAGERLY, by the menu script's own double-quoted
//      `split-window` argument (bash performs command substitution inside
//      double quotes regardless of literal single-quote characters embedded
//      in the string -- those single quotes are not real quote delimiters
//      to that outer parser), permanently freezing the check at whatever
//      the log's byte count happened to be at v-keypress time (typically
//      0), silently disabling the entire byte-ceiling mechanism in real
//      production tmux usage: the log grew fully unbounded.
//
// Isolation: private, per-process `-L` test socket (never the real `cam`
// session socket), kill-server before/after. Mirrors
// test/integration/tmux-introspect.test.ts and
// test/integration/dashboard-pane-selfspawn.test.ts. Skips cleanly when
// tmux is absent.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { buildSetupMenuScript } from '../../src/commands/setup.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';
import { tmuxAvailable } from '../helpers/test-deps.ts';

// Per-process socket name (CAM-482 US-R8-001 convention): a fixed name would
// be destroyed by a second concurrent instance's beforeEach/afterEach.
const TEST_SOCK = `cam-it-setup-menu-viewer-${process.pid}`;
const SESSION = 'setupviewer';

/** Run tmux on the private test socket directly. */
function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync('tmux', ['-L', TEST_SOCK, ...args], { stdio: 'pipe' });
}

/** Live pane ids for the test session, via a real list-panes round-trip. */
function paneIds(): string[] {
	return tmuxRaw(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])
		.stdout.toString()
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/** Real pane_current_command for `paneId`, via a real display-message round-trip. */
function paneCommand(paneId: string): string {
	return tmuxRaw(['display-message', '-p', '-t', paneId, '#{pane_current_command}'])
		.stdout.toString()
		.trim();
}

/**
 * Current on-screen viewport for `paneId`, via a real capture-pane
 * round-trip. Deliberately NOT `-S -` (full scrollback): both bursts below
 * print megabytes of wrapped terminal rows (`tail -f`, on a truncation-based
 * rotate, re-streams the WHOLE rotated file from the top again, several
 * times over), which overflows spawnSync's default stdout buffer under
 * `-S -` and silently truncates mid-line. The current viewport is small,
 * bounded, and -- since both panes' cursors stay pinned to the bottom of a
 * live, continuously-scrolling stream -- always reflects the most recently
 * printed content, which is exactly what "still updating" needs to prove.
 */
function capture(paneId: string): string {
	return tmuxRaw(['capture-pane', '-t', paneId, '-p']).stdout.toString();
}

beforeEach(async () => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
	// A plain bash pane stands in for the real config-agent (claude) pane:
	// this test only needs a controllable, real pty to pipe-pane against.
	tmuxRaw(['new-session', '-d', '-s', SESSION, '-x', '100', '-y', '30', 'bash']);
	await waitForCondition(() => tmuxRaw(['has-session', '-t', SESSION]).status === 0);
});

afterEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
});

test.skipIf(!tmuxAvailable)(
	"the real v|V line stays a single viewer pane, genuinely caps the log (not just after the writer exits), and keeps advancing across a real rotate (CAM-510 US-R2-004)",
	async () => {
		const scratch = createTestTmpdir('cam-setup-menu-viewer-');

		const configPaneId = paneIds()[0];
		expect(configPaneId).toBeTruthy();
		if (!configPaneId) return;

		const menuFile = join(scratch, '.cam-setup-menu.sh');
		writeFileSync(menuFile, buildSetupMenuScript(), 'utf8');
		const orchPromptFile = join(scratch, '.cam-orchestrator-prompt.txt');
		writeFileSync(orchPromptFile, 'unused by this test (no CAM_SETUP_STATUS=DONE is ever emitted)', 'utf8');

		// Mirrors spawnSetupTmux's real inside-tmux `split-window` invocation
		// (src/commands/setup.ts) exactly: same -e vars, same `bash -c "bash
		// '<menuFile>'"` composition -- only the socket and the extra TMPDIR
		// override are test-only additions (TMPDIR keeps the derived config log
		// under the scratch root, never the real $TMPDIR).
		const menuResult = tmuxRaw([
			'split-window', '-t', SESSION, '-h', '-l', '36', '-d', '-P', '-F', '#{pane_id}',
			'-e', `CAM_CONFIG_PANE=${configPaneId}`,
			'-e', `CAM_ORCH_PROMPT_FILE=${orchPromptFile}`,
			'-e', `TMPDIR=${scratch}`,
			'bash', '-c', `bash '${menuFile}'`,
		]);
		expect(menuResult.status).toBe(0);
		const menuPaneId = menuResult.stdout.toString().trim();
		expect(menuPaneId).toBeTruthy();

		await waitForCondition(() => paneIds().length === 2, { timeoutMs: 5000 });

		// Press 'v' -- no Enter, matching the script's `read -rsn1` single
		// raw-keystroke read over a real pty.
		tmuxRaw(['send-keys', '-t', menuPaneId, '-l', 'v']);
		await waitForCondition(() => paneIds().length === 3, { timeoutMs: 5000 });

		const viewerPaneId = paneIds().find((id) => id !== configPaneId && id !== menuPaneId);
		expect(viewerPaneId).toBeTruthy();
		if (!viewerPaneId) return;
		await waitForCondition(() => paneCommand(viewerPaneId) === 'tail', { timeoutMs: 5000 });

		// Locate the real derived log file (pid-namespaced, under the scratch
		// TMPDIR override) -- buildConfigLogPathAssignment pre-creates it empty.
		const logDir = join(scratch, 'cam-cli-config-log');
		await waitForCondition(
			() => existsSync(logDir) && readdirSync(logDir).some((f) => f.endsWith('.log')),
			{ timeoutMs: 5000 },
		);
		const logFile = readdirSync(logDir).find((f) => f.endsWith('.log'));
		expect(logFile).toBeTruthy();
		const logPath = join(logDir, logFile ?? '');

		// Burst 1: real output through the real config pane, comfortably past
		// the real 200_000-byte CONFIG_LOG_CEILING_BYTES (~489KB raw across
		// 3000 padded lines), forcing several real rotates.
		tmuxRaw([
			'send-keys', '-t', configPaneId,
			'for i in $(seq 1 3000); do printf \'MARK-%06d-%0150d\\n\' "$i" 0; done; echo BURST1-DONE',
			'Enter',
		]);
		await waitForCondition(() => capture(configPaneId).includes('BURST1-DONE'), { timeoutMs: 20000 });

		// Real production defect fixed by this story: without deferring the
		// cap command's `$(wc -c < LOG)` past the menu script's own
		// double-quote evaluation, this stays at the full unbounded ~489_000
		// bytes fed above instead of being capped.
		const sizeAfterBurst1 = statSync(logPath).size;
		expect(sizeAfterBurst1).toBeGreaterThan(0);
		expect(sizeAfterBurst1).toBeLessThan(210_000);

		// Real production defect fixed by this story: without resetting `key`
		// before every timed read, the v|V arm re-fires on every 2s poll,
		// flooding the window with extra viewer splits (config + menu +
		// viewer must still be exactly 3, even though burst 1's ~4-9s feed
		// necessarily spanned several 2s poll cycles).
		expect(paneIds().length).toBe(3);

		await waitForCondition(() => capture(viewerPaneId).includes('MARK-002999'), { timeoutMs: 10000 });

		// Burst 2, past the rotate(s) burst 1 already forced: the frozen-viewer
		// defect US-R2-003's real-tmux repro exists to catch would leave the
		// viewer stuck on whatever mark was current right before the first
		// rotate -- continued advancement past it is the only way to falsify
		// that freeze under a genuinely live rotate (as opposed to a
		// direct-bash-spawned rotate, which every prior test in this area used).
		tmuxRaw([
			'send-keys', '-t', configPaneId,
			'for i in $(seq 1 3000); do printf \'ROUND2-%06d-%0150d\\n\' "$i" 0; done; echo BURST2-DONE',
			'Enter',
		]);
		await waitForCondition(() => capture(configPaneId).includes('BURST2-DONE'), { timeoutMs: 20000 });
		await waitForCondition(() => capture(viewerPaneId).includes('ROUND2-002999'), { timeoutMs: 10000 });

		const sizeAfterBurst2 = statSync(logPath).size;
		expect(sizeAfterBurst2).toBeGreaterThan(0);
		expect(sizeAfterBurst2).toBeLessThan(210_000);

		// Still exactly one config + one menu + one viewer pane, and the
		// viewer is still alive (not dead/exited) after the whole exchange.
		expect(paneIds().length).toBe(3);
		expect(paneCommand(viewerPaneId)).toBe('tail');
	},
	{ timeout: 60_000 },
);
