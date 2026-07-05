// src/supervisor/ship-runner.ts
//
// Deterministic pre-PR ship sequence (runShipPhase), US-002 CAM-149.
//
// Replaces the LLM-interpreted markdown steps 1-6 of templates/commands/cam-ship.md
// with a pure, dep-injected TS state machine, so no session has to read and
// judge the sequence itself (the same logic-in-markdown scar as CAM-49/72/86/104).
//
// Step order is fixed and fails fast:
//   1. Branch guard: refuse when the current branch is main.
//   2. PRD-complete check: every story with requires != 'operator' has passes true.
//   3. Commits-ahead-of-main check: `git log main..HEAD` is non-empty.
//   4. Quality gates via the injected runGatesFn (production default command:
//      `bun run check:all`; no config knob added in this story).
//   5. Version bump via the injected bumpFn (wraps runShipBump, src/release/ship-bump.ts).
//   6. Cycle-close finalize via the injected finalizeFn (wraps finalizeCycleClose,
//      src/commands/ship-finalize.ts).
//   7. `git push origin <branch>`.
//
// A failed step returns its result kind immediately; no later step runs.
//
// The PRD snapshot (project, description, issueNumber, userStories) is read
// once at step 2 and carried inside the ready-for-pr result, because
// finalizeFn removes prd.json from disk -- callers building the PR title/body
// (composePrTitle/composePrBody, src/release/pr-body.ts, US-001) need that
// snapshot after prd.json is already gone.
//
// bumpFn is NOT idempotent (a re-run would double-bump the version), so a
// mid-sequence failure after the bump step is an operator escalation, never
// an auto-resume (docs/recovery-runbook.md).
//
// Mirrors src/supervisor/plan-runner.ts conventions: dep-injected options
// interface, discriminated result union. Unlike the plan runner, this phase
// spawns no worker pane (zero LLM in this phase): no pane mutex, no uuid, no
// respawn-pane.

import type { SpawnFn } from './loop.ts';
import type { WorkerEventLogger } from './events.ts';
import type { PrdSnapshot, PrdSnapshotStory } from '../release/pr-body.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The branch ship never runs from and never pushes to. */
export const MAIN_BRANCH = 'main';

/**
 * Documented production default for runGatesFn's underlying command. Not a
 * config knob (deferred); the production wiring (US-004) is expected to spawn
 * exactly this command and capture its output tail on failure.
 */
export const DEFAULT_GATES_COMMAND = 'bun run check:all';

// ---------------------------------------------------------------------------
// Injected-dependency result shapes
// ---------------------------------------------------------------------------

/** Result of the injected quality-gates step. */
export interface ShipGatesResult {
	ok: boolean;
	/** Tail of the gate command's combined output. Empty string when ok is true. */
	outputTail: string;
}

/** Minimal shape of runShipBump's result (src/release/ship-bump.ts) the runner needs. */
export interface ShipBumpResultLike {
	from: string;
	to: string;
	bumpType: string;
}

/** Minimal shape of finalizeCycleClose's result (src/commands/ship-finalize.ts) the runner needs. */
export interface ShipFinalizeResultLike {
	issueId: string | null;
	issueBackend: string;
}

/**
 * Minimal prd.json shape the ship runner reads. userStories is required (unlike
 * PrdSnapshot.userStories, which is optional) because both the PRD-complete
 * check and the ready-for-pr snapshot need the full list.
 */
export interface ShipPrdRecord {
	project?: string;
	description?: string;
	issueNumber?: number | string;
	userStories: PrdSnapshotStory[];
	notes?: string;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Discriminated result returned by runShipPhase.
 *
 * on-main             - refused: current branch is MAIN_BRANCH.
 * prd-incomplete       - one or more non-operator stories still have passes: false.
 * no-commits-ahead     - `git log main..HEAD` is empty; nothing to ship.
 * gates-failed         - runGatesFn reported ok: false.
 * bump-failed          - bumpFn threw.
 * finalize-failed      - finalizeFn threw.
 * push-failed          - `git push origin <branch>` exited non-zero.
 * ready-for-pr         - every step succeeded; the branch is pushed and ready
 *                        for the PR-create step (US-003) to consume.
 */
export type ShipPhaseResult =
	| { kind: 'on-main' }
	| { kind: 'prd-incomplete'; blockingStoryIds: string[] }
	| { kind: 'no-commits-ahead' }
	| { kind: 'gates-failed'; outputTail: string }
	| { kind: 'bump-failed'; detail: string }
	| { kind: 'finalize-failed'; detail: string }
	| { kind: 'push-failed'; detail: string }
	| {
			kind: 'ready-for-pr';
			branchName: string;
			prdSnapshot: PrdSnapshot;
			bumpResult: ShipBumpResultLike;
			finalizeResult: ShipFinalizeResultLike;
	  };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for runShipPhase. All side effects are injected. */
export interface RunShipPhaseOptions {
	/** Spawn a shell command (loop.ts SpawnFn shape). Used for the three git reads/writes below. */
	spawnFn: SpawnFn;

	/** Read scripts/cam/prd.json, already parsed. Called exactly once, before finalizeFn runs. */
	readPrd: () => ShipPrdRecord;

	/**
	 * Run the aggregate quality-gate command. Production default command is
	 * DEFAULT_GATES_COMMAND; no config knob in this story.
	 */
	runGatesFn: () => ShipGatesResult;

