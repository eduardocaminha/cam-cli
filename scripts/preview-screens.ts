// scripts/preview-screens.ts
//
// Color preview harness for the LINEAR-PRINT screens (cam status, cam stop,
// ...). This is the print-path counterpart to `scripts/ui-snapshot.tsx`, which
// covers the Ink screens.
//
// Why a separate harness: the Ink screens render through ink-testing-library
// (which strips ANSI), so ui-snapshot is colorless by design. The print
// screens instead call their `run*` function directly, writing real ANSI to
// THIS process's stdout, so when you run it in a terminal you see the actual
// colors. Fixtures (state file, prd.json, a throwaway git repo, a fake tmux)
// are built in a tmpdir and removed afterwards.
//
// Usage:
//   bun scripts/preview-screens.ts            # every screen, every state
//   bun scripts/preview-screens.ts status     # just `cam status` states
//   bun scripts/preview-screens.ts stop       # just `cam stop` states
//
// Color notes:
//   - In a TTY, chalk enables color automatically.
//   - Piping into a pager? Force it: FORCE_COLOR=1 bun scripts/preview-screens.ts | less -R
//
// Extending (phase 2): add a `previewRun` / `previewResume` etc. and register
// it in SCREENS below. Commands that spawn claude/tmux should be driven
// through their dry-run path (e.g. CAM_RUN_DRY_RUN=1, `cam resume --dry-run`)
// so the preview never launches a real session.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';

import { runStatus } from '../src/commands/status.ts';
import { runStop, type SpawnSyncFn } from '../src/commands/stop.ts';

const HR = '─'.repeat(72);

/** Labeled separator before each variation, matching ui-snapshot.tsx. */
function section(title: string): void {
	process.stdout.write(`\n${HR}\n  ${title}\n${HR}\n`);
}

// A fixed "now" so wall-clock output ("since") is deterministic across runs.
const NOW = new Date('2026-06-05T13:30:00Z');

// Frontmatter body shared by the active/paused status fixtures. `active`
// flips between the two states; everything else stays constant.
function loopStateFile(active: boolean): string {
	return [
		'---',
		`active: ${active}`,
		'iteration: 3',
		'max_iterations: 30',
		'started_at: "2026-06-04T12:00:00Z"',
		'completion_promise: "COMPLETE"',
		'---',
		'',
		'/cam-next',
		'',
	].join('\n');
}

const PRD_FIXTURE = JSON.stringify({
	userStories: [{ id: 'US-014', title: 'align print screens to Ink', priority: 14, passes: false }],
});

/**
 * Build a throwaway repo for a `cam status` state. `idle` has no state file;
 * `active`/`paused` get the loop state file + a prd.json. All three get a
 * single empty commit so the branch + last-commit lines render.
 */
function makeStatusFixture(state: 'idle' | 'active' | 'paused'): string {
	const dir = mkdtempSync(join(tmpdir(), `cam-preview-status-${state}-`));
	spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
	spawnSync(
		'git',
		['-c', 'user.email=cam@example.com', '-c', 'user.name=cam', 'commit', '-q', '--allow-empty', '-m', 'wip: align print screens'],
		{ cwd: dir },
	);
	writeFileSync(join(dir, 'prd.json'), PRD_FIXTURE);
	if (state !== 'idle') {
		mkdirSync(join(dir, '.claude'), { recursive: true });
		writeFileSync(join(dir, '.claude', 'cam-loop.local.md'), loopStateFile(state === 'active'));
	}
	return dir;
}

function previewStatus(): void {
	for (const state of ['idle', 'active', 'paused'] as const) {
		section(`cam status — ${state}`);
		const dir = makeStatusFixture(state);
		try {
			runStatus({ cwd: dir, now: () => NOW });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

/** Minimal SpawnSyncReturns with a chosen exit status — enough for stop's
 *  tmux probes (it only reads `.status`). */
function fakeSpawn(status: number): SpawnSyncReturns<string> {
	return { pid: 0, output: [], stdout: '', stderr: '', status, signal: null };
}

/**
 * Fake tmux for `cam stop`:
 *   `tmux -V`               → available (status 0)
 *   `tmux has-session`      → alive only in the "cleaned" scenario
 *   `tmux kill-session`     → succeeds
 */
function stopSpawn(sessionAlive: boolean): SpawnSyncFn {
	return (_cmd, args) => {
		if (args[0] === 'has-session') return fakeSpawn(sessionAlive ? 0 : 1);
		return fakeSpawn(0);
	};
}

function previewStop(): void {
	// Scenario A: something to clean → accent (green) "Done" close.
	section('cam stop — cleaned (state file + tmux session present)');
	const cleanedDir = mkdtempSync(join(tmpdir(), 'cam-preview-stop-cleaned-'));
	mkdirSync(join(cleanedDir, '.claude'), { recursive: true });
	writeFileSync(join(cleanedDir, '.claude', 'cam-loop.local.md'), 'placeholder\n');
	try {
		runStop({ cwd: cleanedDir, spawnSyncFn: stopSpawn(true) });
	} finally {
		rmSync(cleanedDir, { recursive: true, force: true });
	}

	// Scenario B: nothing to clean → neutral (muted) "Done" close.
	section('cam stop — nothing to clean');
	const emptyDir = mkdtempSync(join(tmpdir(), 'cam-preview-stop-empty-'));
	try {
		runStop({ cwd: emptyDir, spawnSyncFn: stopSpawn(false) });
	} finally {
		rmSync(emptyDir, { recursive: true, force: true });
	}
}

const SCREENS: Record<string, () => void> = {
	status: previewStatus,
	stop: previewStop,
};

function main(): void {
	const which = process.argv[2];
	if (which && !(which in SCREENS)) {
		process.stderr.write(`unknown screen: ${which}\navailable: ${Object.keys(SCREENS).join(', ')} (or omit for all)\n`);
		process.exit(1);
	}
	const names = which ? [which] : Object.keys(SCREENS);
	for (const name of names) {
		SCREENS[name]!();
	}
	process.stdout.write('\n');
}

main();
