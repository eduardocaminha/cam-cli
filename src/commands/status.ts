// src/commands/status.ts
//
// Implementation of `cam status` — reads the local loop state and prints a
// one-glance summary of the current run. Reads three sources, all from the
// current cwd's repo:
//
//   1. `.claude/cam-loop.local.md` — the cam-loop plugin's state file.
//      YAML frontmatter (`active`, `iteration`, `max_iterations`, `started_at`,
//      `completion_promise`) followed by the loop's prompt body.
//      When this file is absent, no loop is active → status: idle.
//   2. `prd.json` (in the cwd) — the harness PRD. We pull the current story —
//      defined as the highest-priority `passes:false` story — and surface its
//      id + title so the operator knows what's being worked on.
//   3. The last commit on the current branch (cwd's git repo) — surfaces what
//      was last committed, so a stalled loop is visually distinguishable from
//      a productive one. Best-effort: if the cwd is not a git repo, we skip
//      the commit line rather than failing.
//
// Acceptance criteria (US-008):
//   1. Reads .claude/cam-loop.local.md + prd.json + last commit; prints:
//      current story id+title, iteration N/M, wall-clock since start, sleep
//      state (active / sleeping / no-loop).
//   2. Exits 0 with sensible output even when no loop is active (`status: idle`).
//   3. Bun unit tests using a tmpdir as `$HOME` substitute — we use `cwd`
//      injection (mirrors `runNext`) since the state files live under cwd,
//      not `$HOME`.
//   4. `bunx tsc --noEmit` passes.
//
// Sleep-state semantics: the plugin doesn't write a "sleeping" marker per se,
// but a rate-limit pause manifests as the loop being armed (state file
// present, active:true) but no recent commits or stdout. We surface a `state`
// value of `active` (state file present + active:true), `paused` (state file
// present + active:false — the plugin sets this on completion or cancel),
// `idle` (no state file at all). A future story can promote `active-but-stalled`
// to a third bucket if we add a heartbeat field.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { load as yamlLoad } from 'js-yaml';

import { glyphs } from '../design/tokens.ts';
import { accent, chalk, destructive, muted, warning } from '../logging/color.ts';
import {
	emitEntry,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
	emitWarn,
} from '../logging/screen.ts';
import { isPauseSet } from '../supervisor/pause-marker.ts';
import {
	orchestratorTranscriptPath,
	parseTranscriptUsage,
	renderTokensLine,
	type TranscriptUsage,
} from '../transcript/usage.ts';
import {
	MERGE_WATCH_FILENAME,
	SHIP_STALLED_FILENAME,
	readMergeWatchState,
	readShipStalledMarker,
	type ShipStalledMarker,
} from '../release/merge-watch.ts';
import { GATE_FILENAME, readGateFileLenient, type CamGate } from '../supervisor/gate.ts';
import {
	PLAN_ESCALATED_FILENAME,
	readPlanEscalatedMarker,
	type PlanEscalatedMarker,
} from '../supervisor/plan-escalation.ts';
import {
	PLAN_PREFLIGHT_FAILED_FILENAME,
	readPlanPreflightFailedMarker,
	type PlanPreflightFailedMarker,
} from '../supervisor/plan-preflight-marker.ts';
import {
	IMPLEMENT_BLOCKED_FILENAME,
	readImplementBlockedMarker,
	type ImplementBlockedMarker,
} from '../supervisor/implement-blocked-marker.ts';
import {
	POST_MERGE_STALLED_FILENAME,
	readPostMergeStalledMarker,
	type PostMergeStalledMarker,
} from '../supervisor/post-merge-stalled-marker.ts';
import {
	SIDECAR_STALLED_FILENAME,
	readSidecarStalledMarker,
	type SidecarStalledMarker,
} from '../supervisor/sidecar-stalled.ts';
import type { ContainerPreflightEventDetail } from '../supervisor/events.ts';
import { diagnoseWhyNotMoving, type WhyNotMovingDiagnostic, type WhyNotMovingSignals } from './status-diagnostics.ts';

// --- Constants -------------------------------------------------------------

const STATE_FILE_PATH = '.claude/cam-loop.local.md';
/** Legacy PRD location (repo root). Kept only as a fallback for old layouts. */
const PRD_PATH = 'prd.json';
/** Canonical PRD location: the cam harness dir. Written by the planner and read
 *  by the supervisor (cam next) + cam-review/ship. */
const PRD_PATH_CANONICAL = 'scripts/cam/prd.json';

/**
 * Resolve the PRD path for `cwd`, preferring the canonical harness location
 * (`scripts/cam/prd.json`) and falling back to the legacy repo-root `prd.json`
 * only when the canonical file is absent. This is what makes `cam status` /
 * `cam dashboard` / `cam resume` read the SAME PRD the loop does, instead of a
 * non-existent root file (CAM-18).
 */
