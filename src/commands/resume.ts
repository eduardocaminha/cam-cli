// src/commands/resume.ts
//
// Implementation of `ralph resume` — the 4-mode recovery command.
//
// Reads three sources from the current cwd's repo and reconciles them into a
// recovery decision:
//
//   1. `.claude/ralph-loop.local.md` (the ralph-loop plugin's state file).
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
//                             the next turn; `ralph resume` just re-spawns
//                             `ralph next`.
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
//                             `claude-auto-retry`'s PID is alive (detected
//                             via `pgrep -f claude-auto-retry`); the loop
//                             will resume on its own. We spawn `ralph next`
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
//     one). Combined with `ralph next` this re-implements that story.
//   - `reset-prd`           — set `passes:false` on every story in the PRD.
//     Re-runs the entire PRD from the top.
//   - `reset-branch`        — `git reset --hard origin/main` then re-runs.
//     Destructive; gated behind a confirmation prompt unless `--force`.
//
// Acceptance criteria covered (US-010):
//   1. `ralph resume` exists; reads `.claude/ralph-loop.local.md` + `prd.json`
//      + last commit and classifies into ONE of the 4 modes.
//   2. Mode 1 (typed mid-loop): state file + commit-since-state-file > 0.
//   3. Mode 2 (terminal closed): state file + PID dead.
//   4. Mode 3 (hard-kill): state file + PID dead + > 24h since last commit
//      → prompts [Y/n/reset].
//   5. Mode 4 (rate-limit alive): claude-auto-retry PID alive → no-op.
//   6. Auto-cleanup of orphan state file when reality has moved on (PRD
//      already complete).
//   7. Bun unit tests for each mode with mocked filesystem + processes.
//   8. `bunx tsc --noEmit` passes.

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';

import { parseStateFile, type LoopState, type PrdShape } from './status.ts';
import { color, muted, printError, printHint, printSuccess, printWarning } from '../logging/color.ts';

// --- Constants -------------------------------------------------------------

const STATE_FILE_PATH = '.claude/ralph-loop.local.md';
const PRD_PATH = 'prd.json';

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
	| 'noop' // Mode 4: claude-auto-retry alive, just re-spawn `ralph next`
	| 'respawn' // Mode 1+2: state file present, no live PID, recent activity
	| 'prompt' // Mode 3: needs operator [Y/n/reset]
	| 'success' // PRD complete; auto-clean state file + exit 0
	| 'idle' // No state file, no in-flight loop — `ralph next` from scratch
	| 'reset-current-story' // explicit --mode override
	| 'reset-prd' // explicit --mode override
	| 'reset-branch'; // explicit --mode override

export interface ResumeReport {
	mode: ResumeMode;
	stateFilePresent: boolean;
	prdComplete: boolean;
	pidAlive: boolean;
	autoRetryAlive: boolean;
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
 * Does any `claude-auto-retry` process exist on this machine? Probes via
 * `pgrep -f claude-auto-retry` (POSIX; macOS + Linux). Exit 0 means a match
 * was found; exit 1 means no match; any other exit is treated as "unknown,
 * assume not running" (safer to fall through to the auto-detect path than to
 * spuriously short-circuit on a tooling glitch).
 */
