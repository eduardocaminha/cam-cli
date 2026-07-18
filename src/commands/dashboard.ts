// US-009 layered the runtime loop on top of the US-004 skeleton:
//   - `runDashboard()` reads `prd.json` + `.claude/cam-loop.local.md` from
//     cwd (using the same shapes `cam status` already exports), composes a
//     `DashboardData` snapshot, and renders it inside the alt-screen.
//   - The render loop polls every `pollIntervalMs` (default 2000ms) and
//     redraws on change. Hashing the snapshot avoids burning a redraw on
//     identical data — important because chalk + alt-screen redraws cost
//     more than the comparison.
//   - Alt-screen lifecycle is wrapped in try/finally so a panic during render
//     does NOT strand the operator's terminal in the alternate buffer (the
//     story note flagged this as load-bearing).
//   - The last 5 worker 'result' events from the structured event log are
//     surfaced in a "recent" panel. Each entry is truncated to a single line
//     so the panel stays width-stable across resizes.
//   - SIGWINCH triggers a re-render; the next render reuses `isFirstRender:
//     true` so the new viewport size is fully repainted.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { chalk, color, muted, visibleLength, warning } from "../logging/color.ts";
import { renderHeader, separator } from "../logging/theme.ts";
import {
	formatWallClock,
	parseStateFile,
	pickCurrentStory,
	resolvePrdPath,
	type LoopState,
	type PrdShape,
	type PrdStory,
} from "./status.ts";
import {
	orchestratorTranscriptPath,
	parseTranscriptUsage,
	readWorkerSessionMarker,
	renderTokensLine,
	transcriptPathForSession,
	type TranscriptUsage,
} from "../transcript/usage.ts";
import { readSidecarSessionStart } from "../supervisor/session-start.ts";

// --- Constants -------------------------------------------------------------

const STATE_FILE_PATH = ".claude/cam-loop.local.md";
// CAM-31: the recent-activity panel reads the structured event log, not the
// retired freeform progress.txt. The supervisor writes one JSON line per worker
// lifecycle step here.
const EVENT_LOG_PATH = ".claude/cam-worker-events.jsonl";

/** How often the render loop polls cwd for state changes. 2 s per US-009 AC4. */
export const DEFAULT_POLL_INTERVAL_MS = 2000;

/** How many recent worker 'result' events to surface in the dashboard panel. */
export const RECENT_ENTRIES_COUNT = 5;

/**
 * Terminal control codes (cursor movement, screen clearing).
 * These are not colors, so they stay separate from the color module.
 */
export const CURSOR = {
	clear: "\x1b[H\x1b[J", // Home cursor then clear from cursor to end
	home: "\x1b[H", // Home cursor only (for redraw without full clear)
	cursorTo: (row: number, col: number) => `\x1b[${row};${col}H`,
	hideCursor: "\x1b[?25l",
	showCursor: "\x1b[?25h",
	enterAltScreen: "\x1b[?1049h", // Enter alternate screen buffer
	leaveAltScreen: "\x1b[?1049l", // Leave alternate screen buffer
} as const;

/**
 * Box drawing characters for panel borders (plain — used by the
 * `horizontalLine` helper for tests and untinted layouts).
 */
const BOX = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	tee: "├",
	teeRight: "┤",
	cross: "┼",
};

/**
 * Dimmed version of BOX characters — for subdued borders that do not
 * compete visually with panel content.
 */
export const dimBox = {
	topLeft: color.dim("┌"),
	topRight: color.dim("┐"),
	bottomLeft: color.dim("└"),
	bottomRight: color.dim("┘"),
	horizontal: color.dim("─"),
	vertical: color.dim("│"),
	tee: color.dim("├"),
	teeRight: color.dim("┤"),
	cross: color.dim("┼"),
} as const;

/**
 * Truncate a string to fit within maxLen characters, adding ellipsis if needed.
 */