export function resolvePrdPath(cwd: string): string {
	const canonical = join(cwd, PRD_PATH_CANONICAL);
	if (existsSync(canonical)) return canonical;
	return join(cwd, PRD_PATH);
}

// --- Types -----------------------------------------------------------------

/**
 * The loop lifecycle phases. This is the single source of truth for what the
 * cam loop is doing. `active` DERIVES from `phase === 'implementing'`.
 *
 * Named `LoopPhase` to avoid collision with the orchestrator/planner/auditor/...
 * `Phase` type in `src/config/models.ts`.
 */
export type LoopPhase = 'idle' | 'planning' | 'implementing' | 'awaiting-operator' | 'shipping';

/** All valid LoopPhase values (used for validation during parse). */
const LOOP_PHASES: readonly LoopPhase[] = [
	'idle',
	'planning',
	'implementing',
	'awaiting-operator',
	'shipping',
];

/**
 * Parsed shape of the YAML frontmatter in `.claude/cam-loop.local.md`. The
 * plugin defines all keys; we treat each as optional so a partially-written
 * state file (e.g. one whose loop crashed mid-flush) still parses cleanly and
 * the operator gets a useful status report instead of a parse error.
 */
export interface LoopState {
	/**
	 * Derived from `phase === 'implementing'`. When `phase` is present this
	 * field is ALWAYS the derived value; the raw `active:` frontmatter field
	 * is ignored. When `phase` is absent (legacy state files), `active` comes
	 * from the raw `active: true|false` value for backward compat.
	 */
	active?: boolean;
	/**
	 * The current loop lifecycle phase. Single source of truth from which
	 * `active` is derived. Absent in state files written before US-001 of
	 * CAM-151 (backward-compat: those files use the raw `active` field).
	 */
	phase?: LoopPhase;
	/**
	 * Optional issue ref associated with the in-progress plan (e.g. "CAM-151").
	 * Absent when not in a planning phase.
	 */
	plan_issue?: string;
	iteration?: number;
	max_iterations?: number;
	completion_promise?: string | null;
	started_at?: string;
	/**
	 * PID of the long-running driver process that owns the loop. Written by
	 * `cam next` (US-007 + US-010); consumed by `cam resume` to detect
	 * orphaned state files (PID present but no live process). Optional for
	 * back-compat with state files written before the field existed.
	 */
	pid?: number;
	/**
	 * Advisory story id the supervisor dispatched this iteration (US-001 live
	 * progress tracking). Written on every iteration rewrite; absent in state
	 * files written before the field existed.
	 */
	current_story?: string | null;
	/**
	 * Count of non-operator stories with passes:true at the time of the last
	 * state-file rewrite (US-001). Optional for back-compat.
	 */
	stories_done?: number;
	/**
	 * Total count of non-operator stories (US-001). Optional for back-compat.
	 */
	stories_total?: number;
	/**
	 * ISO timestamp of the last supervisor iteration tick (US-001). Written
	 * on every state-file rewrite so the dashboard can detect a stalled loop.
	 */
	last_activity?: string;
}

/**
 * Subset of `prd.json` we care about. The schema is large; status only needs
 * the ordered story queue to identify the current story.
 */
export interface PrdStory {
	id: string;
	title: string;
	priority?: number;
	passes?: boolean;
	/** Acceptance criteria bullets from prd.json (US-001). */
	acceptanceCriteria?: string[];
	/** Implementation notes string from prd.json (US-001). */
	notes?: string;
	/** Operator-gate tag, e.g. "operator" (US-001). Null means no gate. */
	requires?: string | null;
}

export interface PrdShape {
	userStories?: PrdStory[];
	branchName?: string;
	/** Top-level review block written by /cam-review (US-001). */
	review?: {
		lastVerdict?: string;
	};
}

/**
 * `operator-paused` is a distinct state from the phase-derived `paused`
 * (which reflects `active:false` in the loop's own state file, set by the
 * plugin on completion/cancel). `operator-paused` reflects the dedicated
 * pause-marker file (`.cam-pause`, `src/supervisor/pause-marker.ts`, US-001)
 * written by `cam pause` — an intentional operator brake — and takes
 * precedence over the phase-derived label so the two are never conflated.
 */
export type StatusState = 'idle' | 'active' | 'paused' | 'operator-paused';

