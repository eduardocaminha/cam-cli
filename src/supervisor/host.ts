// src/supervisor/host.ts
//
// Shared wiring that builds a RunSupervisorOptions for a given cwd.
// Extracted from the old src/commands/next.ts (pre-thin-proxy) so that the
// production sidecar caller (src/commands/sidecar.ts) can reuse exactly the
// same dep-wiring that the old in-process supervisor used.
//
// Every I/O adapter here uses real filesystem / real process primitives.
// Tests that need a fake supervisor do NOT use this module; they build their
// own minimal options bags (see test/supervisor/loop.test.ts).
//
// Exports:
//   buildSupervisorOptions(cwd, options?) -> RunSupervisorOptions + ancillaries
//   makeReadWorkerReport(cwd)             -> ReadWorkerReport
//   makeClearWorkerReport(cwd)            -> ClearWorkerReport
//   makeNotifyOrchestrator(sessionName, spawnFn) -> (line) => void

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
	DEFAULT_PER_WORKER_TIMEOUT_MS,
	type RunSupervisorOptions,
	type OnProgress,
} from './loop.ts';
import { makeReviewDispatch } from './review.ts';
import { makeFileEventLogger, readWorkerTokens } from './events.ts';
import { acquireSupervisorLock, SUPERVISOR_LOCK_FILE, type AcquireLockResult } from './lock.ts';
import type { PrdSnapshot } from './decide.ts';
import {
	readWorkerPaneMarker,
	openPaneInSession,
	writeWorkerPaneMarker,
	projectSessionName,
	getOrchPaneId,
	type SpawnFn as TmuxSpawnFn,
} from '../tmux/session.ts';
import { isPidAlive } from '../commands/resume.ts';
import { renderStateFile, writeStateFile } from '../commands/next.ts';
import { WORKER_REPORT_FILENAME, buildWorkerReportSendKeysArgv } from './worker-report.ts';
import type { ReviewReport } from './review-report.ts';
import { REVIEW_REPORT_FILENAME } from './review-report.ts';
import { preflightWorkerContainer } from './preflight-container.ts';
import { readWorkerIsolation } from '../config/models.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal ancillary info returned alongside RunSupervisorOptions. */
export interface BuiltSupervisorOptions {
	/** The fully wired options bag ready to pass to runSupervisor. */
	opts: RunSupervisorOptions;
	/** The tmux session name for this project (used by lock and state file). */
	sessionName: string;
	/** Absolute path to .claude/cam-loop.local.md (state file). */
	stateFilePath: string;
	/** Acquire the single-supervisor lock for this cwd/session. */
	acquireLock: () => AcquireLockResult;
	/** Absolute path to the PRD file. */
	prdPath: string;
	/** Absolute path to the handoff file. */
	handoffPath: string;
}

// ---------------------------------------------------------------------------
// report-file readers (US-004 injected deps for runSupervisor)
// ---------------------------------------------------------------------------

/**
 * Build a ReadWorkerReport function for the given cwd.
 * Reads `<cwd>/scripts/cam/worker-report.json`.
 * Returns the parsed WorkerReport or null when absent / unparseable.
 */
