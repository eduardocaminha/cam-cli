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
import { runResume, type ResumeOptions, type KillFn } from '../src/commands/resume.ts';
import { runRun } from '../src/commands/run.ts';
import { runNext, type NextSpawnFn } from '../src/commands/next.ts';
import { runPlan, type SpawnFn as PlanSpawnFn, type PromptFn as PlanPromptFn } from '../src/commands/plan.ts';

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

// --- cam resume -------------------------------------------------------------

const PRD_RESUME_PENDING = JSON.stringify({
	userStories: [{ id: 'US-014', title: 'align print screens to Ink', priority: 14, passes: false }],
});
const PRD_RESUME_COMPLETE = JSON.stringify({
	userStories: [{ id: 'US-014', title: 'align print screens to Ink', priority: 14, passes: true }],
});
const PRD_RESUME_MIXED = JSON.stringify({
	userStories: [
		{ id: 'US-013', title: 'shared design tokens', priority: 13, passes: true },
		{ id: 'US-014', title: 'align print screens to Ink', priority: 14, passes: false },
	],
});

/** Loop state file with a pid — liveness is decided by the injected killFn,
 *  not the pid value, so any positive integer works. */
function resumeStateFile(): string {
	return [
		'---',
		'active: true',
		'iteration: 3',
		'max_iterations: 30',
		'started_at: "2026-06-04T12:00:00Z"',
		'pid: 4242',
		'---',
		'',
		'/cam-next',
		'',
	].join('\n');
}

/** Build a throwaway repo for a `cam resume` scenario. `state` writes the loop
 *  state file; `prd` (a JSON string) is dropped in as prd.json when given. */
function makeResumeFixture(state: boolean, prd: string | null): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-preview-resume-'));
	if (prd) writeFileSync(join(dir, 'prd.json'), prd);
	if (state) {
		mkdirSync(join(dir, '.claude'), { recursive: true });
		writeFileSync(join(dir, '.claude', 'cam-loop.local.md'), resumeStateFile());
	}
	return dir;
}

/** Fake `git log -1 --format=%ct` returning a commit `agoMs` before NOW. */
function fakeGitSpawn(agoMs: number): SpawnSyncFn {
	const ct = Math.floor((NOW.getTime() - agoMs) / 1000);
	return () => ({ pid: 0, output: [], stdout: `${ct}\n`, stderr: '', status: 0, signal: null });
}

const deadKill: KillFn = () => {
	throw new Error('no such process');
};
const aliveKill: KillFn = () => {
	/* alive: process.kill(pid, 0) returns without throwing */
};

const HOUR = 60 * 60 * 1000;

