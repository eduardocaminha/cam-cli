// src/commands/next.ts
//
// Implementation of `cam next` -- dispatches to the TS supervisor loop.
//
// ARCHITECTURE (Eduardo 2026-06-08, closes CAM-29):
//   The old stop-hook driver (a vendored Stop hook + /cam-next re-inject) is
//   RETIRED (its vendored script was deleted in CAM-3). Each worker is a real
//   separate claude session spawned via
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
//      started_at, pid, max_iterations) and an empty body -- no
//      stop-hook re-inject prompt. This file is read by `cam status` and
//      `cam dashboard` for display.
//   4. Calls `runSupervisor()` with real I/O adapters (spawn, capturePane,
//      readPrd, writePrd, readHandoff, clock, reviewDispatch, writeSessionMarker).
//      The supervisor drives the worker loop until complete, awaiting-operator,
//      blocked, or max-iterations.
//   5. Returns 0 on complete or awaiting-operator, 1 on blocked or max-iterations.
//
// Acceptance criteria (US-007):
//   1. runNext dispatches to runSupervisor(); stop-hook code path is REMOVED.
//   2. materializeStopHook, writeSettingsLocal, buildHooksBlock and /cam-next
//      re-inject are gone.
//   3. Supervisor writes .claude/cam-loop.local.md with parseStateFile-compatible
//      fields (iteration, started_at, pid) and no re-inject body.
//   4. buildClaudeArgv and buildDashboardArgv are removed (not used by run.ts).
//   5. test/next.test.ts covers supervisor dispatch, state-file shape, no stop-hook.
//   6. Commit body + .claude/commands/cam-next.md (US-010) document retirement.
//   7. Typecheck passes (bun run typecheck).
//   8. Tests pass (bun test).

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { readPermissionMode } from '../config/permission-mode.ts';
import { isPidAlive } from './resume.ts';
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
import { runSupervisor, DEFAULT_PER_WORKER_TIMEOUT_MS, type RunSupervisorOptions, type OnProgress } from '../supervisor/loop.ts';
import { makeReviewDispatch } from '../supervisor/review.ts';
import { makeFileEventLogger, readWorkerTokens } from '../supervisor/events.ts';
import { acquireSupervisorLock, SUPERVISOR_LOCK_FILE, type AcquireLockResult } from '../supervisor/lock.ts';
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

// --- Concurrency-guard shutdown handler (US-015) ---------------------------

/**
 * Single process-wide shutdown handler that releases the active supervisor lock
 * on SIGINT/SIGTERM (US-015 AC4). The handler is registered at most once per
 * process; `currentLockRelease` always points at the most recently acquired
 * lock, so a single handler serves any number of sequential runNext calls
 * without leaking listeners.
 */
let shutdownInstalled = false;
let currentLockRelease: (() => void) | null = null;

function installShutdownHandler(release: () => void): void {
	currentLockRelease = release;
	if (shutdownInstalled) return;
	shutdownInstalled = true;
	const handle = (signal: NodeJS.Signals): void => {
		if (currentLockRelease) currentLockRelease();
		// Conventional exit code 128 + signal number (SIGINT=2, SIGTERM=15).
		process.exit(signal === 'SIGINT' ? 130 : 143);
	};
	process.once('SIGINT', () => handle('SIGINT'));
	process.once('SIGTERM', () => handle('SIGTERM'));
}

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
 *
 * New optional fields (US-001 live progress tracking):
 *   active        - defaults to true (set to false on terminal rewrite)
 *   iteration     - defaults to 1 (updated on each supervisor iteration)
 *   currentStory  - advisory story id or null
 *   storiesDone   - count of non-operator stories with passes:true
 *   storiesTotal  - total count of non-operator stories
 *   lastActivity  - ISO timestamp of latest supervisor tick
 */