	/** Wraps runShipBump (src/release/ship-bump.ts). May throw on failure. */
	bumpFn: () => ShipBumpResultLike;

	/** Wraps finalizeCycleClose (src/commands/ship-finalize.ts). May throw on failure. */
	finalizeFn: () => ShipFinalizeResultLike;

	/** Returns the current ISO 8601 timestamp. Used to stamp logEvent calls. */
	clock: () => string;

	/**
	 * Optional structured event logger. When provided, the bump step's result
	 * is persisted via the event log (mirrors plan-runner.ts / loop.ts).
	 */
	logEvent?: WorkerEventLogger;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract a human-readable message from a thrown value. */
function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the current branch name via `git branch --show-current`.
 * Throws on a non-zero exit (an unrecoverable environment problem, not a
 * normal ship-blocking condition with its own result kind).
 */
function readCurrentBranch(spawnFn: SpawnFn): string {
	const result = spawnFn('git', ['branch', '--show-current']);
	if ((result.exitCode ?? 1) !== 0) {
		throw new Error(`git branch --show-current failed (exit ${result.exitCode ?? 'null'})`);
	}
	return result.stdout.trim();
}

/**
 * Returns true when `git log main..HEAD` has at least one commit.
 * Throws on a non-zero exit (an unrecoverable environment problem).
 */
function hasCommitsAheadOfMain(spawnFn: SpawnFn): boolean {
	const result = spawnFn('git', ['log', `${MAIN_BRANCH}..HEAD`, '--oneline']);
	if ((result.exitCode ?? 1) !== 0) {
		throw new Error(`git log ${MAIN_BRANCH}..HEAD failed (exit ${result.exitCode ?? 'null'})`);
	}
	return result.stdout.trim() !== '';
}

/** Build the PrdSnapshot carried in the ready-for-pr result, from the raw ShipPrdRecord. */
function toPrdSnapshot(prd: ShipPrdRecord): PrdSnapshot {
	return {
		project: prd.project,
		description: prd.description,
		issueNumber: prd.issueNumber,
		userStories: prd.userStories,
		notes: prd.notes,
	};
}

/** Story ids that still need passes: true (excluding operator-required stories). */
function blockingStoryIds(userStories: PrdSnapshotStory[]): string[] {
	return userStories
		.filter((story) => (story.requires ?? null) !== 'operator' && story.passes !== true)
		.map((story) => story.id);
}

// ---------------------------------------------------------------------------
// runShipPhase
// ---------------------------------------------------------------------------

/**
 * Execute the deterministic pre-PR ship sequence.
 *
 * Pure over its injected deps: every git call, the PRD read, the gate run,
 * the bump, and the finalize are all routed through opts so tests can assert
 * the exact sequence and fail-fast behavior without touching a real repo.
 */
export function runShipPhase(opts: RunShipPhaseOptions): ShipPhaseResult {
	const { spawnFn, readPrd, runGatesFn, bumpFn, finalizeFn, clock, logEvent } = opts;

	// Step 1: branch guard.
	const branchName = readCurrentBranch(spawnFn);
	if (branchName === MAIN_BRANCH) return { kind: 'on-main' };

	// Step 2: PRD-complete check. The same read also captures the snapshot
	// carried in ready-for-pr, BEFORE finalizeFn removes prd.json.
	const prd = readPrd();
	const blocking = blockingStoryIds(prd.userStories);
	if (blocking.length > 0) return { kind: 'prd-incomplete', blockingStoryIds: blocking };
	const prdSnapshot = toPrdSnapshot(prd);

	// Step 3: commits-ahead-of-main check.
	if (!hasCommitsAheadOfMain(spawnFn)) return { kind: 'no-commits-ahead' };

	// Step 4: quality gates.
	const gates = runGatesFn();
	if (!gates.ok) return { kind: 'gates-failed', outputTail: gates.outputTail };

	// Step 5: version bump. Not idempotent; a throw here escalates, never resumes.
	let bumpResult: ShipBumpResultLike;
	try {
		bumpResult = bumpFn();
	} catch (err) {
		return { kind: 'bump-failed', detail: errorMessage(err) };
	}
	logEvent?.({
		ts: clock(),
		storyId: undefined,
		uuid: 'ship',
		kind: 'ship-bump',
		detail: { ...bumpResult },
	});

	// Step 6: cycle-close finalize.
	let finalizeResult: ShipFinalizeResultLike;
	try {
		finalizeResult = finalizeFn();
	} catch (err) {
		return { kind: 'finalize-failed', detail: errorMessage(err) };
	}

	// Step 7: push the branch: exactly `push origin <branchName>`, no other
	// variant, never targeting MAIN_BRANCH (the on-main guard above already
	// refused that case).
	const pushResult = spawnFn('git', ['push', 'origin', branchName]);
	if ((pushResult.exitCode ?? 1) !== 0) {
		const detail = `git push origin ${branchName} failed (exit ${pushResult.exitCode ?? 'null'}): ${
			pushResult.stdout.trim() || '(no output)'
		}`;
		return { kind: 'push-failed', detail };
	}

	return { kind: 'ready-for-pr', branchName, prdSnapshot, bumpResult, finalizeResult };
}