/** Run one resume scenario in its fixture, always cleaning up the tmpdir. */
async function runResumeScenario(dir: string, opts: ResumeOptions): Promise<void> {
	try {
		await runResume({ cwd: dir, now: () => NOW, ...opts });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function previewResume(): Promise<void> {
	section('cam resume — idle (no loop state, ready for a fresh cam next)');
	await runResumeScenario(makeResumeFixture(false, PRD_RESUME_PENDING), {
		spawnFn: fakeGitSpawn(HOUR),
		killFn: deadKill,
		retryMonitorFn: () => false,
	});

	section('cam resume — respawn (terminal closed: PID dead, recent commit)');
	await runResumeScenario(makeResumeFixture(true, PRD_RESUME_PENDING), {
		spawnFn: fakeGitSpawn(HOUR),
		killFn: deadKill,
		retryMonitorFn: () => false,
	});

	section('cam resume — noop (retry-monitor sleeping in a rate-limit window)');
	await runResumeScenario(makeResumeFixture(true, PRD_RESUME_PENDING), {
		spawnFn: fakeGitSpawn(HOUR),
		killFn: aliveKill,
		retryMonitorFn: () => true,
	});

	section('cam resume — success (PRD complete: auto-clean orphan state)');
	await runResumeScenario(makeResumeFixture(true, PRD_RESUME_COMPLETE), {
		spawnFn: fakeGitSpawn(HOUR),
		killFn: deadKill,
		retryMonitorFn: () => false,
	});

	section('cam resume — prompt then No (hard-kill orphan, operator declines)');
	await runResumeScenario(makeResumeFixture(true, PRD_RESUME_PENDING), {
		spawnFn: fakeGitSpawn(48 * HOUR),
		killFn: deadKill,
		retryMonitorFn: () => false,
		prompt: () => 'n',
	});

	section('cam resume — prompt then Reset (hard-kill orphan, wipe state)');
	await runResumeScenario(makeResumeFixture(true, PRD_RESUME_PENDING), {
		spawnFn: fakeGitSpawn(48 * HOUR),
		killFn: deadKill,
		retryMonitorFn: () => false,
		prompt: () => 'reset',
	});

	section('cam resume --mode reset-current-story');
	await runResumeScenario(makeResumeFixture(false, PRD_RESUME_MIXED), { mode: 'reset-current-story' });

	section('cam resume --mode reset-prd');
	await runResumeScenario(makeResumeFixture(false, PRD_RESUME_MIXED), { mode: 'reset-prd' });

	section('cam resume --mode reset-branch --force');
	await runResumeScenario(makeResumeFixture(true, PRD_RESUME_PENDING), { mode: 'reset-branch', force: true });
}

// --- cam run ----------------------------------------------------------------

/** Build a throwaway repo for a `cam run` scenario. `withAgent` controls
 *  whether the orchestrator agent file is present (its absence is the
 *  "not initialized" fatal path). */
function makeRunFixture(withAgent: boolean): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-preview-run-'));
	if (withAgent) {
		const agentsDir = join(dir, '.claude', 'agents');
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, 'subagent-orchestrator.md'), '# orchestrator\n');
	}
	return dir;
}

/** Run one `cam run` scenario under CAM_RUN_DRY_RUN=1 (so it never spawns a
 *  real tmux session), restoring the env var and removing the fixture after. */
function runRunScenario(withAgent: boolean): void {
	const saved = process.env['CAM_RUN_DRY_RUN'];
	process.env['CAM_RUN_DRY_RUN'] = '1';
	const dir = makeRunFixture(withAgent);
	try {
		runRun({ cwd: dir });
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (saved === undefined) delete process.env['CAM_RUN_DRY_RUN'];
		else process.env['CAM_RUN_DRY_RUN'] = saved;
	}
}

function previewRun(): void {
	section('cam run — create/attach (dry-run: orchestrator present, tmux available)');
	runRunScenario(true);
	section('cam run — not initialized (subagent-orchestrator.md missing → fatal on stderr)');
	runRunScenario(false);
}

// --- cam next ---------------------------------------------------------------

/** Fake spawn: every spawned process "exits" cleanly with 0. Used for both the
 *  dashboard split and the claude pane so `runNext` returns without launching
 *  anything real. */
const fakeNextSpawn: NextSpawnFn = () => ({ exited: Promise.resolve(0), kill: () => {} });

/** Common non-destructive `runNext` deps: fake spawn + writers that return a
 *  path without touching disk, fixed permission mode + frontmatter values. */
function nextPreviewOptions(hostMode: 'tmux-split' | 'inline') {
	return {
		hostMode,
		permissionMode: 'bypassPermissions',
		spawn: fakeNextSpawn,
		writer: (_cwd: string, _body: string) => '/project/.claude/cam-loop.local.md',
		hookMaterializer: () => '/project/.claude/hooks/cam-loop-stop.sh',
		settingsWriter: () => '/project/.claude/settings.local.json',
		startedAt: '2026-06-05T13:30:00Z',
		sessionId: 'preview-session',
		cwd: '/project',
	};
}

/** Run `fn` with `process.env[key]` temporarily set (or deleted when value is
 *  undefined), restoring the prior value afterward. */
async function withEnv(key: string, value: string | undefined, fn: () => Promise<unknown>): Promise<void> {
	const saved = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	try {
		await fn();
	} finally {
		if (saved === undefined) delete process.env[key];
		else process.env[key] = saved;
	}
}

