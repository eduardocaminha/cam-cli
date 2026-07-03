/**
 * Pure transcript-usage parser and transcript path resolvers.
 *
 * Parses a Claude Code transcript JSONL and sums token usage across all lines
 * that carry message.usage (assistant and sidechain lines).
 * Malformed / non-JSON lines and lines without message.usage are skipped silently.
 *
 * Exports:
 *   orchestratorTranscriptPath  - resolve the JSONL path for the orchestrator session (US-002).
 *   transcriptPathForSession    - generalized resolver given an explicit uuid (US-002).
 *   writeWorkerSessionMarker    - persist a per-story worker session uuid (US-002).
 *   readWorkerSessionMarker     - read back a per-story worker session uuid (US-002).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface TranscriptUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
}

interface MessageUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

interface TranscriptLine {
	requestId?: string;
	message?: {
		id?: string;
		usage?: MessageUsage;
	};
}

function isTranscriptLine(val: unknown): val is TranscriptLine {
	return typeof val === "object" && val !== null;
}

function toNumber(val: unknown): number {
	return typeof val === "number" ? val : 0;
}

/**
 * Sums token usage across every unique request in the JSONL.
 *
 * Real Claude Code transcripts write multiple JSONL lines per assistant turn
 * (one per content block: thinking, text, tool_use), each carrying an identical
 * message.usage object. Naive summation inflates totals 2x to 5x.
 *
 * Dedup strategy: key each usage-bearing line by (message.id, requestId).
 * Keep only the LAST usage payload per key, then sum the deduped map.
 * Lines that carry message.usage but lack both message.id and requestId
 * (degenerate case) are assigned a unique fallback key so they are counted once.
 */
export function parseTranscriptUsage(jsonl: string): TranscriptUsage {
	// Map from dedup-key -> last usage seen for that key.
	const seen = new Map<string, MessageUsage>();
	let fallbackCounter = 0;

	const lines = jsonl.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// malformed JSON: skip silently
			continue;
		}

		if (!isTranscriptLine(parsed)) continue;

		const usage = parsed.message?.usage;
		if (usage === undefined || usage === null) continue;

		const msgId = parsed.message?.id ?? null;
		const reqId = parsed.requestId ?? null;

		let key: string;
		if (msgId !== null || reqId !== null) {
			key = `${msgId ?? ""}|${reqId ?? ""}`;
		} else {
			// No dedup fields present: count this line once (unique fallback key).
			key = `__fallback_${fallbackCounter++}`;
		}

		// Always overwrite: last line wins (identical payloads, so no material
		// difference — this just matches ccusage / claude-devtools convention).
		seen.set(key, usage);
	}

	const result: TranscriptUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheCreation: 0,
	};
	for (const usage of seen.values()) {
		result.input += toNumber(usage.input_tokens);
		result.output += toNumber(usage.output_tokens);
		result.cacheRead += toNumber(usage.cache_read_input_tokens);
		result.cacheCreation += toNumber(usage.cache_creation_input_tokens);
	}

	return result;
}

/**
 * Formats a token count into a compact human-readable string.
 *
 * - >= 1_000_000: round to 1 decimal, append 'M'  (e.g. 1234567 -> '1.2M')
 * - >= 1_000:     round to integer, append 'k'     (e.g. 340000  -> '340k')
 * - < 1_000:      raw integer                       (e.g. 999     -> '999')
 * - 0:            '0'
 */
