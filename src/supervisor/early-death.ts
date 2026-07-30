// src/supervisor/early-death.ts
//
// Pure early-death detector over a session transcript (US-002, CAM-479).
//
// A dispatched worker whose FIRST turn dies (typically a transient upstream
// API error, e.g. "529 Overloaded") looks identical to a healthy worker still
// thinking, unless something reads the transcript itself: both cases capture
// pane show nothing new for minutes, and both pre-existing timeout/dead-pane
// checks (loop.ts) only fire much later (30/60 minute caps). This module adds
// a much-tighter, transcript-driven signal: if the transcript's byte size has
// not grown across a small floor window AND the last assistant entry is a
// transient API error, the session is dead-on-first-turn -- distinct from
// still-working (growing transcript, or a normal last assistant entry).
//
// Two layers, per the story's notes:
//   - `classifyEarlyDeath`: the pure core. Takes two byte-size samples plus
//     the transcript content and returns a verdict. No I/O, no clock.
//   - `makeEarlyDeathProbe`: a thin stateful factory that closes over
//     cwd/claudeDir/an injectable file reader and clock, resolves the
//     transcript path via the EXISTING shared resolver (transcriptPathForSession,
//     src/transcript/usage.ts), and tracks the last sample per session uuid so
//     poll loops (US-003, US-005) can call it once per interval.
//
// Transient-API-error recognition is intentionally local to this module (a
// small literal/regex set) rather than importing src/retry/patterns.ts
// (CAM-435 is the tracked follow-up for unifying the two; out of scope here).

import { readFileSync } from 'node:fs';

import { transcriptPathForSession } from '../transcript/usage.ts';

/**
 * The floor window: how long a transcript's byte size must stay flat before
 * "no growth" is trusted as a real freeze rather than normal inter-turn
 * latency. Deliberately far below BOTH the 30-minute host per-worker cap
 * (DEFAULT_PER_WORKER_TIMEOUT_MS, loop.ts) and the 60-minute container cap
 * (DEFAULT_CONTAINER_WORKER_TIMEOUT_MS, loop.ts): those two remain the
 * ultimate backstops, this is an early, cause-bearing signal available in
 * seconds, not a replacement for either cap.
 */
export const EARLY_DEATH_FLOOR_MS = 60_000;

/** One byte-size observation of a transcript at a point in time. */
export interface TranscriptSample {
	/** Byte size of the transcript content at the time of this sample. */
	size: number;
	/** Epoch milliseconds when this sample was taken. */
	timestamp: number;
}

export type EarlyDeathVerdict =
	| { verdict: 'dead-on-first-turn'; cause: string }
	| { verdict: 'still-working' };

/** The transcript's last entry whose `type` is `"assistant"`. */
export interface LastAssistantEntry {
	/** True when the transcript line itself carries `isApiErrorMessage: true`. */
	isApiErrorMessage: boolean;
	/** Concatenated `text`-block content of the entry, verbatim (may be empty). */
	text: string;
}

interface AssistantContentBlock {
	type?: unknown;
	text?: unknown;
}

interface AssistantEntryLine {
	type?: unknown;
	isApiErrorMessage?: unknown;
	message?: {
		content?: unknown;
	};
}

function isAssistantContentBlock(val: unknown): val is AssistantContentBlock {
	return typeof val === 'object' && val !== null;
}

/**
 * Parses transcript JSONL content and returns the LAST entry whose `type` is
 * `"assistant"`, or null when there is none (empty transcript, or every line
 * is non-assistant / malformed). Malformed lines are skipped silently, same
 * convention as `parseTranscriptUsage` (src/transcript/usage.ts).
 */
export function extractLastAssistantEntry(jsonl: string): LastAssistantEntry | null {
	let last: LastAssistantEntry | null = null;

	for (const rawLine of jsonl.split('\n')) {
		const trimmed = rawLine.trim();
		if (trimmed === '') continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (typeof parsed !== 'object' || parsed === null) continue;

		const entry = parsed as AssistantEntryLine;
		if (entry.type !== 'assistant') continue;

		const rawBlocks = entry.message?.content;
		const blocks = Array.isArray(rawBlocks) ? rawBlocks : [];
		const text = blocks
			.filter(isAssistantContentBlock)
			.filter((block) => block.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text as string)
			.join('\n');

		last = { isApiErrorMessage: entry.isApiErrorMessage === true, text };
	}

	return last;
}

/**
 * Small, locally-owned set of markers for a transient (retry-worthy) upstream
 * API error, matched against the last assistant entry's verbatim text. Kept
 * separate from src/retry/patterns.ts (CAM-435, out of scope for this story).
 */
const TRANSIENT_API_ERROR_TEXT_RE = /^API Error:.*(5\d{2}|overloaded|rate.?limit|timeout|ECONNRESET|socket hang up)/is;