export interface StatusReport {
	state: StatusState;
	currentStory?: { id: string; title: string };
	iteration?: { current: number; max: number };
	wallClock?: string; // human-readable elapsed since started_at
	startedAt?: string; // ISO from state file
	completionPromise?: string | null;
	branchName?: string; // from cwd's git repo
	lastCommit?: { sha: string; subject: string };
	/** Token usage totals from the orchestrator transcript. Undefined when no
	 *  orchestrator session marker or no transcript file is present. */
	tokens?: { input: number; output: number; cacheRead: number; cacheCreation: number };
	/**
	 * Count of non-operator stories with passes:true at the time of the last
	 * state-file rewrite (US-002). Undefined when the state file is absent or
	 * the field was not written (old state files).
	 */
	storiesDone?: number;
	/**
	 * Total count of non-operator stories (US-002). Undefined when the state
	 * file is absent or the field was not written.
	 */
	storiesTotal?: number;
	/**
	 * ISO timestamp of the last supervisor iteration tick (US-002). Used by
	 * `runStatus` to show time-since-last-real-work in the `since` row instead
	 * of time-since-loop-start, so a stalled loop is visually distinct from an
	 * active one.
	 */
	lastActivity?: string;
	/**
	 * Durable ship-stalled marker (US-002, CAM-401). Projected verbatim from
	 * `.claude/.cam-ship-stalled.json` via `readShipStalledMarker`. Absent when
	 * the marker file is absent or malformed.
	 */
	shipStalled?: ShipStalledMarker;
	/**
	 * Durable plan-escalation marker (US-002, CAM-401), from
	 * `.claude/.cam-plan-escalated.json` via `readPlanEscalatedMarker`.
	 */
	planEscalated?: PlanEscalatedMarker;
	/**
	 * Durable plan-preflight-failed marker (US-002, CAM-401), from
	 * `.claude/.cam-plan-preflight-failed.json` via
	 * `readPlanPreflightFailedMarker`.
	 */
	planPreflightFailed?: PlanPreflightFailedMarker;
	/**
	 * Durable implement-blocked marker (US-002, CAM-401), from
	 * `.claude/.cam-implement-blocked.json` via `readImplementBlockedMarker`.
	 */
	implementBlocked?: ImplementBlockedMarker;
	/**
	 * Durable post-merge-stalled marker (US-002, CAM-401), from
	 * `.claude/.cam-post-merge-stalled.json` via `readPostMergeStalledMarker`.
	 */
	postMergeStalled?: PostMergeStalledMarker;
	/**
	 * Durable operator-decision gate (US-002, CAM-401), from
	 * `.claude/.cam-gate.json` via `readGateFileLenient` (the lenient reader --
	 * a malformed gate file degrades to this field being absent, never throws
	 * out of `buildStatusReport`).
	 */
	gate?: CamGate;
	/**
	 * Durable merge-watch position (US-002, CAM-401): `prNumber` + `pollCount`
	 * (defaults to 0 when absent on disk) + `lastPolledAt` (absent when the
	 * watch has never polled yet), from `.claude/.cam-merge-watch.json` via
	 * `readMergeWatchState`.
	 */
	mergeWatch?: { prNumber: number; pollCount: number; lastPolledAt?: number };
	/**
	 * Durable sidecar-stalled marker (US-002, CAM-401), from
	 * `.claude/.cam-sidecar-stalled.json` via `readSidecarStalledMarker`.
	 */
	sidecarStalled?: SidecarStalledMarker;
	/**
	 * The LAST `container-preflight` event recorded in
	 * `.claude/cam-worker-events.jsonl` (US-002, CAM-401). `buildStatusReport`
	 * never re-runs preflight itself -- container preflight has no on-disk
	 * status file, so this is the only way to surface its last result. `ts` is
	 * the event's own timestamp, so a stale container-preflight result is
	 * distinguishable from a fresh one.
	 */
	containerPreflight?: ContainerPreflightEventDetail & { ts: string };
	/**
	 * Closed, ordered, deterministic why-not-moving diagnostic (US-003,
	 * CAM-401), derived by `diagnoseWhyNotMoving` (src/commands/status-diagnostics.ts)
	 * from the rest of this projected model plus the orch-pane-busy /
	 * push-undelivered event-log signals. Always present -- the diagnostic is
	 * total over its closed rule-set and returns a fixed 'none' result rather
	 * than an absent/ambiguous value when nothing is blocking. Optional only at
	 * the type level (for construction ergonomics); `buildStatusReport` always
	 * sets it before returning.
	 */
	diagnostic?: WhyNotMovingDiagnostic;
}

// --- Parsers ---------------------------------------------------------------

/**
 * Parse the loop's state-file body. The file is YAML frontmatter delimited by
 * `---` lines, followed by a prompt body. We only need the frontmatter; the
 * body is operator-readable but not machine-relevant for status.
 *
 * Returns `null` on malformed input — the caller treats that as `idle` since
 * a corrupt state file is functionally indistinguishable from a missing one
 * for status-reporting purposes (the operator should `cam stop` and start
 * fresh either way).
 */