export function makeReadWorkerReport(cwd: string): RunSupervisorOptions['readWorkerReport'] {
	const reportPath = join(cwd, WORKER_REPORT_FILENAME);
	return () => {
		try {
			const raw = readFileSync(reportPath, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			// Shape guard (US-006 / US-R2-001): validate discriminator fields before
			// casting. A wrong-shape file (missing string outcome or story fields)
			// returns null so the poll loop continues to the pane-died / timeout nets
			// instead of treating absent fields as valid completion signals.
			if (
				parsed !== null &&
				typeof parsed === 'object' &&
				!Array.isArray(parsed) &&
				typeof (parsed as Record<string, unknown>)['outcome'] === 'string' &&
				typeof (parsed as Record<string, unknown>)['story'] === 'string'
			) {
				return parsed as import('./worker-report.ts').WorkerReport;
			}
			return null;
		} catch {
			return null;
		}
	};
}

/**
 * Build a ClearWorkerReport function for the given cwd.
 * Removes `<cwd>/scripts/cam/worker-report.json`. Best-effort: no-op on
 * missing file. Prevents false-positive on the first poll tick of a new run.
 */
export function makeClearWorkerReport(cwd: string): RunSupervisorOptions['clearWorkerReport'] {
	const reportPath = join(cwd, WORKER_REPORT_FILENAME);
	return () => {
		try {
			if (existsSync(reportPath)) {
				unlinkSync(reportPath);
			}
		} catch {
			// best-effort: ignore failures
		}
	};
}

// ---------------------------------------------------------------------------
// review-report reader (US-002 / CAM-75)
// ---------------------------------------------------------------------------

/**
 * Build a readReviewReport function for the given cwd.
 * Reads `<cwd>/scripts/cam/review-report.json`.
 * Returns the parsed ReviewReport or null when absent / unparseable.
 * Never throws (graceful degradation, like makeReadWorkerReport).
 */
export function makeReadReviewReport(cwd: string): () => ReviewReport | null {
	const reportPath = join(cwd, REVIEW_REPORT_FILENAME);
	return () => {
		try {
			const raw = readFileSync(reportPath, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			// Shape guard: must be a non-null, non-array object with a string `verdict`.
			// A valid-JSON-but-wrong-shape file (missing `verdict`, top-level array,
			// etc.) returns null so the dispatch falls back to the <review>-tag verdict
			// instead of treating `undefined` as a verdict string (US-R2-001).
			if (
				parsed !== null &&
				typeof parsed === 'object' &&
				!Array.isArray(parsed) &&
				typeof (parsed as Record<string, unknown>)['verdict'] === 'string'
			) {
				return parsed as ReviewReport;
			}
			return null;
		} catch {
			return null;
		}
	};
}

/**
 * Build a clearReviewReport function for the given cwd.
 * Removes `<cwd>/scripts/cam/review-report.json`. Best-effort: no-op on
 * missing file, never throws. Prevents a stale round-N report from being
 * read on the first poll tick of round N+1 (mirrors makeClearWorkerReport).
 */
export function makeClearReviewReport(cwd: string): () => void {
	const reportPath = join(cwd, REVIEW_REPORT_FILENAME);
	return () => {
		try {
			if (existsSync(reportPath)) {
				unlinkSync(reportPath);
			}
		} catch {
			// best-effort: ignore failures
		}
	};
}

// ---------------------------------------------------------------------------
// notifyOrchestrator factory (US-002)
// ---------------------------------------------------------------------------

/**
 * Build a notifyOrchestrator closure that resolves the orchestrator pane via
 * getOrchPaneId and, if found, sends the verdict line via send-keys using
 * buildWorkerReportSendKeysArgv.
 *
 * Best-effort: when getOrchPaneId returns null (orch pane closed or session
 * gone), the closure is a silent no-op. No throw, no error log.
 *
 * Invariants (sendkeys-literal-enter-gotcha, CAM-55):
 *   - send-keys text + Enter go in ONE tmux call (atomic).
 *   - NO -l flag (would make "Enter" literal text, not a key).
 *   buildWorkerReportSendKeysArgv enforces both.
 *
 * @param sessionName  The project's tmux session name.
 * @param spawnFn      Injectable SpawnFn (tmux-flavoured: returns SpawnSyncReturns).
 */
export function makeNotifyOrchestrator(
	sessionName: string,
	spawnFn: TmuxSpawnFn,
): (line: string) => void {
	return (line: string): void => {
		const orchPane = getOrchPaneId(sessionName, spawnFn);
		if (orchPane === null) return; // best-effort: silent no-op
		const argv = buildWorkerReportSendKeysArgv(orchPane, line);
		// argv is the full tmux argv after "tmux"; pass as args to 'tmux'.
		spawnFn('tmux', argv, { stdio: 'ignore' });
	};
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

/**
 * Build a fully wired RunSupervisorOptions for the given cwd.
 * All I/O is real: filesystem, spawnSync, process signals.
 *
 * Options:
 *   permissionMode - claude permission mode (default: bypassPermissions).
 *   taskPrompt     - task prompt sent to the implementer (default: DEFAULT_TASK_PROMPT).
 *   maxIterations  - hard cap (default: MAX_ITERATIONS = 50).
 */
export function buildSupervisorOptions(
	cwd: string,
	options: {
		permissionMode?: string;
		taskPrompt?: string;
		maxIterations?: number;
	} = {},
): BuiltSupervisorOptions {
	const permissionMode = options.permissionMode ?? 'bypassPermissions';
	const taskPrompt =
		options.taskPrompt ?? 'Implement the next user story from scripts/cam/prd.json per your AGENT.md.';

	const PRD_PATH_CANONICAL = 'scripts/cam/prd.json';
	const HANDOFF_PATH_CANONICAL = 'scripts/cam/handoff.json';

	const prdPath = join(cwd, PRD_PATH_CANONICAL);
	const handoffPath = join(cwd, HANDOFF_PATH_CANONICAL);
	const claudeDir = join(cwd, '.claude');
	const sessionName = projectSessionName(cwd);
	const stateFilePath = join(claudeDir, 'cam-loop.local.md');

	// Per-worker timeout: configurable via CAM_WORKER_TIMEOUT_MS env var.
	const perWorkerTimeoutMs = (() => {
		const envVal = process.env['CAM_WORKER_TIMEOUT_MS'];
		if (envVal !== undefined) {
			const parsed = parseInt(envVal, 10);
			if (!isNaN(parsed) && parsed > 0) return parsed;
		}
		return DEFAULT_PER_WORKER_TIMEOUT_MS;
	})();

	// Per-worker token ceiling (CAM-5).
	const maxWorkerTokens = (() => {
		const envVal = process.env['CAM_WORKER_MAX_TOKENS'];
		if (envVal !== undefined) {
			const parsed = parseInt(envVal, 10);
			if (!isNaN(parsed) && parsed > 0) return parsed;
		}
		return 0;
	})();

	// Read worker pane id (must be allocated by `cam plan` first).
	// The boot-time value is the fallback; ensureWorkerPane re-reads the marker
	// fresh on each call so it is never stale across loop boundaries.
	const workerPaneId = readWorkerPaneMarker(claudeDir) ?? '%2';

	// --- I/O adapters ---

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
		const result = spawnSync(
			'tmux',
			['-L', 'cam', 'display-message', '-p', '-t', paneId, '#{pane_dead}'],
			{ stdio: 'pipe', encoding: 'utf8' } as Parameters<typeof spawnSync>[2],
		);
		if (result.status !== 0) return false;
		const out = typeof result.stdout === 'string' ? result.stdout.trim() : '';
		return out === '0';
	};

	const capturePane: RunSupervisorOptions['capturePane'] = (paneId) => {
		const result = spawnSync(
			'tmux',
			['-L', 'cam', 'capture-pane', '-p', '-S', '-', '-t', paneId],
			{ stdio: 'pipe', encoding: 'utf8' } as Parameters<typeof spawnSync>[2],
		);
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

	// US-013 structured event sink.
	const logEvent = makeFileEventLogger(join(claudeDir, 'cam-worker-events.jsonl'));

	// Concurrency lock factory.
	const lockPath = join(claudeDir, SUPERVISOR_LOCK_FILE);
	const acquireLock = (): AcquireLockResult =>
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
			pidAlive: (probePid) => isPidAlive(probePid, (p, s) => process.kill(p, s)),
			clock: () => new Date().toISOString(),
			logEvent,
		});

	// CAM-57: ensure a live worker pane exists before each respawn-pane dispatch.
	// Re-reads the marker fresh (do NOT rely on the boot-time cached const) so a
	// pane allocated mid-session by a previous dispatch is picked up correctly.
	// If the current pane is dead or missing, opens a new one via openPaneInSession
	// (a vertical split inside the project session), writes the new marker, and
	// returns the new id. Always use this returned id for set-option + respawn-pane.
	const ensureWorkerPaneFn: RunSupervisorOptions['ensureWorkerPane'] = () => {
		const currentId = readWorkerPaneMarker(claudeDir) ?? workerPaneId;
		if (isPaneAlive(currentId)) {
			return currentId;
		}
		// Pane is dead or missing: open a fresh one with a placeholder command.
		// openPaneInSession does a split-window -v inside the project session and
		// returns the stable %<n> pane id. We start with 'cat' (silent placeholder)
		// because the respawn-pane -k call immediately after will replace it.
		//
		// Resolve the orchestrator pane id so the split targets the orch pane
		// explicitly (giving the worker a stable, readable geometry). Fallback to
		// the session window target when getOrchPaneId returns null (e.g. orch pane
		// is also gone).
		const orchPaneId = getOrchPaneId(sessionName, (cmd, args, opts) =>
			spawnSync(cmd, args, {
				stdio: opts?.stdio ?? 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]),
		);
		const targetPaneId: string = orchPaneId ?? `${sessionName}:0`;
		const newId = openPaneInSession(sessionName, ['cat'], (cmd, args, opts) =>
			spawnSync(cmd, args, {
				stdio: opts?.stdio ?? 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]),
		targetPaneId);
		writeWorkerPaneMarker(claudeDir, newId);
		return newId;
	};

	// US-002 / CAM-75: reviewer structured exit report reader.
	const readReviewReport = makeReadReviewReport(cwd);

	// US-R1-001: clear stale review-report.json before each reviewer respawn.
	const clearReviewReport = makeClearReviewReport(cwd);

	// US-005 / B-1 + B-2: production container preflight seam.
	// Declared here (before makeReviewDispatch) so it can be threaded into both
	// the review dispatch and the RunSupervisorOptions opts bag below.
	// Uses real Docker probe (spawnSync) and real filesystem stat. CI has no Docker
	// installed, so the probe will return daemon-unreachable -- in host mode that is
	// fine (observe-only). In container mode (B-2 / CAM-152) a not-ready result is
	// fail-closed: the loop blocks and never dispatches a host worker.
	const preflightContainerFn: RunSupervisorOptions['preflightContainerFn'] = () =>
		preflightWorkerContainer({
			probe: (args) => {
				const result = spawnSync('docker', args, {
					stdio: 'pipe',
					encoding: 'utf8',
				} as Parameters<typeof spawnSync>[2]);
				return {
					stdout: typeof result.stdout === 'string' ? result.stdout : '',
					exitCode: result.status ?? 1,
				};
			},
			statFn: (path) => {
				try {
					const s = statSync(path);
					return { mtimeMs: s.mtimeMs };
				} catch {
					return null;
				}
			},
		});

	// US-004 / B-2 (CAM-152): read worker isolation mode from project.toml.
	// Declared here (before makeReviewDispatch) so it can be threaded into both
	// the review dispatch and the RunSupervisorOptions opts bag below.
	// 'container' enables dockerExecWrap + fail-closed preflight in the loop.
	// 'host' (default) leaves every existing loop behavior unchanged.
	const workerIsolation = readWorkerIsolation(join(cwd, 'scripts/cam/project.toml'));

	// Review dispatch.
	const reviewDispatch: RunSupervisorOptions['reviewDispatch'] = makeReviewDispatch({
		spawn: (cmd, args) => {
			const proc = spawnSync(cmd, args, { stdio: 'pipe' });
			return {
				stdout: proc.stdout?.toString() ?? '',
				exitCode: proc.status ?? null,
			};
		},
		capturePane: (paneId) => {
			const proc = spawnSync(
				'tmux',
				['-L', 'cam', 'capture-pane', '-p', '-S', '-', '-t', paneId],
				{ stdio: 'pipe' },
			);
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
		// CAM-57: thread ensureWorkerPane into the review dispatch so the review
		// closure also self-heals a dead pane before each respawn.
		ensureWorkerPane: ensureWorkerPaneFn,
		// US-007: persist spawn-resolution events for the reviewer phase.
		logEvent,
		// US-002 / CAM-75: structured reviewer exit report (primary completion signal).
		readReviewReport,
		// US-R1-001: clear stale report before each reviewer respawn.
		clearReviewReport,
		// US-005 / CAM-152: reviewer container isolation (mirrors implementer wiring).
		workerIsolation,
		preflightContainerFn,
	});

	const writeSessionMarker: RunSupervisorOptions['writeSessionMarker'] = (storyId, uuid) => {
		const markerPath = join(claudeDir, `.cam-worker-${storyId}.session`);
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(markerPath, uuid, 'utf8');
	};

	// runGates + finalizeStory for CAM-32 supervisor-finalize.
	const runGates: RunSupervisorOptions['runGates'] = () => {
		const tc = spawnSync('bun', ['run', 'typecheck'], { cwd, stdio: 'ignore' });
		if (tc.status !== 0) return { ok: false, detail: 'typecheck failed' };
		const tt = spawnSync('bun', ['test'], { cwd, stdio: 'ignore' });
		if (tt.status !== 0) return { ok: false, detail: 'tests failed' };
		return { ok: true, detail: 'typecheck + tests passed' };
	};

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
			const add = spawnSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
			if (add.status !== 0) return { ok: false, detail: 'git add failed' };
			const commit = spawnSync(
				'git',
				['commit', '-m', `chore(cam): finalize ${storyId} (supervisor)`],
				{ cwd, stdio: 'ignore' },
			);
			if (commit.status !== 0) return { ok: false, detail: 'git commit failed' };
			const branchProc = spawnSync('git', ['branch', '--show-current'], {
				cwd,
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			const branchName = (typeof branchProc.stdout === 'string' ? branchProc.stdout : '').trim();
			const push = spawnSync('git', ['push', 'origin', branchName], { cwd, stdio: 'ignore' });
			if (push.status !== 0) return { ok: false, detail: `git push to ${branchName} failed` };
			return { ok: true, detail: `finalized ${storyId} on ${branchName}` };
		} catch (e) {
			return { ok: false, detail: e instanceof Error ? e.message : String(e) };
		}
	};

	// ensurePushed for US-001.
	const ensurePushed: RunSupervisorOptions['ensurePushed'] = () => {
		try {
			const branchProc = spawnSync('git', ['branch', '--show-current'], {
				cwd,
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			const branchName = (typeof branchProc.stdout === 'string' ? branchProc.stdout : '').trim();
			if (!branchName) {
				return { ok: false, pushed: false, sha: '', detail: 'could not determine current branch' };
			}
			const pushProc = spawnSync('git', ['push', 'origin', branchName], {
				cwd,
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
			const headProc = spawnSync('git', ['rev-parse', 'HEAD'], {
				cwd,
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			const localSha = (typeof headProc.stdout === 'string' ? headProc.stdout : '').trim();
			const originProc = spawnSync('git', ['rev-parse', `origin/${branchName}`], {
				cwd,
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

	// US-013 token reader.
	const transcriptClaudeDir = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
	const readWorkerTokensAdapter: RunSupervisorOptions['readWorkerTokens'] = (uuid) =>
		readWorkerTokens(uuid, cwd, transcriptClaudeDir);

	// US-004 worker-report readers.
	const readWorkerReport = makeReadWorkerReport(cwd);
	const clearWorkerReport = makeClearWorkerReport(cwd);

	// US-002: build the notifyOrchestrator closure that resolves the orch pane
	// and sends the verdict line via send-keys. Uses a spawnSync adapter that
	// matches the TmuxSpawnFn signature (returns SpawnSyncReturns, not the
	// loop.ts SpawnFn shape). Best-effort: silent no-op when orch pane is gone.
	const tmuxSpawnFn: TmuxSpawnFn = (cmd, args, spawnOpts) =>
		spawnSync(cmd, args, {
			stdio: spawnOpts?.stdio ?? 'pipe',
			encoding: 'utf8',
		} as Parameters<typeof spawnSync>[2]);

	const notifyOrchestrator = makeNotifyOrchestrator(sessionName, tmuxSpawnFn);

	// onProgress: rewrite state file on each iteration and terminal exit.
	// Built here so the sidecar can inject it when calling runSupervisor.
	const startedAt = new Date().toISOString();
	const pid = process.pid;
	const maxIterations = options.maxIterations;
	const stateFileBase = {
		maxIterations: maxIterations ?? 50,
		completionPromise: 'COMPLETE',
		startedAt,
		pid,
	};

	const onProgress: OnProgress = (payload) => {
		if (payload.terminalStatus !== undefined) {
			if (payload.terminalStatus === 'complete') {
				try {
					unlinkSync(stateFilePath);
				} catch {
					/* already gone */
				}
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
				writeFileSync(stateFilePath, pausedBody, 'utf8');
			} catch {
				// non-fatal
			}
			return;
		}
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
			writeFileSync(stateFilePath, body, 'utf8');
		} catch {
			// non-fatal
		}
	};

	const opts: RunSupervisorOptions = {
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
		workerReportPath: join(cwd, WORKER_REPORT_FILENAME),
		permissionMode,
		taskPrompt,
		maxIterations,
		perWorkerTimeoutMs,
		maxWorkerTokens,
		logEvent,
		readWorkerTokens: readWorkerTokensAdapter,
		ensurePushed,
		onProgress,
		readWorkerReport,
		clearWorkerReport,
		// US-002: push review verdict line to the orchestrator pane. Best-effort.
		notifyOrchestrator,
		// CAM-57: self-heal dead worker pane before each dispatch.
		ensureWorkerPane: ensureWorkerPaneFn,
		sleepFn: (ms) => {
			Bun.sleepSync(ms);
		},
		// US-005 / B-1 + B-2: container preflight seam.
		// Fail-closed in container mode (workerIsolation === 'container').
		preflightContainerFn,
		// US-004 / B-2 (CAM-152): isolation mode drives dockerExecWrap + fail-closed.
		workerIsolation,
	};

	return {
		opts,
		sessionName,
		stateFilePath,
		acquireLock,
		prdPath,
		handoffPath,
	};
}
