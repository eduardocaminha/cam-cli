// src/commands/status.ts
//
// Implementation of `cam status` — reads the local loop state and prints a
// one-glance summary of the current run. Reads three sources, all from the
// current cwd's repo:
//
//   1. `.claude/cam-loop.local.md` — the cam-loop plugin's state file.
//      YAML frontmatter (`active`, `iteration`, `max_iterations`, `started_at`,
//      `completion_promise`, `session_id`) followed by the loop's prompt body.
//      When this file is absent, no loop is active → status: idle.
//   2. `prd.json` (in the cwd) — the harness PRD. We pull the current story —
//      defined as the highest-priority `passes:false` story — and surface its
//      id + title so the operator knows what's being worked on.
//   3. The last commit on the current branch (cwd's git repo) — surfaces what
//      was last committed, so a stalled loop is visually distinguishable from
//      a productive one. Best-effort: if the cwd is not a git repo, we skip
//      the commit line rather than failing.
//
// Acceptance criteria (US-008):
//   1. Reads .claude/cam-loop.local.md + prd.json + last commit; prints:
//      current story id+title, iteration N/M, wall-clock since start, sleep
//      state (active / sleeping / no-loop).
//   2. Exits 0 with sensible output even when no loop is active (`status: idle`).
//   3. Bun unit tests using a tmpdir as `$HOME` substitute — we use `cwd`
//      injection (mirrors `runNext`) since the state files live under cwd,
//      not `$HOME`.
//   4. `bunx tsc --noEmit` passes.
//
// Sleep-state semantics: the plugin doesn't write a "sleeping" marker per se,
// but a rate-limit pause manifests as the loop being armed (state file
// present, active:true) but no recent commits or stdout. We surface a `state`
// value of `active` (state file present + active:true), `paused` (state file
// present + active:false — the plugin sets this on completion or cancel),
// `idle` (no state file at all). A future story can promote `active-but-stalled`
// to a third bucket if we add a heartbeat field.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import yaml from 'js-yaml';

import {
	accent,
	chalk,
	muted,
	printError,
	printHint,
	printSuccess,
	printWarning,
	warning,
	color,
} from '../logging/color.ts';
import {
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
} from '../logging/screen.ts';

// --- Constants -------------------------------------------------------------

const STATE_FILE_PATH = '.claude/cam-loop.local.md';
const PRD_PATH = 'prd.json';

// --- Types -----------------------------------------------------------------

/**
 * Parsed shape of the YAML frontmatter in `.claude/cam-loop.local.md`. The
 * plugin defines all keys; we treat each as optional so a partially-written
 * state file (e.g. one whose loop crashed mid-flush) still parses cleanly and
 * the operator gets a useful status report instead of a parse error.
 */
export interface LoopState {
	active?: boolean;
	iteration?: number;
	max_iterations?: number;
	completion_promise?: string | null;
	started_at?: string;
	session_id?: string;
	/**
	 * PID of the long-running driver process that owns the loop. Written by
	 * `cam next` (US-007 + US-010); consumed by `cam resume` to detect
	 * orphaned state files (PID present but no live process). Optional for
	 * back-compat with state files written before the field existed.
	 */
	pid?: number;
}

/**
 * Subset of `prd.json` we care about. The schema is large; status only needs
 * the ordered story queue to identify the current story.
 */
export interface PrdStory {
	id: string;
	title: string;
	priority?: number;
	passes?: boolean;
}

export interface PrdShape {
	userStories?: PrdStory[];
	branchName?: string;
}

export type StatusState = 'idle' | 'active' | 'paused';

export interface StatusReport {
	state: StatusState;
	currentStory?: { id: string; title: string };
	iteration?: { current: number; max: number };
	wallClock?: string; // human-readable elapsed since started_at
	startedAt?: string; // ISO from state file
	completionPromise?: string | null;
	branchName?: string; // from cwd's git repo
	lastCommit?: { sha: string; subject: string };
}

// --- Parsers ---------------------------------------------------------------

/**
 * Parse the loop's state-file body. The file is YAML frontmatter delimited by
 * `---` lines, followed by a prompt body. We only need the frontmatter; the
 * body is operator-readable but not machine-relevant for status.
 *
 * Returns `null` on malformed input — the caller treats that as `idle` since
 * a corrupt state file is functionally indistinguishable from a missing one
 * for status-reporting purposes (the operator should `cam stop` and start
 * fresh either way).
 */