export function renderStateFile(input: {
	maxIterations: number;
	completionPromise: string;
	startedAt: string;
	pid: number;
	/** defaults to true */
	active?: boolean;
	/** defaults to 1 */
	iteration?: number;
	/** advisory story id or null; defaults to null */
	currentStory?: string | null;
	/** defaults to 0 */
	storiesDone?: number;
	/** defaults to 0 */
	storiesTotal?: number;
	/** ISO timestamp; defaults to startedAt */
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
	/**
	 * Path to the supervisor lockfile (override for tests).
	 * Default: `<cwd>/.claude/.cam-supervisor.lock`.
	 */
	lockPath?: string;
	/**
	 * Override the lock acquirer (US-015). Default: fs/process-backed acquire
	 * via acquireSupervisorLock. Tests inject a fake to drive the
	 * already-running / stale-takeover branches without real processes.
	 */
	acquireLock?: () => AcquireLockResult;
	/**
	 * Register a shutdown handler that releases the lock on SIGINT/SIGTERM
	 * (US-015 AC4). Default: a single process-wide handler. Tests inject a
	 * no-op (or capturing) registrar so they do not touch process signals.
	 */
	onShutdown?: (release: () => void) => void;
}

/**
 * Run the `cam next` flow: writes the state file then delegates to runSupervisor().
 *
 * Returns:
 *   0 — supervisor completed (all stories done + review passed), or finished
 *       all autonomous work and is awaiting an operator ceremony
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

	// Per-worker timeout: configurable via CAM_WORKER_TIMEOUT_MS env var or default (30 min).
	const perWorkerTimeoutMs = (() => {
		const envVal = process.env['CAM_WORKER_TIMEOUT_MS'];
		if (envVal !== undefined) {
			const parsed = parseInt(envVal, 10);
			if (!isNaN(parsed) && parsed > 0) return parsed;
		}
		return DEFAULT_PER_WORKER_TIMEOUT_MS;
	})();

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

	// US-013 structured event sink, shared by the concurrency guard (stale-lock)
	// and the supervisor (worker lifecycle events).
	const logEvent: RunSupervisorOptions['logEvent'] = makeFileEventLogger(
		join(claudeDir, 'cam-worker-events.jsonl'),
	);

	// 1.5 Concurrency guard (US-015): refuse to start if another supervisor is
	//     already driving this project. Writes .claude/.cam-supervisor.lock and
	//     releases it on every terminal return below AND on SIGINT/SIGTERM.
	const lockPath = options.lockPath ?? join(claudeDir, SUPERVISOR_LOCK_FILE);
	const acquireLock =
		options.acquireLock ??
		(() =>
			acquireSupervisorLock(process.pid, sessionName, {
				read: () => {
					try {
						return readFileSync(lockPath, 'utf8');
					} catch {
						return null;
					}
				},
				write: (content) => {
					mkdirSync(dirname(lockPath), { recursive: true });
					writeFileSync(lockPath, content, 'utf8');
				},
				remove: () => {
					try {
						unlinkSync(lockPath);
					} catch {
						/* already gone */
					}
				},
				// Reuse the canonical signal-0 liveness probe from resume.ts so the
				// concurrency guard agrees with the rest of the lifecycle commands.
				pidAlive: (probePid) => isPidAlive(probePid, (p, s) => process.kill(p, s)),
				clock: () => new Date().toISOString(),
				logEvent,
			}));

	const lock = acquireLock();
	if (!lock.acquired) {
		printError(
			'Supervisor already running',
			`supervisor already running (pid=${lock.holderPid}) — run \`cam stop\` to clear if it is not.`,
		);
		emitTrailingBlank();
		return 1;
	}
	emitOk('Lock acquired', lockPath);

	const registerShutdown = options.onShutdown ?? installShutdownHandler;
	registerShutdown(lock.release);

	// 2. Write the supervisor state file. Fields: active, iteration, started_at,
	//    pid, max_iterations. Body: empty (no stop-hook re-inject).
	const startedAt = options.startedAt ?? new Date().toISOString();
	const pid = options.pid ?? process.pid;

	const stateBody = renderStateFile({
		maxIterations,
		completionPromise,
		startedAt,
		pid,
	});

	const writer =
		options.writer ??
		((cwd2: string, body: string) => writeStateFile(cwd2, body, { force: options.force ?? false }));

	let writtenPath: string;
	try {
		writtenPath = writer(cwd, stateBody);
	} catch (err) {
		lock.release();
		printError(
			'Failed to write cam-loop state file',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}
	emitOk(`State file armed at ${writtenPath}`);

	// US-001: build the per-iteration progress writer. Called by the supervisor
	// on each iteration (live rewrite) and on terminal exit. On 'complete' the
	// state file is removed (idle); on a non-success terminal it is rewritten with
	// active:false so status/dashboard show 'paused' (CAM-2) — see below.
	const stateFileBase = { maxIterations, completionPromise, startedAt, pid };
	const progressOnProgress: OnProgress = (payload) => {
		if (payload.terminalStatus !== undefined) {
			// Terminal exit. 'complete' = the run finished cleanly: remove the state
			// file so `cam status` / dashboard show idle. Any other terminal
			// (blocked / awaiting-operator / max-iterations) STOPPED but needs the
			// operator: rewrite with active:false so status/dashboard show 'paused'
			// (the actionable state) instead of idle (CAM-2). Never leave active:true
			// behind (that would read as a still-running loop).
			if (payload.terminalStatus === 'complete') {
				try { unlinkSync(writtenPath); } catch { /* already gone */ }
				return;
			}
			const pausedBody = renderStateFile({
				...stateFileBase,
				active: false,
				iteration: payload.iteration,
				currentStory: payload.currentStoryId ?? null,
				storiesDone: payload.storiesDone,
				storiesTotal: payload.storiesTotal,
				lastActivity: payload.lastActivity,
			});
			try {
				writeFileSync(writtenPath, pausedBody, 'utf8');
			} catch {
				// Non-fatal: a stale active:true would be worse, but best-effort here.
			}
			return;
		}
		// Live iteration: rewrite with current progress fields.
		const body = renderStateFile({
			...stateFileBase,
			active: true,
			iteration: payload.iteration,
			currentStory: payload.currentStoryId ?? null,
			storiesDone: payload.storiesDone,
			storiesTotal: payload.storiesTotal,
			lastActivity: payload.lastActivity,
		});
		try {
			writeFileSync(writtenPath, body, 'utf8');
		} catch {
			// Non-fatal: live-update failed; loop continues.
		}
	};

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

	const isPaneAlive: RunSupervisorOptions['isPaneAlive'] = (paneId) => {
		const result = spawnSync('tmux', ['-L', 'cam', 'list-panes', '-t', paneId], {
			stdio: 'ignore',
		});
		return result.status === 0;
	};

	const capturePane: RunSupervisorOptions['capturePane'] = (paneId) => {
		// -S - captures the full scrollback, not just the visible region: a TUI
		// worker's sentinel line can scroll off-screen between polls (CAM-42).
		const result = spawnSync('tmux', ['-L', 'cam', 'capture-pane', '-p', '-S', '-', '-t', paneId], {
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

	// Review dispatch: wired via makeReviewDispatch (US-008). Interactive TUI
	// reviewer with <review>-tag polling since CAM-42 (claude -p is forbidden
	// for subscription accounts).
	const reviewDispatch: RunSupervisorOptions['reviewDispatch'] = makeReviewDispatch({
		spawn: (cmd, args) => {
			const proc = spawnSync(cmd, args, { stdio: 'pipe' });
			return {
				stdout: proc.stdout?.toString() ?? '',
				exitCode: proc.status ?? null,
			};
		},
		capturePane: (paneId) => {
			// -S - captures the full scrollback (TUI sentinel can scroll away, CAM-42).
			const proc = spawnSync('tmux', ['-L', 'cam', 'capture-pane', '-p', '-S', '-', '-t', paneId], {
				stdio: 'pipe',
			});
			return proc.stdout?.toString() ?? '';
		},
		isPaneAlive,
		sleepFn: (ms) => {
			Bun.sleepSync(ms);
		},
		permissionMode,
		timeoutMs: perWorkerTimeoutMs,
		readPrd: (): PrdSnapshot | null => {
			try {
				const text = readFileSync(prdPath, 'utf8');
				return JSON.parse(text) as PrdSnapshot;
			} catch {
				return null;
			}
		},
		writePrd: (prd) => {
			writeFileSync(prdPath, JSON.stringify(prd, null, 2) + '\n', 'utf8');
		},
		workerPaneId,
	});

	const writeSessionMarker: RunSupervisorOptions['writeSessionMarker'] = (storyId, uuid) => {
		const markerPath = join(claudeDir, `.cam-worker-${storyId}.session`);
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(markerPath, uuid, 'utf8');
	};

	// --- CAM-32 wiring: supervisor-finalize tail ---

	// runGates: deterministic re-check before the supervisor finalizes a worker
	// that implemented a story but did not flip prd.json (BUG 2).
	const runGates: RunSupervisorOptions['runGates'] = () => {
		const tc = spawnSync('bun', ['run', 'typecheck'], { stdio: 'ignore' });
		if (tc.status !== 0) return { ok: false, detail: 'typecheck failed' };
		const tt = spawnSync('bun', ['test'], { stdio: 'ignore' });
		if (tt.status !== 0) return { ok: false, detail: 'tests failed' };
		return { ok: true, detail: 'typecheck + tests passed' };
	};

	// finalizeStory: flip prd.json passes:true, commit, and push the tail the
	// worker truncated (BUG 2). Only invoked after runGates is green.
	const finalizeStory: RunSupervisorOptions['finalizeStory'] = (storyId) => {
		try {
			const prd = readPrd();
			if (!prd || !Array.isArray(prd.userStories)) {
				return { ok: false, detail: 'prd.json unreadable for finalize' };
			}
			const story = prd.userStories.find((s) => s.id === storyId);
			if (!story) return { ok: false, detail: `story ${storyId} not found in prd.json` };
			story.passes = true;
			writePrd(prd);
			const add = spawnSync('git', ['add', '-A'], { stdio: 'ignore' });
			if (add.status !== 0) return { ok: false, detail: 'git add failed' };
			const commit = spawnSync(
				'git',
				['commit', '-m', `chore(cam): finalize ${storyId} (supervisor)`],
				{ stdio: 'ignore' },
			);
			if (commit.status !== 0) return { ok: false, detail: 'git commit failed' };
			const branchProc = spawnSync('git', ['branch', '--show-current'], {
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			const branchName = (typeof branchProc.stdout === 'string' ? branchProc.stdout : '').trim();
			const push = spawnSync('git', ['push', 'origin', branchName], { stdio: 'ignore' });
			if (push.status !== 0) return { ok: false, detail: `git push to ${branchName} failed` };
			return { ok: true, detail: `finalized ${storyId} on ${branchName}` };
		} catch (e) {
			return { ok: false, detail: e instanceof Error ? e.message : String(e) };
		}
	};

	// --- US-001 wiring: verify worker pass landed on origin before loop continues ---
	// Idempotent push + HEAD vs origin/<branch> equality check. Uses spawnSync
	// (encoding utf8) consistent with finalizeStory's git invocations above.
	const ensurePushed: RunSupervisorOptions['ensurePushed'] = () => {
		try {
			const branchProc = spawnSync('git', ['branch', '--show-current'], {
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			const branchName = (typeof branchProc.stdout === 'string' ? branchProc.stdout : '').trim();
			if (!branchName) {
				return { ok: false, pushed: false, sha: '', detail: 'could not determine current branch' };
			}
			// Idempotent push: "Everything up-to-date" -> ok:true pushed:false.
			const pushProc = spawnSync('git', ['push', 'origin', branchName], {
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			const pushStdout = typeof pushProc.stdout === 'string' ? pushProc.stdout : '';
			const pushStderr = typeof pushProc.stderr === 'string' ? pushProc.stderr : '';
			const combined = pushStdout + pushStderr;
			const noop = combined.includes('Everything up-to-date');
			if (pushProc.status !== 0 && !noop) {
				return { ok: false, pushed: false, sha: '', detail: `git push failed: ${combined.trim()}` };
			}
			const pushed = !noop;
			// Verify HEAD == origin/<branch>.
			const headProc = spawnSync('git', ['rev-parse', 'HEAD'], {
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			const localSha = (typeof headProc.stdout === 'string' ? headProc.stdout : '').trim();
			const originProc = spawnSync('git', ['rev-parse', `origin/${branchName}`], {
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			const originSha = (typeof originProc.stdout === 'string' ? originProc.stdout : '').trim();
			if (!localSha || !originSha || localSha !== originSha) {
				return {
					ok: false,
					pushed,
					sha: localSha,
					detail: `HEAD (${localSha || 'unknown'}) != origin/${branchName} (${originSha || 'unknown'}) after push`,
				};
			}
			return { ok: true, pushed, sha: localSha, detail: `HEAD == origin/${branchName} (${localSha})` };
		} catch (e) {
			return { ok: false, pushed: false, sha: '', detail: e instanceof Error ? e.message : String(e) };
		}
	};

	// --- US-013 wiring: structured per-story observability events ---
	// logEvent is defined above (shared with the US-015 concurrency guard).
	// readWorkerTokens: resolve a worker's transcript by uuid and sum its usage.
	// Transcripts live under the Claude CONFIG dir (~/.claude or CLAUDE_CONFIG_DIR),
	// not the project's .claude — match the convention in status.ts/dashboard.ts.
	const transcriptClaudeDir = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
	const readWorkerTokensAdapter: RunSupervisorOptions['readWorkerTokens'] = (uuid) =>
		readWorkerTokens(uuid, cwd, transcriptClaudeDir);

	// 4. Dispatch to the supervisor.
	const supervisorFn = options.supervisorFn ?? runSupervisor;
	emitSectionHeading('Loop');

	let result: import('../supervisor/loop.ts').SupervisorResult;
	try {
		result = await supervisorFn({
			spawn: supervisorSpawn,
			capturePane,
			readPrd,
			writePrd,
			readHandoff,
			clock,
			reviewDispatch,
			writeSessionMarker,
			runGates,
			finalizeStory,
			isPaneAlive,
			workerPaneId,
			prdPath,
			handoffPath,
			permissionMode,
			taskPrompt,
			maxIterations,
			perWorkerTimeoutMs,
			logEvent,
			readWorkerTokens: readWorkerTokensAdapter,
			ensurePushed,
			onProgress: progressOnProgress,
			// Bun.sleepSync blocks the thread: drives both the no-progress backoff
			// (CAM-38) and the sentinel-poll interval between capture-pane reads.
			sleepFn: (ms) => {
				Bun.sleepSync(ms);
			},
		});
	} catch (err) {
		lock.release();
		printError(
			'Supervisor loop failed',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}

	// Loop reached a terminal state: release the concurrency lock (US-015 AC4).
	lock.release();

	// 5. Report result.
	if (result.status === 'complete') {
		emitOk(`Complete after ${result.iterations} iteration(s)`);
	} else if (result.status === 'awaiting-operator') {
		// Implement + review done (review clean); only operator ceremonies remain.
		// This is a successful terminal state, not a block.
		const pending = result.pendingStoryIds?.join(', ') || 'operator story';
		emitOk(`Reviewed clean after ${result.iterations} iteration(s) — autonomous work done`);
		emitMutedHint(
			`Awaiting operator ceremony: ${pending}. Run it, flip the story to passes:true, then re-run \`cam next\`.`,
		);
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

	// 'awaiting-operator' is a successful terminal state (autonomous work done,
	// reviewed clean, operator ceremony pending) — exit 0 like 'complete'.
	return result.status === 'complete' || result.status === 'awaiting-operator' ? 0 : 1;
}