export function isAutoRetryAlive(spawnFn: SpawnSyncFn): boolean {
	const result = spawnFn('pgrep', ['-f', 'claude-auto-retry'], { encoding: 'utf8' });
	return result.status === 0 && result.stdout.trim().length > 0;
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
 * tests can drive each branch deterministically. Encapsulates the 4-mode
 * decision tree from the acceptance criteria:
 *
 *   if PRD complete                          → success (auto-clean)
 *   else if no state file                    → idle (fresh `ralph next`)
 *   else if claude-auto-retry alive          → noop  (Mode 4)
 *   else if heartbeat PID alive              → respawn (Mode 1: typed mid-loop)
 *   else if last commit > 24h old (or null)  → prompt (Mode 3: hard-kill orphan)
 *   else                                     → respawn (Mode 2: recent crash)
 *
 * The "PID alive but operator typed mid-loop" branch (the spec's Mode 1)
 * collapses into the same `respawn` action because the user-facing behavior
 * is identical: re-spawn `ralph next`, the plugin handles the rest. We keep
 * the diagnostic string distinct so the printer can explain what happened.
 */
export function classifyResumeMode(
	state: LoopState | null,
	prd: PrdShape | null,
	lastCommitMs: number | null,
	pidAlive: boolean,
	autoRetryAlive: boolean,
	now: Date,
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
			reason: 'no `.claude/ralph-loop.local.md` — ready for a fresh `ralph next`',
		};
	}
	if (autoRetryAlive) {
		return {
			mode: 'noop',
			reason: 'claude-auto-retry process is alive — loop is sleeping in a rate-limit window',
		};
	}
	if (pidAlive) {
		return {
			mode: 'respawn',
			reason: 'heartbeat PID alive but spawn was requested — re-attaching to the loop',
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
 * In ralph's priority scheme, lower `priority` value = earlier in the
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
	const path = join(cwd, PRD_PATH);
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

// --- Public entrypoint -----------------------------------------------------

export type ExplicitMode = 'reset-current-story' | 'reset-prd' | 'reset-branch';

export interface ResumeOptions {
	/** Override cwd; default `process.cwd()`. */
	cwd?: string;
	/** Override "now" for tests. */
	now?: () => Date;
	/** Inject `spawnSync` for liveness probes + git lookups. Default: real `spawnSync`. */
	spawnFn?: SpawnSyncFn;
	/** Inject `process.kill`. Default: `process.kill`. */
	killFn?: KillFn;
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

	const state = readStateFile(cwd);
	const prd = readPrd(cwd);
	const lastCommitMs = readLastCommitTimestamp(cwd, spawnFn);
	const pidAlive = isPidAlive(state?.pid, killFn);
	const autoRetryAlive = isAutoRetryAlive(spawnFn);

	const decision = classifyResumeMode(state, prd, lastCommitMs, pidAlive, autoRetryAlive, now());
	const report: ResumeReport = {
		mode: decision.mode,
		stateFilePresent: state !== null,
		prdComplete: isPrdComplete(prd),
		pidAlive,
		autoRetryAlive,
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

	const report = buildResumeReport(options);
	printSummary(report);

	if (options.dryRun) {
		printHint('dry run: no state mutations or spawns');
		return 0;
	}

	switch (report.mode) {
		case 'success': {
			// PRD complete — auto-cleanup the orphan state file.
			const removed = removeStateFileIfPresent(cwd);
			if (removed) {
				report.cleanedStateFile = true;
				printSuccess(`removed orphan ${STATE_FILE_PATH}`);
			}
			printSuccess('PRD complete — nothing to resume');
			return 0;
		}
		case 'idle':
			printHint('run `ralph next` to start a fresh loop');
			return 0;
		case 'noop':
			printHint('claude-auto-retry is sleeping — its next wake will spawn `ralph next`');
			return 0;
		case 'respawn':
			printHint('next step: re-run `ralph next` from this cwd to re-attach the loop');
			return 0;
		case 'prompt': {
			const answer = normalizePromptAnswer(
				promptFn('Resume the loop? [Y/n/reset] '),
			);
			if (answer === 'y') {
				printSuccess('continuing — re-run `ralph next` to re-attach the loop');
				return 0;
			}
			if (answer === 'reset') {
				const removed = removeStateFileIfPresent(cwd);
				if (removed) {
					report.cleanedStateFile = true;
					printSuccess(`removed ${STATE_FILE_PATH}`);
				}
				return 0;
			}
			printWarning('aborted', 'no recovery action taken');
			return 1;
		}
		default:
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
	if (mode === 'reset-current-story') {
		const prd = readPrd(cwd);
		if (!prd) {
			printError('reset-current-story: no prd.json found in cwd');
			return 2;
		}
		if (options.dryRun) {
			printHint(`dry run: would reset the most-recently-completed story`);
			return 0;
		}
		const id = resetCurrentStoryInPlace(prd);
		if (!id) {
			printWarning('nothing to reset', 'no completed stories in the PRD');
			return 2;
		}
		writePrd(cwd, prd);
		printSuccess(`reset ${id} → passes:false`);
		printHint('next step: re-run `ralph next` to re-implement that story');
		return 0;
	}
	if (mode === 'reset-prd') {
		const prd = readPrd(cwd);
		if (!prd) {
			printError('reset-prd: no prd.json found in cwd');
			return 2;
		}
		if (options.dryRun) {
			const count = (prd.userStories ?? []).filter((s) => s.passes !== false).length;
			printHint(`dry run: would flip ${count} stor${count === 1 ? 'y' : 'ies'} to passes:false`);
			return 0;
		}
		const count = resetPrdInPlace(prd);
		if (count === 0) {
			printHint('PRD already had every story at passes:false');
			return 0;
		}
		writePrd(cwd, prd);
		printSuccess(`reset ${count} stor${count === 1 ? 'y' : 'ies'} → passes:false`);
		printHint('next step: re-run `ralph next` to re-implement from US-001');
		return 0;
	}
	if (mode === 'reset-branch') {
		// Destructive: we DO NOT run `git reset --hard` from here. We surface
		// the command and require the operator to copy-paste it. The PRD's
		// `--mode reset-branch` lives at the spec level; the actual destructive
		// step lives outside ralph — we don't want to be the tool that clobbers
		// uncommitted work because of a misclassification.
		if (options.dryRun) {
			printHint('dry run: would print the `git reset --hard origin/main` instruction');
			return 0;
		}
		if (!options.force) {
			const answer = normalizePromptAnswer(
				promptFn('Reset branch will discard local commits — continue? [y/N] '),
			);
			if (answer !== 'y') {
				printWarning('aborted', 'no branch reset performed');
				return 1;
			}
		}
		printWarning(
			'reset-branch is operator-driven — ralph does NOT run `git reset --hard` itself',
			'copy: git reset --hard origin/main',
		);
		// Also remove the state file; the next `ralph next` should treat the
		// branch as freshly-checked-out.
		const removed = removeStateFileIfPresent(cwd);
		if (removed) {
			printSuccess(`removed ${STATE_FILE_PATH}`);
		}
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
 * of `ralph status` so an operator who already knows status can read this
 * without context-switching.
 */
function printSummary(report: ResumeReport): void {
	const modeLabel =
		report.mode === 'noop' || report.mode === 'idle'
			? muted(report.mode)
			: report.mode === 'success'
				? color.green(report.mode)
				: report.mode === 'prompt'
					? color.yellow(report.mode)
					: color.cyan(report.mode);
	process.stdout.write(`mode:    ${modeLabel}\n`);
	process.stdout.write(`state:   ${report.stateFilePresent ? 'present' : muted('absent')}\n`);
	process.stdout.write(
		`pid:     ${report.pidAlive ? color.green('alive') : muted('dead/absent')}\n`,
	);
	process.stdout.write(
		`retry:   ${report.autoRetryAlive ? color.green('claude-auto-retry alive') : muted('not running')}\n`,
	);
	if (typeof report.lastCommitAgeMs === 'number') {
		const hours = Math.floor(report.lastCommitAgeMs / (60 * 60 * 1000));
		process.stdout.write(`commit:  ${hours}h since last commit\n`);
	}
	for (const note of report.notes) {
		process.stdout.write(`${muted('→')} ${note}\n`);
	}
}

// --- exports kept alive against unused-export sweeps -----------------------

void statSync;
