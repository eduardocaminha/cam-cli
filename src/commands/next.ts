// src/commands/next.ts
//
// Implementation of `cam next` -- thin-proxy that routes the implementation
// task prompt to the live orchestrator pane via send-keys (US-006).
//
// ARCHITECTURE (US-006 single-hub dispatch):
//   `cam run` is the only dispatch hub. `cam next` is now a thin-proxy that
//   detects the live orchestrator and injects the task prompt into it via
//   atomic send-keys. The orchestrator (claude agent) then schedules and
//   dispatches the worker.
//
//   On miss (no live orchestrator): bootstrap `cam run --no-attach`, poll
//   `.claude/.cam-orch-ready` (+ orchestratorAlive re-check), then send-keys.
//
// Utility exports kept for supervisor internals and tests:
//   renderStateFile, writeStateFile, DEFAULT_MAX_ITERATIONS,
//   DEFAULT_COMPLETION_PROMISE, DEFAULT_TASK_PROMPT.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { readEmbedded } from '../vendor/embedded.ts';
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
	getOrchPaneId,
	paneCountMutex,
	projectSessionName,
	type Env,
	type SpawnFn as TmuxSpawnFn,
} from '../tmux/session.ts';
import { waitForOrchestrator } from '../tmux/bootstrap-wait.ts';
import { sendKeysWhenIdle, type CapturePaneFn } from '../tmux/dispatch.ts';

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

/**
 * Default task prompt sent to the orchestrator when `cam next` is invoked.
 * The orchestrator (claude agent) receives this as a natural-language request
 * and schedules the next worker accordingly.
 */
export const DEFAULT_TASK_PROMPT =
	'Implement the next user story from scripts/cam/prd.json per your AGENT.md.';

/** State-file path relative to cwd. Read by cam status / cam dashboard. */
const STATE_FILE_PATH = '.claude/cam-loop.local.md';

// ---------------------------------------------------------------------------
// Vendored template utilities (kept for supervisor internals and tests)
// ---------------------------------------------------------------------------

/**
 * Render the supervisor state-file body from the vendored template.
 * Substitution is a dumb literal `{{KEY}} -> value` replace.
 *
 * Kept as an exported utility so the supervisor (loop.ts) and tests can
 * still use it even though `runNext` is now a thin-proxy.
 */
export function renderStateFile(input: {
	maxIterations: number;
	completionPromise: string;
	startedAt: string;
	pid: number;
	active?: boolean;
	iteration?: number;
	currentStory?: string | null;
	storiesDone?: number;
	storiesTotal?: number;
	lastActivity?: string;
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
	return tmpl
		.replace('{{ACTIVE}}', String(input.active ?? true))
		.replace('{{ITERATION}}', String(input.iteration ?? 1))
		.replace('{{MAX_ITERATIONS}}', String(input.maxIterations))
		.replace('{{COMPLETION_PROMISE_YAML}}', promiseYaml)
		.replace('{{STARTED_AT}}', input.startedAt)
		.replace('{{PID}}', String(input.pid))
		.replace('{{CURRENT_STORY_YAML}}', currentStoryYaml)
		.replace('{{STORIES_DONE}}', String(input.storiesDone ?? 0))
		.replace('{{STORIES_TOTAL}}', String(input.storiesTotal ?? 0))
		.replace('{{LAST_ACTIVITY}}', input.lastActivity ?? input.startedAt)
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
	/** Task prompt sent to the orchestrator. Default: DEFAULT_TASK_PROMPT. */
	taskPrompt?: string;
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
	 * Sleep function for the ready-poll and idle-poll. Defaults to `Bun.sleepSync`.
	 * Tests inject a no-op to avoid real waits.
	 */
	sleepFn?: (ms: number) => void;
	/** Total poll budget for waitForOrchestrator (ms). Default 60 000. */
	waitTimeoutMs?: number;
	/**
	 * Override the capture-pane reader used by the idle-check before send-keys.
	 * Tests inject a fake that returns controlled pane content strings.
	 */
	capturePaneFn?: CapturePaneFn;
	/**
	 * Maximum ms to wait for the orchestrator pane to go idle before sending
	 * anyway (fallback: log + still send). Default: 5 000.
	 */
	idleTimeoutMs?: number;
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
 * Run the `cam next` flow: thin-proxy to the live orchestrator (US-006).
 *
 * If the orchestrator is already running (hasSession + orchestratorAlive):
 *   - Sends the task prompt to the orchestrator pane via send-keys.
 *
 * If the orchestrator is not running:
 *   - Bootstraps it via `cam run --no-attach` (or injected bootstrapFn).
 *   - Polls `.claude/.cam-orch-ready` + orchestratorAlive until ready.
 *   - Then sends the task prompt.
 *
 * Returns 0 on success, 1 on bootstrap/liveness failure.
 */
export async function runNext(options: NextOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const taskPrompt = options.taskPrompt ?? DEFAULT_TASK_PROMPT;

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

	// Wait for the orchestrator pane to be idle, then issue atomic send-keys.
	// sendKeysWhenIdle polls capture-pane until the prompt is stable (no
	// spinner / tool-call glyph), then sends text + Enter in one call WITHOUT -l
	// (sendkeys-literal-enter-gotcha: -l would make "Enter" literal and never
	// submit; the text is a single non-key-name arg, already literal; US-008).
	sendKeysWhenIdle({
		paneId: orchPaneId,
		text: taskPrompt,
		tmuxSpawnFn,
		capturePaneFn: options.capturePaneFn,
		sleepFn: options.sleepFn,
		idleTimeoutMs: options.idleTimeoutMs,
	});

	emitOk(`Sent task prompt to orchestrator pane ${orchPaneId}`);
	emitAttachHint(sessionName, env);
	emitTrailingBlank();
	return 0;
}