/**
 * True when the last assistant entry represents a transient upstream API
 * error rather than normal work. Either the transcript line's own
 * `isApiErrorMessage: true` flag (the real Claude Code CLI signal), or a
 * verbatim-text match against the local transient-marker set, is sufficient.
 */
export function isTransientApiError(entry: LastAssistantEntry): boolean {
	if (entry.isApiErrorMessage) return true;
	return TRANSIENT_API_ERROR_TEXT_RE.test(entry.text);
}

export interface ClassifyEarlyDeathParams {
	/** The prior sample, or null when this is the first observation for this session. */
	previousSample: TranscriptSample | null;
	/** The current sample. */
	currentSample: TranscriptSample;
	/** Full transcript content backing `currentSample`, used to read the last assistant entry. */
	jsonl: string;
	/** Overrides EARLY_DEATH_FLOOR_MS; only ever used by tests. */
	floorMs?: number;
}

/**
 * The pure core predicate (no I/O, no clock): classifies a session as
 * dead-on-first-turn only when BOTH hold -- the transcript has not grown in
 * byte size across at least the floor window, AND its last assistant entry is
 * a transient API error. Any other combination (still growing, frozen for
 * less than the floor, no previous sample yet, normal last assistant entry,
 * empty/unparseable transcript) reports still-working.
 */
export function classifyEarlyDeath(params: ClassifyEarlyDeathParams): EarlyDeathVerdict {
	const { previousSample, currentSample, jsonl } = params;
	const floorMs = params.floorMs ?? EARLY_DEATH_FLOOR_MS;

	if (previousSample === null) {
		// No prior observation: cannot prove the transcript has been frozen
		// across the floor window yet.
		return { verdict: 'still-working' };
	}

	const grew = currentSample.size > previousSample.size;
	const elapsedMs = currentSample.timestamp - previousSample.timestamp;
	if (grew || elapsedMs < floorMs) {
		return { verdict: 'still-working' };
	}

	const lastEntry = extractLastAssistantEntry(jsonl);
	if (lastEntry === null || !isTransientApiError(lastEntry)) {
		return { verdict: 'still-working' };
	}

	return { verdict: 'dead-on-first-turn', cause: lastEntry.text };
}

export interface EarlyDeathProbeDeps {
	/** The project root directory (matches transcriptPathForSession's `cwd`). */
	cwd: string;
	/** The Claude config root (honors CLAUDE_CONFIG_DIR at the call site; never re-resolved here). */
	claudeDir: string;
	/** Reads a file's full content as utf8. Defaults to a real `readFileSync`. Injectable for tests. */
	readFileFn?: (path: string) => string;
	/** Returns "now" in epoch milliseconds. Defaults to `Date.now`. Injectable for tests. */
	nowFn?: () => number;
	/** Overrides EARLY_DEATH_FLOOR_MS; only ever used by tests. */
	floorMs?: number;
}

/**
 * Builds a stateful probe: `(uuid) => EarlyDeathVerdict`. Each call resolves
 * the session's transcript path via the shared `transcriptPathForSession`
 * resolver, reads it, and compares against the FREEZE-ANCHOR sample recorded
 * for that uuid (tracked in a closure-local Map, one entry per session): the
 * anchor is only replaced when the transcript's byte size actually changes,
 * so its timestamp stays pinned for as long as the size stays flat and the
 * frozen window accumulates across poll ticks instead of resetting to one
 * poll interval on every call. An absent or unreadable transcript always
 * reports still-working (a resolver miss can never fabricate a death) and
 * clears any stale sample for that uuid so a transcript that later appears is
 * not falsely credited with a frozen window it never actually held.
 */
export function makeEarlyDeathProbe(deps: EarlyDeathProbeDeps): (uuid: string) => EarlyDeathVerdict {
	const readFileFn = deps.readFileFn ?? ((path: string) => readFileSync(path, 'utf8'));
	const nowFn = deps.nowFn ?? Date.now;
	const samples = new Map<string, TranscriptSample>();

	return (uuid: string): EarlyDeathVerdict => {
		const path = transcriptPathForSession(uuid, deps.cwd, deps.claudeDir);

		let jsonl: string;
		try {
			jsonl = readFileFn(path);
		} catch {
			samples.delete(uuid);
			return { verdict: 'still-working' };
		}

		const currentSample: TranscriptSample = { size: Buffer.byteLength(jsonl, 'utf8'), timestamp: nowFn() };
		const previousSample = samples.get(uuid) ?? null;

		// Freeze-anchor semantics: only replace the stored sample when the byte
		// size actually changed (or there is no prior sample yet). When the size
		// is unchanged, keep the anchor's original timestamp so the frozen
		// window accumulates across ticks instead of resetting to one poll
		// interval on every call (the bug this anchoring fixes).
		if (previousSample === null || currentSample.size !== previousSample.size) {
			samples.set(uuid, currentSample);
		}

		return classifyEarlyDeath({ previousSample, currentSample, jsonl, floorMs: deps.floorMs });
	};
}