export function parseStateFile(contents: string): LoopState | null {
	const trimmed = contents.trimStart();
	if (!trimmed.startsWith('---')) return null;
	// Find the closing `---` on its own line. We split on `\n` and walk —
	// safer than a multiline regex for paths with stray `---` inside the body.
	const lines = trimmed.split('\n');
	if (lines[0]?.trim() !== '---') return null;
	let endIdx = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i]?.trim() === '---') {
			endIdx = i;
			break;
		}
	}
	if (endIdx < 0) return null;
	const fmText = lines.slice(1, endIdx).join('\n');
	let parsed: unknown;
	try {
		parsed = yamlLoad(fmText);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object') return null;
	const obj = parsed as Record<string, unknown>;
	const out: LoopState = {};

	// --- Phase (new field, US-001 CAM-151) ------------------------------------
	// When `phase` is present and valid, `active` is DERIVED from it.
	// When absent (legacy files), fall back to the raw `active: true|false` field.
	const rawPhase = obj['phase'];
	if (typeof rawPhase === 'string' && (LOOP_PHASES as readonly string[]).includes(rawPhase)) {
		out.phase = rawPhase as LoopPhase;
		// active MUST derive from phase; ignore the raw `active:` field.
		out.active = out.phase === 'implementing';
	} else {
		// Legacy back-compat: no `phase` field -- read raw `active`.
		if (typeof obj['active'] === 'boolean') out.active = obj['active'];
	}

	// --- plan_issue (new optional field, US-001 CAM-151) ----------------------
	if (typeof obj['plan_issue'] === 'string' && obj['plan_issue'].length > 0) {
		out.plan_issue = obj['plan_issue'];
	}

	if (typeof obj['iteration'] === 'number') out.iteration = obj['iteration'];
	if (typeof obj['max_iterations'] === 'number') out.max_iterations = obj['max_iterations'];
	if (obj['completion_promise'] === null) {
		out.completion_promise = null;
	} else if (typeof obj['completion_promise'] === 'string') {
		out.completion_promise = obj['completion_promise'];
	}
	if (typeof obj['started_at'] === 'string') out.started_at = obj['started_at'];
	if (typeof obj['pid'] === 'number' && Number.isFinite(obj['pid']) && obj['pid'] > 0) {
		out.pid = obj['pid'];
	}
	// US-001 live-progress fields — all optional for back-compat.
	if (obj['current_story'] === null) {
		out.current_story = null;
	} else if (typeof obj['current_story'] === 'string') {
		out.current_story = obj['current_story'];
	}
	if (typeof obj['stories_done'] === 'number' && Number.isFinite(obj['stories_done'])) {
		out.stories_done = obj['stories_done'];
	}
	if (typeof obj['stories_total'] === 'number' && Number.isFinite(obj['stories_total'])) {
		out.stories_total = obj['stories_total'];
	}
	if (typeof obj['last_activity'] === 'string' && obj['last_activity'].length > 0) {
		out.last_activity = obj['last_activity'];
	}
	return out;
}

/**
 * Pick the "current story" from a PRD's stories list. Definition: the
 * highest-priority entry where `passes:false`. Mirrors the implementer's
 * selection logic so `cam status` and `/cam-next` agree on what's
 * being worked on. Returns `null` when the PRD has no pending stories.
 */
export function pickCurrentStory(prd: PrdShape): PrdStory | null {
	const stories = prd.userStories ?? [];
	const pending = stories.filter((s) => s.passes === false);
	if (pending.length === 0) return null;
	pending.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
	return pending[0] ?? null;
}

/**
 * Format a duration in milliseconds as a compact human-readable string.
 * Examples: `42s`, `7m 12s`, `2h 03m`, `1d 04h`. Returns `unknown` on negative
 * or NaN input. We deliberately avoid sub-second precision — wall-clock since
 * loop start is informational, not a stopwatch.
 */
