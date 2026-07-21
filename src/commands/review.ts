// src/commands/review.ts
//
// Implementation of `cam review` -- thin-proxy that routes /cam-review to the
// live orchestrator pane via send-keys (US-007).
//
// Acceptance criteria (US-007):
//   1. Detect a live orchestrator via orchestratorAlive (US-005 predicate).
//   2. On hit: atomic send-keys /cam-review to the orchestrator pane and
//      return 0 immediately (fire-and-forget).
//   3. On miss: bootstrap cam run --no-attach, poll .claude/.cam-orch-ready
//      (with orchestratorAlive re-check), then send-keys.
//   4. send-keys is atomic (text + Enter in one call), NO -l (it would make "Enter" literal).
//   5. No --permission-mode CLI flag (enforced by no-permission-mode-flag.test.ts).
//   6. Typecheck passes (bun run typecheck).
//   7. Tests pass (bun test).

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
	getOrchPaneId,
	paneCountMutex,
	projectSessionName,
	type Env,
	type SpawnFn as TmuxSpawnFn,
} from '../tmux/session.ts';
import { waitForOrchestrator } from '../tmux/bootstrap-wait.ts';
import { sendKeysWhenIdle, makePushLogEvent, type CapturePaneFn } from '../tmux/dispatch.ts';
import type { WorkerEventKind, WorkerEventDetail } from '../supervisor/events.ts';

// --- Types -----------------------------------------------------------------

export interface ReviewOptions {
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
	 * Bootstrap the orchestrator when not alive. Receives `cwd` and
	 * returns a Promise<boolean> (true = bootstrap succeeded).
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
	 * anyway (fallback: log + still send). Default:
	 * `IDLE_WAIT_DEADLINE_MS` (30 000 ms, see src/tmux/dispatch.ts).
	 */
	idleTimeoutMs?: number;
	/**
	 * Injectable sink for events emitted by `sendKeysWhenIdle` (currently only
	 * `'push-undelivered'`, on retry exhaustion). Default: the real event log
	 * (`.claude/cam-worker-events.jsonl`), adapted via `adaptLogEventForPush`
	 * (US-003, CAM-359). Tests inject `makeInMemoryEventLogger()` instead of
	 * touching the real event log.
	 */
	logEvent?: (kind: WorkerEventKind, detail: WorkerEventDetail) => void;
}

// --- Internal helpers -------------------------------------------------------

async function doBootstrap(cwd: string, bootstrapFn?: () => Promise<boolean>): Promise<boolean> {
	if (bootstrapFn) return bootstrapFn();
	const { spawnSync } = await import('node:child_process');
	const result = spawnSync('cam', ['run', '--no-attach'], { cwd, stdio: 'ignore' });
	return (result.status ?? 1) === 0;
}

// --- Public entrypoint -----------------------------------------------------

/**
 * Run the `cam review` flow: thin-proxy to the live orchestrator (US-007).
 *
 * If the orchestrator is already running (hasSession + orchestratorAlive):
 *   - Sends `/cam-review` to the orchestrator pane via send-keys.
 *
 * If the orchestrator is not running:
 *   - Bootstraps it via `cam run --no-attach` (or injected bootstrapFn).
 *   - Polls `.claude/.cam-orch-ready` + orchestratorAlive until ready.
 *   - Then sends the request.
 *
 * Returns 0 on success, 1 on bootstrap/liveness failure.
 */
export async function runReview(options: ReviewOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const request = '/cam-review';

	const { spawnSync } = await import('node:child_process');
	const tmuxSpawnFn: TmuxSpawnFn =
		options.tmuxSpawnFn ??
		((cmd, args, opts) => spawnSync(cmd, args, { stdio: opts?.stdio ?? 'ignore' }));

	emitTitle('cam review');
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
				'Run `cam run` manually, then retry `cam review`.',
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

	// sendKeysWhenIdle: idle-gate + atomic send-keys (no -l; US-008).
	// logEvent (US-003, CAM-359) defaults via makePushLogEvent (wraps
	// adaptLogEventForPush) so retry exhaustion traces instead of vanishing.
	const logEvent = options.logEvent ?? makePushLogEvent(cwd, 'cli-review');
	sendKeysWhenIdle({
		paneId: orchPaneId,
		text: request,
		tmuxSpawnFn,
		capturePaneFn: options.capturePaneFn,
		sleepFn: options.sleepFn,
		idleTimeoutMs: options.idleTimeoutMs,
		logEvent,
	});

	emitOk(`Sent "${request}" to orchestrator pane ${orchPaneId}`);
	emitAttachHint(sessionName, env);
	emitTrailingBlank();
	return 0;
}