export function parseStateFile(contents: string): LoopState | null {
	const trimmed = contents.trimStart();
	if (!trimmed.startsWith('---')) return null;
	// Find the closing `---` on its own line. We split on `\n` and walk —
	// safer than a multiline regex for paths with stray `---` inside the body.
	const lines = trimmed.split('\n');
	if (lines[0]?.trim() !== '---') return null;
	let endIdx = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i]?.trim() === '---') {
			endIdx = i;
			break;
		}
	}
	if (endIdx < 0) return null;
	const fmText = lines.slice(1, endIdx).join('\n');
	let parsed: unknown;
	try {
		parsed = yaml.load(fmText);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object') return null;
	const obj = parsed as Record<string, unknown>;
	const out: LoopState = {};
	if (typeof obj['active'] === 'boolean') out.active = obj['active'];
	if (typeof obj['iteration'] === 'number') out.iteration = obj['iteration'];
	if (typeof obj['max_iterations'] === 'number') out.max_iterations = obj['max_iterations'];
	if (obj['completion_promise'] === null) {
		out.completion_promise = null;
	} else if (typeof obj['completion_promise'] === 'string') {
		out.completion_promise = obj['completion_promise'];
	}
	if (typeof obj['started_at'] === 'string') out.started_at = obj['started_at'];
	if (typeof obj['session_id'] === 'string') out.session_id = obj['session_id'];
	if (typeof obj['pid'] === 'number' && Number.isFinite(obj['pid']) && obj['pid'] > 0) {
		out.pid = obj['pid'];
	}
	return out;
}

/**
 * Pick the "current story" from a PRD's stories list. Definition: the
 * highest-priority entry where `passes:false`. Mirrors the implementer's
 * selection logic so `cam status` and `/cam-next` agree on what's
 * being worked on. Returns `null` when the PRD has no pending stories.
 */
export function pickCurrentStory(prd: PrdShape): PrdStory | null {
	const stories = prd.userStories ?? [];
	const pending = stories.filter((s) => s.passes === false);
	if (pending.length === 0) return null;
	pending.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
	return pending[0] ?? null;
}

/**
 * Format a duration in milliseconds as a compact human-readable string.
 * Examples: `42s`, `7m 12s`, `2h 03m`, `1d 04h`. Returns `unknown` on negative
 * or NaN input. We deliberately avoid sub-second precision — wall-clock since
 * loop start is informational, not a stopwatch.
 */
