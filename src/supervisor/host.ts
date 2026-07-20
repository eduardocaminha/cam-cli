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
//   makeNotifyOrchestrator(sessionName, spawnFn, capturePaneFn?, logEvent?) -> (line) => void
//   makeCapturePaneFn(spawnFn) -> CapturePaneFn
//   adaptLogEventForPush(logEvent) -> (kind, detail) => void

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
	DEFAULT_PER_WORKER_TIMEOUT_MS,
	DEFAULT_CONTAINER_WORKER_TIMEOUT_MS,
	type RunSupervisorOptions,
	type OnProgress,
	type ImplementBlockedWriterParams,
} from './loop.ts';
import { makeReviewDispatch } from './review.ts';
import { commitSubjectMatchesStory } from './result.ts';
import {
	makeFileEventLogger,
	readWorkerTokens,
	type WorkerEventKind,
	type WorkerEventDetail,
	type WorkerEventLogger,
} from './events.ts';
import { acquireSupervisorLock, SUPERVISOR_LOCK_FILE, type AcquireLockResult } from './lock.ts';
import type { PrdSnapshot } from './decide.ts';
import {
	readWorkerPaneMarker,
	openPaneInSession,
	writeWorkerPaneMarker,
	projectSessionName,
	getOrchPaneId,
	tmuxArgs,
	type SpawnFn as TmuxSpawnFn,
} from '../tmux/session.ts';
import { sendKeysVerified, type CapturePaneFn } from '../tmux/dispatch.ts';
import { isPidAlive } from '../commands/resume.ts';
import { renderStateFile } from '../commands/next.ts';
import { WORKER_REPORT_FILENAME } from './worker-report.ts';
import { parseReviewReport, parseWorkerReport } from './report-parse.ts';
import type { ReviewReport } from './review-report.ts';
import { REVIEW_REPORT_FILENAME } from './review-report.ts';
import { preflightWorkerContainer } from './preflight-container.ts';
import { makeProductionEnsureContainerFn } from './ensure-container.ts';
import { appendOutcomeOnMain } from '../commands/pattern-records.ts';
import type { PatternOutcomeStatus } from '../patterns/record.ts';
import { realOnMainSpawnFn } from '../git/on-main.ts';
import { readWorkerIsolation } from '../config/models.ts';
import {
	writeImplementBlockedMarker,
	readImplementBlockedMarker,
	removeImplementBlockedMarker,
	advanceBlockedMarker,
	IMPLEMENT_BLOCKED_FILENAME,
} from './implement-blocked-marker.ts';

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
// implement-blocked marker: prd.json content-hash (US-002, CAM-214)
// ---------------------------------------------------------------------------

/** Stable reset-key value used when prd.json is unreadable/absent at write time (US-002, CAM-214). */
const PRD_HASH_UNREADABLE = 'prd-unreadable';

/**
 * Compute the sha256 hex digest over prd.json's raw file bytes at write time
 * (US-002, CAM-214). Degrades gracefully to a stable reset-key value
 * (`PRD_HASH_UNREADABLE`) on any read error (absent file, permission error,
 * etc.) -- never throws, so the marker writer always persists a marker.
 */
