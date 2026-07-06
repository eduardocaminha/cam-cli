// src/commands/ship.ts
//
// Implementation of `cam ship` (no flags) -- thin-proxy that writes
// phase:shipping to the loop state file instead of injecting a slash
// command via send-keys (US-005 of CAM-149).
//
// Acceptance criteria (US-005):
//   1. runShip writes phase:shipping to .claude/cam-loop.local.md (mirrors
//      runPlan's buildPlanningBody + writeStateFile pattern), preserving all
//      other state-file fields, and no longer sends a slash command via
//      send-keys. The liveness/bootstrap preamble and the paneCountMutex
//      busy-refusal are preserved.
//   2. --bump / --finalize argv parsing and dispatch (index.ts's
//      parseShipArgs/dispatchShip) are unchanged in behavior.
//   3. index.ts help text describes the phase-signal behavior.
//   4. No --permission-mode CLI flag (no-permission-mode-flag.test.ts).
//   5. Typecheck passes (bun run typecheck).
//   6. Tests pass (bun test).

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

// --- Types -----------------------------------------------------------------

export interface ShipOptions {
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
	/** Injectable state-file writer for tests. Defaults to writeStateFile. */
	writeFn?: (cwd: string, body: string, opts: { force?: boolean }) => string;
}

// --- Internal helpers -------------------------------------------------------

async function doBootstrap(cwd: string, bootstrapFn?: () => Promise<boolean>): Promise<boolean> {
	if (bootstrapFn) return bootstrapFn();
	const { spawnSync } = await import('node:child_process');
	const result = spawnSync('cam', ['run', '--no-attach'], { cwd, stdio: 'ignore' });
	return (result.status ?? 1) === 0;
}

/**
 * Build the state-file body for phase:shipping.
 * Merges with existing state-file fields when the file is already present
 * (mirrors plan.ts's buildPlanningBody).
 */
function buildShippingBody(claudeDir: string): string {
	const stateFilePath = join(claudeDir, 'cam-loop.local.md');
	const now = new Date().toISOString();
	if (!existsSync(stateFilePath)) {
		return renderStateFile({
			maxIterations: DEFAULT_MAX_ITERATIONS,
			completionPromise: DEFAULT_COMPLETION_PROMISE,
			startedAt: now,
			pid: process.pid,
			phase: 'shipping',
			lastActivity: now,
		});
	}
	const contents = readFileSync(stateFilePath, 'utf8');
	const parsed = parseStateFile(contents);
	return renderStateFile({
		maxIterations: parsed?.max_iterations ?? DEFAULT_MAX_ITERATIONS,
		completionPromise: parsed?.completion_promise ?? DEFAULT_COMPLETION_PROMISE,
		startedAt: parsed?.started_at ?? now,
		pid: parsed?.pid ?? process.pid,
		phase: 'shipping',
		iteration: parsed?.iteration,
		currentStory: parsed?.current_story,
		storiesDone: parsed?.stories_done,
		storiesTotal: parsed?.stories_total,
		lastActivity: now,
		plan_issue: parsed?.plan_issue,
	});
}

// --- Public entrypoint -----------------------------------------------------

/**
 * Run the `cam ship` flow: writes phase:shipping to the loop state file
 * (US-005 of CAM-149).
 *
 * The liveness/bootstrap/mutex preamble is unchanged from the previous
 * thin-proxy. The SEND step (send-keys to the orchestrator pane) is
 * replaced by a state-file write that the sidecar's deterministic ship
 * runner detects and acts on.
 *
 * Returns 0 on success, 1 on any failure.
 */
export async function runShip(options: ShipOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;

	const { spawnSync } = await import('node:child_process');
	const tmuxSpawnFn: TmuxSpawnFn =
		options.tmuxSpawnFn ??
		((cmd, args, opts) => spawnSync(cmd, args, { stdio: opts?.stdio ?? 'ignore' }));

	emitTitle('cam ship');
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
				'Run `cam run` manually, then retry `cam ship`.',
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

	// --- Write phase:shipping to state file (US-005) ---------------------------
	// The sidecar's poll loop reads this phase and runs the deterministic ship
	// runner (runShipPhase / runShipPrStep, wired in loop.ts). No slash command
	// is injected into the orchestrator pane anymore.
	try {
		const body = buildShippingBody(claudeDir);
		(options.writeFn ?? writeStateFile)(cwd, body, { force: true });
		emitMutedHint('phase:shipping written to .claude/cam-loop.local.md');
	} catch (err) {
		printError(
			'Failed to write phase:shipping to .claude/cam-loop.local.md',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}

	emitOk('Ship phase initiated (phase:shipping written; sidecar will run the ship pipeline)');
	emitAttachHint(sessionName, env);
	emitTrailingBlank();
	return 0;
}