export function truncate(str: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}…`;
}

/**
 * Pad or truncate a string to exactly the given width.
 */
export function pad(str: string, width: number): string {
	if (width <= 0) return "";
	if (str.length >= width) return str.slice(0, width);
	return str + " ".repeat(width - str.length);
}

/**
 * Draw a horizontal line with left/right connectors using plain BOX chars.
 * Exported for tests and untinted layouts.
 */
export function horizontalLine(width: number, left: string, _middle: string, right: string): string {
	return left + BOX.horizontal.repeat(Math.max(0, width - 2)) + right;
}

/**
 * Draw a horizontal line using dimmed border characters.
 * ANSI-aware: uses visibleLength() for padding calculations.
 */
export function dimHorizontalLine(width: number, left: string, right: string): string {
	const fillCount = Math.max(0, width - visibleLength(left) - visibleLength(right));
	return left + dimBox.horizontal.repeat(fillCount) + right;
}

// === Single-write composition skeleton ===

/**
 * Snapshot of TUI state assembled by the caller and handed to `renderDashboard`.
 * `runDashboard` populates this from `prd.json`, the loop's state file, and
 * the event log; tests can populate it by hand to exercise the composition
 * primitive in isolation.
 */
export interface DashboardData {
	/** Branch this loop is operating on, e.g. `cam/pr-127-cam-cli`. */
	branchName: string;
	/** Current PRD story id, e.g. `US-007`. Empty string while booting. */
	currentStoryId: string;
	/** Current PRD story title (rendered next to the id). */
	currentStoryTitle: string;
	/** Iteration counter (turns sent to claude this run). */
	iteration: number;
	/** Plugin's `--max-iterations` value. */
	maxIterations: number;
	/** Wall-clock start time of the run, in ms since epoch. 0 when booting. */
	startedAtMs: number;
	/** "now" in ms since epoch — injected for deterministic tests. */
	nowMs: number;
	/** True when the loop's state file marks the run as paused. */
	paused: boolean;
	/** True when no state file is present (idle). */
	idle: boolean;
	/** Last N worker 'result' events, newest first, single-line summaries. */
	recent: string[];
	/**
	 * Full ordered story queue from `prd.json` (priority order). Used by the
	 * Ink dashboard's Stories panel. Optional + defaults to `[]` so test
	 * fixtures that hand-build `DashboardData` without it stay valid.
	 */
	stories?: PrdStory[];
	/**
	 * Token counts from the orchestrator transcript (US-003). All four fields
	 * are optional: undefined means no session marker was found or the
	 * transcript is unreadable. The renderer omits the row when tokensInput is
	 * undefined. Cache fields are added here now so US-004's diff stays small.
	 */
	tokensInput?: number;
	tokensOutput?: number;
	tokensCacheRead?: number;
	tokensCacheCreation?: number;
	/**
	 * Per-story session token usage, keyed by story id (US-014). Only stories
	 * with a `.cam-worker-<id>.session` marker AND a readable transcript appear;
	 * stories without a marker are absent (the renderer shows a placeholder).
	 * Optional + defaults to `{}` so hand-built test fixtures stay valid.
	 */
	storyTokens?: Record<string, TranscriptUsage>;
	/**
	 * ISO timestamp of the last supervisor iteration tick (US-002). Read from
	 * the state file's `last_activity` field. Undefined when absent (old state
	 * files or initial boot). Used by the Loop section to show time-since-last-
	 * real-work instead of time-since-start, so the operator can detect a
	 * stalled loop.
	 */
	lastActivity?: string;
	/**
	 * Top-level review verdict from prd.json's `review.lastVerdict` field
	 * (US-001). Undefined when absent (no review run yet or old prd.json).
	 */
	reviewLastVerdict?: string;
	/**
	 * Wall-clock start time of the current sidecar SESSION, in ms since epoch
	 * (US-001, PR-83). Distinct from `startedAtMs`, which comes from the loop's state
	 * file and resets on every fresh story-implementation cycle. Read from the
	 * dedicated once-per-process marker the sidecar writes at startup
	 * (`.claude/.cam-sidecar-session.json`, see `session-start.ts`). Undefined
	 * when the marker is absent or unreadable (e.g. the sidecar has never run).
	 */
	sessionStartedAtMs?: number;
	/**
	 * Session-cumulative worker token total (US-002, PR-83): the sum of all
	 * worker 'tokens' events at-or-after the sidecar session start, across every
	 * story in the current session. Expressed in tokens, never USD (price varies
	 * by model/tier). Undefined when the event log is absent, the session-start
	 * marker is unknown, or no 'tokens' events fall inside the session window —
	 * the renderer omits the row in all three cases. Computed by
	 * `sumSessionWorkerTokens`.
	 */
	sessionWorkerTokens?: number;
}

/**
 * Render the full dashboard in a single `process.stdout.write()` call to
 * avoid Warp's "block-per-clear" issue. First render uses CURSOR.clear; all
 * subsequent renders use CURSOR.home so terminals that group output by
 * clear-events stay in one block.
 */
export function renderDashboard(
	data: DashboardData,
	intervalMs: number,
	isFirstRender: boolean,
	out: NodeJS.WritableStream = process.stdout,
): void {
	out.write(composeDashboard(data, intervalMs, isFirstRender));
}

/**
 * Pure composition: produce the bytes that `renderDashboard` would write.
 * Exposed for tests that want to assert frame contents without spying on
 * `process.stdout.write`.
 */
export function composeDashboard(
	data: DashboardData,
	intervalMs: number,
	isFirstRender: boolean,
): string {
	const width = (process.stdout.columns ?? 100) || 100;

	// First render: clear entire alt screen. Subsequent: just home cursor
	// and overwrite in-place (avoids Warp's block-per-clear issue).
	let output = isFirstRender ? CURSOR.clear : CURSOR.home;

	// --- Header -----------------------------------------------------------
	const elapsedMs = data.startedAtMs > 0 ? Math.max(0, data.nowMs - data.startedAtMs) : 0;
	const wallClock = data.startedAtMs > 0 ? formatWallClock(elapsedMs) : "—";
	const storyLabel = data.currentStoryId
		? `${data.currentStoryId} · ${data.currentStoryTitle}`
		: data.idle
			? "(idle)"
			: "(booting)";
	const title = `cam · ${data.branchName} · ${storyLabel}`;
	output += `${renderHeader(title, width)}\n`;

	// --- Status row -------------------------------------------------------
	const statusBits = [
		`iter ${data.iteration}/${data.maxIterations}`,
		`elapsed ${wallClock}`,
		`poll=${intervalMs}ms`,
	];
	output += `${muted(statusBits.join("  ·  "))}\n`;

	// --- Token usage row (omitted when no transcript data) ----------------
	if (data.tokensInput !== undefined) {
		const tokenLine = renderTokensLine({
			input: data.tokensInput ?? 0,
			output: data.tokensOutput ?? 0,
			cacheRead: data.tokensCacheRead ?? 0,
			cacheCreation: data.tokensCacheCreation ?? 0,
		});
		output += `${muted(`tokens  ${tokenLine}`)}\n`;
	}

	// --- Sleep banner -----------------------------------------------------
	// Surfaces when the plugin marked the run paused (e.g. completion-promise
	// landed but the loop hasn't been cleared) — visually distinct from idle.
	// Uses the same `!`-warning + default-message pattern as the Ink screens.
	if (data.paused) {
		const banner = "loop is paused (state file: active:false) — `cam stop` to clear";
		output += `\n${warning("!")} ${banner}\n`;
	}

	// --- Recent worker events --------------------------------------------
	// Styled as a Section: bold heading + muted divisor, matching Ink screens.
	output += "\n";
	output += `${chalk.bold("Recent")}\n`;
	output += `${muted(separator(width))}\n`;
	if (data.recent.length === 0) {
		output += `${muted("  (no activity yet)")}\n`;
	} else {
		for (const entry of data.recent) {
			// Reserve 2 chars for the bullet, account for ANSI overhead by
			// truncating against visible width — since the bullet is plain
			// ASCII, `width - 4` is safe.
			output += `${muted("  · ")}${truncate(entry, Math.max(20, width - 4))}\n`;
		}
	}

	// --- Footer hint ------------------------------------------------------
	output += `\n${muted("press q or Ctrl+C to exit")}\n`;

	return output;
}

// === Alt-screen lifecycle ===

/**
 * Enter the alternate screen buffer (vim/htop style), hide the cursor, and
 * put stdin into raw mode so single-key handlers (`q` / Ctrl+C) work.
 *
 * Returns a `cleanup` function that restores the original screen + cursor +
 * stdin mode. Caller is responsible for installing SIGINT and stdin handlers
 * that invoke `cleanup` and exit.
 */
export function enterAltScreen(): { cleanup: () => void } {
	process.stdout.write(CURSOR.enterAltScreen);
	process.stdout.write(CURSOR.hideCursor);
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
	}

	let cleaned = false;
	const cleanup = () => {
		// Idempotent — both SIGINT and the `q` handler can race to call us.
		if (cleaned) return;
		cleaned = true;
		if (process.stdin.isTTY) {
			try {
				process.stdin.setRawMode(false);
			} catch {
				// stdin may already be closed during shutdown; ignore.
			}
			process.stdin.pause();
		}
		process.stdout.write(CURSOR.showCursor);
		process.stdout.write(CURSOR.leaveAltScreen);
	};

	return { cleanup };
}

/**
 * Install SIGINT + stdin handlers that invoke `cleanup` on Ctrl+C or `q`.
 * Sets process.exitCode = 0 on quit. Idempotent — safe to call once per
 * dashboard session.
 */
export function installQuitHandlers(cleanup: () => void): void {
	process.on("SIGINT", () => {
		cleanup();
		process.exitCode = 0;
	});

	process.stdin.on("data", (data: Buffer) => {
		const key = data.toString();
		if (key === "q" || key === "\x03") {
			// 'q' or Ctrl+C
			cleanup();
			process.exitCode = 0;
		}
	});
}

// === Runtime loop (US-009) =================================================

/**
 * Read the latest snapshot from `cwd`. Pure function — IO only — so the loop
 * can call it on every poll and diff snapshots without re-implementing
 * filesystem access.
 *
 * - `prd.json` → branch name + current story (highest-priority `passes:false`)
 * - `.claude/cam-loop.local.md` → iteration / max / started_at / paused state
 * - `.claude/cam-worker-events.jsonl` → last RECENT_ENTRIES_COUNT 'result' events
 *
 * Each source is best-effort: a missing/corrupt file falls back to defaults
 * rather than throwing, because the dashboard is read-only and a render
 * failure mid-loop should NOT brick the operator's terminal.
 */
export function readSnapshot(options: { cwd: string; nowMs: number; claudeDir?: string }): DashboardData {
	const { cwd, nowMs } = options;
	const claudeDir = options.claudeDir ?? (process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"));

	const prd = readPrd(cwd);
	const state = readState(cwd);
	const recent = readRecentProgress(cwd, prd?.userStories);
	const orchPath = orchestratorTranscriptPath(cwd, claudeDir);
	const tokenUsage = orchPath !== null ? readTranscriptTokens(orchPath) : null;
	const storyTokens = readStoryTokens(cwd, claudeDir, prd?.userStories ?? []);

	// Prefer prd.json's `branchName` (canonical for the loop) and fall back to
	// `git branch --show-current` so the dashboard still labels itself when
	// run from a cwd whose prd.json lives elsewhere (e.g. cross-repo).
	const branchName = prd?.branchName ?? readGitBranch(cwd) ?? "(unknown branch)";

	const data: DashboardData = {
		branchName,
		currentStoryId: "",
		currentStoryTitle: "",
		iteration: 0,
		maxIterations: 0,
		startedAtMs: 0,
		nowMs,
		paused: false,
		idle: state === null,
		recent,
		stories: prd?.userStories ?? [],
		storyTokens,
		...(tokenUsage !== null
			? {
					tokensInput: tokenUsage.input,
					tokensOutput: tokenUsage.output,
					tokensCacheRead: tokenUsage.cacheRead,
					tokensCacheCreation: tokenUsage.cacheCreation,
				}
			: {}),
	};

	if (prd) {
		const story = pickCurrentStory(prd);
		if (story) {
			data.currentStoryId = story.id;
			data.currentStoryTitle = story.title;
		}
		// US-001: surface the top-level review verdict when present.
		if (typeof prd.review?.lastVerdict === "string" && prd.review.lastVerdict.length > 0) {
			data.reviewLastVerdict = prd.review.lastVerdict;
		}
	}

	if (state) {
		if (typeof state.iteration === "number") data.iteration = state.iteration;
		if (typeof state.max_iterations === "number") data.maxIterations = state.max_iterations;
		if (state.started_at) {
			const startMs = Date.parse(state.started_at);
			if (Number.isFinite(startMs)) data.startedAtMs = startMs;
		}
		if (state.active === false) data.paused = true;
		// US-002: map live-progress fields from the state file.
		if (typeof state.last_activity === "string" && state.last_activity.length > 0) {
			data.lastActivity = state.last_activity;
		}
	}

	// US-001 (PR-83): total-session elapsed, read from the dedicated once-per-process
	// marker the sidecar writes at startup (project-local `.claude/`, NOT the
	// `claudeDir` option above which points at the transcript home dir).
	// Absent/unreadable marker leaves the field undefined without throwing.
	const sessionStartIso = readSidecarSessionStart(join(cwd, ".claude"));
	if (sessionStartIso !== null) {
		const sessionStartMs = Date.parse(sessionStartIso);
		if (Number.isFinite(sessionStartMs)) {
			data.sessionStartedAtMs = sessionStartMs;
			// US-002 (PR-83): bound the worker-token sum by the same session-start
			// marker so the total reflects "since this sidecar session began", not
			// the whole (never-truncated) event log.
			const sessionTokens = sumSessionWorkerTokens(readEventLogBody(cwd), sessionStartIso);
			if (sessionTokens !== undefined) data.sessionWorkerTokens = sessionTokens;
		}
	}

	return data;
}

function readPrd(cwd: string): PrdShape | null {
	const path = resolvePrdPath(cwd);
	if (!existsSync(path)) return null;
	try {
		const body = readFileSync(path, "utf8");
		const parsed = JSON.parse(body) as unknown;
		if (parsed === null || typeof parsed !== "object") return null;
		return parsed as PrdShape;
	} catch {
		return null;
	}
}

function readGitBranch(cwd: string): string | null {
	try {
		const out = spawnSync("git", ["-C", cwd, "branch", "--show-current"], {
			encoding: "utf8",
		});
		if (out.status !== 0) return null;
		const name = out.stdout.trim();
		return name.length > 0 ? name : null;
	} catch {
		return null;
	}
}

function readState(cwd: string): LoopState | null {
	const path = join(cwd, STATE_FILE_PATH);
	if (!existsSync(path)) return null;
	try {
		const body = readFileSync(path, "utf8");
		return parseStateFile(body);
	} catch {
		return null;
	}
}

/**
 * Best-effort read of a transcript JSONL at `transcriptPath` to sum token
 * usage. Returns null on any miss (no file / read error). Never throws.
 *
 * Generalized in US-014 to accept a resolved path so both the orchestrator
 * transcript and per-story worker transcripts share one reader. Callers
 * resolve the path (orchestratorTranscriptPath / transcriptPathForSession)
 * before calling.
 */
function readTranscriptTokens(transcriptPath: string): TranscriptUsage | null {
	try {
		if (!existsSync(transcriptPath)) return null;
		const body = readFileSync(transcriptPath, "utf8");
		return parseTranscriptUsage(body);
	} catch {
		return null;
	}
}

/**
 * Read per-story session token usage for every story that has a worker session
 * marker (`.claude/.cam-worker-<id>.session`, written by the supervisor's
 * writeSessionMarker, US-002) AND a readable transcript.
 *
 * marker → uuid → transcript path (transcriptPathForSession) → parsed usage.
 * Stories without a marker or with an unreadable transcript are omitted so the
 * renderer can show a placeholder. Never throws: readWorkerSessionMarker and
 * readTranscriptTokens both swallow their IO errors.
 */
function readStoryTokens(
	cwd: string,
	claudeDir: string,
	stories: readonly PrdStory[],
): Record<string, TranscriptUsage> {
	const projectClaudeDir = join(cwd, ".claude");
	const out: Record<string, TranscriptUsage> = {};
	for (const story of stories) {
		const uuid = readWorkerSessionMarker(projectClaudeDir, story.id);
		if (uuid === null) continue;
		const usage = readTranscriptTokens(transcriptPathForSession(uuid, cwd, claudeDir));
		if (usage !== null) out[story.id] = usage;
	}
	return out;
}

/**
 * Read the worker event log (.claude/cam-worker-events.jsonl) under cwd and
 * surface the last `RECENT_ENTRIES_COUNT` 'result' events as single-line bullets
 * via parseRecentProgress (CAM-31). One JSON object per line; a missing file
 * yields []. Each bullet is a fixed `MM-DD HH:MM US-XXX outcome` string, which
 * keeps the panel width-stable.
 *
 * `userStories` (US-001, CAM-346) is the same live prd.json array the Stories
 * panel reads (Dashboard.tsx:445 filters `s.passes === true`). It is reduced to
 * a storyId->passes:true Set and threaded into parseRecentProgress so a frozen
 * 'incomplete' event for a story that has since been finalized-DONE renders in
 * agreement with the Stories panel, instead of contradicting it.
 */
export function readRecentProgress(cwd: string, userStories?: readonly PrdStory[]): string[] {
	const path = join(cwd, EVENT_LOG_PATH);
	if (!existsSync(path)) return [];
	let body: string;
	try {
		body = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const passingStoryIds = new Set(
		(userStories ?? []).filter((s) => s.passes === true).map((s) => s.id),
	);
	return parseRecentProgress(body, passingStoryIds);
}

/**
 * Read the raw event-log body under `cwd`, or null when the file is absent
 * or unreadable. Shared by `readRecentProgress` (via its own inline read) and
 * `readSnapshot`'s session-worker-token summation (US-002, PR-83).
 */
function readEventLogBody(cwd: string): string | null {
	const path = join(cwd, EVENT_LOG_PATH);
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Coerce an unknown JSON value to a number (0 if not a number). */
function toNumberOrZero(v: unknown): number {
	return typeof v === "number" ? v : 0;
}

/**
 * Pure exported helper (US-002, PR-83): sum worker 'tokens' events from the
 * event-log JSONL, counting only events timestamped at-or-after
 * `sessionStartIso`. Each 'tokens' event contributes all four
 * TokensEventDetail fields (inputTokens + outputTokens + cacheReadTokens +
 * cacheCreationTokens), mirroring the `extractTokensFromLine` formula in
 * `recordCycleTokens` (journal.ts, CAM-131). 'cycle-tokens' aggregate events
 * are excluded by construction (only `kind === "tokens"` lines are summed),
 * so a worker's spend already folded into a closed cycle's aggregate is never
 * double-counted alongside its own raw event.
 *
 * Malformed lines are skipped, never fatal. `jsonl === null` (missing event
 * log) yields `undefined` (no total). When the log is present but no 'tokens'
 * event falls at-or-after the session start, this also yields `undefined`
 * (distinct from a real `0` total, which requires at least one matching
 * event whose four fields happen to sum to zero) — both cases mean "no total
 * to show" for the caller.
 */
export function sumSessionWorkerTokens(jsonl: string | null, sessionStartIso: string): number | undefined {
	if (jsonl === null) return undefined;
	const sessionStartMs = Date.parse(sessionStartIso);
	let total = 0;
	let matched = false;
	for (const line of jsonl.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue; // skip a malformed line, never crash the dashboard
		}
		if (typeof event !== "object" || event === null) continue;
		const e = event as { ts?: unknown; kind?: unknown; detail?: unknown };
		if (e.kind !== "tokens") continue;
		if (typeof e.ts !== "string") continue;
		const ts = Date.parse(e.ts);
		if (!Number.isFinite(ts) || ts < sessionStartMs) continue;
		if (typeof e.detail !== "object" || e.detail === null) continue;
		const d = e.detail as Record<string, unknown>;
		total +=
			toNumberOrZero(d["inputTokens"]) +
			toNumberOrZero(d["outputTokens"]) +
			toNumberOrZero(d["cacheReadTokens"]) +
			toNumberOrZero(d["cacheCreationTokens"]);
		matched = true;
	}
	return matched ? total : undefined;
}

/**
 * Pure parser exposed for tests (CAM-31): read the worker event log (one JSON
 * object per line) and surface the last N 'result' events as single-line
 * summaries, newest first. Each line is `{ ts, storyId, uuid, kind, detail }`;
 * a 'result' event carries `detail.outcome`. Malformed lines are skipped, not
 * fatal. Format: `<MM-DD HH:MM> US-XXX <outcome>` (the structured event log
 * replaces the old progress.txt markdown scrape).
 *
 * `passingStoryIds` (US-001, CAM-346) is an optional live-state reconciliation
 * lookup: the event log is factually correct for the instant it was written
 * (a 'result' event can legitimately record 'incomplete' when prd.json hadn't
 * flipped `passes:true` yet), but a story that has since been finalized-DONE
 * should no longer show as 'incomplete' next to the Stories panel's checkmark.
 * Only the 'incomplete' outcome is reconciled to 'done'; every other outcome
 * (pass, blocked, fail, unknown, no-commit, ...) passes through verbatim. The
 * event itself is never rewritten, only its rendered summary.
 */
export function parseRecentProgress(jsonl: string, passingStoryIds?: ReadonlySet<string>): string[] {
	const summaries: string[] = [];
	for (const line of jsonl.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue; // skip a malformed line, never crash the dashboard
		}
		if (typeof event !== "object" || event === null) continue;
		const e = event as { ts?: unknown; storyId?: unknown; kind?: unknown; detail?: unknown };
		if (e.kind !== "result") continue;
		const story = typeof e.storyId === "string" && e.storyId.length > 0 ? e.storyId : "?";
		const rawOutcome =
			typeof e.detail === "object" && e.detail !== null &&
			typeof (e.detail as { outcome?: unknown }).outcome === "string"
				? (e.detail as { outcome: string }).outcome
				: "?";
		const outcome =
			rawOutcome === "incomplete" && (passingStoryIds?.has(story) ?? false) ? "done" : rawOutcome;
		const when = typeof e.ts === "string" ? shortTimestamp(e.ts) : "";
		summaries.push(`${when ? when + " " : ""}${story} ${outcome}`);
	}
	// Newest events are at the bottom of the log; surface those first.
	return summaries.slice(-RECENT_ENTRIES_COUNT).reverse();
}

/** Render an ISO timestamp as `MM-DD HH:MM` for the compact recent panel. */
function shortTimestamp(iso: string): string {
	// ISO shape: 2026-06-14T03:12:45.678Z -> "06-14 03:12". Pure string slice so
	// it is timezone-stable and needs no Date parsing.
	const m = iso.match(/^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/);
	return m ? `${m[1]} ${m[2]}` : "";
}

// === runDashboard ==========================================================

/**
 * Stream-like writable accepted by `runDashboard` for testability. We don't
 * need the full `WritableStream` surface — just `write(chunk)` — so this
 * narrow shape is enough and keeps the test fakes tiny.
 */
export interface DashboardWriter {
	write(chunk: string): boolean;
}

/**
 * Stream-like readable accepted by `runDashboard` for testability. Mirrors
 * the bits of `process.stdin` we use: `on('data', ...)` for keypress
 * handling, plus optional `setRawMode` / `pause` / `resume` for TTY mode.
 */
export interface DashboardReader {
	on(event: "data", listener: (data: Buffer) => void): void;
	off?(event: "data", listener: (data: Buffer) => void): void;
	setRawMode?(enabled: boolean): unknown;
	resume?(): unknown;
	pause?(): unknown;
	isTTY?: boolean;
}

export interface RunDashboardOptions {
	/** cwd for state-file / prd.json / event-log lookups. */
	cwd?: string;
	/** Override poll interval (default 2000ms). */
	pollIntervalMs?: number;
	/** Override the writer (default `process.stdout`). */
	writer?: DashboardWriter;
	/** Override the reader (default `process.stdin`). */
	reader?: DashboardReader;
	/** Override clock — tests pin this for deterministic wall-clock display. */
	now?: () => number;
	/** When set, runDashboard exits after this many ticks (test only). */
	maxTicks?: number;
	/** Receive the cleanup function before the first render — tests use it
	 *  to assert the alt-screen lifecycle ran with try/finally. */
	onMounted?: (handle: { cleanup: () => void }) => void;
	/** Override the Claude config dir (default: CLAUDE_CONFIG_DIR env or ~/.claude). Tests inject a tmpdir. */
	claudeDir?: string;
}

/**
 * Run the dashboard loop. Returns when the user presses `q` or Ctrl+C, or
 * when `maxTicks` (test mode) is exhausted. The alt-screen lifecycle is
 * wrapped in `try { ... } finally { cleanup() }` so a thrown error during
 * render does not strand the terminal in the alternate buffer.
 */
export async function runDashboard(options: RunDashboardOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const writer: DashboardWriter = options.writer ?? process.stdout;
	const reader: DashboardReader = options.reader ?? process.stdin;
	const now = options.now ?? (() => Date.now());
	const claudeDir = options.claudeDir;

	// Enter alt-screen + raw mode. The lifecycle MUST be wrapped in
	// try/finally so a panic during the render loop doesn't strand the
	// operator's terminal in the alternate buffer (US-009 story note).
	const handle = mountAltScreen(writer, reader);
	if (options.onMounted) options.onMounted({ cleanup: handle.cleanup });

	let firstRender = true;
	let lastFrameKey = "";
	let stopped = false;

	const stopSignals = () => {
		stopped = true;
	};

	const onKey = (data: Buffer) => {
		const key = data.toString();
		if (key === "q" || key === "\x03") {
			stopSignals();
		}
	};
	reader.on("data", onKey);

	const onSigint = () => stopSignals();
	process.on("SIGINT", onSigint);

	const onResize = () => {
		// Force a full repaint at the new viewport size on the next tick.
		firstRender = true;
		lastFrameKey = "";
	};
	process.on("SIGWINCH", onResize);

	let exitCode = 0;
	try {
		let ticks = 0;
		while (!stopped) {
			const data = readSnapshot({ cwd, nowMs: now(), ...(claudeDir !== undefined ? { claudeDir } : {}) });
			const frame = composeDashboard(data, intervalMs, firstRender);
			const key = snapshotKey(data, firstRender);
			if (firstRender || key !== lastFrameKey) {
				writer.write(frame);
				lastFrameKey = key;
			}
			firstRender = false;
			ticks += 1;
			if (options.maxTicks !== undefined && ticks >= options.maxTicks) break;
			await sleep(intervalMs);
		}
	} catch (err) {
		exitCode = 1;
		// Best-effort: surface the error after we've cleaned up.
		queueMicrotask(() => {
			process.stderr.write(`dashboard render error: ${(err as Error).message}\n`);
		});
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGWINCH", onResize);
		if (typeof reader.off === "function") {
			reader.off("data", onKey);
		}
		handle.cleanup();
	}

	return exitCode;
}

/**
 * Wrapper around `enterAltScreen` that uses the injected reader/writer so
 * tests don't poke `process.stdin`/`process.stdout` directly.
 */
function mountAltScreen(writer: DashboardWriter, reader: DashboardReader): { cleanup: () => void } {
	writer.write(CURSOR.enterAltScreen);
	writer.write(CURSOR.hideCursor);
	if (reader.isTTY && typeof reader.setRawMode === "function") {
		try {
			reader.setRawMode(true);
		} catch {
			// Stub readers may not support setRawMode; ignore.
		}
		if (typeof reader.resume === "function") reader.resume();
	}

	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		if (reader.isTTY && typeof reader.setRawMode === "function") {
			try {
				reader.setRawMode(false);
			} catch {
				// stdin may already be closed.
			}
			if (typeof reader.pause === "function") {
				try {
					reader.pause();
				} catch {
					// stdin already closed during shutdown — ignore.
				}
			}
		}
		// Cleanup writes must NOT propagate write errors — a panic during
		// rendering already triggered cleanup; the operator needs the alt
		// screen escape sequences emitted whether or not the writer is
		// fault-injected. Fall through to the next write on failure so both
		// showCursor and leaveAltScreen get a chance to land.
		try {
			writer.write(CURSOR.showCursor);
		} catch {
			// continue — leaveAltScreen is the more important of the two.
		}
		try {
			writer.write(CURSOR.leaveAltScreen);
		} catch {
			// nothing more we can do — the test harness's writer asserts
			// the bytes that did land.
		}
	};
	return { cleanup };
}

/**
 * Stable identity for a snapshot — used to skip writes when nothing changed.
 * We hash the volatile fields only; `nowMs` is excluded because including it
 * would force a redraw on every tick (it changes monotonically).
 */
function snapshotKey(data: DashboardData, firstRender: boolean): string {
	if (firstRender) return "first";
	return [
		data.branchName,
		data.currentStoryId,
		data.currentStoryTitle,
		data.iteration,
		data.maxIterations,
		data.startedAtMs,
		data.paused ? 1 : 0,
		data.idle ? 1 : 0,
		data.recent.join("|"),
		data.tokensInput ?? -1,
		data.tokensOutput ?? -1,
		data.tokensCacheRead ?? -1,
		data.tokensCacheCreation ?? -1,
	].join("§");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

// === Ink-based dashboard (production interactive path) ====================
//
// `runDashboardInk` is the entrypoint wired into `cam dashboard` from
// `index.ts`. It enters the alt-screen, mounts the Ink `DashboardApp`, and
// cleans up on `q` / Ctrl+C. The legacy `runDashboard` (above) is kept
// because the test suite drives it with fake writer/reader to assert the
// alt-screen lifecycle byte-for-byte.

export interface RunDashboardInkOptions {
	cwd?: string;
	pollIntervalMs?: number;
	now?: () => number;
	/** Override the Claude config dir (default: CLAUDE_CONFIG_DIR env or ~/.claude). Tests inject a tmpdir. */
	claudeDir?: string;
	/**
	 * tmux pane id of the orchestrator pane (target for send-keys / select-pane).
	 * When undefined (standalone `cam dashboard`), dispatch keys are inert no-ops.
	 */
	orchPane?: string;
}

/** How long to wait after the last resize event before re-asserting a trailing clear. */
export const RESIZE_TRAILING_CLEAR_MS = 100;

export interface ResizeClearerOptions {
	/** Write sink for the clear escape sequence. Defaults to `process.stdout.write`. */
	writeFn?: (data: string) => void;
	/**
	 * Injectable `setTimeout`, so tests never touch the real event loop timers.
	 * The handle type is intentionally opaque (`unknown`): Bun's global `Timer`
	 * and `@types/node`'s ambient `NodeJS.Timeout` are structurally distinct,
	 * and this factory never inspects the handle, only round-trips it to
	 * `clearTimeoutFn`.
	 */
	setTimeoutFn?: (cb: () => void, ms: number) => unknown;
	/** Injectable `clearTimeout`, paired with `setTimeoutFn`. */
	clearTimeoutFn?: (id: unknown) => void;
	/** Delay after the last resize event before the trailing re-clear fires. */
	debounceMs?: number;
}

export interface ResizeClearer {
	/** Register as the `resize` listener. Writes an immediate clear, then (re)arms a trailing clear. */
	onResize: () => void;
	/** Cancels any pending trailing timer. Call from the outer cleanup before removing the listener. */
	cleanup: () => void;
}

/**
 * Hardens the on-resize alt-screen clear against reflow storms (CAM-66
 * US-002). A single resize event still writes an immediate `CURSOR.clear`
 * ahead of Ink's repaint, matching the pre-hardening behavior. A rapid burst
 * of resize events (the cam-run window-resized hook can fire several in a
 * row while a pane settles) additionally (re)arms a trailing debounced clear
 * a tick after the last event in the burst: this re-asserts the clear once
 * the burst has settled, so Ink's stale previous-frame line count (tracked
 * at a mid-burst width) cannot leave the "Loop" header ghosted on the final
 * repaint.
 */
// Bun's global `Timer` and `@types/node`'s ambient `NodeJS.Timeout` are
// structurally distinct, so the default setTimeout/clearTimeout wiring is
// funnelled through these narrow, single-signature wrappers instead of
// exposing the ambient overloaded types on `ResizeClearerOptions`.
function defaultSetTimeoutFn(cb: () => void, ms: number): unknown {
	return setTimeout(cb, ms);
}
function defaultClearTimeoutFn(id: unknown): void {
	clearTimeout(id as Parameters<typeof clearTimeout>[0]);
}

export function makeResizeClearer(options: ResizeClearerOptions = {}): ResizeClearer {
	const writeFn = options.writeFn ?? ((data: string) => process.stdout.write(data));
	const setTimeoutFn = options.setTimeoutFn ?? defaultSetTimeoutFn;
	const clearTimeoutFn = options.clearTimeoutFn ?? defaultClearTimeoutFn;
	const debounceMs = options.debounceMs ?? RESIZE_TRAILING_CLEAR_MS;

	let trailingTimer: unknown;

	const writeClear = (): void => {
		try {
			writeFn(CURSOR.clear);
		} catch {
			// A failed clear only risks a transient ghost, never a crash.
		}
	};

	const onResize = (): void => {
		writeClear();
		if (trailingTimer !== undefined) {
			clearTimeoutFn(trailingTimer);
		}
		trailingTimer = setTimeoutFn(() => {
			trailingTimer = undefined;
			writeClear();
		}, debounceMs);
	};

	const cleanup = (): void => {
		if (trailingTimer !== undefined) {
			clearTimeoutFn(trailingTimer);
			trailingTimer = undefined;
		}
	};

	return { onResize, cleanup };
}

/**
 * Production dashboard entrypoint. Enters the alt-screen + hides the cursor,
 * mounts the Ink `DashboardApp`, and on user exit (`q` or Ctrl+C) tears the
 * lifecycle down. Returns 0 on graceful exit. On render error, restores the
 * terminal and surfaces the error on stderr after cleanup.
 */
export async function runDashboardInk(options: RunDashboardInkOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const now = options.now ?? (() => Date.now());
	const claudeDir = options.claudeDir;
	const orchPane = options.orchPane;

	// Dynamic imports so the legacy non-Ink path (used by tests) does not
	// drag React/Ink into the cold-start cost when the dashboard is not
	// actually launching interactively.
	const { render } = await import('ink');
	const { createElement } = await import('react');
	const { DashboardApp } = await import('../ui/Dashboard.tsx');

	process.stdout.write(CURSOR.enterAltScreen);
	process.stdout.write(CURSOR.hideCursor);

	// On terminal resize, fully clear the alt screen before Ink repaints. Ink's
	// in-place update tracks the previous frame's line count at the OLD width;
	// when the cam-run window-resized hook reflows the column, that count is wrong
	// and the old top (e.g. the "Loop" header) ghosts. Registering BEFORE render()
	// so this runs ahead of Ink's own resize rerender gives it a blank canvas.
	// `makeResizeClearer` additionally hardens against reflow storms (a rapid
	// burst of resize events): see its doc comment for the trailing-clear
	// rationale.
	const resizeClearer = makeResizeClearer();
	process.stdout.on('resize', resizeClearer.onResize);

	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		resizeClearer.cleanup();
		try {
			process.stdout.removeListener('resize', resizeClearer.onResize);
		} catch {
			// listener may already be gone; nothing to do.
		}
		try {
			process.stdout.write(CURSOR.showCursor);
		} catch {
			// continue — leaveAltScreen is the more important of the two.
		}
		try {
			process.stdout.write(CURSOR.leaveAltScreen);
		} catch {
			// nothing more we can do.
		}
	};

	let exitCode = 0;
	try {
		const view = createElement(DashboardApp, {
			readSnapshot: () => readSnapshot({ cwd, nowMs: now(), ...(claudeDir !== undefined ? { claudeDir } : {}) }),
			pollIntervalMs: intervalMs,
			...(orchPane !== undefined ? { orchPane } : {}),
		});
		const instance = render(view);
		await instance.waitUntilExit();
	} catch (err) {
		exitCode = 1;
		queueMicrotask(() => {
			process.stderr.write(
				`dashboard render error: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		});
	} finally {
		cleanup();
	}
	return exitCode;
}