function computePrdHashForBlockedMarker(prdPath: string): string {
	try {
		const bytes = readFileSync(prdPath);
		const hasher = new Bun.CryptoHasher('sha256');
		hasher.update(bytes);
		return hasher.digest('hex');
	} catch {
		return PRD_HASH_UNREADABLE;
	}
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
			// Shape guard (US-002, CAM-301): delegate discriminator/shape validation
			// to the shared parser instead of re-declaring an inline typeof check.
			// A wrong-shape file (missing string outcome or story fields) yields
			// null so the poll loop continues to the pane-died / timeout nets
			// instead of treating absent fields as valid completion signals.
			return parseWorkerReport(raw);
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
			// Shape guard (US-004, CAM-301): delegate discriminator/findings shape
			// validation to the shared parser instead of re-declaring an inline
			// typeof verdict check. A wrong-shape file (missing string verdict, or a
			// malformed findings[] entry) yields null so the dispatch falls back to
			// the <review>-tag verdict instead of treating undefined/unchecked
			// fields as valid completion signals.
			return parseReviewReport(raw);
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
// pattern-outcome recorder (US-006, CAM-64)
// ---------------------------------------------------------------------------

/**
 * Build a recordPatternOutcomeFn for the given cwd (US-006, CAM-64).
 *
 * Loops `recordIds` and calls appendOutcomeOnMain (src/commands/pattern-
 * records.ts) once per id with the same `status`, via realOnMainSpawnFn
 * (src/git/on-main.ts) -- the same real spawnSync wrapper
 * appendSuggestionOnMain's production wiring uses (sidecar.ts). A failed
 * append for one id (diverged main, detached head, missing main, not-found)
 * is skip-and-ignored: appendOutcomeOnMain never throws for those cases, and
 * this factory does not re-throw, so the remaining ids in the batch still get
 * attempted.
 *
 * This is the supervisor's ONLY call site for appendOutcomeOnMain: no
 * worker/branch-side code path ever calls it (mirrors ADR-0035's "supervisor
 * is the sole writer" posture, there for passes:true, here for pattern
 * outcomes).
 *
 * US-001 (CAM-336): `logEvent` is threaded in additively (optional, backward
 * compatible with the pre-existing `makeRecordPatternOutcomeFn(cwd)` call
 * shape). When appendOutcomeOnMain returns a non-ok result for a recordId,
 * exactly one 'pattern-outcome-append-failed' WorkerEvent is appended
 * carrying that recordId and the failure reason, so a persistently
 * diverged/detached/missing main is diagnosable from
 * .claude/cam-worker-events.jsonl instead of only transient stderr.
 */
export function makeRecordPatternOutcomeFn(
	cwd: string,
	logEvent?: WorkerEventLogger,
): (recordIds: string[], status: PatternOutcomeStatus) => void {
	return (recordIds, status) => {
		for (const recordId of recordIds) {
			const result = appendOutcomeOnMain({ cwd, recordId, status, spawnFn: realOnMainSpawnFn });
			if (!result.ok) {
				logEvent?.({
					ts: new Date().toISOString(),
					storyId: undefined,
					uuid: 'sidecar',
					kind: 'pattern-outcome-append-failed',
					detail: { recordId, reason: result.reason },
				});
			}
		}
	};
}

// ---------------------------------------------------------------------------
// notifyOrchestrator factory (US-002)
// ---------------------------------------------------------------------------

/**
 * Build a CapturePaneFn (src/tmux/dispatch.ts) over the given TmuxSpawnFn, for
 * callers that only have a bare spawnFn in scope and need the same
 * capture-pane reader shape sendKeysVerified's composer-emptied verify step
 * expects (US-003, CAM-200). Mirrors the raw `capture-pane -p -t <paneId>`
 * shape dispatch.ts's own internal default reader builds, so behavior is
 * unchanged whether a caller threads this explicitly or omits capturePaneFn
 * and lets sendKeysVerified default it from the same spawnFn.
 */
export function makeCapturePaneFn(spawnFn: TmuxSpawnFn): CapturePaneFn {
	return (paneId: string): string => {
		const r = spawnFn('tmux', tmuxArgs(['capture-pane', '-p', '-t', paneId]), { stdio: 'pipe' });
		return typeof r.stdout === 'string' ? r.stdout : (r.stdout?.toString() ?? '');
	};
}

/**
 * Adapt a full WorkerEventLogger (ts/storyId/uuid/kind/detail) down to the
 * bare `(kind, detail) => void` seam sendKeysVerified's `logEvent` expects
 * (US-003, CAM-200). `storyId` is always `undefined` and `uuid` is fixed to
 * `'sidecar'`: a push-undelivered narration is not tied to a specific story
 * or worker session, mirroring the same fixed-uuid convention already used
 * for merge-watch/ship-phase sidecar-originated events.
 */
export function adaptLogEventForPush(
	logEvent: WorkerEventLogger,
): (kind: WorkerEventKind, detail: WorkerEventDetail) => void {
	return (kind, detail) => {
		logEvent({ ts: new Date().toISOString(), storyId: undefined, uuid: 'sidecar', kind, detail });
	};
}

/**
 * Build a notifyOrchestrator closure that resolves the orchestrator pane via
 * getOrchPaneId and, if found, pushes the line via `sendKeysVerified` (US-003,
 * CAM-200): idle-gate + composer-emptied delivery verify + bounded retry,
 * emitting `'push-undelivered'` via the injected `logEvent` on retry
 * exhaustion instead of writing any new durable marker (terminal states
 * already write their own; a lost non-terminal narration is self-healing
 * since the sidecar proceeds regardless).
 *
 * Best-effort: when getOrchPaneId returns null (orch pane closed or session
 * gone), the closure is a silent no-op. No throw, no error log.
 *
 * Invariants (sendkeys-literal-enter-gotcha, CAM-55):
 *   - send-keys text + Enter go in ONE tmux call (atomic).
 *   - NO -l flag (would make "Enter" literal text, not a key).
 *   `sendKeysVerified` enforces both (mirrors buildWorkerReportSendKeysArgv's
 *   argv shape exactly).
 *
 * @param sessionName    The project's tmux session name.
 * @param spawnFn        Injectable SpawnFn (tmux-flavoured: returns SpawnSyncReturns).
 * @param capturePaneFn  Injectable capture-pane reader for the composer-emptied
 *                       verify step. Omitting it falls back to sendKeysVerified's
 *                       own spawnFn-derived default reader.
 * @param logEvent       Bare `(kind, detail) => void` sink for `'push-undelivered'`
 *                       on retry exhaustion. Omitting it is a zero-side-effect
 *                       no-op (mirrors the sub-state-machine logEvent seam,
 *                       US-002/CAM-200).
 */
export function makeNotifyOrchestrator(
	sessionName: string,
	spawnFn: TmuxSpawnFn,
	capturePaneFn?: CapturePaneFn,
	logEvent?: (kind: WorkerEventKind, detail: WorkerEventDetail) => void,
): (line: string) => void {
	return (line: string): void => {
		const orchPane = getOrchPaneId(sessionName, spawnFn);
		if (orchPane === null) return; // best-effort: silent no-op
		sendKeysVerified({
			paneId: orchPane,
			text: line,
			tmuxSpawnFn: spawnFn,
			capturePaneFn,
			logEvent,
		});
	};
}

// ---------------------------------------------------------------------------
// onProgress factory (US-002, CAM-191: extracted so real-writer regression
// tests can exercise the production unlink-on-complete behavior directly,
// without constructing the entire tmux-dependent buildSupervisorOptions bag)
// ---------------------------------------------------------------------------

/**
 * Build the production onProgress closure that rewrites the loop state file
 * on every iteration and unlinks it on the terminal 'complete' status.
 *
 * Extracted verbatim from buildSupervisorOptions (zero behavior change): the
 * only difference is that `stateFilePath` and `stateFileBase` are now
 * parameters instead of closed-over locals, so a caller (or a test) can build
 * the SAME real writer against an arbitrary state-file path without pulling
 * in the rest of buildSupervisorOptions' tmux-dependent wiring.
 *
 * @param stateFilePath Absolute path to the state file (cam-loop.local.md).
 * @param stateFileBase Static fields carried into every renderStateFile call.
 */
export function makeOnProgress(
	stateFilePath: string,
	stateFileBase: { maxIterations: number; completionPromise: string; startedAt: string; pid: number },
): OnProgress {
	return (payload) => {
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
}

// ---------------------------------------------------------------------------
// ensurePushed compare-first push-verification (US-001, CAM-156)
// ---------------------------------------------------------------------------

/** Injectable subset of node:child_process spawnSync used by resolveEnsurePushed. */
export type GitSpawnFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8' },
) => { stdout: string | null; stderr: string | null; status: number | null };

/** Return contract for ensurePushed (unchanged by this story: see loop.ts + events.ts consumers). */
export interface EnsurePushedResult {
	ok: boolean;
	pushed: boolean;
	sha: string;
	detail: string;
}

/**
 * Fallback path: the ORIGINAL push-then-compare behavior, used when the
 * remote is genuinely behind/missing the branch, or when `git ls-remote`
 * itself failed (transient network error) and a compare-first decision
 * cannot be made. No lease-style force flag is introduced here; a plain
 * `git push origin <branch>` is git's own compare-and-swap against whatever
 * the remote currently holds.
 */
function pushThenCompare(spawnFn: GitSpawnFn, cwd: string, branchName: string): EnsurePushedResult {
	const pushProc = spawnFn('git', ['-C', cwd, 'push', 'origin', branchName], { encoding: 'utf8' });
	const combined = (pushProc.stdout ?? '') + (pushProc.stderr ?? '');
	const noop = combined.includes('Everything up-to-date');
	if ((pushProc.status ?? 1) !== 0 && !noop) {
		return { ok: false, pushed: false, sha: '', detail: `git push failed: ${combined.trim()}` };
	}
	const pushed = !noop;
	const headProc = spawnFn('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
	const localSha = (headProc.stdout ?? '').trim();
	const originProc = spawnFn('git', ['-C', cwd, 'rev-parse', `origin/${branchName}`], { encoding: 'utf8' });
	const originSha = (originProc.stdout ?? '').trim();
	if (!localSha || !originSha || localSha !== originSha) {
		return {
			ok: false,
			pushed,
			sha: localSha,
			detail: `HEAD (${localSha || 'unknown'}) != origin/${branchName} (${originSha || 'unknown'}) after push`,
		};
	}
	return { ok: true, pushed, sha: localSha, detail: `HEAD == origin/${branchName} (${localSha})` };
}

/**
 * Compare-first push-verification (US-001, CAM-156): read the authoritative
 * remote sha via `git ls-remote origin <branch>` (read-only, no fetch, no
 * mutation of local tracking refs) and compare it to local HEAD BEFORE
 * attempting any `git push`.
 *
 *   - origin sha == local HEAD: the worker already pushed. Return
 *     { ok:true, pushed:false } WITHOUT running `git push` at all, so a
 *     stale compare-and-swap old-oid can never be sent for an already-landed
 *     push (the false BLOCKED this story fixes).
 *   - origin behind or missing the branch: genuinely unpushed. Fall through
 *     to the push-then-compare path (which runs `git push` and re-verifies).
 *   - `git ls-remote` itself fails (e.g. transient network error): fall
 *     through to the same push-then-compare path so the fix never loses the
 *     ability to push when needed.
 *
 * Return contract is unchanged: { ok, pushed, sha, detail }.
 */
export function resolveEnsurePushed(spawnFn: GitSpawnFn, cwd: string): EnsurePushedResult {
	const branchProc = spawnFn('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
	const branchName = (branchProc.stdout ?? '').trim();
	if (!branchName) {
		return { ok: false, pushed: false, sha: '', detail: 'could not determine current branch' };
	}

	const headProc = spawnFn('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
	const localSha = (headProc.stdout ?? '').trim();
	if (!localSha) {
		return { ok: false, pushed: false, sha: '', detail: 'could not determine local HEAD' };
	}

	const lsRemote = spawnFn('git', ['-C', cwd, 'ls-remote', 'origin', branchName], { encoding: 'utf8' });
	if ((lsRemote.status ?? 1) === 0) {
		const remoteSha = (lsRemote.stdout ?? '').trim().split(/\s+/)[0] ?? '';
		if (remoteSha && remoteSha === localSha) {
			return {
				ok: true,
				pushed: false,
				sha: localSha,
				detail: `origin/${branchName} already at HEAD (${localSha}), no push needed`,
			};
		}
		// Remote present but behind, or branch missing on remote (empty stdout):
		// fall through to the genuine push-then-compare path below.
	}
	// ls-remote failed (network/auth error), or remote is behind/missing:
	// fall back to the original push-then-compare behavior.
	return pushThenCompare(spawnFn, cwd, branchName);
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

	// CAM-188 / US-001: tear down the reused worker pane on every terminal exit.
	// Uses `tmux kill-pane` (NOT respawn-pane -k which keeps the pane alive and
	// leaves the mutex busy). Pane id resolved fresh from readWorkerPaneMarker so
	// a mid-session pane re-allocation is picked up correctly; the boot-time
	// workerPaneId is the fallback when no marker exists.
	// Best-effort: a null marker, already-dead pane, or absent tmux is a silent
	// no-op. Never throws so the terminal return always proceeds.
	const teardownWorkerPaneFn: RunSupervisorOptions['teardownWorkerPaneFn'] = () => {
		const id = readWorkerPaneMarker(claudeDir) ?? workerPaneId;
		try {
			spawnSync('tmux', ['-L', 'cam', 'kill-pane', '-t', id], { stdio: 'pipe' });
		} catch {
			// best-effort: silent no-op
		}
	};

	// US-005 (CAM-195, Defect 2): durable implement-blocked marker writer.
	// Stamps `writtenAt` (the one field the pure loop.ts seam does NOT add,
	// keeping loop.ts clock-free) and persists via writeImplementBlockedMarker
	// (never throws). Mirrors makeWriteEscalationMarkerFn (src/commands/sidecar.ts).
	//
	// US-002 (CAM-214): reads the existing marker + the current sha256 of
	// prd.json and feeds both through `advanceBlockedMarker` so the persisted
	// `consecutiveCount`/`keyHash`/`escalated` reflect real cross-session
	// repetition (rather than the US-001 placeholder fresh-block values).
	const implementBlockedMarkerPath = join(claudeDir, IMPLEMENT_BLOCKED_FILENAME);
	const writeImplementBlockedMarkerFn: RunSupervisorOptions['writeImplementBlockedMarkerFn'] = (
		params: ImplementBlockedWriterParams,
	) => {
		const prev = readImplementBlockedMarker(implementBlockedMarkerPath);
		const prdHash = computePrdHashForBlockedMarker(prdPath);
		const marker = advanceBlockedMarker(prev, { ...params, writtenAt: new Date().toISOString() }, prdHash);
		writeImplementBlockedMarker(implementBlockedMarkerPath, marker);
	};

	// US-001 (CAM-347): durable implement-blocked marker remover, wired to the
	// same path the writer above uses. Fired by loop.ts's finishTerminal only on
	// a successful 'complete' terminal (never throws; removeImplementBlockedMarker
	// is a silent no-op when the marker is already absent).
	const removeImplementBlockedMarkerFn: RunSupervisorOptions['removeImplementBlockedMarkerFn'] = () => {
		removeImplementBlockedMarker(implementBlockedMarkerPath);
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

	// US-007 (CAM-192/CAM-201): production container ensure/reconcile +
	// auto-rebuild seam. Reuses the SAME closure the sidecar calls once at boot
	// (makeProductionEnsureContainerFn), so per-cycle reconcile never drifts
	// from the boot-time reconcile. Only wired in container mode: the loop
	// (runSupervisor) only ever invokes it when workerIsolation === 'container',
	// but leaving it undefined in host mode avoids constructing an unused
	// docker-mutating closure.
	const ensureContainerFn: RunSupervisorOptions['ensureContainerFn'] =
		workerIsolation === 'container' ? makeProductionEnsureContainerFn(cwd) : undefined;

	// Per-worker timeout: configurable via CAM_WORKER_TIMEOUT_MS env var. When
	// unset, the fallback is isolation-aware (US-003 / CAM-187): container
	// workers get DEFAULT_CONTAINER_WORKER_TIMEOUT_MS (60 min) so long container
	// stories (image rebuild + in-container test suites) do not hit the host
	// ceiling and trigger a premature timeout/re-dispatch; host workers keep
	// DEFAULT_PER_WORKER_TIMEOUT_MS (30 min). An explicit env value always wins.
	const perWorkerTimeoutMs = (() => {
		const envVal = process.env['CAM_WORKER_TIMEOUT_MS'];
		if (envVal !== undefined) {
			const parsed = parseInt(envVal, 10);
			if (!isNaN(parsed) && parsed > 0) return parsed;
		}
		return workerIsolation === 'container'
			? DEFAULT_CONTAINER_WORKER_TIMEOUT_MS
			: DEFAULT_PER_WORKER_TIMEOUT_MS;
	})();

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

	// US-003 (ADR 0035): finalizeStory is now the SOLE writer of passes:true,
	// invoked by loop.ts on BOTH the incomplete path (worker truncated before
	// flipping) and the pass path (worker already wrote passes:true itself) --
	// the pass/incomplete distinction collapses for the flip. That means this
	// idempotent write can land on a story that ALREADY has passes:true and an
	// already-committed prd.json (the worker's own commit), leaving nothing
	// staged after `git add -A`. `git commit` fails ("nothing to commit") in
	// that case; treat it as an already-finalized no-op (ok:true), not an
	// error -- the desired end state (a landed commit carrying passes:true)
	// already holds, so there is nothing for the supervisor to add.
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
			const diffCheck = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd, stdio: 'ignore' });
			if (diffCheck.status === 0) {
				return { ok: true, detail: `${storyId} already finalized (no staged changes)` };
			}
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

	// ensurePushed for US-001 (CAM-156: rewritten compare-first via resolveEnsurePushed).
	const gitSpawnFn: GitSpawnFn = (cmd, args, opts) => spawnSync(cmd, args, opts);
	const ensurePushed: RunSupervisorOptions['ensurePushed'] = () => {
		try {
			return resolveEnsurePushed(gitSpawnFn, cwd);
		} catch (e) {
			return { ok: false, pushed: false, sha: '', detail: e instanceof Error ? e.message : String(e) };
		}
	};

	// commitExistsForStory for US-002 (CAM-187): reads commits unique to this
	// PRD/branch and matches them with the anchored matcher from US-001
	// (commitSubjectMatchesStory). Read-only (no mutation), same
	// spawnSync-git style as ensurePushed/finalizeStory above.
	//
	// US-R1-002 fix: `git log --format=%s <branch>` walks the branch's ENTIRE
	// ancestry back to the root commit (git-scm.com/docs/git-log), not just
	// commits unique to this branch. Story ids (US-001..) are reused every
	// PRD, so an ancient bracketless commit from an unrelated past PRD
	// collides and makes the gate return true unconditionally, silently
	// defeating the exact "passes:true but no commit" scenario the epic
	// exists to catch. Scope the range to `origin/main..HEAD` (a best-effort
	// `git fetch origin main` keeps it fresh), falling back to local
	// `main..HEAD` when origin/main cannot be resolved (e.g. no remote
	// configured), so only commits made on this branch since it forked from
	// main are considered.
	const commitExistsForStory: RunSupervisorOptions['commitExistsForStory'] = (storyId) => {
		try {
			const branchProc = spawnSync('git', ['branch', '--show-current'], {
				cwd,
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			const branchName = (typeof branchProc.stdout === 'string' ? branchProc.stdout : '').trim();
			if (!branchName) return false;

			// Best-effort: refresh origin/main so the range reflects the true
			// upstream fork point. Ignore failures (offline, no remote, etc.).
			spawnSync('git', ['fetch', 'origin', 'main'], {
				cwd,
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);

			const originMainProc = spawnSync('git', ['rev-parse', 'origin/main'], {
				cwd,
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			const range = originMainProc.status === 0 ? 'origin/main..HEAD' : 'main..HEAD';

			const logProc = spawnSync('git', ['log', '--format=%s', range], {
				cwd,
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			if (logProc.status !== 0) return false;
			const subjects = (typeof logProc.stdout === 'string' ? logProc.stdout : '').split('\n');
			return subjects.some((subject) => commitSubjectMatchesStory(subject, storyId));
		} catch {
			return false;
		}
	};

	// aheadByForBranch for US-004 (empty-push gate): counts commits ahead of
	// origin/main, mirroring commitExistsForStory's best-effort fetch +
	// origin/main..HEAD-with-local-fallback range resolution above. Read-only
	// (no mutation), same spawnSync-git style as the other adapters here.
	// Returns null (fail-open; see confirmEmptyPushGate) when the count could
	// not be determined (e.g. git failures), rather than a sentinel number.
	const aheadByForBranch: RunSupervisorOptions['aheadByForBranch'] = () => {
		try {
			// Best-effort: refresh origin/main so the range reflects the true
			// upstream fork point. Ignore failures (offline, no remote, etc.).
			spawnSync('git', ['fetch', 'origin', 'main'], {
				cwd,
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);

			const originMainProc = spawnSync('git', ['rev-parse', 'origin/main'], {
				cwd,
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			const range = originMainProc.status === 0 ? 'origin/main..HEAD' : 'main..HEAD';

			const countProc = spawnSync('git', ['rev-list', '--count', range], {
				cwd,
				stdio: 'pipe',
				encoding: 'utf8',
			} as Parameters<typeof spawnSync>[2]);
			if (countProc.status !== 0) return null;
			const raw = (typeof countProc.stdout === 'string' ? countProc.stdout : '').trim();
			const count = Number(raw);
			return Number.isFinite(count) ? count : null;
		} catch {
			return null;
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
	// and pushes the verdict line via sendKeysVerified. Uses a spawnSync adapter
	// that matches the TmuxSpawnFn signature (returns SpawnSyncReturns, not the
	// loop.ts SpawnFn shape). Best-effort: silent no-op when orch pane is gone.
	const tmuxSpawnFn: TmuxSpawnFn = (cmd, args, spawnOpts) =>
		spawnSync(cmd, args, {
			stdio: spawnOpts?.stdio ?? 'pipe',
			encoding: 'utf8',
		} as Parameters<typeof spawnSync>[2]);

	// US-003 (CAM-200): thread the capture-pane reader + logEvent deps
	// sendKeysVerified needs for its idle-gate + bounded-retry push. Reuses the
	// SAME real capturePane closure (with -S - full scrollback) already wired
	// above -- safe as of the review round 2 fix (US-R2-001, CAM-359),
	// because sendKeysVerified now feeds this scrollback reader ONLY to its
	// PRE-send idle-gate; the content backstop's row-index lookup samples a
	// SEPARATE, always-visible-screen reader it builds internally
	// (`visibleCaptureFn`, defaulted from `tmuxSpawnFn`), never this one.
	// Also adapts the full logEvent WorkerEventLogger down to the bare
	// (kind, detail) seam.
	const notifyOrchestrator = makeNotifyOrchestrator(
		sessionName,
		tmuxSpawnFn,
		capturePane,
		adaptLogEventForPush(logEvent),
	);

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

	const onProgress: OnProgress = makeOnProgress(stateFilePath, stateFileBase);

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
		// US-002 (CAM-187): commit-existence gate, threaded into readWorkerOutcome.
		commitExistsForStory,
		// US-004: empty-push gate, threaded into readWorkerOutcome.
		aheadByForBranch,
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
		// US-007: container ensure/reconcile + auto-rebuild seam, run before
		// preflightContainerFn on every dispatch cycle in container mode.
		ensureContainerFn,
		// US-004 / B-2 (CAM-152): isolation mode drives dockerExecWrap + fail-closed.
		workerIsolation,
		// CAM-188 / US-001: kill-pane on every terminal exit so the session returns
		// to exactly 2 panes and paneCountMutex reports 'available'.
		teardownWorkerPaneFn,
		// US-005 (CAM-195, Defect 2): durable implement-blocked marker writer.
		writeImplementBlockedMarkerFn,
		// US-001 (CAM-347): durable implement-blocked marker remover (complete terminal only).
		removeImplementBlockedMarkerFn,
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
