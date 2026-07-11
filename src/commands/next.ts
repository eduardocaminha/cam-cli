// src/commands/next.ts
//
// Implementation of `cam next` -- thin-proxy that flips active:true to trigger
// the sidecar (US-001 of CAM-78).
//
// ARCHITECTURE (US-006 single-hub dispatch):
//   `cam run` is the only dispatch hub. `cam next` is a thin-proxy that
//   detects the live orchestrator pane (liveness precondition) and then writes
//   active:true to .claude/cam-loop.local.md. The sidecar (spawned by cam run)
//   polls that flag and dispatches the next worker autonomously.
//
//   On miss (no live orchestrator): bootstrap `cam run --no-attach`, poll
//   `.claude/.cam-orch-ready` (+ orchestratorAlive re-check), then flip.
//
// Utility exports kept for supervisor internals and tests:
//   renderStateFile, writeStateFile, DEFAULT_MAX_ITERATIONS,
//   DEFAULT_COMPLETION_PROMISE.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { readEmbedded } from '../vendor/embedded.ts';
import { printError } from '../logging/color.ts';
import type { LoopPhase } from './status.ts';
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
	getOrchPaneId,
	paneCountMutex,
	projectSessionName,
	type Env,
	type SpawnFn as TmuxSpawnFn,
} from '../tmux/session.ts';
import { waitForOrchestrator } from '../tmux/bootstrap-wait.ts';
import { parseStateFile } from './status.ts';
import { sidecarLivenessGate } from './sidecar-gate.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default `--max-iterations` (kept for backward compat / future use).
 */
export const DEFAULT_MAX_ITERATIONS = 30;

/**
 * Default `--completion-promise` value (kept for backward compat).
 */
export const DEFAULT_COMPLETION_PROMISE = 'COMPLETE';

/** State-file path relative to cwd. Read by cam status / cam dashboard. */
const STATE_FILE_PATH = '.claude/cam-loop.local.md';

// ---------------------------------------------------------------------------
// Vendored template utilities (kept for supervisor internals and tests)
// ---------------------------------------------------------------------------

/**
 * Read the current `phase` from the on-disk state file under `cwd`. Used by
 * `renderStateFile`'s read-modify-write phase preservation (US-001, CAM-195).
 * Returns `undefined` when the file is absent, unreadable, unparseable, or
 * has no `phase` field — all of which the caller treats as "no phase to
 * preserve" and falls back to `idle`.
 */
function readCurrentPhase(cwd: string): LoopPhase | undefined {
	const path = join(cwd, STATE_FILE_PATH);
	if (!existsSync(path)) return undefined;
	try {
		const contents = readFileSync(path, 'utf8');
		return parseStateFile(contents)?.phase;
	} catch {
		return undefined;
	}
}

/**
 * Render the supervisor state-file body from the vendored template.
 * Substitution is a dumb literal `{{KEY}} -> value` replace.
 *
 * Kept as an exported utility so the supervisor (loop.ts) and tests can
 * still use it even though `runNext` is now a thin-proxy.
 *
 * `phase` is the single source of truth for the `active` field:
 *   - When `phase` is provided, `active` is derived as `phase === 'implementing'`.
 *   - When `phase` is absent AND `cwd` is provided, renderStateFile is
 *     read-modify-write (US-001, CAM-195, Defect 3): it reads the CURRENT
 *     on-disk phase at `cwd` and preserves it, rather than deriving from the
 *     legacy `active` flag. A nonexistent/unparseable/phase-less file at
 *     `cwd` defaults to `idle`.
 *   - When `phase` and `cwd` are both absent, it is derived from the legacy
 *     `active` flag (`true` -> `implementing`, `false` -> `idle`), preserving
 *     backward compat for existing callers that only pass `active`.
 */
