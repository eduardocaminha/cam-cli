// src/commands/plan.ts
//
// Implementation of `cam plan` -- thin-proxy that writes phase:planning +
// plan_issue to the loop state file (US-004 of CAM-151).
//
// Acceptance criteria (US-004):
//   1. runPlan writes phase:planning + plan_issue=N to .claude/cam-loop.local.md
//      (via renderStateFile/writeStateFile) instead of send-keys-injecting.
//   2. `cam plan N` with a valid issue id returns 0; state file has
//      phase==='planning' and plan_issue===N.
//   3. `cam plan N` with a specific N whose issue is missing / not open / not
//      plannable halts clean (non-zero). Does NOT fall back to top-of-queue.
//      A bare `cam plan` with no N still uses the top-plannable selection.
//   4. index.ts still dispatches `case 'plan'` to runPlan (unchanged).
//   5. No --permission-mode CLI flag.
//   6. Typecheck passes (bun run typecheck).
//   7. Tests pass (bun test).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { printError } from '../logging/color.ts';
import {
	emitAttachHint,
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
} from '../logging/screen.ts';
import {
	hasSession,
	orchestratorAlive,
	paneCountMutex,
	projectSessionName,
	type Env,
	type SpawnFn as TmuxSpawnFn,
} from '../tmux/session.ts';
import { waitForOrchestrator } from '../tmux/bootstrap-wait.ts';
import { parseStateFile } from './status.ts';
import {
	renderStateFile,
	writeStateFile,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_COMPLETION_PROMISE,
} from './next.ts';
import { readBacklogFromMain } from '../issues/backlog.ts';
import { isBlocked } from '../issues/graph.ts';
import { selectPlannableIssue } from '../issues/select.ts';
import type { IssueEntry } from '../issues/types.ts';

// --- Types -----------------------------------------------------------------

export interface PlanOptions {
	/** Optional issue number; when provided, validates and targets that issue. */
	issue?: number;
	/** Override the working directory; default `process.cwd()`. */
	cwd?: string;
	/** Override the synchronous spawn function used for tmux calls. */
	tmuxSpawnFn?: TmuxSpawnFn;
	/** Override process.env for attach-hint detection. */
	env?: Env;
	/** Bootstrap the orchestrator when not alive. Tests inject a no-op. */
	bootstrapFn?: () => Promise<boolean>;
	/** File-existence check for the .cam-orch-ready poll. Tests inject a fake. */
	statFn?: (path: string) => boolean;
	/** Sleep function for the ready-poll. Tests inject a no-op. */
	sleepFn?: (ms: number) => void;
	/** Total poll budget for waitForOrchestrator (ms). Default 60 000. */
	waitTimeoutMs?: number;
	/** Injectable state-file writer for tests. Defaults to writeStateFile. */
	writeFn?: (cwd: string, body: string, opts: { force?: boolean }) => string;
	/**
	 * Injectable backlog reader for tests.
	 * When provided, bypasses the real git reads from main.
	 */
	readBacklogFn?: () => IssueEntry[];
}

// --- Internal helpers -------------------------------------------------------

async function doBootstrap(cwd: string, bootstrapFn?: () => Promise<boolean>): Promise<boolean> {
	if (bootstrapFn) return bootstrapFn();
	const { spawnSync } = await import('node:child_process');
	const result = spawnSync('cam', ['run', '--no-attach'], { cwd, stdio: 'ignore' });
	return (result.status ?? 1) === 0;
}

/** Parse the numeric suffix from an issue id like "CAM-151" -> 151. */
function numericSuffix(id: string): number {
	const part = id.split('-').at(-1);
	if (part === undefined) return NaN;
	const n = Number(part);
	return Number.isFinite(n) ? n : NaN;
}

/**
 * Bootstrap orchestrator and wait for it to be ready.
 * Returns 0 on success, 1 on failure (after printing the error).
 */
async function bootstrapAndWait(
	cwd: string,
	claudeDir: string,
	sessionName: string,
	tmuxSpawnFn: TmuxSpawnFn,
	options: Pick<PlanOptions, 'bootstrapFn' | 'statFn' | 'sleepFn' | 'waitTimeoutMs'>,
): Promise<number> {
	emitMutedHint('No live orchestrator detected, bootstrapping cam run...');
	const bootstrapped = await doBootstrap(cwd, options.bootstrapFn);
	if (!bootstrapped) {
		printError('Failed to bootstrap orchestrator', 'Run `cam run` manually, then retry `cam plan`.');
		emitTrailingBlank();
		return 1;
	}
	const ready = waitForOrchestrator({
		claudeDir,
		sessionName,
		spawnFn: tmuxSpawnFn,
		statFn: options.statFn,
		sleepFn: options.sleepFn,
		timeoutMs: options.waitTimeoutMs,
	});
	if (!ready) {
		printError('Orchestrator did not become ready in time', 'Run `cam run` manually and retry.');
		emitTrailingBlank();
		return 1;
	}
	return 0;
}

/**
 * Validate that a specific issue number N is plannable.
 * Returns `{ ok: true; id }` on success, `{ ok: false }` after printing error.
 * Must NOT fall back to top-of-queue (F-01).
 */
