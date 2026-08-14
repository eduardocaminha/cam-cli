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
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

// Poll interval for every wait below. The shared helper's 20ms default spawns
// one tmux client per tick against a single-threaded server, which is exactly
// the process-table pressure CAM-446 recorded in scripts/cam/patterns.md.
const POLL_MS = 150;

// Every wait budget in this file is named here, and each test's external
// timeout is DERIVED from the waits that test actually performs plus one
// explicit non-wait margin (CAM-506 format). Hardcoding the outer timeout let
// the two drift into incoherence: the first test's internal budgets summed to
// 80s under a 60s outer timeout, so the outer one could never be reached.
const BUDGET = {
	/** A tmux split-window round-trip until the new pane is listed. */
	paneAppears: 5_000,
	/** The viewer pane comes up alive and running tail. */
	viewerUp: 5_000,
	/** The derived config log file is created under the scratch TMPDIR. */
	logFileAppears: 5_000,
	/** One burst of 2000-3000 padded lines through a real pty. */
	burst: 20_000,
	/** The viewer's captured viewport reaches a given mark. */
	viewerAdvances: 10_000,
	/** A transient in-place rotate finishes and exposes a valid capped size. */
	rotateSettles: 5_000,
} as const;

/**
 * Non-wait work each test performs outside the budgets above (file writes,
 * statSync, capture-pane round-trips, the surrounding tmux server setup and
 * teardown), plus slack. Explicit so each outer timeout stays derived rather
 * than guessed.
 */
const NON_WAIT_MARGIN_MS = 15_000;

const VIEWER_TEST_TIMEOUT_MS =
	BUDGET.paneAppears * 2 +
	BUDGET.viewerUp +
	BUDGET.logFileAppears +
	BUDGET.burst * 2 +
	BUDGET.viewerAdvances * 2 +
	BUDGET.rotateSettles * 2 +
	NON_WAIT_MARGIN_MS;

const SPACE_TEST_TIMEOUT_MS =
	BUDGET.paneAppears * 2 +
	BUDGET.viewerUp +
	BUDGET.logFileAppears +
	BUDGET.burst +
	BUDGET.viewerAdvances +
	BUDGET.rotateSettles +
	NON_WAIT_MARGIN_MS;

const CAPPED_LOG_SIZE_UPPER_BOUND = 210_000;

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

/** One `#{...}` format field of `paneId`, or '' once the pane is gone. */
function paneField(paneId: string, format: string): string {
	return tmuxRaw(['display-message', '-p', '-t', paneId, format]).stdout.toString().trim();
}

/**
 * Is `paneId` still a live pane of the test session?
 *
 * Deliberately NOT `#{pane_current_command} === 'tail'`: tmux on macOS resolves
 * that name through tcgetpgrp(), so it reports the pane's process-group leader,
 * which equals the final command only when default-shell EXECs the last command
 * of an `A; B` list. Measured here: zsh execs, bash and sh fork and stay alive
 * as the leader forever. The v|V arm passes its command as one string, so tmux
 * runs it under `default-shell -c` and that name is a property of the machine's
 * shell, not of the product (the log streams identically either way). A
 * zsh-vs-bash split is exactly what made those assertions pass locally and fail
 * on the CI runner.
 */
function paneAlive(paneId: string): boolean {
	if (!paneIds().includes(paneId)) return false;
	return paneField(paneId, '#{pane_dead}') === '0';
}

/**
 * Does `paneId` genuinely run `tail`? Scoped to the pane's own pid, so it is
 * never the machine-wide `pgrep -f` tautology CAM-446 filed (patterns.md): the
 * default-shell either exec'd tail, in which case the pane pid IS tail, or
 * forked it, in which case tail is a direct child of the pane pid. Both are the
 * same production behavior.
 */
function paneRunsTail(paneId: string): boolean {
	const pid = paneField(paneId, '#{pane_pid}');
	if (!pid) return false;
	const own = spawnSync('ps', ['-o', 'comm=', '-p', pid]).stdout.toString().trim();
	if (own.split('/').pop() === 'tail') return true;
	return spawnSync('pgrep', ['-P', pid, '-x', 'tail']).status === 0;
}

/**
 * Everything needed to tell apart the two hypotheses that produce an IDENTICAL
 * "predicate still false" string: a shell that forks instead of execs (no
 * product defect) versus a viewer pane that died right after being listed (a
 * real one). Without this dump the second hypothesis stays invisible.
 */
function viewerDiagnostics(paneId: string): string {
	const defaultShell = tmuxRaw(['show-options', '-g', 'default-shell']).stdout.toString().trim();
	const pid = paneField(paneId, '#{pane_pid}');
	const ps = pid
		? spawnSync('ps', ['-o', 'pid=,ppid=,comm=', '-p', pid]).stdout.toString().trim()
		: '';
	return [
		`tmux ${defaultShell || '(default-shell unreadable)'}`,
		`$SHELL: ${process.env['SHELL'] ?? '(unset)'}`,
		`pane ${paneId}: dead=${paneField(paneId, '#{pane_dead}') || '(no such pane)'} pid=${pid || '(no such pane)'}`,
		`ps: ${ps || '(no such process)'}`,
		`live panes: ${paneIds().join(' ') || '(none)'}`,
	].join('\n  ');
}