export function renderStateFile(input: {
	maxIterations: number;
	completionPromise: string;
	startedAt: string;
	pid: number;
	/** Loop lifecycle phase (US-001 CAM-151). When provided, `active` is derived from it. */
	phase?: LoopPhase;
	/** Legacy active flag — used only when `phase` and `cwd` are both absent (back-compat). */
	active?: boolean;
	iteration?: number;
	currentStory?: string | null;
	storiesDone?: number;
	storiesTotal?: number;
	lastActivity?: string;
	/** Optional issue ref associated with an in-progress plan (e.g. "CAM-151"). */
	plan_issue?: string | null;
	/**
	 * Working directory enabling read-modify-write phase preservation
	 * (US-001, CAM-195) when `phase` is absent. See the function doc above.
	 */
	cwd?: string;
}): string {
	const tmpl = readEmbedded('cam-loop.local.md.tmpl');
	const promiseYaml =
		input.completionPromise.length === 0
			? 'null'
			: `"${input.completionPromise.replace(/"/g, '\\"')}"`;
	const currentStoryYaml =
		input.currentStory != null && input.currentStory.length > 0
			? `"${input.currentStory.replace(/"/g, '\\"')}"`
			: 'null';
	// Derive effective phase and active from the inputs (US-001 CAM-151, refined
	// for read-modify-write by US-001 CAM-195).
	//   1. Explicit `phase` always wins.
	//   2. Absent `phase` + `cwd` given: read-modify-write — preserve the
	//      CURRENT on-disk phase; a nonexistent/unparseable/phase-less file
	//      defaults to 'idle'.
	//   3. Absent `phase` + no `cwd`: legacy back-compat derivation from `active`.
	const effectivePhase: LoopPhase =
		input.phase ??
		(input.cwd !== undefined
			? readCurrentPhase(input.cwd) ?? 'idle'
			: input.active !== false
				? 'implementing'
				: 'idle');
	const effectiveActive = effectivePhase === 'implementing';
	const planIssueYaml =
		input.plan_issue != null && input.plan_issue.length > 0
			? `"${input.plan_issue.replace(/"/g, '\\"')}"`
			: 'null';
	return tmpl
		.replace('{{ACTIVE}}', String(effectiveActive))
		.replace('{{PHASE}}', effectivePhase)
		.replace('{{ITERATION}}', String(input.iteration ?? 1))
		.replace('{{MAX_ITERATIONS}}', String(input.maxIterations))
		.replace('{{COMPLETION_PROMISE_YAML}}', promiseYaml)
		.replace('{{STARTED_AT}}', input.startedAt)
		.replace('{{PID}}', String(input.pid))
		.replace('{{CURRENT_STORY_YAML}}', currentStoryYaml)
		.replace('{{STORIES_DONE}}', String(input.storiesDone ?? 0))
		.replace('{{STORIES_TOTAL}}', String(input.storiesTotal ?? 0))
		.replace('{{LAST_ACTIVITY}}', input.lastActivity ?? input.startedAt)
		.replace('{{PLAN_ISSUE_YAML}}', planIssueYaml)
		.replace('{{PROMPT}}', '');
}

/**
 * Write `.claude/cam-loop.local.md` under `cwd`, creating `.claude/` if
 * needed. Returns the absolute path written. Refuses to clobber an existing
 * file unless `force` is true.
 */
export function writeStateFile(
	cwd: string,
	body: string,
	options: { force?: boolean } = {},
): string {
	const target = join(cwd, STATE_FILE_PATH);
	const dir = dirname(target);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	if (existsSync(target) && !options.force) {
		throw new Error(
			`state file already exists at ${target} — run \`cam stop\` to clear`,
		);
	}
	writeFileSync(target, body, 'utf8');
	return target;
}

// ---------------------------------------------------------------------------
// Public types (simplified for thin-proxy)
// ---------------------------------------------------------------------------

export interface NextOptions {
	/** Override `--max-iterations`; kept for CLI parity, not used by thin-proxy. */
	maxIterations?: number;
	/** Override `--completion-promise`; kept for CLI parity, not used. */
	completionPromise?: string;
	/** Override the working directory; default `process.cwd()`. */
	cwd?: string;
	/**
	 * Override the synchronous spawn function used for tmux calls.
	 * Tests inject a fake so they never call a real tmux binary.
	 */
	tmuxSpawnFn?: TmuxSpawnFn;
	/**
	 * Override process.env for attach-hint detection.
	 */
	env?: Env;
	/**
	 * Bootstrap the orchestrator when not alive.
	 * Defaults to `spawnSync('cam', ['run', '--no-attach'])`.
	 * Tests inject a no-op that returns true immediately.
	 */
	bootstrapFn?: () => Promise<boolean>;
	/**
	 * File-existence check injected for tests (avoids real fs access
	 * in the .cam-orch-ready poll). Defaults to `fs.existsSync`.
	 */
	statFn?: (path: string) => boolean;
	/**
	 * Sleep function for the ready-poll. Defaults to `Bun.sleepSync`.
	 * Tests inject a no-op to avoid real waits.
	 */
	sleepFn?: (ms: number) => void;
	/** Total poll budget for waitForOrchestrator (ms). Default 60 000. */
	waitTimeoutMs?: number;
	/**
	 * Override the function used to write the state file.
	 * Defaults to `writeStateFile`. Tests inject a throwing function to
	 * exercise the write-failure error path.
	 */
	writeFn?: (cwd: string, body: string, opts: { force?: boolean }) => string;
	/**
	 * Injectable sidecar-liveness probe (US-003, CAM-207). Defaults to
	 * `sidecarAlive` from `src/supervisor/sidecar-pid.ts`. Tests inject a fake
	 * to exercise the dead/alive branches without touching real pids.
	 */
	sidecarAliveFn?: (claudeDir: string) => boolean;
}

// --- Internal helpers -------------------------------------------------------

