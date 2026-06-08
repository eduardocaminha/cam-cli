// src/commands/resume.ts
//
// Implementation of `cam resume` — the 4-mode recovery command.
//
// Reads three sources from the current cwd's repo and reconciles them into a
// recovery decision:
//
//   1. `.claude/cam-loop.local.md` (the cam-loop plugin's state file).
//      YAML frontmatter contains `active`, `iteration`, `max_iterations`,
//      `started_at`, `completion_promise`, `session_id`, and (per US-010) a
//      `pid` field that names the driver process owning the loop.
//   2. `prd.json` — the harness PRD. We pick the next story (highest-priority
//      `passes:false`) so the operator knows what would be picked up next.
//   3. The last commit on the current branch — git's `log -1 --format=%H %ct`.
//      The commit timestamp drives the 24h heuristic that distinguishes a
//      hard-kill orphan (Mode 3) from a freshly-interrupted loop (Mode 2).
//
// The 4 modes (acceptance criteria 2–5):
//   - `continue`            — Mode 1: operator typed mid-loop. State file
//                             present + commits landed since state-file mtime.
//                             The loop's own re-injection lifecycle handles
//                             the next turn; `cam resume` just re-spawns
//                             `cam next`.
//   - `respawn`             — Mode 2: terminal closed / OS rebooted. State
//                             file present + heartbeat PID dead + last
//                             commit ≤ 24h. Same action as Mode 1 — spawn
//                             a fresh loop; the plugin picks up where the
//                             iteration counter left off.
//   - `prompt`              — Mode 3: hard-kill orphan. State file present
//                             + heartbeat PID dead + last commit > 24h. We
//                             prompt `[Y/n/reset]`:
//                                Y     → continue (treat as Mode 2 respawn)
//                                n     → abort (exit 1; do nothing)
//                                reset → remove state file + exit 0
//   - `noop`                — Mode 4: rate-limit sleep killed mid-window.
//                             The retry-monitor PID recorded in
//                             `~/.cam/retry.pid` is still alive; the loop
//                             will resume on its own. We spawn `cam next`
//                             normally — the existing loop's plugin
//                             refuses-to-clobber semantics protect the
//                             state file.
//
// Auto-cleanup: if the PRD shows all stories `passes:true` (the loop must
// have completed without the plugin flushing `active:false`), we remove the
// state file and exit 0 with a `success` mode value.
//
// Explicit `--mode` overrides: the operator can short-circuit detection via
// `--mode reset-current-story | reset-prd | reset-branch`. Each mode rolls
// back to a different point:
//   - `reset-current-story` — set `passes:false` on the highest-priority
//     story that's currently `passes:true` (i.e. the most recently completed
//     one). Combined with `cam next` this re-implements that story.
//   - `reset-prd`           — set `passes:false` on every story in the PRD.
//     Re-runs the entire PRD from the top.
//   - `reset-branch`        — `git reset --hard origin/main` then re-runs.
//     Destructive; gated behind a confirmation prompt unless `--force`.
//
// Acceptance criteria covered (US-010):
//   1. `cam resume` exists; reads `.claude/cam-loop.local.md` + `prd.json`
//      + last commit and classifies into ONE of the 4 modes.
//   2. Mode 1 (typed mid-loop): state file + commit-since-state-file > 0.
//   3. Mode 2 (terminal closed): state file + PID dead.
//   4. Mode 3 (hard-kill): state file + PID dead + > 24h since last commit
//      → prompts [Y/n/reset].
//   5. Mode 4 (rate-limit alive): retry-monitor PID alive (from ~/.cam/retry.pid) → no-op.
//   6. Auto-cleanup of orphan state file when reality has moved on (PRD
//      already complete).
//   7. Bun unit tests for each mode with mocked filesystem + processes.
//   8. `bunx tsc --noEmit` passes.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';

