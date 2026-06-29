// src/commands/sidecar.ts
//
// Production caller for runSupervisor via the sidecar model (US-FIX-002).
//
// `cam sidecar` is an INTERNAL command spawned as a detached background process
// by `cam run`. It is not listed in `cam help` (there is no public user-facing
// use case) but it IS a real registered subcommand in index.ts so that
// `Bun.spawn(['cam', 'sidecar', ...])` works against the installed binary.
//
// Architecture (FLOW.md §4 + §9, sidecar model):
//   The sidecar:
//     1. Reads the `active` flag in .claude/cam-loop.local.md.
//     2. When active:false (or absent): idles (sleeps SIDECAR_IDLE_POLL_MS).
//     3. When active:true AND non-operator stories pending:
//        a. Acquires the supervisor lock (.claude/.cam-supervisor.lock).
//        b. Calls runSupervisor with the real-I/O options from host.ts.
//        c. On terminal: sets active:false (cam status shows 'paused').
//     4. Loops forever until killed by cam run's SIGINT/SIGTERM cleanup.
//
// All I/O is injectable via SidecarOptions for unit tests.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { runSidecarLoop, type RunSidecarLoopOptions } from '../supervisor/loop.ts';
import { buildSupervisorOptions, makeNotifyOrchestrator } from '../supervisor/host.ts';
import { makeFileEventLogger, type WorkerEventLogger } from '../supervisor/events.ts';
import { parseStateFile } from './status.ts';
import { renderStateFile, writeStateFile } from './next.ts';
import { TERMINAL_VERDICTS, type PrdSnapshot } from '../supervisor/decide.ts';
import { hasSession, projectSessionName, getOrchPaneId, type SpawnFn } from '../tmux/session.ts';
import { readMergeMode, readMetaLoop, readPlanApproval, readResendConfig } from '../config/models.ts';
import { sendEscalation } from '../notify/resend.ts';
import { buildWorkerReportSendKeysArgv } from '../supervisor/worker-report.ts';
import {
	runMergeWatch,
	MERGE_WATCH_FILENAME,
	type MergeWatchState,
	type GhPollFn,
	type PrStatus,
} from '../release/merge-watch.ts';
import { runPostMerge, type SpawnFn as PostMergeSpawnFn } from '../release/post-merge.ts';
import { observeDecide, type ObserveState } from '../supervisor/observe.ts';
import { selectPlannableFromFile } from '../issues/select.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SidecarOptions {
	/** Working directory (defaults to process.cwd()). */
	cwd?: string;
	/**
	 * Override the readActive implementation.
	 * Reads the active flag from .claude/cam-loop.local.md.
	 * Tests inject a fake to control the gate.
	 */
	readActiveFn?: () => boolean | undefined;
	/**
	 * Override the clearActive implementation.
	 * Sets active:false in .claude/cam-loop.local.md.
	 * Tests inject a fake to assert it was called.
	 */
	clearActiveFn?: () => void;
	/**
	 * Override the hasPendingStories check.
	 * Tests inject a fake to control whether work exists.
	 */
	hasPendingStoriesFn?: () => boolean;
	/**
	 * Override the sleep function. Tests inject a no-op.
	 */
	sleepFn?: (ms: number) => void;
	/**
	 * Override the supervisor lock acquisition. Tests inject a fake.
	 */
	acquireLockFn?: () => { acquired: true; release: () => void } | { acquired: false; holderPid: number };
	/**
	 * Override the runSupervisor call. Tests inject a fake.
	 */
	runSupervisorFn?: RunSidecarLoopOptions['runSupervisorFn'];
	/**
	 * Override the buildOpts call. Tests inject a fake.
	 */
	buildOptsFn?: RunSidecarLoopOptions['buildOpts'];
	/**
	 * Override the hasSession check used for sidecar self-exit.
	 * Production: closure over hasSession(projectSessionName(cwd), spawnFn).
	 * Tests inject a fake to avoid spawning real tmux.
	 */
	hasSessionFn?: () => boolean;
	/**
	 * Override the event logger used to record sidecar lifecycle events.
	 * Production: makeFileEventLogger('.claude/cam-worker-events.jsonl').
	 * Tests inject makeInMemoryEventLogger().logger to capture events in memory.
	 */
	logEventFn?: WorkerEventLogger;
	/**
	 * Override the flipActiveFn (US-005).
	 *
	 * Production (auto mode): writes active:true to .claude/cam-loop.local.md
	 * so the sidecar re-triggers after a supervisor run without a human cam-next.
	 * Production (operator mode): undefined (inert, zero behavior change).
	 * Tests inject a spy to assert the flip happened.
	 */
	flipActiveFn?: RunSidecarLoopOptions['flipActiveFn'];
	/**
	 * Override the autoShipFn (US-005).
	 *
	 * Production (auto mode): sends '/cam-ship Enter' to the orchestrator pane
	 * via tmux send-keys so cam-ship runs without a human gate after CLEAN review.
	 * Production (operator mode): undefined (inert, zero behavior change).
	 * Tests inject a spy to assert the dispatch happened.
	 */
	autoShipFn?: RunSidecarLoopOptions['autoShipFn'];
	/**
	 * Override the merge-watch function (US-007).
	 *
	 * Production (ci-gated mode): reads .claude/.cam-merge-watch.json, runs
	 * gh polling via runMergeWatch, narrates via notifyOrchestrator.
	 * Production (immediate mode): undefined (inert, zero behavior change).
	 * Tests: inject a fake to drive MERGED / CI-red paths without real gh calls.
	 *
	 * When absent and merge mode is ci-gated, the production runSidecar builds
	 * the real implementation automatically.
	 */
	runMergeWatchFn?: RunSidecarLoopOptions['runMergeWatchFn'];
	/**
	 * Override the escalateFn (US-R1-001).
	 *
	 * Production: reads RESEND_API_KEY env var + resend_recipient from
	 * [notify] project.toml and builds a sendEscalation closure. Absent when
	 * Resend is unconfigured (both values must be non-empty).
	 * Tests: inject a spy to assert the escalation was dispatched without a
	 * real network hit.
	 */
	escalateFn?: RunSidecarLoopOptions['escalateFn'];
	/**
	 * Override the meta-loop observe function (US-004, CAM-132).
	 *
	 * Production (meta_loop=observe): a closure that calls selectPlannableFromFile
	 * on the MAIN backlog, runs observeDecide with in-memory dedup state, and emits
	 * a 'meta-loop-observe' event via logEvent.
	 * Production (meta_loop=off, default): undefined (inert, zero behavior change).
	 * Tests: inject a spy to assert the function was (or was not) called.
	 */
	runMetaLoopObserveFn?: RunSidecarLoopOptions['runMetaLoopObserveFn'];
}