async function previewNext(): Promise<void> {
	section('cam next — tmux-split, outside tmux (creates the "cam" session)');
	await withEnv('TMUX', undefined, () => runNext(nextPreviewOptions('tmux-split')));

	section('cam next — tmux-split, inside tmux (splits the current window)');
	await withEnv('TMUX', '/tmp/fake-tmux-socket', () => runNext(nextPreviewOptions('tmux-split')));

	section('cam next — inline (VS Code or no tmux: single pane)');
	await runNext(nextPreviewOptions('inline'));

	section('cam next — fatal (stop-hook materialization fails → stderr)');
	await runNext({
		hostMode: 'inline',
		permissionMode: 'bypassPermissions',
		hookMaterializer: () => {
			throw new Error('EACCES: permission denied, mkdir .claude/hooks');
		},
		cwd: '/project',
	});
}

// --- cam plan ---------------------------------------------------------------

interface PlanHarness {
	spawn: PlanSpawnFn;
	emitData: (text: string) => void;
	resolveExit: (code: number) => void;
}

/** Minimal PTY-spawn harness mirroring test/plan.test.ts: captures the onData
 *  callback so `emitData` can feed bytes (e.g. an APPROVE verdict line), and
 *  exposes `resolveExit` to end the fake subprocess. */
function makePlanHarness(): PlanHarness {
	let capturedOnData: ((b: Uint8Array) => void) | null = null;
	let resolveExit: (code: number) => void = () => {};
	const exited = new Promise<number>((r) => {
		resolveExit = r;
	});
	const enc = new TextEncoder();
	const terminal = { write: () => 0, resize: () => {}, close: () => {} };
	const spawn: PlanSpawnFn = (_cmd, callbacks) => {
		capturedOnData = callbacks.onData;
		return { exited, terminal, kill: () => {} };
	};
	return {
		spawn,
		emitData: (text) => capturedOnData?.(enc.encode(text)),
		resolveExit,
	};
}

/** Prompt fake that echoes the question + a canned answer, so the preview
 *  shows the decision point the way an operator's keystroke would. */
function planPreviewPrompt(answer: string): PlanPromptFn {
	return (question) => {
		process.stdout.write(`${question}${answer}\n`);
		return Promise.resolve(answer);
	};
}

async function previewPlan(): Promise<void> {
	section('cam plan — dispatched (interactive session starts, no verdict yet)');
	{
		const h = makePlanHarness();
		queueMicrotask(() => h.resolveExit(0));
		await runPlan({ spawn: h.spawn, prompt: planPreviewPrompt('y') });
	}

	section('cam plan — APPROVE then Yes (let the planner finish branch + commit)');
	{
		const h = makePlanHarness();
		queueMicrotask(() => {
			h.emitData('"verdict": "APPROVE"\n');
			setTimeout(() => h.resolveExit(0), 20);
		});
		await runPlan({ spawn: h.spawn, prompt: planPreviewPrompt('y') });
	}

	section('cam plan — APPROVE then No (cancel, terminate the planning session)');
	{
		const h = makePlanHarness();
		queueMicrotask(() => {
			h.emitData('"verdict": "APPROVE"\n');
			setTimeout(() => h.resolveExit(0), 20);
		});
		await runPlan({ spawn: h.spawn, prompt: planPreviewPrompt('n') });
	}

	section('cam plan — spawn failure (claude not on PATH → fatal on stderr)');
	{
		const throwingSpawn: PlanSpawnFn = () => {
			throw new Error('Executable not found in $PATH: claude');
		};
		await runPlan({ spawn: throwingSpawn, prompt: planPreviewPrompt('n') });
	}
}

const SCREENS: Record<string, () => void | Promise<void>> = {
	status: previewStatus,
	stop: previewStop,
	resume: previewResume,
	run: previewRun,
	next: previewNext,
	plan: previewPlan,
};

async function main(): Promise<void> {
	const which = process.argv[2];
	if (which && !(which in SCREENS)) {
		process.stderr.write(`unknown screen: ${which}\navailable: ${Object.keys(SCREENS).join(', ')} (or omit for all)\n`);
		process.exit(1);
	}
	const names = which ? [which] : Object.keys(SCREENS);
	for (const name of names) {
		await SCREENS[name]!();
	}
	process.stdout.write('\n');
}

void main();
