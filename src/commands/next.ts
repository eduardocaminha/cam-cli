// src/commands/next.ts
//
// Implementation of `cam next` -- dispatches to the TS supervisor loop.
//
// ARCHITECTURE (Eduardo 2026-06-08, closes CAM-29):
//   The stop-hook driver (vendor/cam-loop-stop-hook.sh + /cam-next re-inject)
//   is RETIRED. Each worker is a real separate claude session spawned via
//   `tmux respawn-pane -k`, reusing the single worker pane established by
//   `cam plan`. The deterministic TS supervisor sequences stories directly.
//
// What `cam next` does, step by step:
//   1. Resolves `permission_mode` from `~/.config/cam/config.toml` via
//      `readPermissionMode()` (default `bypassPermissions`). NO CLI flag
//      overrides this.
//   2. Reads the worker pane id from `.claude/.cam-worker-pane` (written by
//      `cam plan`). If missing, instructs the operator to run `cam plan` first.
//   3. Writes `.claude/cam-loop.local.md` with YAML frontmatter (active, iteration,
//      started_at, pid, session_id, max_iterations) and an empty body -- no
//      stop-hook re-inject prompt. This file is read by `cam status` and
//      `cam dashboard` for display.
//   4. Calls `runSupervisor()` with real I/O adapters (spawn, waitFor, capturePane,
//      readPrd, writePrd, readHandoff, clock, reviewDispatch, writeSessionMarker).
//      The supervisor drives the worker loop until complete, blocked, or max-iterations.
//   5. Returns 0 on complete, 1 on blocked or max-iterations.
//
// Acceptance criteria (US-007):
//   1. runNext dispatches to runSupervisor(); stop-hook code path is REMOVED.
//   2. materializeStopHook, writeSettingsLocal, buildHooksBlock and /cam-next
//      re-inject are gone.
//   3. Supervisor writes .claude/cam-loop.local.md with parseStateFile-compatible
//      fields (iteration, started_at, pid, session_id) and no re-inject body.
//   4. buildClaudeArgv and buildDashboardArgv are removed (not used by run.ts).
//   5. test/next.test.ts covers supervisor dispatch, state-file shape, no stop-hook.
//   6. Commit body + .claude/commands/cam-next.md (US-010) document retirement.
//   7. Typecheck passes (bun run typecheck).
//   8. Tests pass (bun test).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { readPermissionMode } from '../config/permission-mode.ts';
import { printError } from '../logging/color.ts';
import {
	emitAttachHint,
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
	emitWarn,
} from '../logging/screen.ts';
import {
	projectSessionName,
	readWorkerPaneMarker,
	type Env,
} from '../tmux/session.ts';
import { readEmbedded } from '../vendor/embedded.ts';
import { runSupervisor, type RunSupervisorOptions } from '../supervisor/loop.ts';
import { makeReviewDispatch } from '../supervisor/review.ts';
import type { PrdSnapshot } from '../supervisor/decide.ts';

// --- Constants -------------------------------------------------------------

/**
 * Default `--max-iterations` for the supervisor. 30 covers a typical
 * 15-story PRD plus a couple of review rounds.
 */
export const DEFAULT_MAX_ITERATIONS = 30;

/**
 * Default `--completion-promise` value (kept for CLI help parity).
 * The TS supervisor does NOT use a completion promise -- it reads prd.json
 * directly. This constant is preserved for backwards compat with callers
 * that pass it via options.
 */
export const DEFAULT_COMPLETION_PROMISE = 'COMPLETE';

/** State-file path relative to cwd. Read by cam status / cam dashboard. */
const STATE_FILE_PATH = '.claude/cam-loop.local.md';

/** Canonical PRD location in the cam harness dir. */
const PRD_PATH_CANONICAL = 'scripts/cam/prd.json';

/** Handoff file location in the cam harness dir. */
const HANDOFF_PATH_CANONICAL = 'scripts/cam/handoff.json';

/** Default task prompt sent to the implementer agent. */
export const DEFAULT_TASK_PROMPT =
	'Implement the next user story from scripts/cam/prd.json per your AGENT.md.';

// --- Vendored template -----------------------------------------------------

/**
 * Render the supervisor state-file body from the vendored template.
 * Substitution is a dumb literal `{{KEY}} -> value` replace.
 *
 * The body section after the closing `---` is left empty: the supervisor
 * drives the loop directly, so there is no stop-hook re-inject prompt.
 *
 * The template body comes from `vendor/cam-loop.local.md.tmpl`, embedded
 * into the compiled binary via `with { type: "file" }` (src/vendor/embedded.ts).
 */