/** A viewer-pane wait whose timeout carries the diagnostics above. */
async function waitForViewer(
	label: string,
	paneId: string,
	predicate: () => boolean,
	timeoutMs: number,
): Promise<void> {
	try {
		await waitForCondition(predicate, { timeoutMs, intervalMs: POLL_MS });
	} catch (cause) {
		throw new Error(`${label}: still false after ${timeoutMs}ms\n  ${viewerDiagnostics(paneId)}`, {
			cause,
		});
	}
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

/**
 * Observe the log in either valid steady state around an in-place rotate:
 * non-empty and below the ceiling plus one writer chunk. `cat TMP > LOG`
 * briefly truncates LOG to zero before copying the capped bytes back, so a
 * single stat can race that implementation detail even after the viewer has
 * displayed the burst's last mark. Capture the size inside the successful
 * poll instead of statting again and reopening the same race.
 */
async function waitForCappedLogSize(logPath: string): Promise<number> {
	let observedSize = 0;
	await waitForCondition(
		() => {
			observedSize = statSync(logPath).size;
			return observedSize > 0 && observedSize < CAPPED_LOG_SIZE_UPPER_BOUND;
		},
		{ timeoutMs: BUDGET.rotateSettles, intervalMs: POLL_MS },
	);
	return observedSize;
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

		await waitForCondition(() => paneIds().length === 2, {
			timeoutMs: BUDGET.paneAppears,
			intervalMs: POLL_MS,
		});

		// Press 'v' -- no Enter, matching the script's `read -rsn1` single
		// raw-keystroke read over a real pty.
		tmuxRaw(['send-keys', '-t', menuPaneId, '-l', 'v']);
		await waitForCondition(() => paneIds().length === 3, {
			timeoutMs: BUDGET.paneAppears,
			intervalMs: POLL_MS,
		});

		const viewerPaneId = paneIds().find((id) => id !== configPaneId && id !== menuPaneId);
		expect(viewerPaneId).toBeTruthy();
		if (!viewerPaneId) return;
		await waitForViewer(
			'viewer pane comes up alive and running tail',
			viewerPaneId,
			() => paneAlive(viewerPaneId) && paneRunsTail(viewerPaneId),
			BUDGET.viewerUp,
		);

		// Locate the real derived log file (pid-namespaced, under the scratch
		// TMPDIR override) -- buildConfigLogPathAssignment pre-creates it empty.
		const logDir = join(scratch, 'cam-cli-config-log');
		await waitForCondition(
			() => existsSync(logDir) && readdirSync(logDir).some((f) => f.endsWith('.log')),
			{ timeoutMs: BUDGET.logFileAppears, intervalMs: POLL_MS },
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
		await waitForCondition(() => capture(configPaneId).includes('BURST1-DONE'), {
			timeoutMs: BUDGET.burst,
			intervalMs: POLL_MS,
		});

		// Real production defect fixed by this story: without deferring the
		// cap command's `$(wc -c < LOG)` past the menu script's own
		// double-quote evaluation, this stays at the full unbounded ~489_000
		// bytes fed above instead of being capped.
		const sizeAfterBurst1 = await waitForCappedLogSize(logPath);
		expect(sizeAfterBurst1).toBeGreaterThan(0);
		expect(sizeAfterBurst1).toBeLessThan(CAPPED_LOG_SIZE_UPPER_BOUND);

		// Real production defect fixed by this story: without resetting `key`
		// before every timed read, the v|V arm re-fires on every 2s poll,
		// flooding the window with extra viewer splits (config + menu +
		// viewer must still be exactly 3, even though burst 1's ~4-9s feed
		// necessarily spanned several 2s poll cycles).
		expect(paneIds().length).toBe(3);

		await waitForViewer(
			"viewer viewport reaches burst 1's last mark",
			viewerPaneId,
			() => capture(viewerPaneId).includes('MARK-002999'),
			BUDGET.viewerAdvances,
		);

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
		await waitForCondition(() => capture(configPaneId).includes('BURST2-DONE'), {
			timeoutMs: BUDGET.burst,
			intervalMs: POLL_MS,
		});
		await waitForViewer(
			"viewer viewport advances past the rotate to burst 2's last mark",
			viewerPaneId,
			() => capture(viewerPaneId).includes('ROUND2-002999'),
			BUDGET.viewerAdvances,
		);

		const sizeAfterBurst2 = await waitForCappedLogSize(logPath);
		expect(sizeAfterBurst2).toBeGreaterThan(0);
		expect(sizeAfterBurst2).toBeLessThan(CAPPED_LOG_SIZE_UPPER_BOUND);

		// Still exactly one config + one menu + one viewer pane, and the
		// viewer is still alive (not dead/exited) after the whole exchange.
		expect(paneIds().length).toBe(3);
		expect(paneAlive(viewerPaneId)).toBe(true);
		expect(paneRunsTail(viewerPaneId)).toBe(true);
	},
	{ timeout: VIEWER_TEST_TIMEOUT_MS },
);

// CAM-510 US-R2-006: `buildConfigLogCapCommand`'s path expansions used to be
// unquoted throughout (`cat ${LOG}.chunk >> ${LOG}`, etc.), and the `v|V`
// arm's trailing `tail -f ${CAM_CONFIG_LOG}` was unquoted too. `${LOG}`
// derives from `${TMPDIR:-/tmp}`, so a `TMPDIR` containing a space would
// word-split every one of those calls -- e.g. `cat` receiving `"/has"` and
// `"space/1234.log.chunk"` as two separate arguments instead of the one real
// path -- silently writing/reading the wrong paths, or erroring against a
// path fragment that doesn't exist. None of the direct-bash-spawn tests in
// test/setup-config-log.test.ts can observe this: they call
// `buildConfigLogCapCommand` with a plain scratch path they control (no
// space), never through the real `v|V` embedding this test drives.
test.skipIf(!tmuxAvailable)(
	'a TMPDIR containing a space does not word-split the derived log path -- the viewer stays alive and the log stays capped at the real, correctly-quoted path (CAM-510 US-R2-006)',
	async () => {
		const scratchParent = createTestTmpdir('cam-setup-menu-viewer-space-');
		const scratch = join(scratchParent, 'has space');
		mkdirSync(scratch, { recursive: true });

		const configPaneId = paneIds()[0];
		expect(configPaneId).toBeTruthy();
		if (!configPaneId) return;

		const menuFile = join(scratch, '.cam-setup-menu.sh');
		writeFileSync(menuFile, buildSetupMenuScript(), 'utf8');
		const orchPromptFile = join(scratch, '.cam-orchestrator-prompt.txt');
		writeFileSync(orchPromptFile, 'unused by this test (no CAM_SETUP_STATUS=DONE is ever emitted)', 'utf8');

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

		await waitForCondition(() => paneIds().length === 2, {
			timeoutMs: BUDGET.paneAppears,
			intervalMs: POLL_MS,
		});

		tmuxRaw(['send-keys', '-t', menuPaneId, '-l', 'v']);
		await waitForCondition(() => paneIds().length === 3, {
			timeoutMs: BUDGET.paneAppears,
			intervalMs: POLL_MS,
		});

		const viewerPaneId = paneIds().find((id) => id !== configPaneId && id !== menuPaneId);
		expect(viewerPaneId).toBeTruthy();
		if (!viewerPaneId) return;
		await waitForViewer(
			'viewer pane comes up alive and running tail',
			viewerPaneId,
			() => paneAlive(viewerPaneId) && paneRunsTail(viewerPaneId),
			BUDGET.viewerUp,
		);

		// A word-split write would either never create this directory (the
		// writer erroring against a nonexistent "/has" cwd-relative fragment)
		// or scatter a stray "has"/"space" sibling next to it; neither may
		// exist once the derived log path is confirmed to be real.
		const logDir = join(scratch, 'cam-cli-config-log');
		await waitForCondition(
			() => existsSync(logDir) && readdirSync(logDir).some((f) => f.endsWith('.log')),
			{ timeoutMs: BUDGET.logFileAppears, intervalMs: POLL_MS },
		);
		const scratchSiblings = readdirSync(scratch);
		expect(scratchSiblings).not.toContain('has');
		expect(scratchSiblings).not.toContain('space');
		const logFile = readdirSync(logDir).find((f) => f.endsWith('.log'));
		expect(logFile).toBeTruthy();
		const logPath = join(logDir, logFile ?? '');

		tmuxRaw([
			'send-keys', '-t', configPaneId,
			'for i in $(seq 1 2000); do printf \'MARK-%06d-%0150d\\n\' "$i" 0; done; echo BURST-DONE',
			'Enter',
		]);
		await waitForCondition(() => capture(configPaneId).includes('BURST-DONE'), {
			timeoutMs: BUDGET.burst,
			intervalMs: POLL_MS,
		});
		await waitForViewer(
			"viewer viewport reaches the burst's last mark",
			viewerPaneId,
			() => capture(viewerPaneId).includes('MARK-001999'),
			BUDGET.viewerAdvances,
		);

		const sizeAfterBurst = await waitForCappedLogSize(logPath);
		expect(sizeAfterBurst).toBeGreaterThan(0);
		expect(sizeAfterBurst).toBeLessThan(CAPPED_LOG_SIZE_UPPER_BOUND);

		expect(paneIds().length).toBe(3);
		expect(paneAlive(viewerPaneId)).toBe(true);
		expect(paneRunsTail(viewerPaneId)).toBe(true);
	},
	{ timeout: SPACE_TEST_TIMEOUT_MS },
);