import { parseStateFile, resolvePrdPath, type LoopState, type PrdShape } from './status.ts';
import { readWorkerPaneMarker } from '../tmux/session.ts';
import {
	accent,
	chalk,
	muted,
	printError,
	warning,
} from '../logging/color.ts';
import {
	emitContent,
	emitEntry,
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
	emitWarn,
} from '../logging/screen.ts';
import { readRetryPid, isRetryPidAlive } from '../util/retry-pid.ts';
import { promptSelect } from '../ui/promptSelect.tsx';

// --- Constants -------------------------------------------------------------

const STATE_FILE_PATH = '.claude/cam-loop.local.md';

/**
 * Heuristic cutoff for distinguishing "freshly interrupted" (Mode 2) from
 * "hard-kill orphan" (Mode 3). 24h means an operator who paused their
 * machine over a long weekend gets a confirmation prompt, while an
 * overnight crash auto-respawns. Reasonable middle-ground per the PRD note.
 */
export const HARD_KILL_AGE_MS = 24 * 60 * 60 * 1000;

// --- Mode types ------------------------------------------------------------

/**
 * The auto-detected resume mode. `runResume` returns this on its `mode` field
 * so a programmatic caller (or future TUI) can branch.
 */
export type ResumeMode =
	| 'noop' // Mode 4: retry-monitor PID alive, just re-spawn `cam next`
	| 'live-supervisor' // Mode 1: supervisor PID is alive (already running)
	| 'respawn' // Mode 2: state file present, PID dead, recent activity
	| 'orphaned-worker' // Mode 2b: no supervisor PID but worker slot pane is alive
	| 'prompt' // Mode 3: needs operator [Y/n/reset]
	| 'success' // PRD complete; auto-clean state file + exit 0
	| 'idle' // No state file, no in-flight loop — `cam next` from scratch
	| 'reset-current-story' // explicit --mode override
	| 'reset-prd' // explicit --mode override
	| 'reset-branch'; // explicit --mode override

export interface ResumeReport {
	mode: ResumeMode;
	stateFilePresent: boolean;
	prdComplete: boolean;
	pidAlive: boolean;
	retryPidAlive: boolean;
	/** Whether the worker slot pane (%N) was alive at classification time. */
	workerPaneAlive: boolean;
	lastCommitAgeMs?: number;
	cleanedStateFile: boolean;
	notes: string[]; // human-readable diagnostics for the printer
}

// --- Filesystem helpers ----------------------------------------------------

/**
 * Read + parse the loop's state file under `cwd`. Returns `null` when the
 * file is missing or unreadable. Mirrors `status.ts § readStateFile`.
 */
export function readStateFile(cwd: string): LoopState | null {
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
 */
export function readPrd(cwd: string): PrdShape | null {
	const path = resolvePrdPath(cwd);
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
 * Best-effort: get the timestamp (ms since epoch) of the last commit on the
 * current branch in `cwd`. Returns `null` when cwd is not a git repo or the
 * branch has no commits.
 */
export function readLastCommitTimestamp(cwd: string, spawnFn: SpawnSyncFn): number | null {
	const result = spawnFn('git', ['-C', cwd, 'log', '-1', '--format=%ct'], { encoding: 'utf8' });
	if (result.status !== 0) return null;
	const trimmed = result.stdout.trim();
	if (!trimmed) return null;
	const sec = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(sec) || sec <= 0) return null;
	return sec * 1000;
}

/**
 * Are ALL `userStories[]` entries `passes:true`? Used for the auto-cleanup
 * branch: when the PRD is complete but the state file lingers, the loop
 * almost certainly finished but the plugin's stop hook didn't flush
 * `active:false` (race with the runner exiting). Safe to remove the file.
 */
export function isPrdComplete(prd: PrdShape | null): boolean {
	if (!prd) return false;
	const stories = prd.userStories ?? [];
	if (stories.length === 0) return false;
	return stories.every((s) => s.passes === true);
}

// --- Process detection -----------------------------------------------------

/**
 * Subset of `spawnSync` we use; injectable for tests so we never shell out
 * to real processes during unit runs.
 */
export type SpawnSyncFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8' },
) => SpawnSyncReturns<string>;