export function renderStateFile(input: {
	maxIterations: number;
	completionPromise: string;
	startedAt: string;
	sessionId: string;
	pid: number;
}): string {
	const tmpl = readEmbedded('cam-loop.local.md.tmpl');
	const promiseYaml =
		input.completionPromise.length === 0
			? 'null'
			: `"${input.completionPromise.replace(/"/g, '\\"')}"`;
	return tmpl
		.replace('{{SESSION_ID}}', input.sessionId)
		.replace('{{MAX_ITERATIONS}}', String(input.maxIterations))
		.replace('{{COMPLETION_PROMISE_YAML}}', promiseYaml)
		.replace('{{STARTED_AT}}', input.startedAt)
		.replace('{{PID}}', String(input.pid))
		// No stop-hook re-inject prompt: leave the body empty.
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

// --- Public entrypoint -----------------------------------------------------

export interface NextOptions {
	/** Override `--max-iterations`; default `DEFAULT_MAX_ITERATIONS`. */
	maxIterations?: number;
	/** Override `--completion-promise`; kept for CLI parity, not used by supervisor. */
	completionPromise?: string;
	/** Override the working directory; default `process.cwd()`. */
	cwd?: string;
	/** Permission-mode override (purely for tests; production reads config). */
	permissionMode?: string;
	/** Force-overwrite an existing state file. Default: false. */
	force?: boolean;
	/** ISO timestamp used in the state-file frontmatter (override for tests). */
	startedAt?: string;
	/** Session id used in the state-file frontmatter (override for tests). */
	sessionId?: string;
	/** PID written to the state-file frontmatter (override for tests). Default: `process.pid`. */
	pid?: number;
	/**
	 * Override process.env for attach-hint detection. Tests inject a fake env
	 * to assert hint printed/suppressed without touching process.env.
	 */
	env?: Env;
	/**
	 * Override the state-file writer for tests. Receives the cwd and the
	 * rendered body; returns the path that would be written.
	 */
	writer?: (cwd: string, body: string) => string;
	/**
	 * Override the worker-pane-id reader for tests. Receives claudeDir;
	 * returns the pane id or null.
	 */
	workerPaneReader?: (claudeDir: string) => string | null;
	/**
	 * Override the runSupervisor implementation for tests. Receives the same
	 * options bag as the real runSupervisor.
	 */
	supervisorFn?: (opts: RunSupervisorOptions) => Promise<import('../supervisor/loop.ts').SupervisorResult>;
	/**
	 * Task prompt sent to the implementer agent. Default: DEFAULT_TASK_PROMPT.
	 */
	taskPrompt?: string;
	/**
	 * Path to prd.json (override for tests). Default: `<cwd>/scripts/cam/prd.json`.
	 */
	prdPath?: string;
	/**
	 * Path to handoff.json (override for tests). Default: `<cwd>/scripts/cam/handoff.json`.
	 */
	handoffPath?: string;
}

/**
 * Run the `cam next` flow: writes the state file then delegates to runSupervisor().
 *
 * Returns:
 *   0 — supervisor completed (all stories done or review passed)
 *   1 — supervisor blocked, max-iterations reached, missing worker pane, or
 *       state-file write failed
 */
export async function runNext(options: NextOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	const completionPromise = options.completionPromise ?? DEFAULT_COMPLETION_PROMISE;
	const permissionMode = options.permissionMode ?? readPermissionMode();
	const env = options.env ?? process.env;
	const taskPrompt = options.taskPrompt ?? DEFAULT_TASK_PROMPT;
	const prdPath = options.prdPath ?? join(cwd, PRD_PATH_CANONICAL);
	const handoffPath = options.handoffPath ?? join(cwd, HANDOFF_PATH_CANONICAL);

	const claudeDir = join(cwd, '.claude');

	// Compute session name for attach hint.
	const sessionName = projectSessionName(cwd);

	emitTitle('cam next');
	emitSectionHeading('Supervisor');

	// 1. Read worker pane id. Must be allocated by `cam plan` first.
	const workerPaneReader = options.workerPaneReader ?? readWorkerPaneMarker;
	const workerPaneId = workerPaneReader(claudeDir);
	if (!workerPaneId) {
		printError(
			'Worker pane not allocated',
			'Run `cam plan` first to create the worker pane, then re-run `cam next`.',
		);
		emitTrailingBlank();
		return 1;
	}
	emitOk('Worker pane', workerPaneId);

	// 2. Write the supervisor state file. Fields: active, iteration, started_at,
	//    pid, session_id, max_iterations. Body: empty (no stop-hook re-inject).
	const supervisorSessionId =
		options.sessionId ?? process.env['CLAUDE_CODE_SESSION_ID'] ?? crypto.randomUUID();
	const startedAt = options.startedAt ?? new Date().toISOString();
	const pid = options.pid ?? process.pid;

	const stateBody = renderStateFile({
		maxIterations,
		completionPromise,
		startedAt,
		sessionId: supervisorSessionId,
		pid,
	});

	const writer =
		options.writer ??
		((cwd2: string, body: string) => writeStateFile(cwd2, body, { force: options.force ?? false }));

	let writtenPath: string;
	try {
		writtenPath = writer(cwd, stateBody);
	} catch (err) {
		printError(
			'Failed to write cam-loop state file',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}
	emitOk(`State file armed at ${writtenPath}`);

	// 3. Build real I/O adapters for the supervisor.
	const supervisorSpawn: RunSupervisorOptions['spawn'] = (cmd, args, opts) => {
		const result = spawnSync(cmd, args, {
			stdio: opts?.stdio ?? 'pipe',
			encoding: 'utf8',
		} as Parameters<typeof spawnSync>[2]);
		return {
			stdout: typeof result.stdout === 'string' ? result.stdout : '',
			exitCode: result.status ?? null,
		};
	};

	const waitFor: RunSupervisorOptions['waitFor'] = (channel) => {
		spawnSync('tmux', ['-L', 'cam', 'wait-for', channel], { stdio: 'ignore' });
	};

	const capturePane: RunSupervisorOptions['capturePane'] = (paneId) => {
		const result = spawnSync('tmux', ['-L', 'cam', 'capture-pane', '-p', '-t', paneId], {
			stdio: 'pipe',
			encoding: 'utf8',
		} as Parameters<typeof spawnSync>[2]);
		return typeof result.stdout === 'string' ? result.stdout : '';
	};

	const readPrd: RunSupervisorOptions['readPrd'] = () => {
		try {
			const raw = readFileSync(prdPath, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			if (parsed !== null && typeof parsed === 'object') {
				return parsed as PrdSnapshot;
			}
			return null;
		} catch {
			return null;
		}
	};

	const writePrd: RunSupervisorOptions['writePrd'] = (prd) => {
		writeFileSync(prdPath, JSON.stringify(prd, null, 2) + '\n', 'utf8');
	};

	const readHandoff: RunSupervisorOptions['readHandoff'] = () => {
		try {
			const raw = readFileSync(handoffPath, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			if (parsed !== null && typeof parsed === 'object') {
				return parsed as ReturnType<RunSupervisorOptions['readHandoff']>;
			}
			return null;
		} catch {
			return null;
		}
	};

	const clock: RunSupervisorOptions['clock'] = () => new Date().toISOString();

	// Review dispatch: wired via makeReviewDispatch (US-008).
	const reviewDispatch: RunSupervisorOptions['reviewDispatch'] = makeReviewDispatch({
		spawn: (cmd, args) => {
			const proc = spawnSync(cmd, args, { stdio: 'pipe' });
			return {
				stdout: proc.stdout?.toString() ?? '',
				exitCode: proc.status ?? null,
			};
		},
		waitFor: (channel) => {
			spawnSync('tmux', ['-L', 'cam', 'wait-for', channel]);
		},
		capturePane: (paneId) => {
			const proc = spawnSync('tmux', ['-L', 'cam', 'capture-pane', '-p', '-t', paneId], {
				stdio: 'pipe',
			});
			return proc.stdout?.toString() ?? '';
		},
		readPrd: (): PrdSnapshot | null => {
			try {
				const text = readFileSync(prdPath, 'utf8');
				return JSON.parse(text) as PrdSnapshot;
			} catch {
				return null;
			}
		},
		writePrd: (prd) => {
			writeFileSync(prdPath, JSON.stringify(prd, null, 2), 'utf8');
		},
		workerPaneId,
	});

	const writeSessionMarker: RunSupervisorOptions['writeSessionMarker'] = (storyId, uuid) => {
		const markerPath = join(claudeDir, `.cam-worker-${storyId}.session`);
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(markerPath, uuid, 'utf8');
	};

	// 4. Dispatch to the supervisor.
	const supervisorFn = options.supervisorFn ?? runSupervisor;
	emitSectionHeading('Loop');

	let result: import('../supervisor/loop.ts').SupervisorResult;
	try {
		result = await supervisorFn({
			spawn: supervisorSpawn,
			waitFor,
			capturePane,
			readPrd,
			writePrd,
			readHandoff,
			clock,
			reviewDispatch,
			writeSessionMarker,
			workerPaneId,
			prdPath,
			handoffPath,
			permissionMode,
			taskPrompt,
			maxIterations,
		});
	} catch (err) {
		printError(
			'Supervisor loop failed',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}

	// 5. Report result.
	if (result.status === 'complete') {
		emitOk(`Complete after ${result.iterations} iteration(s)`);
	} else if (result.status === 'max-iterations') {
		emitWarn(`Stopped: max iterations (${result.iterations}) reached`);
	} else {
		// blocked
		emitWarn(`Blocked after ${result.iterations} iteration(s)`);
		if (result.lastOutcome) {
			emitMutedHint(`Last outcome: ${result.lastOutcome.kind}`);
		}
	}

	// Emit attach hint if caller is running outside the project session.
	emitAttachHint(sessionName, env);
	emitTrailingBlank();

	return result.status === 'complete' ? 0 : 1;
}
