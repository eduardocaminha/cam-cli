// Forked from jayminwest/overstory@main:src/commands/dashboard.ts
//   - lines 62-160 (CURSOR consts, BOX/dimBox primitives, truncate/pad/horizontalLine helpers)
//   - lines 968-1018 (renderDashboard single-write composition skeleton)
//   - lines 1061-1094 (alt-screen + raw-stdin enter / cleanup lifecycle)
// (MIT). See LICENSE-OVERSTORY.md.
//
// SCOPE: Skeleton only. Mail/Merge/Tasks/Metrics panels DROPPED — ralph CLI
// has no merge queue, no mail, and a different task model. Concrete panels
// (story panel, iteration counter, wall-clock) land in later stories.

import { color, visibleLength } from "../logging/color.ts";
import { renderHeader } from "../logging/theme.ts";

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
 * Concrete panel data (story title, iteration count, elapsed seconds) will be
 * populated by later stories.
 */
export interface DashboardData {
	/** Branch this loop is operating on, e.g. `ralph/pr-127-ralph-cli`. */
	branchName: string;
	/** Current PRD story id, e.g. `US-007`. Empty string while booting. */
	currentStoryId: string;
	/** Iteration counter (turns sent to claude this run). */
	iteration: number;
	/** Wall-clock start time of the run, in ms since epoch. */
	startedAtMs: number;
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
): void {
	const width = process.stdout.columns ?? 100;

	// First render: clear entire alt screen. Subsequent: just home cursor
	// and overwrite in-place (avoids Warp's block-per-clear issue).
	let output = isFirstRender ? CURSOR.clear : CURSOR.home;

	// Header (rows 1-2)
	const elapsedSec = Math.floor((Date.now() - data.startedAtMs) / 1000);
	const title = `ralph · ${data.branchName} · ${data.currentStoryId || "(booting)"} · iter ${data.iteration} · ${elapsedSec}s · poll=${intervalMs}ms`;
	output += `${renderHeader(title, width)}\n`;

	// Concrete panels (story progress, iteration log, etc.) DROPPED for the
	// US-004 skeleton — they land in later stories that have real data sources.

	process.stdout.write(output);
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

	const cleanup = () => {
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
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