/**
 * Subset of `process.kill` used for liveness checks. Injectable so tests
 * never signal real PIDs. Default: `process.kill`.
 *
 * `process.kill(pid, 0)` is the canonical "is this process alive?" probe on
 * POSIX — signal 0 doesn't deliver anything; it just runs the kernel's
 * permission check. Throws on dead/missing/permission-denied PIDs.
 */
export type KillFn = (pid: number, signal: 0) => void;

/**
 * Is the heartbeat PID still a running process? Returns `false` when the
 * PID is missing or `process.kill(pid, 0)` throws.
 */
export function isPidAlive(pid: number | undefined, killFn: KillFn): boolean {
	if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		killFn(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Is the cam retry-monitor process still alive? Reads the PID from
 * `~/.cam/retry.pid` (written by `cam claude` when it forks the monitor)
 * and checks liveness via `isRetryPidAlive`. Returns `false` when the PID
 * file is absent or the process has exited.
 */
export function isRetryMonitorAlive(): boolean {
	const pid = readRetryPid();
	if (pid === null) return false;
	return isRetryPidAlive(pid);
}

/**
 * Check whether a specific tmux pane id is currently alive.
 *
 * Uses `tmux -L cam list-panes -a -F '#{pane_id}'` to enumerate all panes on
 * the cam socket and checks whether the given pane id appears in the output.
 * Returns `false` when tmux is unavailable, the socket is missing, or the pane
 * id is falsy.
 */
export function isWorkerPaneAlive(paneId: string | null, spawnFn: SpawnSyncFn): boolean {
	if (!paneId || paneId.length === 0) return false;
	const result = spawnFn(
		'tmux',
		['-L', 'cam', 'list-panes', '-a', '-F', '#{pane_id}'],
		{ encoding: 'utf8' },
	);
	if (result.status !== 0) return false;
	const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
	return lines.includes(paneId);
}

// --- Mode classification ---------------------------------------------------

export interface ClassifyInput {
	cwd: string;
	now: () => Date;
	spawnFn: SpawnSyncFn;
	killFn: KillFn;
}

/**
 * Pure classifier — no I/O of its own; reads from already-loaded snapshots so
 * tests can drive each branch deterministically. Encapsulates the decision tree:
 *
 *   if PRD complete                               → success (auto-clean)
 *   else if no state file                         → idle (fresh `cam next`)
 *   else if retry-monitor PID alive               → noop  (Mode 4)
 *   else if supervisor PID alive                  → live-supervisor (already running)
 *   else if worker slot pane alive (no sup PID)   → orphaned-worker (relaunch supervisor)
 *   else if last commit > 24h old (or null)       → prompt (Mode 3: hard-kill orphan)
 *   else                                          → respawn (Mode 2: recent crash)
 */
export function classifyResumeMode(
	state: LoopState | null,
	prd: PrdShape | null,
	lastCommitMs: number | null,
	pidAlive: boolean,
	retryMonitorAlive: boolean,
	now: Date,
	workerPaneAlive?: boolean,
): { mode: ResumeMode; reason: string } {
	if (isPrdComplete(prd)) {
		return {
			mode: 'success',
			reason: 'PRD already complete (every story passes:true) — cleaning orphan state file',
		};
	}
	if (!state) {
		return {
			mode: 'idle',
			reason: 'no `.claude/cam-loop.local.md` — ready for a fresh `cam next`',
		};
	}
	if (retryMonitorAlive) {
		return {
			mode: 'noop',
			reason: 'retry-monitor process is alive — loop is sleeping in a rate-limit window',
		};
	}
	if (pidAlive) {
		return {
			mode: 'live-supervisor',
			reason: 'supervisor PID is alive — loop is already running',
		};
	}
	// Supervisor PID dead or absent. Check worker slot pane liveness.
	if (workerPaneAlive) {
		return {
			mode: 'orphaned-worker',
			reason: 'supervisor PID dead but worker slot pane is alive — relaunching supervisor',
		};
	}
	const ageMs =
		lastCommitMs !== null ? now.getTime() - lastCommitMs : Number.POSITIVE_INFINITY;
	if (ageMs > HARD_KILL_AGE_MS) {
		return {
			mode: 'prompt',
			reason: `heartbeat PID dead and last commit ${
				lastCommitMs === null ? 'unknown' : `${Math.floor(ageMs / (60 * 60 * 1000))}h old`
			} — likely a hard-kill orphan, asking [Y/n/reset]`,
		};
	}
	return {
		mode: 'respawn',
		reason: 'heartbeat PID dead but last commit is recent — terminal closed / OS rebooted',
	};
}

// --- PRD mutators (reset-* modes) ------------------------------------------

/**
 * Find the most-recently-completed story and flip it back to `passes:false`.
 * Used by `--mode reset-current-story` to re-do the just-finished work.
 *
 * In cam's priority scheme, lower `priority` value = earlier in the
 * implementation queue. Stories are picked off in ascending priority order,
 * so the most-recently-completed story is the `passes:true` entry with the
 * HIGHEST priority value. (The next pending story will have a still-higher
 * priority value, sitting at the top of the queue.)
 *
 * Returns the story id that was reset, or `null` when no candidate exists
 * (PRD empty / nothing has passed yet).
 */
export function resetCurrentStoryInPlace(prd: PrdShape): string | null {
	const stories = prd.userStories ?? [];
	const passed = stories.filter((s) => s.passes === true);
	if (passed.length === 0) return null;
	passed.sort(
		(a, b) =>
			(a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
	);
	// Highest-priority-value-among-passed = most recently completed.
	const target = passed[passed.length - 1];
	if (!target) return null;
	for (const s of stories) {
		if (s.id === target.id) {
			s.passes = false;
		}
	}
	return target.id;
}

/**
 * Flip every story to `passes:false`. Used by `--mode reset-prd`.
 * Returns the count of stories reset.
 */
export function resetPrdInPlace(prd: PrdShape): number {
	const stories = prd.userStories ?? [];
	let count = 0;
	for (const s of stories) {
		if (s.passes !== false) {
			s.passes = false;
			count += 1;
		}
	}
	return count;
}

/**
 * Persist a mutated PRD back to disk under `cwd`. Pretty-printed (2-space
 * indent) so git diffs stay readable.
 */
export function writePrd(cwd: string, prd: PrdShape): void {
	const path = resolvePrdPath(cwd);
	writeFileSync(path, `${JSON.stringify(prd, null, 2)}\n`, 'utf8');
}

// --- Prompt surface --------------------------------------------------------

/**
 * Synchronous y/n/reset prompt. Tests inject a fake; the production
 * implementation reads from process.stdin via Bun's blocking line-read.
 *
 * Return values are normalized to lowercase and mapped to one of three
 * canonical answers; anything we can't recognize defaults to `n` (the safe
 * choice — abort rather than continue).
 */
export type PromptFn = (question: string) => string;

export type PromptAnswer = 'y' | 'n' | 'reset';

export function normalizePromptAnswer(raw: string): PromptAnswer {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed === 'y' || trimmed === 'yes') return 'y';
	if (trimmed === 'reset') return 'reset';
	return 'n';
}

/**
 * Default prompt — uses Bun's `prompt` global which performs a synchronous
 * blocking line-read from stdin (the canonical way to ask a CLI question
 * without pulling in a readline dep). We cast through `unknown` because
 * `globalThis.prompt`'s type isn't always present in older `@types/bun` —
 * the runtime always provides it (verified via `bun -e 'typeof prompt'`).
 *
 * Returns the operator's literal answer (no normalization here — the
 * caller pipes through `normalizePromptAnswer`).
 */
function defaultPrompt(question: string): string {
	const promptGlobal = (globalThis as unknown as {
		prompt?: (label: string) => string | null;
	}).prompt;
	if (typeof promptGlobal !== 'function') {
		// Defensive: in a non-Bun runtime (or a stripped-down sandbox), we
		// can't ask. Return an empty string and the caller will fall through
		// to the `n` default — safer than silently continuing.
		process.stdout.write(question);
		return '';
	}
	const answer = promptGlobal(question);
	return answer ?? '';
}

/** True when we can render Ink to the operator's TTY. */
function isInteractiveTTY(): boolean {
	return Boolean(process.stdout.isTTY) && !process.env['CI'];
}

/**
 * Ask "resume the loop?" — Ink Select in interactive TTY, blocking text prompt
 * elsewhere (tests inject `options.prompt`, which is why the second arg short-
 * circuits to the text path even on a real TTY when the caller is asserting
 * synchronous behaviour).
 */
async function askResumeChoice(
	promptFn: PromptFn,
	testOverride: boolean,
): Promise<PromptAnswer> {
	if (testOverride || !isInteractiveTTY()) {
		return normalizePromptAnswer(promptFn('Resume the loop? [Y/n/reset] '));
	}
	const chosen = await promptSelect<PromptAnswer>({
		question: 'Resume the loop?',
		options: [
			{ value: 'y', label: 'Yes', description: 'Re-run `cam next` to re-attach the loop' },
			{ value: 'n', label: 'No', description: 'Abort — leave the state file in place' },
			{ value: 'reset', label: 'Reset', description: 'Remove the state file and start clean' },
		],
		defaultValue: 'y',
	});
	return chosen ?? 'n';
}

/**
 * Confirm the destructive `--mode reset-branch` step. Same Ink-vs-text
 * branching as `askResumeChoice`. Default is `n` so an accidental Enter
 * does NOT discard local commits.
 */
async function askResetBranchConfirm(
	promptFn: PromptFn,
	testOverride: boolean,
): Promise<PromptAnswer> {
	if (testOverride || !isInteractiveTTY()) {
		return normalizePromptAnswer(
			promptFn('Reset branch will discard local commits — continue? [y/N] '),
		);
	}
	const chosen = await promptSelect<'y' | 'n'>({
		question: 'Reset branch will discard local commits — continue?',
		options: [
			{ value: 'n', label: 'No', description: 'Abort — branch stays untouched' },
			{ value: 'y', label: 'Yes', description: 'Print the `git reset --hard origin/main` instruction' },
		],
		defaultValue: 'n',
	});
	return (chosen ?? 'n') as PromptAnswer;
}

// --- Public entrypoint -----------------------------------------------------

export type ExplicitMode = 'reset-current-story' | 'reset-prd' | 'reset-branch';

export interface ResumeOptions {
	/** Override cwd; default `process.cwd()`. */
	cwd?: string;
	/** Override "now" for tests. */
	now?: () => Date;
	/** Inject `spawnSync` for git lookups and tmux pane checks. Default: real `spawnSync`. */
	spawnFn?: SpawnSyncFn;
	/** Inject `process.kill`. Default: `process.kill`. */
	killFn?: KillFn;
	/**
	 * Inject the retry-monitor liveness check. Default: `isRetryMonitorAlive()`.
	 * Tests inject this so they can control the PID-file liveness path without
	 * touching the real `~/.cam/retry.pid` on the host machine.
	 */
	retryMonitorFn?: () => boolean;
	/**
	 * Inject the worker-pane-id reader for tests.
	 * Default: `readWorkerPaneMarker(claudeDir)`.
	 */
	workerPaneReader?: (claudeDir: string) => string | null;
	/** Inject the prompt function. Default: blocking `prompt(...)` global. */
	prompt?: PromptFn;
	/** Skip auto-detection; honor an explicit reset mode. */
	mode?: ExplicitMode;
	/** With `--dry-run`, classify + print; do not mutate or spawn. */
	dryRun?: boolean;
	/** With `--force`, skip the destructive-mode confirmation prompt. */
	force?: boolean;
}

/**
 * Run the resume reconciliation. Returns the structured report (mode,
 * detected fields, what was cleaned). Pure with respect to non-overridden
 * deps — the caller decides what to do with the report (the printing
 * wrapper `runResume` handles the operator-facing UX).
 */
export function buildResumeReport(options: ResumeOptions = {}): ResumeReport {
	const cwd = options.cwd ?? process.cwd();
	const now = options.now ?? (() => new Date());
	const spawnFn = options.spawnFn ?? ((cmd, args, opts) => spawnSync(cmd, args, opts));
	const killFn = options.killFn ?? ((pid: number, signal: 0) => process.kill(pid, signal));
	const retryMonitorFn = options.retryMonitorFn ?? isRetryMonitorAlive;
	const workerPaneReaderFn = options.workerPaneReader ?? readWorkerPaneMarker;

	const claudeDir = join(cwd, '.claude');
	const state = readStateFile(cwd);
	const prd = readPrd(cwd);
	const lastCommitMs = readLastCommitTimestamp(cwd, spawnFn);
	const pidAlive = isPidAlive(state?.pid, killFn);
	const retryPidAliveResult = retryMonitorFn();
	const workerPaneId = workerPaneReaderFn(claudeDir);
	const workerPaneAliveResult = isWorkerPaneAlive(workerPaneId, spawnFn);

	const decision = classifyResumeMode(
		state, prd, lastCommitMs, pidAlive, retryPidAliveResult, now(), workerPaneAliveResult,
	);
	const report: ResumeReport = {
		mode: decision.mode,
		stateFilePresent: state !== null,
		prdComplete: isPrdComplete(prd),
		pidAlive,
		retryPidAlive: retryPidAliveResult,
		workerPaneAlive: workerPaneAliveResult,
		cleanedStateFile: false,
		notes: [decision.reason],
	};
	if (lastCommitMs !== null) {
		report.lastCommitAgeMs = now().getTime() - lastCommitMs;
	}
	return report;
}

/**
 * Operator-facing entrypoint. Builds the report, applies side-effects per
 * the resolved mode (with `dryRun` short-circuiting all of them), prints
 * a summary, and returns the exit code.
 *
 * Exit codes:
 *   0 — recovery complete OR `--dry-run` succeeded OR Mode 3 prompt → reset/continue
 *   1 — Mode 3 prompt → `n` (operator declined to recover); no work done
 *   2 — explicit reset-mode failed (e.g. nothing to reset)
 */
export async function runResume(options: ResumeOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const promptFn = options.prompt ?? defaultPrompt;

	// Explicit `--mode` short-circuits classification entirely.
	if (options.mode) {
		return await runExplicitReset(options.mode, cwd, promptFn, options);
	}

	emitTitle('cam resume');
	emitSectionHeading('Summary');

	const report = buildResumeReport(options);
	printSummary(report);

	if (options.dryRun) {
		emitMutedHint('Dry run: no state mutations or spawns');
		emitTrailingBlank();
		return 0;
	}

	switch (report.mode) {
		case 'success': {
			// PRD complete — auto-cleanup the orphan state file. Closing "Done"
			// section: divisor stays muted, the accent ✓ glyph carries success.
			const removed = removeStateFileIfPresent(cwd);
			emitSectionHeading('Done');
			if (removed) {
				report.cleanedStateFile = true;
				emitOk(`Removed orphan ${STATE_FILE_PATH}`);
			}
			emitOk('PRD complete — nothing to resume');
			emitTrailingBlank();
			return 0;
		}
		case 'idle':
			emitSectionHeading('Next');
			emitEntry('cam next', 'start a fresh loop');
			emitTrailingBlank();
			return 0;
		case 'noop':
			emitSectionHeading('Next');
			emitMutedHint('Nothing to do — the retry-monitor will respawn `cam next` when the rate-limit window ends');
			emitTrailingBlank();
			return 0;
		case 'live-supervisor':
			emitSectionHeading('Status');
			emitOk('Supervisor is already running (PID alive) — no action needed');
			emitTrailingBlank();
			return 0;
		case 'orphaned-worker':
			// Worker pane is alive but supervisor PID is dead. Relaunch the
			// supervisor (via cam next) without re-running cam plan — the worker
			// pane marker is still intact so runNext picks it up directly.
			emitSectionHeading('Next');
			emitEntry('cam next', 'relaunch supervisor (worker pane already allocated)');
			emitTrailingBlank();
			return 0;
		case 'respawn':
			emitSectionHeading('Next');
			emitEntry('cam next', 're-attach the loop from this cwd');
			emitTrailingBlank();
			return 0;
		case 'prompt': {
			const answer = await askResumeChoice(promptFn, options.prompt !== undefined);
			if (answer === 'y') {
				emitSectionHeading('Next');
				emitEntry('cam next', 're-attach the loop from this cwd');
				emitTrailingBlank();
				return 0;
			}
			if (answer === 'reset') {
				const removed = removeStateFileIfPresent(cwd);
				emitSectionHeading('Done');
				if (removed) {
					report.cleanedStateFile = true;
					emitOk(`Removed ${STATE_FILE_PATH}`);
				} else {
					emitMutedHint(`No ${STATE_FILE_PATH} to remove`);
				}
				emitTrailingBlank();
				return 0;
			}
			emitSectionHeading('Done');
			emitMutedHint('Aborted — no recovery action taken');
			emitTrailingBlank();
			return 1;
		}
		default:
			emitTrailingBlank();
			return 0;
	}
}

/**
 * Handle the three explicit `--mode` overrides. Each one is destructive
 * relative to the PRD or branch; we always print what we did before
 * returning.
 */
async function runExplicitReset(
	mode: ExplicitMode,
	cwd: string,
	promptFn: PromptFn,
	options: ResumeOptions,
): Promise<number> {
	emitTitle('cam resume');
	emitSectionHeading(`Mode: ${mode}`);

	if (mode === 'reset-current-story') {
		const prd = readPrd(cwd);
		if (!prd) {
			// Fatal: missing dependency. Errors go to stderr (col 0), matching
			// the CLI contract — never decorated as a Section "Failed".
			printError('reset-current-story: no prd.json found in cwd');
			emitTrailingBlank();
			return 2;
		}
		if (options.dryRun) {
			emitMutedHint('Dry run: would reset the most-recently-completed story');
			emitTrailingBlank();
			return 0;
		}
		const id = resetCurrentStoryInPlace(prd);
		if (!id) {
			emitWarn('Nothing to reset', '(no completed stories in the PRD)');
			emitTrailingBlank();
			return 2;
		}
		writePrd(cwd, prd);
		emitOk(`Reset ${id}`, '→ passes:false');
		emitSectionHeading('Next');
		emitEntry('cam next', 're-implement that story');
		emitTrailingBlank();
		return 0;
	}
	if (mode === 'reset-prd') {
		const prd = readPrd(cwd);
		if (!prd) {
			// Fatal: missing dependency → stderr (CLI contract), not a Section.
			printError('reset-prd: no prd.json found in cwd');
			emitTrailingBlank();
			return 2;
		}
		if (options.dryRun) {
			const count = (prd.userStories ?? []).filter((s) => s.passes !== false).length;
			emitMutedHint(`Dry run: would flip ${count} stor${count === 1 ? 'y' : 'ies'} to passes:false`);
			emitTrailingBlank();
			return 0;
		}
		const count = resetPrdInPlace(prd);
		if (count === 0) {
			emitMutedHint('PRD already had every story at passes:false');
			emitTrailingBlank();
			return 0;
		}
		writePrd(cwd, prd);
		emitOk(`Reset ${count} stor${count === 1 ? 'y' : 'ies'}`, '→ passes:false');
		emitSectionHeading('Next');
		emitEntry('cam next', 're-implement from the top');
		emitTrailingBlank();
		return 0;
	}
	if (mode === 'reset-branch') {
		// Destructive: we DO NOT run `git reset --hard` from here. We surface
		// the command and require the operator to copy-paste it. The PRD's
		// `--mode reset-branch` lives at the spec level; the actual destructive
		// step lives outside cam — we don't want to be the tool that clobbers
		// uncommitted work because of a misclassification.
		if (options.dryRun) {
			emitMutedHint('Dry run: would print the `git reset --hard origin/main` instruction');
			emitTrailingBlank();
			return 0;
		}
		if (!options.force) {
			const answer = await askResetBranchConfirm(promptFn, options.prompt !== undefined);
			if (answer !== 'y') {
				emitSectionHeading('Done');
				emitMutedHint('Aborted — no branch reset performed');
				emitTrailingBlank();
				return 1;
			}
		}
		// Also remove the state file; the next `cam next` should treat the
		// branch as freshly-checked-out. The git command is shown as a content
		// line (not an emitEntry) because it's far wider than the entry name
		// column — copy-paste target, not a short command label.
		const removed = removeStateFileIfPresent(cwd);
		emitWarn('cam does NOT run `git reset --hard` itself', '(operator-driven)');
		emitContent('Copy: git reset --hard origin/main');
		if (removed) {
			emitMutedHint(`Removed ${STATE_FILE_PATH}`);
		}
		emitSectionHeading('Next');
		emitEntry('cam next', 're-run after the reset');
		emitTrailingBlank();
		return 0;
	}
	return 2;
}

function removeStateFileIfPresent(cwd: string): boolean {
	const path = join(cwd, STATE_FILE_PATH);
	if (!existsSync(path)) return false;
	try {
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Print a one-glance human summary of the resume report. Mirrors the shape
 * of `cam status` so an operator who already knows status can read this
 * without context-switching.
 */
function printSummary(report: ResumeReport): void {
	const KEY_W = 9;
	const padKey = (k: string): string => chalk.bold(k.padEnd(KEY_W));
	// Color the mode token using the unified palette: success → accent green,
	// prompt → warning yellow, idle/noop → muted (these are quiet states),
	// anything else (e.g. respawn) stays default so it doesn't fight for the
	// eye against success/prompt.
	const modeLabel = (() => {
		switch (report.mode) {
			case 'success':
				return accent(report.mode);
			case 'prompt':
				return warning(report.mode);
			case 'idle':
			case 'noop':
				return muted(report.mode);
			case 'live-supervisor':
				return accent(report.mode);
			case 'orphaned-worker':
				return warning(report.mode);
			default:
				return report.mode;
		}
	})();

	process.stdout.write(`    ${padKey('mode')}${modeLabel}\n`);
	process.stdout.write(`    ${padKey('state')}${report.stateFilePresent ? 'present' : muted('absent')}\n`);
	process.stdout.write(`    ${padKey('pid')}${report.pidAlive ? accent('alive') : muted('dead/absent')}\n`);
	process.stdout.write(
		`    ${padKey('retry')}${report.retryPidAlive ? accent('retry-monitor alive') : muted('not running')}\n`,
	);
	process.stdout.write(
		`    ${padKey('worker')}${report.workerPaneAlive ? accent('pane alive') : muted('pane absent')}\n`,
	);
	if (typeof report.lastCommitAgeMs === 'number') {
		const hours = Math.floor(report.lastCommitAgeMs / (60 * 60 * 1000));
		process.stdout.write(`    ${padKey('commit')}${hours}h since last commit\n`);
	}
	for (const note of report.notes) {
		process.stdout.write(`    ${muted(`→ ${note}`)}\n`);
	}
}