// ---------------------------------------------------------------------------
// Active-flag helpers (real implementations)
// ---------------------------------------------------------------------------

/**
 * Read the `active` flag from .claude/cam-loop.local.md.
 * Returns undefined when the file is absent, unparseable, or the active field
 * is not present. The sidecar treats undefined as false (idle).
 */
function makeReadActive(claudeDir: string): () => boolean | undefined {
	const stateFilePath = join(claudeDir, 'cam-loop.local.md');
	return () => {
		try {
			if (!existsSync(stateFilePath)) return undefined;
			const contents = readFileSync(stateFilePath, 'utf8');
			const parsed = parseStateFile(contents);
			if (parsed === null) return undefined;
			return parsed.active;
		} catch {
			return undefined;
		}
	};
}

/**
 * Set active:false in .claude/cam-loop.local.md by overwriting the frontmatter.
 * Reads the existing state to preserve other fields; falls back to a minimal
 * write if the file is absent or unparseable. Best-effort: a failure here is
 * non-fatal (the loop will just re-check on the next poll).
 */
function makeClearActive(claudeDir: string, cwd: string): () => void {
	const stateFilePath = join(claudeDir, 'cam-loop.local.md');
	return () => {
		try {
			if (!existsSync(stateFilePath)) {
				// Write a minimal state file with active:false so cam status shows 'paused'.
				const body = renderStateFile({
					maxIterations: 50,
					completionPromise: 'COMPLETE',
					startedAt: new Date().toISOString(),
					pid: process.pid,
					active: false,
				});
				writeStateFile(cwd, body, { force: true });
				return;
			}
			const contents = readFileSync(stateFilePath, 'utf8');
			const parsed = parseStateFile(contents);
			if (parsed === null) {
				// Unparseable: write fresh minimal state with active:false.
				const body = renderStateFile({
					maxIterations: 50,
					completionPromise: 'COMPLETE',
					startedAt: new Date().toISOString(),
					pid: process.pid,
					active: false,
				});
				writeFileSync(stateFilePath, body, 'utf8');
				return;
			}
			const body = renderStateFile({
				maxIterations: parsed.max_iterations ?? 50,
				completionPromise: parsed.completion_promise ?? 'COMPLETE',
				startedAt: parsed.started_at ?? new Date().toISOString(),
				pid: parsed.pid ?? process.pid,
				active: false,
				iteration: parsed.iteration,
				currentStory: parsed.current_story,
				storiesDone: parsed.stories_done,
				storiesTotal: parsed.stories_total,
				lastActivity: parsed.last_activity ?? new Date().toISOString(),
			});
			writeFileSync(stateFilePath, body, 'utf8');
		} catch {
			// Non-fatal.
		}
	};
}