async function doBootstrap(cwd: string, bootstrapFn?: () => Promise<boolean>): Promise<boolean> {
	if (bootstrapFn) return bootstrapFn();
	const { spawnSync } = await import('node:child_process');
	const result = spawnSync('cam', ['run', '--no-attach'], { cwd, stdio: 'ignore' });
	return (result.status ?? 1) === 0;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the `cam next` flow: thin-proxy that flips active:true (US-001, CAM-78).
 *
 * If the orchestrator is already running (hasSession + orchestratorAlive):
 *   - Verifies the orchestrator pane exists (precondition).
 *   - Writes active:true to .claude/cam-loop.local.md (sidecar trigger).
 *
 * If the orchestrator is not running:
 *   - Bootstraps it via `cam run --no-attach` (or injected bootstrapFn).
 *   - Polls `.claude/.cam-orch-ready` + orchestratorAlive until ready.
 *   - Then flips active:true.
 *
 * Returns 0 on success, 1 on bootstrap/liveness failure.
 */
export async function runNext(options: NextOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;

	const { spawnSync } = await import('node:child_process');
	const tmuxSpawnFn: TmuxSpawnFn =
		options.tmuxSpawnFn ??
		((cmd, args, opts) => spawnSync(cmd, args, { stdio: opts?.stdio ?? 'ignore' }));

	emitTitle('cam next');
	emitSectionHeading('Orchestrator');

	const sessionName = projectSessionName(cwd);
	const claudeDir = join(cwd, '.claude');

	// --- Liveness check -------------------------------------------------------
	const alive = hasSession(sessionName, tmuxSpawnFn) && orchestratorAlive(sessionName, tmuxSpawnFn);

	if (!alive) {
		emitMutedHint('No live orchestrator detected, bootstrapping cam run...');
		const bootstrapped = await doBootstrap(cwd, options.bootstrapFn);
		if (!bootstrapped) {
			printError(
				'Failed to bootstrap orchestrator',
				'Run `cam run` manually, then retry `cam next`.',
			);
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
			printError(
				'Orchestrator did not become ready in time',
				'Run `cam run` manually and retry.',
			);
			emitTrailingBlank();
			return 1;
		}
	}

	// --- Mutex check (US-009) ------------------------------------------------
	// Refuse to dispatch if a worker pane is already running (3 panes = busy).
	// A 4th pane must never be spawned; exit with non-zero so the caller knows.
	const mutexState = paneCountMutex(sessionName, tmuxSpawnFn);
	if (mutexState === 'busy') {
		printError('worker busy', 'blocked until the worker-pane closes');
		emitTrailingBlank();
		return 1;
	}

	// --- Send request ---------------------------------------------------------
	const orchPaneId = getOrchPaneId(sessionName, tmuxSpawnFn);
	if (!orchPaneId) {
		printError(
			'Could not find orchestrator pane',
			'The session exists but pane index 0 is missing.',
		);
		emitTrailingBlank();
		return 1;
	}

	// --- Sidecar liveness gate (US-003, CAM-207) ------------------------------
	if (!sidecarLivenessGate(claudeDir, 'next', options.sidecarAliveFn)) return 1;

	// --- Flip active:true to trigger the sidecar (US-FIX-002) ----------------
	// The sidecar (spawned by cam run) polls .claude/cam-loop.local.md for the
	// active flag. Setting it to true here is the trigger that makes the sidecar
	// acquire the supervisor lock and start the deterministic loop. If the state
	// file does not exist yet, we create it with sensible defaults. If it already
	// exists (e.g. from a previous `cam next`), we overwrite only the active flag
	// while preserving the other fields.
	const stateFilePath = join(claudeDir, 'cam-loop.local.md');
	try {
		const now = new Date().toISOString();
		let newBody: string;
		if (existsSync(stateFilePath)) {
			const contents = readFileSync(stateFilePath, 'utf8');
			const parsed = parseStateFile(contents);
			newBody = renderStateFile({
				maxIterations: parsed?.max_iterations ?? DEFAULT_MAX_ITERATIONS,
				completionPromise: parsed?.completion_promise ?? DEFAULT_COMPLETION_PROMISE,
				startedAt: parsed?.started_at ?? now,
				pid: parsed?.pid ?? process.pid,
				active: true,
				iteration: parsed?.iteration,
				currentStory: parsed?.current_story,
				storiesDone: parsed?.stories_done,
				storiesTotal: parsed?.stories_total,
				lastActivity: now,
			});
		} else {
			newBody = renderStateFile({
				maxIterations: DEFAULT_MAX_ITERATIONS,
				completionPromise: DEFAULT_COMPLETION_PROMISE,
				startedAt: now,
				pid: process.pid,
				active: true,
				lastActivity: now,
			});
		}
		(options.writeFn ?? writeStateFile)(cwd, newBody, { force: true });
		emitMutedHint('Sidecar trigger: active:true written to .claude/cam-loop.local.md');
	} catch (err) {
		printError(
			'Failed to write active:true to .claude/cam-loop.local.md',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}

	emitOk(`Sidecar trigger written (active:true); orchestrator pane ${orchPaneId} ready`);
	emitAttachHint(sessionName, env);
	emitTrailingBlank();
	return 0;
}
