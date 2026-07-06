// src/commands/spec.ts
//
// Implementation of `cam spec` -- thin-proxy that routes /cam-spec <id> to the
// live orchestrator pane via send-keys (US-004, CAM-107), PLUS the in-process
// `--write-docs` write channel (US-003, CAM-118) that lets the read-only
// orchestrator persist domain docs via a single Bash pipe, exactly like
// `cam journal append` / `cam issue --file-local`.
//
// Acceptance criteria (US-004, thin-proxy path):
//   1. Detect a live orchestrator via orchestratorAlive.
//   2. On hit: atomic send-keys /cam-spec <id> to the orchestrator pane and
//      return 0 immediately (fire-and-forget).
//   3. On miss: bootstrap cam run --no-attach, poll .claude/.cam-orch-ready
//      (with orchestratorAlive re-check), then send-keys.
//   4. send-keys is atomic (text + Enter in one call), NO -l (it would make "Enter" literal).
//   5. No --permission-mode CLI flag (enforced by no-permission-mode-flag.test.ts).
//   6. Typecheck passes (bun run typecheck).
//   7. Tests pass (bun test).
//
// Acceptance criteria (US-003, --write-docs path):
//   1. `echo '<json>' | cam spec --write-docs <id>` reads the DomainDocsPayload
//      from stdin and calls writeDomainDocsOnMain in-process: NO tmux calls,
//      no send-keys, no pane bootstrap, no orchestrator liveness check.
//   2. Exit 0 on { ok: true } including noOp (prints a muted hint); exit 1 on
//      malformed stdin JSON, invalid payload (errors printed), or a guard
//      failure (diverged / detached-head / missing-main).

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
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
import { sendKeysWhenIdle, type CapturePaneFn } from '../tmux/dispatch.ts';
import {
	writeDomainDocsOnMain,
	type ClockFn,
	type SpawnFn as OnMainSpawnFn,
	type WriteDomainDocsOnMainOutcome,
} from './domain-docs.ts';
import type { DomainDocsPayload } from '../domain-docs/render.ts';

// --- Types -----------------------------------------------------------------

export interface SpecOptions {
	/** Issue id to spec (e.g. 'CAM-42'); passed through as `/cam-spec CAM-42`. */
	id: string;
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

// --- Public entrypoint -----------------------------------------------------

/**
 * Run the `cam spec` flow: thin-proxy to the live orchestrator (US-004, CAM-107).
 *
 * If the orchestrator is already running (hasSession + orchestratorAlive):
 *   - Sends `/cam-spec <id>` to the orchestrator pane via send-keys.
 *
 * If the orchestrator is not running:
 *   - Bootstraps it via `cam run --no-attach` (or injected bootstrapFn).
 *   - Polls `.claude/.cam-orch-ready` + orchestratorAlive until ready.
 *   - Then sends the request.
 *
 * Returns 0 on success, 1 on bootstrap/liveness failure.
 */
export async function runSpec(options: SpecOptions): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const { id } = options;
	const request = `/cam-spec ${id}`;

	const { spawnSync } = await import('node:child_process');
	const tmuxSpawnFn: TmuxSpawnFn =
		options.tmuxSpawnFn ??
		((cmd, args, opts) => spawnSync(cmd, args, { stdio: opts?.stdio ?? 'ignore' }));

	emitTitle('cam spec');
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
				'Run `cam run` manually, then retry `cam spec`.',
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

	// --- Mutex check ---------------------------------------------------------
	// Refuse to dispatch if a worker pane is already running (3 panes = busy).
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
	// (sendkeys-literal-enter-gotcha: -l would make "Enter" literal and never submit).
	sendKeysWhenIdle({
		paneId: orchPaneId,
		text: request,
		tmuxSpawnFn,
		capturePaneFn: options.capturePaneFn,
		sleepFn: options.sleepFn,
		idleTimeoutMs: options.idleTimeoutMs,
	});

	emitOk(`Sent "${request}" to orchestrator pane ${orchPaneId}`);
	emitAttachHint(sessionName, env);
	emitTrailingBlank();
	return 0;
}

// --- --write-docs entrypoint (US-003, CAM-118) ------------------------------

export interface SpecWriteDocsOptions {
	/** Id the domain docs are being written for (drives the commit message). */
	id: string;
	/** Override the working directory; default `process.cwd()`. */
	cwd?: string;
	/**
	 * Injectable stdin reader. Default: `Bun.stdin.text()` (matches the
	 * `cam journal append` / `cam issue --file-local` stdin-JSON convention).
	 */
	readStdin?: () => Promise<string>;
	/**
	 * Injectable spawnSync-based git plumbing fn, passed through to
	 * writeDomainDocsOnMain. Default: a `spawnSync` wrapper over `git`.
	 */
	spawnFn?: OnMainSpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. Default: `new Date().toISOString()`. */
	clock?: ClockFn;
	/** Injectable stdout writer. Default: `process.stdout.write`. */
	writeStdout?: (line: string) => void;
	/**
	 * Injectable full bypass of stdin-read + writeDomainDocsOnMain, for
	 * branch-isolation unit tests. When present, `readStdin`/`spawnFn`/`clock`
	 * are never consulted.
	 */
	writeFn?: (payload: unknown) => WriteDomainDocsOnMainOutcome;
}

/**
 * `cam spec --write-docs <id>`: read a DomainDocsPayload as JSON from stdin
 * and call writeDomainDocsOnMain in-process. NO tmux calls, no send-keys, no
 * pane bootstrap, no orchestrator liveness check -- this is the write channel
 * FOR the orchestrator (the orchestrator's own tools disallow Edit/Write/
 * NotebookEdit), mirroring `cam journal append` / `cam issue --file-local`.
 *
 * Returns 0 on `{ ok: true }` (including the noOp outcome, which prints a
 * muted "nothing to write" hint); returns 1 on malformed stdin JSON, an
 * invalid payload (validation errors printed), or a guard failure (diverged /
 * detached-head / missing-main).
 */
export async function runSpecWriteDocs(options: SpecWriteDocsOptions): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const readStdin = options.readStdin ?? (() => Bun.stdin.text());
	const writeStdout =
		options.writeStdout ?? ((line: string) => { process.stdout.write(line); });
	const clock = options.clock ?? (() => new Date().toISOString());
	const spawnFn: OnMainSpawnFn =
		options.spawnFn ??
		((cmd, args, opts) => spawnSync(cmd, args, { ...opts, stdio: 'pipe' }) as SpawnSyncReturns<string>);

	const stdinText = await readStdin();
	let payload: unknown;
	try {
		payload = JSON.parse(stdinText);
	} catch (err) {
		printError(`cam spec --write-docs: invalid JSON from stdin: ${String(err)}`);
		return 1;
	}

	const outcome: WriteDomainDocsOnMainOutcome = options.writeFn
		? options.writeFn(payload)
		: writeDomainDocsOnMain({
				cwd,
				id: options.id,
				payload: payload as DomainDocsPayload,
				spawnFn,
				clock,
			});

	if (!outcome.ok) {
		if (outcome.reason === 'invalid-payload') {
			printError('cam spec --write-docs: invalid payload', outcome.errors.join('; '));
		} else {
			printError(
				`cam spec --write-docs: ${outcome.reason}`,
				'ensure main is up to date and you are not on a detached HEAD, then retry.',
			);
		}
		return 1;
	}

	if (outcome.noOp) {
		emitMutedHint('nothing to write (empty payload: no terms, no adrs)');
		return 0;
	}

	writeStdout(`CAM_DOMAIN_DOCS_WRITTEN=${options.id} sha=${outcome.sha}\n`);
	return 0;
}