export function formatTokens(n: number): string {
	if (n === 0) return "0";
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(1)}M`;
	}
	if (n >= 1_000) {
		return `${Math.round(n / 1_000)}k`;
	}
	return `${n}`;
}

/**
 * Renders the token usage line shared by both the dashboard and cam status.
 *
 * Format: "↑ <in> in (<cached> cached) · ↓ <out> out"
 * where:
 *   in     = t.input + t.cacheCreation + t.cacheRead  (total input volume)
 *   cached = t.cacheRead only (cacheCreation is fresh billed spend, not cached)
 *
 * The "(N cached)" suffix is omitted entirely when cached is 0 (clean display
 * for runs with no cache yet). When cached > 0 it always appears.
 *
 * Single source of truth: both Dashboard.tsx and status.ts import this so the
 * wording cannot drift between the two surfaces.
 */
export function renderTokensLine(t: TranscriptUsage): string {
	const inTotal = t.input + t.cacheCreation + t.cacheRead;
	const cached = t.cacheRead;
	const cachedSuffix = cached > 0 ? ` (${formatTokens(cached)} cached)` : '';
	return `↑ ${formatTokens(inTotal)} in${cachedSuffix} · ↓ ${formatTokens(t.output)} out`;
}

/**
 * Returns the input-window occupancy of the LAST usage-bearing request in the JSONL.
 *
 * Occupancy = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 * of the final request only (output_tokens excluded; they do not fill the input window).
 *
 * Unlike parseTranscriptUsage, this is NOT cumulative. It answers: "how full is the
 * context window right now?" rather than "how many tokens did this session spend total?"
 *
 * Real transcripts write multiple JSONL lines per assistant turn (one per content block),
 * each carrying an identical usage payload. The same dedup logic as parseTranscriptUsage
 * is applied: key each line by (message.id, requestId), keep only the last payload per
 * key. The "last request" is whichever distinct key appeared last in the JSONL.
 *
 * Returns 0 for empty transcripts or transcripts with no usage-bearing lines.
 */
export function parseContextOccupancy(jsonl: string): number {
	const seen = new Map<string, MessageUsage>();
	let fallbackCounter = 0;
	let lastKey: string | null = null;

	const lines = jsonl.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (!isTranscriptLine(parsed)) continue;

		const usage = parsed.message?.usage;
		if (usage === undefined || usage === null) continue;

		const msgId = parsed.message?.id ?? null;
		const reqId = parsed.requestId ?? null;

		let key: string;
		if (msgId !== null || reqId !== null) {
			key = `${msgId ?? ""}|${reqId ?? ""}`;
		} else {
			key = `__fallback_${fallbackCounter++}`;
		}

		seen.set(key, usage);
		lastKey = key;
	}

	if (lastKey === null) return 0;
	const lastUsage = seen.get(lastKey);
	if (lastUsage === undefined) return 0;

	return (
		toNumber(lastUsage.input_tokens) +
		toNumber(lastUsage.cache_read_input_tokens) +
		toNumber(lastUsage.cache_creation_input_tokens)
	);
}

/**
 * Resolves the JSONL transcript path for a given session uuid.
 *
 * Returns:
 *   <claudeDir>/projects/<encode(cwd)>/<uuid>.jsonl
 *
 * where encode replaces every character not matching /[a-zA-Z0-9]/ with '-'
 * (verified empirically against ~/.claude/projects).
 *
 * @param uuid      The session UUID (e.g. from a .cam-worker-<US>.session marker).
 * @param cwd       The project root directory.
 * @param claudeDir The Claude config root (honor CLAUDE_CONFIG_DIR; callers
 *                  typically pass process.env.CLAUDE_CONFIG_DIR ?? join(os.homedir(), '.claude')).
 */
export function transcriptPathForSession(uuid: string, cwd: string, claudeDir: string): string {
	const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
	return join(claudeDir, 'projects', encoded, `${uuid}.jsonl`);
}

/**
 * Resolves the JSONL transcript path for the orchestrator session.
 *
 * Thin wrapper around transcriptPathForSession: reads the session id from
 * <cwd>/.claude/.cam-orch-session (written by cam run on every new session).
 *
 * Returns null when the marker file is absent, unreadable, or empty.
 *
 * @param cwd       The project root directory (contains .claude/).
 * @param claudeDir The Claude config root (honor CLAUDE_CONFIG_DIR; callers
 *                  typically pass process.env.CLAUDE_CONFIG_DIR ?? join(os.homedir(), '.claude')).
 */
export function orchestratorTranscriptPath(cwd: string, claudeDir: string): string | null {
	const markerPath = join(cwd, '.claude', '.cam-orch-session');
	let uuid: string;
	try {
		const raw = readFileSync(markerPath, 'utf8');
		uuid = raw.trim();
	} catch {
		return null;
	}
	if (uuid === '') return null;

	return transcriptPathForSession(uuid, cwd, claudeDir);
}

/** Filename prefix for per-story worker session markers. */
const WORKER_SESSION_MARKER_PREFIX = '.cam-worker-';

/**
 * Persists a per-story worker session uuid to
 *   <claudeDir>/<WORKER_SESSION_MARKER_PREFIX><storyId>.session
 *
 * Creates the directory if it does not exist. Overwrites any existing marker.
 *
 * @param claudeDir  The .claude directory inside the project root (e.g. /project/.claude).
 * @param storyId    The story identifier (e.g. "US-007").
 * @param uuid       The Claude Code session UUID for this story's worker run.
 */
export function writeWorkerSessionMarker(claudeDir: string, storyId: string, uuid: string): void {
	mkdirSync(claudeDir, { recursive: true });
	const markerPath = join(claudeDir, `${WORKER_SESSION_MARKER_PREFIX}${storyId}.session`);
	writeFileSync(markerPath, uuid, 'utf8');
}

/**
 * Reads back the per-story worker session uuid from
 *   <claudeDir>/<WORKER_SESSION_MARKER_PREFIX><storyId>.session
 *
 * Returns null when the marker is absent, unreadable, or empty.
 *
 * @param claudeDir  The .claude directory inside the project root.
 * @param storyId    The story identifier (e.g. "US-007").
 */
export function readWorkerSessionMarker(claudeDir: string, storyId: string): string | null {
	const markerPath = join(claudeDir, `${WORKER_SESSION_MARKER_PREFIX}${storyId}.session`);
	let raw: string;
	try {
		raw = readFileSync(markerPath, 'utf8');
	} catch {
		return null;
	}
	const uuid = raw.trim();
	return uuid === '' ? null : uuid;
}