export function formatWallClock(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return 'unknown';
	const totalSec = Math.floor(ms / 1000);
	const days = Math.floor(totalSec / 86400);
	const hours = Math.floor((totalSec % 86400) / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (days > 0) {
		return `${days}d ${String(hours).padStart(2, '0')}h`;
	}
	if (hours > 0) {
		return `${hours}h ${String(minutes).padStart(2, '0')}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
	}
	return `${seconds}s`;
}

// --- Filesystem + git helpers ----------------------------------------------

/**
 * Read + parse the loop's state file under `cwd`. Returns `null` when the
 * file is missing or unreadable; callers treat that as the `idle` state.
 */
function readStateFile(cwd: string): LoopState | null {
	const path = join(cwd, STATE_FILE_PATH);
	if (!existsSync(path)) return null;
	let body: string;
	try {
		body = readFileSync(path, 'utf8');
	} catch {
		return null;
	}
	return parseStateFile(body);
}

/**
 * Read + parse `prd.json` under `cwd`. Returns `null` when missing or invalid.
 * A bad PRD is non-fatal for `cam status` — we still print the loop's
 * iteration counter, just without a story id.
 */
function readPrd(cwd: string): PrdShape | null {
	const path = join(cwd, PRD_PATH);
	if (!existsSync(path)) return null;
	try {
		const body = readFileSync(path, 'utf8');
		const parsed = JSON.parse(body) as unknown;
		if (parsed === null || typeof parsed !== 'object') return null;
		return parsed as PrdShape;
	} catch {
		return null;
	}
}

/**
 * Best-effort branch + last-commit lookup. Skips silently when cwd is not a
 * git repo. Returns separate `branchName` + `lastCommit` slots so the caller
 * can surface partial info.
 */
function readGitInfo(cwd: string): { branchName?: string; lastCommit?: { sha: string; subject: string } } {
	const branch = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
	if (branch.status !== 0) return {};
	const branchName = branch.stdout.trim() || undefined;

	const log = spawnSync('git', ['-C', cwd, 'log', '-1', '--pretty=format:%h %s'], { encoding: 'utf8' });
	const out: { branchName?: string; lastCommit?: { sha: string; subject: string } } = {};
	if (branchName) out.branchName = branchName;
	if (log.status === 0) {
		const line = log.stdout.trim();
		const space = line.indexOf(' ');
		if (space > 0) {
			out.lastCommit = { sha: line.slice(0, space), subject: line.slice(space + 1) };
		}
	}
	return out;
}

// --- Public entrypoint -----------------------------------------------------

export interface StatusOptions {
	/** Override cwd; default `process.cwd()`. */
	cwd?: string;
	/** Override "now" for wall-clock calculations (tests pin a deterministic time). */
	now?: () => Date;
}

/**
 * Build a `StatusReport` without doing any I/O for printing. Exposed for tests
 * + future programmatic consumers (e.g. the dashboard might subscribe to a
 * status snapshot in a later story).
 */
export function buildStatusReport(options: StatusOptions = {}): StatusReport {
	const cwd = options.cwd ?? process.cwd();
	const now = options.now ?? (() => new Date());
	const state = readStateFile(cwd);
	const prd = readPrd(cwd);
	const git = readGitInfo(cwd);

	const report: StatusReport = { state: 'idle' };
	if (git.branchName) report.branchName = git.branchName;
	if (git.lastCommit) report.lastCommit = git.lastCommit;

	if (!state) {
		// No loop state file. PRD might still exist — surface the "next pending"
		// story so the operator sees what would run next.
		if (prd) {
			const story = pickCurrentStory(prd);
			if (story) report.currentStory = { id: story.id, title: story.title };
		}
		return report;
	}

	report.state = state.active === false ? 'paused' : 'active';
	if (typeof state.iteration === 'number' && typeof state.max_iterations === 'number') {
		report.iteration = { current: state.iteration, max: state.max_iterations };
	}
	if (state.started_at) {
		report.startedAt = state.started_at;
		const startMs = Date.parse(state.started_at);
		if (Number.isFinite(startMs)) {
			report.wallClock = formatWallClock(now().getTime() - startMs);
		}
	}
	if (state.completion_promise !== undefined) {
		report.completionPromise = state.completion_promise;
	}

	if (prd) {
		const story = pickCurrentStory(prd);
		if (story) report.currentStory = { id: story.id, title: story.title };
	}
	return report;
}

/**
 * Pretty-print a `StatusReport` to stdout. Always exits 0 — `cam status` is
 * a read-only inspection, never a failure. Idle output is intentionally
 * sparse: a one-line `status: idle` plus (if present) the next-pending story
 * + branch info, so the operator can confirm the right cwd.
 */
/** Column width for entry keys (e.g. `state    `, `story    `). */
const KEY_COL_WIDTH = 9;

/** Indent used inside Sections — matches `screen.ts` and the Ink Section. */
const CONTENT_INDENT = '    ';

/**
 * Render a state indicator (icon + label) using the unified palette:
 *   idle   → muted ○ idle
 *   active → accent ● active
 *   paused → warning ! paused
 */
function renderStateIndicator(state: 'idle' | 'active' | 'paused'): string {
	if (state === 'idle') return `${muted('○')} ${muted('idle')}`;
	if (state === 'paused') return `${warning('!')} paused`;
	return `${accent('●')} active`;
}

/** One key/value row inside the Loop section (bold key column + value). */
function renderEntry(key: string, value: string): string {
	return `${CONTENT_INDENT}${chalk.bold(key.padEnd(KEY_COL_WIDTH))}${value}`;
}

export function runStatus(options: StatusOptions = {}): number {
	const report = buildStatusReport(options);

	emitTitle('cam status');
	emitSectionHeading('Loop');

	// State indicator is always shown; the rest of the rows depend on which
	// data is available (idle skips iter/since/promise; paused keeps them).
	process.stdout.write(`${renderEntry('state', renderStateIndicator(report.state))}\n`);

	if (report.state === 'idle') {
		if (report.currentStory) {
			process.stdout.write(
				`${renderEntry('next', `${accent(report.currentStory.id)} ${report.currentStory.title}`)}\n`,
			);
		}
		if (report.branchName) {
			process.stdout.write(`${renderEntry('branch', report.branchName)}\n`);
		}
		if (report.lastCommit) {
			process.stdout.write(
				`${renderEntry('last', `${muted(report.lastCommit.sha)} ${report.lastCommit.subject}`)}\n`,
			);
		}
		process.stdout.write('\n');
		printHint('No `.claude/cam-loop.local.md` — start a loop with `cam next` (or `/cam-loop` from inside claude)');
		emitTrailingBlank();
		return 0;
	}

	if (report.currentStory) {
		process.stdout.write(
			`${renderEntry('story', `${accent(report.currentStory.id)} ${report.currentStory.title}`)}\n`,
		);
	} else {
		process.stdout.write(`${renderEntry('story', muted('(no pending story in prd.json)'))}\n`);
	}
	if (report.iteration) {
		process.stdout.write(`${renderEntry('iter', `${report.iteration.current} / ${report.iteration.max}`)}\n`);
	}
	if (report.wallClock) {
		const sinceVal = `${report.wallClock}${report.startedAt ? ` ${muted(`(${report.startedAt})`)}` : ''}`;
		process.stdout.write(`${renderEntry('since', sinceVal)}\n`);
	}
	if (report.branchName) {
		process.stdout.write(`${renderEntry('branch', report.branchName)}\n`);
	}
	if (report.lastCommit) {
		process.stdout.write(
			`${renderEntry('last', `${muted(report.lastCommit.sha)} ${report.lastCommit.subject}`)}\n`,
		);
	}
	if (report.completionPromise !== undefined) {
		const promiseShown = report.completionPromise === null ? muted('(none)') : `"${report.completionPromise}"`;
		process.stdout.write(`${renderEntry('promise', promiseShown)}\n`);
	}

	if (report.state === 'paused') {
		printWarning('Loop is paused (active:false in state file)', 'Run `cam stop` to clear, then `cam next` to restart');
	}
	emitTrailingBlank();
	return 0;
}

// Ensure helpers don't get tree-shaken away in unused-export sweeps.
void statSync;
void printError;
void printSuccess;
