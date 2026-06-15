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
//   4. send-keys is atomic (text + Enter in one call) and uses -l for literal.
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
	projectSessionName,
	tmuxArgs,
	type Env,
	type SpawnFn as TmuxSpawnFn,
} from '../tmux/session.ts';
import { waitForOrchestrator } from '../tmux/bootstrap-wait.ts';

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
	 * Sleep function for the ready-poll. Defaults to `Bun.sleepSync`.
	 * Tests inject a no-op to avoid real waits.
	 */
	sleepFn?: (ms: number) => void;
	/** Total poll budget for waitForOrchestrator (ms). Default 60 000. */
	waitTimeoutMs?: number;
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

	// Atomic text + Enter in one send-keys call; -l for literal payload so
	// slash characters and spaces in the request are not interpreted as key
	// sequences (patterns.md: send-keys atomic text+Enter, -l for literal).
	tmuxSpawnFn(
		'tmux',
		tmuxArgs(['send-keys', '-t', orchPaneId, '-l', request, 'Enter']),
		{ stdio: 'ignore' },
	);

	emitOk(`Sent "${request}" to orchestrator pane ${orchPaneId}`);
	emitAttachHint(sessionName, env);
	emitTrailingBlank();
	return 0;
}