export function formatWallClock(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return 'unknown';
	const totalSec = Math.floor(ms / 1000);
	const days = Math.floor(totalSec / 86400);
	const hours = Math.floor((totalSec % 86400) / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (days > 0) {
		return `${days}d ${String(hours).padStart(2, '0')}h`;
	}
	if (hours > 0) {
		return `${hours}h ${String(minutes).padStart(2, '0')}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
	}
	return `${seconds}s`;
}

// --- Filesystem + git helpers ----------------------------------------------

/**
 * Read + parse the loop's state file under `cwd`. Returns `null` when the
 * file is missing or unreadable; callers treat that as the `idle` state.
 */
function readStateFile(cwd: string): LoopState | null {
	const path = join(cwd, STATE_FILE_PATH);
	if (!existsSync(path)) return null;
	let body: string;
	try {
		body = readFileSync(path, 'utf8');
	} catch {
		return null;
	}
	return parseStateFile(body);
}

/**
 * Read + parse `prd.json` under `cwd`. Returns `null` when missing or invalid.
 * A bad PRD is non-fatal for `cam status` — we still print the loop's
 * iteration counter, just without a story id.
 */
export function readPrd(cwd: string): PrdShape | null {
	const path = resolvePrdPath(cwd);
	if (!existsSync(path)) return null;
	try {
		const body = readFileSync(path, 'utf8');
		const parsed = JSON.parse(body) as unknown;
		if (parsed === null || typeof parsed !== 'object') return null;
		return parsed as PrdShape;
	} catch {
		return null;
	}
}

/**
 * Best-effort branch + last-commit lookup. Skips silently when cwd is not a
 * git repo. Returns separate `branchName` + `lastCommit` slots so the caller
 * can surface partial info.
 */
function readGitInfo(cwd: string): { branchName?: string; lastCommit?: { sha: string; subject: string } } {
	const branch = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
	if (branch.status !== 0) return {};
	const branchName = branch.stdout.trim() || undefined;

	const log = spawnSync('git', ['-C', cwd, 'log', '-1', '--pretty=format:%h %s'], { encoding: 'utf8' });
	const out: { branchName?: string; lastCommit?: { sha: string; subject: string } } = {};
	if (branchName) out.branchName = branchName;
	if (log.status === 0) {
		const line = log.stdout.trim();
		const space = line.indexOf(' ');
		if (space > 0) {
			out.lastCommit = { sha: line.slice(0, space), subject: line.slice(space + 1) };
		}
	}
	return out;
}

/**
 * Generic last-matching-line scanner over `.claude/cam-worker-events.jsonl`
 * (US-002/US-003, CAM-401): reads the whole log, parses each line
 * independently inside its own try/catch so one malformed line never stops
 * the scan, and keeps overwriting with the LAST line whose `kind` matches
 * `kind` and whose parsed object passes `guard` (returns non-`undefined`).
 * Shared by the container-preflight, orch-pane-busy, and push-undelivered
 * projections below -- each differs only in `kind` and its own shape-guard.
 * Never throws; returns `undefined` when the log is absent/unreadable or no
 * line matches.
 */
function scanLastEventOfKind<T>(
	cwd: string,
	kind: string,
	guard: (obj: Record<string, unknown>) => T | undefined,
): T | undefined {
	const path = join(cwd, '.claude', 'cam-worker-events.jsonl');
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}

	let last: T | undefined;
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed === null || typeof parsed !== 'object') continue;
			const obj = parsed as Record<string, unknown>;
			if (obj['kind'] !== kind) continue;
			const result = guard(obj);
			if (result !== undefined) last = result;
		} catch {
			// Malformed line; skip and keep scanning for a later valid one.
		}
	}
	return last;
}

/**
 * Read the LAST `container-preflight` event from `.claude/cam-worker-events.jsonl`
 * (US-002, CAM-401). Container preflight has no on-disk status file (unlike
 * the marker family above), so the event log is the only durable record of
 * its last result; this never re-runs preflight itself.
 *
 * Returns `undefined` when the event log is absent/unreadable, contains no
 * `container-preflight` line, or every `container-preflight` line is
 * malformed.
 */
function readLastContainerPreflightEvent(
	cwd: string,
): (ContainerPreflightEventDetail & { ts: string }) | undefined {
	return scanLastEventOfKind(cwd, 'container-preflight', (obj) => {
		if (typeof obj['ts'] !== 'string') return undefined;
		const detail = obj['detail'];
		if (detail === null || typeof detail !== 'object') return undefined;
		const detailObj = detail as Record<string, unknown>;
		if (typeof detailObj['ready'] !== 'boolean') return undefined;
		const reason = detailObj['reason'];
		const entry: ContainerPreflightEventDetail & { ts: string } = { ready: detailObj['ready'], ts: obj['ts'] };
		if (typeof reason === 'string') entry.reason = reason;
		return entry;
	});
}

/**
 * Read the why-not-moving diagnostic's US-001 event-log signals (US-003,
 * CAM-401): whether an `orch-pane-busy` event is present, and the `reason` of
 * the LAST `push-undelivered` event. These two event kinds are not part of
 * the marker-file family above (no on-disk status file), so they are read
 * straight from the event log via `scanLastEventOfKind`, mirroring
 * `readLastContainerPreflightEvent`. Never throws.
 */
function readWhyNotMovingSignals(cwd: string): WhyNotMovingSignals {
	const orchPaneBusy =
		scanLastEventOfKind(cwd, 'orch-pane-busy', (obj) => {
			const detail = obj['detail'];
			if (detail === null || typeof detail !== 'object') return undefined;
			return typeof (detail as Record<string, unknown>)['paneId'] === 'string' ? true : undefined;
		}) === true;

	const pushUndeliveredReason = scanLastEventOfKind(cwd, 'push-undelivered', (obj) => {
		const detail = obj['detail'];
		if (detail === null || typeof detail !== 'object') return undefined;
		const reason = (detail as Record<string, unknown>)['reason'];
		return reason === 'retries-exhausted' || reason === 'pane-not-idle' ? reason : undefined;
	});

	const signals: WhyNotMovingSignals = { orchPaneBusy };
	if (pushUndeliveredReason !== undefined) signals.pushUndeliveredReason = pushUndeliveredReason;
	return signals;
}

/**
 * Fields of `StatusReport` populated by `projectCycleState` (US-002,
 * CAM-401): the six blocker/wedge/stall markers, the durable merge-watch
 * position, the sidecar-stalled marker, and the last container-preflight
 * event. Extracted from `buildStatusReport` into its own function (rather
 * than inlined) purely to keep `buildStatusReport` under the project's
 * per-function line budget; the two are always called together.
 */
type CycleStateProjection = Pick<
	StatusReport,
	| 'shipStalled'
	| 'planEscalated'
	| 'planPreflightFailed'
	| 'implementBlocked'
	| 'postMergeStalled'
	| 'gate'
	| 'mergeWatch'
	| 'sidecarStalled'
	| 'containerPreflight'
>;

/**
 * Project the full cycle state-machine position (US-002, CAM-401):
 * read-only, via each marker's existing lenient never-throw reader, all
 * under `<cwd>/.claude/` (the event log is the one exception -- it has no
 * on-disk status file of its own, so its LAST `container-preflight` line is
 * read instead of re-running preflight).
 */
function projectCycleState(cwd: string): CycleStateProjection {
	const claudeDirLocal = join(cwd, '.claude');
	const out: CycleStateProjection = {};

	const shipStalled = readShipStalledMarker(join(claudeDirLocal, SHIP_STALLED_FILENAME));
	if (shipStalled) out.shipStalled = shipStalled;
	const planEscalated = readPlanEscalatedMarker(join(claudeDirLocal, PLAN_ESCALATED_FILENAME));
	if (planEscalated) out.planEscalated = planEscalated;
	const planPreflightFailed = readPlanPreflightFailedMarker(
		join(claudeDirLocal, PLAN_PREFLIGHT_FAILED_FILENAME),
	);
	if (planPreflightFailed) out.planPreflightFailed = planPreflightFailed;
	const implementBlocked = readImplementBlockedMarker(join(claudeDirLocal, IMPLEMENT_BLOCKED_FILENAME));
	if (implementBlocked) out.implementBlocked = implementBlocked;
	const postMergeStalled = readPostMergeStalledMarker(join(claudeDirLocal, POST_MERGE_STALLED_FILENAME));
	if (postMergeStalled) out.postMergeStalled = postMergeStalled;
	const gate = readGateFileLenient(join(claudeDirLocal, GATE_FILENAME));
	if (gate) out.gate = gate;

	const mergeWatchState = readMergeWatchState(join(claudeDirLocal, MERGE_WATCH_FILENAME));
	if (mergeWatchState) {
		out.mergeWatch = { prNumber: mergeWatchState.prNumber, pollCount: mergeWatchState.pollCount ?? 0 };
		if (mergeWatchState.lastPolledAt !== undefined) {
			out.mergeWatch.lastPolledAt = mergeWatchState.lastPolledAt;
		}
	}
	const sidecarStalled = readSidecarStalledMarker(join(claudeDirLocal, SIDECAR_STALLED_FILENAME));
	if (sidecarStalled) out.sidecarStalled = sidecarStalled;
	const containerPreflight = readLastContainerPreflightEvent(cwd);
	if (containerPreflight) out.containerPreflight = containerPreflight;

	return out;
}

// --- Public entrypoint -----------------------------------------------------

export interface StatusOptions {
	/** Override cwd; default `process.cwd()`. */
	cwd?: string;
	/** Override "now" for wall-clock calculations (tests pin a deterministic time). */
	now?: () => Date;
	/** Override the Claude config directory (default: CLAUDE_CONFIG_DIR env var or
	 *  ~/.claude). Used to locate the orchestrator transcript JSONL only — the
	 *  operator pause marker is always read from the project-local `<cwd>/.claude`
	 *  dir instead (see US-R1-001), never from this option. */
	claudeDir?: string;
}

/**
 * Build a `StatusReport` without doing any I/O for printing. Exposed for tests
 * + future programmatic consumers (e.g. the dashboard might subscribe to a
 * status snapshot in a later story).
 */
export function buildStatusReport(options: StatusOptions = {}): StatusReport {
	const cwd = options.cwd ?? process.cwd();
	const now = options.now ?? (() => new Date());
	const claudeDir = options.claudeDir ?? (process.env['CLAUDE_CONFIG_DIR'] ?? join(os.homedir(), '.claude'));
	const state = readStateFile(cwd);
	const prd = readPrd(cwd);
	const git = readGitInfo(cwd);
	// US-003 / US-R1-001 (CAM-360 review round 1): the operator pause marker
	// takes precedence over the phase-derived state (idle/active/paused) so
	// an intentional brake always renders distinctly, regardless of what the
	// loop's own state file says. The marker itself lives under the
	// PROJECT-LOCAL `<cwd>/.claude` dir (matching pause.ts, host.ts, stop.ts
	// — never the `claudeDir` above, which resolves to the global Claude
	// config dir used only for transcript lookup and can diverge from cwd
	// in production).
	const operatorPaused = isPauseSet(join(cwd, '.claude'));

	const report: StatusReport = { state: 'idle' };
	if (git.branchName) report.branchName = git.branchName;
	if (git.lastCommit) report.lastCommit = git.lastCommit;

	// US-002 (CAM-401): project the six blocker/wedge/stall markers, the
	// durable merge-watch position, the sidecar-stalled marker, and the last
	// container-preflight event. Extracted into `projectCycleState` to keep
	// this function under the project's per-function line budget.
	Object.assign(report, projectCycleState(cwd));

	// Resolve token usage from the orchestrator transcript (best-effort, never throws).
	const transcriptPath = orchestratorTranscriptPath(cwd, claudeDir);
	if (transcriptPath !== null) {
		try {
			const jsonl = readFileSync(transcriptPath, 'utf8');
			const usage: TranscriptUsage = parseTranscriptUsage(jsonl);
			report.tokens = {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheCreation: usage.cacheCreation,
			};
		} catch {
			// Transcript not yet written or unreadable; leave tokens undefined.
		}
	}

	if (!state) {
		// No loop state file. PRD might still exist — surface the "next pending"
		// story so the operator sees what would run next.
		if (prd) {
			const story = pickCurrentStory(prd);
			if (story) report.currentStory = { id: story.id, title: story.title };
		}
		if (operatorPaused) report.state = 'operator-paused';
		// US-003 (CAM-401): attach the closed why-not-moving diagnostic last, once
		// `report.state` (incl. the operator-paused override) is final.
		report.diagnostic = diagnoseWhyNotMoving(report, readWhyNotMovingSignals(cwd));
		return report;
	}

	report.state = state.active === false ? 'paused' : 'active';
	if (operatorPaused) report.state = 'operator-paused';
	if (typeof state.iteration === 'number' && typeof state.max_iterations === 'number') {
		report.iteration = { current: state.iteration, max: state.max_iterations };
	}
	if (state.started_at) {
		report.startedAt = state.started_at;
		const startMs = Date.parse(state.started_at);
		if (Number.isFinite(startMs)) {
			report.wallClock = formatWallClock(now().getTime() - startMs);
		}
	}
	if (state.completion_promise !== undefined) {
		report.completionPromise = state.completion_promise;
	}
	// US-002: live-progress fields from the state file.
	if (typeof state.stories_done === 'number' && Number.isFinite(state.stories_done)) {
		report.storiesDone = state.stories_done;
	}
	if (typeof state.stories_total === 'number' && Number.isFinite(state.stories_total)) {
		report.storiesTotal = state.stories_total;
	}
	if (typeof state.last_activity === 'string' && state.last_activity.length > 0) {
		report.lastActivity = state.last_activity;
	}

	if (prd) {
		const story = pickCurrentStory(prd);
		if (story) report.currentStory = { id: story.id, title: story.title };
	}
	// US-003 (CAM-401): attach the closed why-not-moving diagnostic last, once
	// `report.state` (incl. the operator-paused override) is final.
	report.diagnostic = diagnoseWhyNotMoving(report, readWhyNotMovingSignals(cwd));
	return report;
}

/**
 * Pretty-print a `StatusReport` to stdout. Always exits 0 — `cam status` is
 * a read-only inspection, never a failure. Idle output is intentionally
 * sparse: a one-line `status: idle` plus (if present) the next-pending story
 * + branch info, so the operator can confirm the right cwd.
 */
/** Column width for entry keys (e.g. `state    `, `story    `). */
const KEY_COL_WIDTH = 9;

/** Indent used inside Sections — matches `screen.ts` and the Ink Section. */
const CONTENT_INDENT = '    ';

/**
 * Render a state indicator (glyph + label) from the shared design tokens, so
 * the print path speaks the same vocabulary as the Ink Dashboard:
 *   idle             → muted ◌ idle               (glyphs.pending)
 *   active           → accent ● active             (glyphs.active)
 *   paused           → warning ! paused             (glyphs.warning)
 *   operator-paused  → destructive ! operator-paused (glyphs.warning, US-003)
 *
 * `operator-paused` reuses the warning glyph but pairs it with the
 * destructive color and a distinct label, so it never reads as the plain
 * phase-derived `paused` state at a glance.
 */
function renderStateIndicator(state: StatusState): string {
	if (state === 'idle') return `${muted(glyphs.pending)} ${muted('idle')}`;
	if (state === 'operator-paused') return `${destructive(glyphs.warning)} operator-paused`;
	if (state === 'paused') return `${warning(glyphs.warning)} paused`;
	return `${accent(glyphs.active)} active`;
}

/** One key/value row inside the Loop section (bold key column + value). */
function renderEntry(key: string, value: string): string {
	return `${CONTENT_INDENT}${chalk.bold(key.padEnd(KEY_COL_WIDTH))}${value}`;
}

export function runStatus(options: StatusOptions = {}): number {
	const now = options.now ?? (() => new Date());
	const report = buildStatusReport(options);

	emitTitle('cam status');
	emitSectionHeading('Loop');

	// State indicator is always shown; the rest of the rows depend on which
	// data is available (idle skips iter/since/promise; paused keeps them).
	process.stdout.write(`${renderEntry('state', renderStateIndicator(report.state))}\n`);

	if (report.state === 'idle') {
		if (report.currentStory) {
			process.stdout.write(
				`${renderEntry('next', `${accent(report.currentStory.id)} ${report.currentStory.title}`)}\n`,
			);
		}
		if (report.branchName) {
			process.stdout.write(`${renderEntry('branch', report.branchName)}\n`);
		}
		if (report.lastCommit) {
			process.stdout.write(
				`${renderEntry('last', `${muted(report.lastCommit.sha)} ${report.lastCommit.subject}`)}\n`,
			);
		}
		if (report.tokens !== undefined) {
			process.stdout.write(`${renderEntry('tokens', renderTokensLine(report.tokens))}\n`);
		}
		emitSectionHeading('Next');
		emitEntry('cam next', 'start the autonomous loop');
		emitEntry('cam plan', 'plan an issue and create a PRD');
		emitTrailingBlank();
		return 0;
	}

	if (report.currentStory) {
		process.stdout.write(
			`${renderEntry('story', `${accent(report.currentStory.id)} ${report.currentStory.title}`)}\n`,
		);
	} else {
		process.stdout.write(`${renderEntry('story', muted('(no pending story in prd.json)'))}\n`);
	}
	// US-002: replace meaningless stop-hook `iter N/max` with real per-story
	// progress `stories done/total` sourced from the live state file.
	if (report.storiesDone !== undefined && report.storiesTotal !== undefined) {
		process.stdout.write(
			`${renderEntry('stories', `${report.storiesDone} / ${report.storiesTotal}`)}\n`,
		);
	}
	// US-002: `since` uses last_activity (real last-work heartbeat) when
	// present, falling back to the loop start time. This makes a stalled loop
	// visually distinct from an active one.
	const sinceTimestamp = report.lastActivity ?? report.startedAt;
	if (sinceTimestamp) {
		const sinceMs = Date.parse(sinceTimestamp);
		const sinceVal = Number.isFinite(sinceMs)
			? formatWallClock(now().getTime() - sinceMs)
			: report.wallClock ?? '';
		const annotation = muted(`(${sinceTimestamp})`);
		if (sinceVal) {
			process.stdout.write(`${renderEntry('since', `${sinceVal} ${annotation}`)}\n`);
		}
	}
	if (report.branchName) {
		process.stdout.write(`${renderEntry('branch', report.branchName)}\n`);
	}
	if (report.lastCommit) {
		process.stdout.write(
			`${renderEntry('last', `${muted(report.lastCommit.sha)} ${report.lastCommit.subject}`)}\n`,
		);
	}
	if (report.tokens !== undefined) {
		process.stdout.write(`${renderEntry('tokens', renderTokensLine(report.tokens))}\n`);
	}
	if (report.completionPromise !== undefined) {
		const promiseShown = report.completionPromise === null ? muted('(none)') : `"${report.completionPromise}"`;
		process.stdout.write(`${renderEntry('promise', promiseShown)}\n`);
	}

	if (report.state === 'operator-paused') {
		emitWarn('Loop is operator-paused', '(.cam-pause marker present)');
		emitSectionHeading('Next');
		emitEntry('cam resume', 'clear the pause marker and continue');
	} else if (report.state === 'paused') {
		emitWarn('Loop is paused', '(active:false in state file)');
		emitSectionHeading('Next');
		emitEntry('cam stop', 'clear the state file');
		emitEntry('cam next', 'restart the loop');
	}
	emitTrailingBlank();
	return 0;
}
