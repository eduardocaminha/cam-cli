import type { ColorFn } from "./color.ts";
import { color, noColor } from "./color.ts";
import { AGENT_COLORS } from "./theme.ts";

// === Story Color Mapping (renamed from buildAgentColorMap) ===

/**
 * Builds a stable color map for stories by first-appearance order.
 * Stories are assigned colors from AGENT_COLORS cycling as needed.
 */
export function buildStoryColorMap(storyIds: readonly string[]): Map<string, ColorFn> {
	const colorMap = new Map<string, ColorFn>();
	let idx = 0;
	for (const storyId of storyIds) {
		if (!colorMap.has(storyId)) {
			const colorFn = AGENT_COLORS[idx % AGENT_COLORS.length] ?? noColor;
			colorMap.set(storyId, colorFn);
			idx++;
		}
	}
	return colorMap;
}

/**
 * Extends an existing story color map with new story IDs.
 * Used in follow / live-update mode to add stories discovered after the
 * initial map was built.
 */
export function extendStoryColorMap(
	colorMap: Map<string, ColorFn>,
	storyIds: readonly string[],
): void {
	let idx = colorMap.size;
	for (const storyId of storyIds) {
		if (!colorMap.has(storyId)) {
			const colorFn = AGENT_COLORS[idx % AGENT_COLORS.length] ?? noColor;
			colorMap.set(storyId, colorFn);
			idx++;
		}
	}
}

// === Status Colors ===

/**
 * Returns a color function for a priority string.
 * urgent=red, high=yellow, normal=identity, low=dim.
 */
export function priorityColor(priority: string): ColorFn {
	switch (priority) {
		case "urgent":
			return color.red;
		case "high":
			return color.yellow;
		case "normal":
			return (text: string) => text;
		case "low":
			return color.dim;
		default:
			return (text: string) => text;
	}
}

/**
 * Returns a color function for a numeric tracker priority.
 * 1=urgent (red), 2=high (yellow), 3=normal (identity), 4=low (dim).
 */
export function numericPriorityColor(priority: number): ColorFn {
	switch (priority) {
		case 1:
			return color.red;
		case 2:
			return color.yellow;
		case 3:
			return (text: string) => text;
		case 4:
			return color.dim;
		default:
			return (text: string) => text;
	}
}

/**
 * Returns a color function for a log level string.
 * debug=gray, info=blue, warn=yellow, error=red.
 */
export function logLevelColor(level: string): ColorFn {
	switch (level) {
		case "debug":
			return color.gray;
		case "info":
			return color.blue;
		case "warn":
			return color.yellow;
		case "error":
			return color.red;
		default:
			return (text: string) => text;
	}
}

/**
 * Returns a 3-character label for a log level string.
 * debug="DBG", info="INF", warn="WRN", error="ERR".
 */
export function logLevelLabel(level: string): string {
	switch (level) {
		case "debug":
			return "DBG";
		case "info":
			return "INF";
		case "warn":
			return "WRN";
		case "error":
			return "ERR";
		default:
			return level.slice(0, 3).toUpperCase();
	}
}