/**
 * Check whether there is pending work in prd.json.
 *
 * Returns true when:
 *   (a) at least one non-operator story has passes !== true, OR
 *   (b) all non-operator stories pass but the review verdict is non-terminal
 *       (absent, null, or any value not in TERMINAL_VERDICTS from decide.ts).
 *
 * Returns false only when all non-operator stories pass AND the review verdict
 * is terminal ('CLEAN' or 'MAX_ROUNDS_DEBT').
 *
 * Exported so unit tests can import it directly.
 */
export function makeHasPendingStories(prdPath: string): () => boolean {
	return () => {
		try {
			const raw = readFileSync(prdPath, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			if (parsed === null || typeof parsed !== 'object') return false;
			const prd = parsed as PrdSnapshot;
			const stories = prd.userStories ?? [];
			// US-008 guard: MAX_ROUNDS_DEBT is the non-convergence terminal. At this
			// state no further implement should be dispatched, regardless of any
			// passes:false stories (orphan fix stories left before the terminal was
			// detected). Return false so the auto-chain does not re-trigger the loop.
			// Note: CLEAN is NOT guarded here — CLEAN + pending stories is a valid
			// scenario (e.g. review passed but the operator added a new story). Only
			// MAX_ROUNDS_DEBT means "the pipeline is exhausted, stop everything."
			const currentVerdict = prd.review?.lastVerdict ?? null;
			if (currentVerdict === 'MAX_ROUNDS_DEBT') {
				return false;
			}
			// Case (a): at least one implementable story is still pending.
			if (stories.some((s) => s.passes !== true && s.requires !== 'operator')) {
				return true;
			}
			// Case (b): all non-operator stories pass — gate on review verdict.
			// Return true when the verdict is absent/null (review not yet run) or
			// non-terminal (e.g. FIXES_PENDING:*), so the sidecar triggers review.
			const verdict = prd.review?.lastVerdict;
			return verdict == null || !TERMINAL_VERDICTS.has(verdict);
		} catch {
			return false;
		}
	};
}

// ---------------------------------------------------------------------------
// Merge-watch production factory (extracted to keep runSidecar under
// complexity/line limits; CAM-60 factory/helper pattern)
// ---------------------------------------------------------------------------

/**
 * Build the production runMergeWatchFn closure for ci-gated ship mode.
 *
 * This factory is called by runSidecar when merge_mode == "ci-gated".
 * It is NOT exported: tests inject `options.runMergeWatchFn` directly.
 */
function makeProductionMergeWatchFn(
	cwd: string,
	claudeDir: string,
	sessionName: string,
	logEvent: WorkerEventLogger,
	realSpawnFn: SpawnFn,
): () => Promise<void> {
	return async (): Promise<void> => {
		const watchFilePath = join(claudeDir, MERGE_WATCH_FILENAME);
		if (!existsSync(watchFilePath)) return; // no watch pending

		let state: MergeWatchState;
		try {
			const raw = readFileSync(watchFilePath, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
			state = parsed as MergeWatchState;
		} catch {
			try { unlinkSync(watchFilePath); } catch { /* best-effort */ }
			return;
		}

		// Remove the watch file BEFORE starting to prevent re-entry on sidecar restart.
		try { unlinkSync(watchFilePath); } catch { /* best-effort */ }

		const ghPollFn: GhPollFn = (prNumber): PrStatus | null => {
			const result = spawnSync(
				'gh',
				['pr', 'view', String(prNumber), '--json', 'state,mergeStateStatus,statusCheckRollup'],
				{ encoding: 'utf8' },
			);
			if ((result.status ?? 1) !== 0) return null;
			try {
				const parsed: unknown = JSON.parse(result.stdout);
				if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
					return parsed as PrStatus;
				}
				return null;
			} catch { return null; }
		};

		const postMergeSpawnFn: PostMergeSpawnFn = (cmd, args, spawnOpts) =>
			spawnSync(cmd, args, spawnOpts as Parameters<typeof spawnSync>[2]) as SpawnSyncReturns<string>;

		const notify = makeNotifyOrchestrator(sessionName, realSpawnFn);

		await runMergeWatch({
			prNumber: state.prNumber,
			mergedBranch: state.mergedBranch,
			cwd,
			pollFn: ghPollFn,
			postMergeFn: ({ cwd: mergeCwd, mergedBranch }) =>
				runPostMerge({ cwd: mergeCwd, mergedBranch, spawnFn: postMergeSpawnFn }),
			notifyOrchestrator: notify,
			logEvent: (kind, detail) =>
				logEvent({ ts: new Date().toISOString(), storyId: undefined, uuid: 'sidecar', kind, detail }),
			sleepFn: (ms) => Bun.sleepSync(ms),
		});
	};
}

// ---------------------------------------------------------------------------
// Auto-chain production factories (US-005)
// ---------------------------------------------------------------------------

/**
 * Build the production flipActiveFn closure for auto mode.
 *
 * Writes active:true to .claude/cam-loop.local.md, preserving all other
 * fields from the existing state file (mirrors the cam-next thin-proxy).
 * Non-fatal on any error: the sidecar continues; the auto-chain may simply
 * miss one cycle rather than aborting.
 */
function makeFlipActiveFn(claudeDir: string, cwd: string): () => void {
	const stateFilePath = join(claudeDir, 'cam-loop.local.md');
	return (): void => {
		try {
			const now = new Date().toISOString();
			let body: string;
			if (existsSync(stateFilePath)) {
				const contents = readFileSync(stateFilePath, 'utf8');
				const parsed = parseStateFile(contents);
				body = renderStateFile({
					maxIterations: parsed?.max_iterations ?? 50,
					completionPromise: parsed?.completion_promise ?? 'COMPLETE',
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
				body = renderStateFile({
					maxIterations: 50,
					completionPromise: 'COMPLETE',
					startedAt: now,
					pid: process.pid,
					active: true,
					lastActivity: now,
				});
			}
			writeStateFile(cwd, body, { force: true });
		} catch {
			// Non-fatal: sidecar continues to next poll cycle.
		}
	};
}

/**
 * Build the production autoShipFn closure for auto mode.
 *
 * Sends '/cam-ship Enter' to the orchestrator pane via tmux send-keys so
 * cam ship runs without a human gate after a CLEAN review verdict.
 * Best-effort: a missing orchestrator pane is a silent no-op.
 */
function makeAutoShipFn(sessionName: string, spawnFn: SpawnFn): () => void {
	return (): void => {
		const orchPane = getOrchPaneId(sessionName, spawnFn);
		if (orchPane === null) return; // best-effort: silent no-op
		const argv = buildWorkerReportSendKeysArgv(orchPane, '/cam-ship');
		spawnFn('tmux', argv, { stdio: 'ignore' });
	};
}

// ---------------------------------------------------------------------------
// Dep-resolution helper (extracted from runSidecar to keep it under the biome
// cognitive-complexity <=15 and function-length <=80 line limits; CAM-60
// factory/helper-extraction pattern)
// ---------------------------------------------------------------------------

interface SidecarLoopDepsCtx {
	cwd: string;
	claudeDir: string;
	prdPath: string;
	sessionName: string;
	logEvent: WorkerEventLogger;
	realSpawnFn: SpawnFn;
}

interface SidecarLoopDepsResult {
	readActiveFn: () => boolean | undefined;
	clearActiveFn: () => void;
	hasPendingStoriesFn: () => boolean;
	sleepFn: (ms: number) => void;
	hasSessionFn: () => boolean;
	acquireLockFn: NonNullable<SidecarOptions['acquireLockFn']>;
	buildOptsFn: NonNullable<RunSidecarLoopOptions['buildOpts']>;
	runMergeWatchFn: RunSidecarLoopOptions['runMergeWatchFn'];
	flipActiveFn: RunSidecarLoopOptions['flipActiveFn'];
	autoShipFn: RunSidecarLoopOptions['autoShipFn'];
	escalateFn: RunSidecarLoopOptions['escalateFn'];
	runMetaLoopObserveFn: RunSidecarLoopOptions['runMetaLoopObserveFn'];
}

/**
 * Build the production escalateFn closure (US-R1-001).
 *
 * Extracted from buildSidecarLoopDeps to reduce its cognitive complexity (biome
 * noExcessiveCognitiveComplexity, max 15). Not exported: tests inject
 * options.escalateFn directly.
 *
 * Returns undefined when either apiKey or recipient is empty so the non-convergence
 * terminal stays inert for projects that have not configured Resend.
 */
function makeProductionEscalateFn(
	apiKey: string,
	recipient: string,
): RunSidecarLoopOptions['escalateFn'] {
	if (apiKey === '' || recipient === '') return undefined;
	return async () => {
		await sendEscalation({
			apiKey,
			recipient,
			subject: '[cam] Non-convergence: max review rounds reached',
			html: '<p><strong>[cam]</strong> The supervisor reached the maximum number of review rounds without a CLEAN verdict. Manual intervention is required.</p>',
		});
	};
}

/**
 * Build the production runMetaLoopObserveFn closure for meta_loop=observe mode
 * (US-004, CAM-132).
 *
 * Extracted from buildSidecarLoopDeps to keep that function under the biome
 * noExcessiveLinesPerFunction(maxLines=80) limit. Not exported: tests inject
 * options.runMetaLoopObserveFn directly.
 *
 * Dedup state is held in the closure (NOT persisted to any file under .claude
 * or the working tree per CAM-68 invariant).
 */
function makeProductionMetaLoopObserveFn(
	cwd: string,
	logEvent: WorkerEventLogger,
): () => void {
	let lastState: ObserveState = { kind: 'none' };
	return (): void => {
		const selected = selectPlannableFromFile(cwd);
		const result = observeDecide(selected, lastState);
		if (result !== null) {
			lastState = result.newState;
			logEvent({
				ts: new Date().toISOString(),
				storyId: undefined,
				uuid: 'sidecar',
				kind: 'meta-loop-observe',
				detail: result.detail,
			});
		}
	};
}

/**
 * Resolve all injectable sidecar loop deps from SidecarOptions + context.
 *
 * Each dep follows the options-injection-or-production-default pattern: when
 * the option is provided (by tests), use it; otherwise build the real dep.
 * Extracted so runSidecar stays under the biome cognitive-complexity (<=15)
 * and function-length (<=80 lines) limits.
 */
function buildSidecarLoopDeps(ctx: SidecarLoopDepsCtx, options: SidecarOptions): SidecarLoopDepsResult {
	const { cwd, claudeDir, prdPath, sessionName, logEvent, realSpawnFn } = ctx;

	const readActiveFn = options.readActiveFn ?? makeReadActive(claudeDir);
	const clearActiveFn = options.clearActiveFn ?? makeClearActive(claudeDir, cwd);
	const hasPendingStoriesFn = options.hasPendingStoriesFn ?? makeHasPendingStories(prdPath);
	const sleepFn = options.sleepFn ?? ((ms: number) => Bun.sleepSync(ms));
	const hasSessionFn = options.hasSessionFn ?? (() => hasSession(sessionName, realSpawnFn));
	const acquireLockFn =
		options.acquireLockFn ??
		(() => { const built = buildSupervisorOptions(cwd); return built.acquireLock(); });
	const buildOptsFn =
		options.buildOptsFn ??
		(() => { const built = buildSupervisorOptions(cwd); return built.opts; });

	// US-007: Merge-watch wiring for CI-gated ship mode.
	const mergeMode = readMergeMode(join(cwd, 'scripts/cam/project.toml'));
	const runMergeWatchFn: RunSidecarLoopOptions['runMergeWatchFn'] =
		options.runMergeWatchFn ??
		(mergeMode === 'ci-gated'
			? makeProductionMergeWatchFn(cwd, claudeDir, sessionName, logEvent, realSpawnFn)
			: undefined);

	// US-005: plan_approval drives auto-chain wiring (flip + autoShip only in auto
	// mode; undefined in operator mode = zero behavior change).
	const planApproval = readPlanApproval(join(cwd, 'scripts/cam/project.toml'));
	const autoChainProduction = planApproval === 'auto'
		? { flipActiveFn: makeFlipActiveFn(claudeDir, cwd), autoShipFn: makeAutoShipFn(sessionName, realSpawnFn) }
		: { flipActiveFn: undefined as RunSidecarLoopOptions['flipActiveFn'], autoShipFn: undefined as RunSidecarLoopOptions['autoShipFn'] };
	const flipActiveFn = options.flipActiveFn ?? autoChainProduction.flipActiveFn;
	const autoShipFn = options.autoShipFn ?? autoChainProduction.autoShipFn;

	// US-R1-001: escalateFn from Resend config; only wired when both apiKey and
	// recipient are non-empty. Production logic extracted to makeProductionEscalateFn
	// to keep buildSidecarLoopDeps under biome cognitive-complexity limit.
	const resendConfig = readResendConfig(join(cwd, 'scripts/cam/project.toml'));
	const escalateFn: RunSidecarLoopOptions['escalateFn'] =
		options.escalateFn ?? makeProductionEscalateFn(resendConfig.apiKey, resendConfig.recipient);

	// US-004 / CAM-132: meta-loop observe wiring. undefined when off (default).
	const metaLoop = readMetaLoop(join(cwd, 'scripts/cam/project.toml'));
	const runMetaLoopObserveFn: RunSidecarLoopOptions['runMetaLoopObserveFn'] =
		options.runMetaLoopObserveFn ??
		(metaLoop === 'observe'
			? makeProductionMetaLoopObserveFn(cwd, logEvent)
			: undefined);

	return {
		readActiveFn, clearActiveFn, hasPendingStoriesFn, sleepFn, hasSessionFn,
		acquireLockFn, buildOptsFn, runMergeWatchFn, flipActiveFn, autoShipFn, escalateFn,
		runMetaLoopObserveFn,
	};
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the sidecar supervisor loop.
 *
 * This is the PRODUCTION caller of runSupervisor. It is spawned as a detached
 * background process by `cam run` and runs for the lifetime of the cam session.
 *
 * Returns a Promise<void> that never resolves (the process is killed by cam run's
 * cleanup handler on SIGINT/SIGTERM).
 */
export async function runSidecar(options: SidecarOptions = {}): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const claudeDir = join(cwd, '.claude');
	const prdPath = join(cwd, 'scripts/cam/prd.json');

	const realSpawnFn: SpawnFn = (cmd, args, spawnOpts) =>
		spawnSync(cmd, args, spawnOpts as Parameters<typeof spawnSync>[2]);
	const sessionName = projectSessionName(cwd);
	const logEvent =
		options.logEventFn ?? makeFileEventLogger(join(claudeDir, 'cam-worker-events.jsonl'));

	const deps = buildSidecarLoopDeps(
		{ cwd, claudeDir, prdPath, sessionName, logEvent, realSpawnFn },
		options,
	);

	await runSidecarLoop({
		buildOpts: deps.buildOptsFn,
		readActive: deps.readActiveFn,
		clearActive: deps.clearActiveFn,
		sleep: deps.sleepFn,
		hasPendingStories: deps.hasPendingStoriesFn,
		acquireLock: deps.acquireLockFn,
		runSupervisorFn: options.runSupervisorFn,
		hasSessionFn: deps.hasSessionFn,
		logEvent,
		runMergeWatchFn: deps.runMergeWatchFn,
		flipActiveFn: deps.flipActiveFn,
		autoShipFn: deps.autoShipFn,
		escalateFn: deps.escalateFn,
		runMetaLoopObserveFn: deps.runMetaLoopObserveFn,
	});
}