function resolveSpecificIssue(
	issue: number,
	backlog: IssueEntry[],
): { ok: true; id: string } | { ok: false } {
	const entry = backlog.find((e) => numericSuffix(e.id) === issue);
	if (entry === undefined) {
		printError(`issue ${issue} not found`, 'check that the issue exists in scripts/cam/issues/');
		emitTrailingBlank();
		return { ok: false };
	}
	if (entry.stage !== 'specified' || entry.status !== 'open' || isBlocked(entry, backlog)) {
		const reason = buildNotPlannableReason(entry, backlog);
		printError(`issue ${entry.id} is not plannable`, reason);
		emitTrailingBlank();
		return { ok: false };
	}
	return { ok: true, id: entry.id };
}

function buildNotPlannableReason(entry: IssueEntry, backlog: IssueEntry[]): string {
	if (entry.status !== 'open') return `status is ${entry.status} (not open)`;
	if (entry.stage !== 'specified') return `stage is ${entry.stage} (not specified)`;
	if (isBlocked(entry, backlog)) return 'blocked by an unshipped dependency';
	return 'not plannable';
}

/**
 * Pick the top-of-queue plannable issue (bare `cam plan` path).
 * Returns `{ ok: true; id }` on success, `{ ok: false }` after printing error.
 */
function resolveTopOfQueue(backlog: IssueEntry[]): { ok: true; id: string } | { ok: false } {
	const top = selectPlannableIssue(backlog);
	if (top === null) {
		printError('no plannable issue found', 'ensure an issue with stage:specified and status:open exists');
		emitTrailingBlank();
		return { ok: false };
	}
	return { ok: true, id: top.id };
}

/**
 * Build the state-file body for phase:planning + plan_issue.
 * Merges with existing state-file fields when the file is already present.
 */
function buildPlanningBody(claudeDir: string, planIssueId: string): string {
	const stateFilePath = join(claudeDir, 'cam-loop.local.md');
	const now = new Date().toISOString();
	if (!existsSync(stateFilePath)) {
		return renderStateFile({
			maxIterations: DEFAULT_MAX_ITERATIONS,
			completionPromise: DEFAULT_COMPLETION_PROMISE,
			startedAt: now,
			pid: process.pid,
			phase: 'planning',
			lastActivity: now,
			plan_issue: planIssueId,
		});
	}
	const contents = readFileSync(stateFilePath, 'utf8');
	const parsed = parseStateFile(contents);
	return renderStateFile({
		maxIterations: parsed?.max_iterations ?? DEFAULT_MAX_ITERATIONS,
		completionPromise: parsed?.completion_promise ?? DEFAULT_COMPLETION_PROMISE,
		startedAt: parsed?.started_at ?? now,
		pid: parsed?.pid ?? process.pid,
		phase: 'planning',
		iteration: parsed?.iteration,
		currentStory: parsed?.current_story,
		storiesDone: parsed?.stories_done,
		storiesTotal: parsed?.stories_total,
		lastActivity: now,
		plan_issue: planIssueId,
	});
}

// --- Public entrypoint -----------------------------------------------------

/**
 * Run the `cam plan` flow: writes phase:planning + plan_issue to the loop
 * state file (US-004 of CAM-151).
 *
 * The liveness/bootstrap/mutex preamble is unchanged from the previous
 * thin-proxy. The SEND step (send-keys /cam-plan) is replaced by a
 * state-file write that the sidecar detects via its poll loop.
 *
 * Returns 0 on success, 1 on any failure.
 */
export async function runPlan(options: PlanOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;

	const { spawnSync } = await import('node:child_process');
	const tmuxSpawnFn: TmuxSpawnFn =
		options.tmuxSpawnFn ??
		((cmd, args, opts) => spawnSync(cmd, args, { stdio: opts?.stdio ?? 'ignore' }));

	emitTitle('cam plan');
	emitSectionHeading('Orchestrator');

	const sessionName = projectSessionName(cwd);
	const claudeDir = join(cwd, '.claude');

	// --- Liveness check / bootstrap -------------------------------------------
	const alive = hasSession(sessionName, tmuxSpawnFn) && orchestratorAlive(sessionName, tmuxSpawnFn);
	if (!alive) {
		const code = await bootstrapAndWait(cwd, claudeDir, sessionName, tmuxSpawnFn, options);
		if (code !== 0) return code;
	}

	// --- Mutex check (US-009) -------------------------------------------------
	if (paneCountMutex(sessionName, tmuxSpawnFn) === 'busy') {
		printError('worker busy', 'blocked until the worker-pane closes');
		emitTrailingBlank();
		return 1;
	}

	// --- Resolve issue to plan (F-01) -----------------------------------------
	const backlog = options.readBacklogFn ? options.readBacklogFn() : readBacklogFromMain(cwd);
	const resolved =
		options.issue !== undefined
			? resolveSpecificIssue(options.issue, backlog)
			: resolveTopOfQueue(backlog);
	if (!resolved.ok) return 1;

	// --- Write phase:planning + plan_issue to state file ----------------------
	try {
		const body = buildPlanningBody(claudeDir, resolved.id);
		(options.writeFn ?? writeStateFile)(cwd, body, { force: true });
		emitMutedHint(`phase:planning + plan_issue:${resolved.id} written to .claude/cam-loop.local.md`);
	} catch (err) {
		printError(
			'Failed to write phase:planning to .claude/cam-loop.local.md',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}

	emitOk(`Plan phase initiated: ${resolved.id} (phase:planning written)`);
	emitAttachHint(sessionName, env);
	emitTrailingBlank();
	return 0;
}
