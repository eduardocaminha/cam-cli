// src/supervisor/implement-blocked-marker.ts
//
// Durable implement-blocked marker (US-005, CAM-195, Defect 2).
//
// Written on every 'blocked' terminal of runSupervisor so a recycled
// orchestrator can learn the implement loop was blocked even when the live
// send-keys narration to the orchestrator pane is dropped. Mirrors the
// durable ship-stalled marker precedent verbatim (src/release/merge-watch.ts
// SHIP_STALLED_FILENAME / read+write+remove) and the plan-escalation marker
// (src/supervisor/plan-escalation.ts): a plain JSON marker file under
// .claude/, read/write/remove helpers that never throw.
//
// This module does NOT wire the marker into runSupervisor's blocked-terminal
// seam or into the sidecar's rearm path itself -- it only provides the
// filename constant and the I/O helpers. Wiring lives in loop.ts (write) and
// sidecar.ts (read/remove on the next implement dispatch for the same issue).
//
// US-001 (issue CAM-214): extends the marker with a dedup key
// (`keyHash`, sha256 over storyId + BLOCKED_* token + prdHash) and a
// `consecutiveCount` so repeated identical deterministic blocks on the same
// story are detectable across sessions, plus an `escalated`/`haltedAt` pair
// tripped at `threshold` consecutive identical keys. `advanceBlockedMarker`
// is the pure state-transition function; it is clock-free (mirrors the
// existing loop.ts/host.ts split: `writtenAt`/`haltedAt` are stamped by the
// caller via `params.writtenAt`, never computed in here via `Date.now()`).
// Wiring `advanceBlockedMarker` into the production writer (host.ts, reading
// the live prd.json hash) is out of scope for this story (US-002).

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

/**
 * Filename of the durable implement-blocked marker (relative to the .claude/
 * dir, US-005, CAM-195). Written on every 'blocked' terminal of runSupervisor;
 * removed when the same issue's implement loop is next re-armed (caller's
 * responsibility to check issueId match first, mirroring
 * removeShipStalledMarker / removePlanEscalatedMarker).
 */
export const IMPLEMENT_BLOCKED_FILENAME = '.cam-implement-blocked.json';

/**
 * Durable implement-blocked marker payload.
 *   - issueId: the issue (prd.issueNumber, stringified) the blocked implement
 *     loop was targeting.
 *   - story: the advisory story id in flight when the loop blocked, or null
 *     when the block happened before any story was selected (e.g.
 *     blocked-no-implementable, an unreadable prd.json).
 *   - reason: a short human-readable reason string (mirrors the outcome.detail
 *     text already used for the live BLOCKED narration line).
 *   - writtenAt: ISO 8601 timestamp the marker was written.
 *   - consecutiveCount: how many consecutive blocked terminals produced the
 *     same dedup key (see `keyHash`). Required going forward (US-001); a
 *     marker read from disk that predates this field defaults to 1 (see
 *     `readImplementBlockedMarker`).
 *   - keyHash: sha256 dedup key over (storyId, the BLOCKED_* token extracted
 *     from `reason`, prdHash) -- see `advanceBlockedMarker`. Required going
 *     forward; a pre-US-001 marker on disk defaults to `''`.
 *   - escalated: set true once `consecutiveCount` reaches the escalation
 *     threshold (default 3) for the same dedup key. Absent/false otherwise.
 *   - haltedAt: ISO 8601 timestamp stamped the moment `escalated` first
 *     becomes true. Absent until escalation.
 */
export interface ImplementBlockedMarker {
	issueId: string;
	story: string | null;
	reason: string;
	writtenAt: string;
	consecutiveCount: number;
	keyHash: string;
	escalated?: boolean;
	haltedAt?: string;
}

/**
 * Read the implement-blocked marker from a persistent file.
 *
 * Returns null when the file is absent, contains malformed JSON, a non-object
 * / array value, or is missing / mistyping any required field (issueId:
 * string, story: string|null, reason: string, writtenAt: string). Never
 * throws (mirrors readShipStalledMarker / readPlanEscalatedMarker).
 *
 * `consecutiveCount` / `keyHash` are required on the `ImplementBlockedMarker`
 * type but are read leniently for backward compatibility with CAM-195-era
 * markers written before US-001 that lack them entirely: absent -> default
 * (`consecutiveCount: 1`, `keyHash: ''`), present-but-mistyped -> shape-guard
 * failure (null), same treatment as any other field. `escalated` / `haltedAt`
 * stay optional; present-but-mistyped also fails the shape guard.
 */
export function readImplementBlockedMarker(filePath: string): ImplementBlockedMarker | null {
	try {
		if (!existsSync(filePath)) return null;
		const raw = readFileSync(filePath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		const story = obj['story'];
		if (
			typeof obj['issueId'] !== 'string' ||
			(story !== null && typeof story !== 'string') ||
			typeof obj['reason'] !== 'string' ||
			typeof obj['writtenAt'] !== 'string'
		) {
			return null;
		}
		if (!isValidOptionalFields(obj)) return null;

		const marker: ImplementBlockedMarker = {
			issueId: obj['issueId'] as string,
			story: story as string | null,
			reason: obj['reason'] as string,
			writtenAt: obj['writtenAt'] as string,
			consecutiveCount: typeof obj['consecutiveCount'] === 'number' ? obj['consecutiveCount'] : 1,
			keyHash: typeof obj['keyHash'] === 'string' ? obj['keyHash'] : '',
		};
		if (typeof obj['escalated'] === 'boolean') marker.escalated = obj['escalated'];
		if (typeof obj['haltedAt'] === 'string') marker.haltedAt = obj['haltedAt'];
		return marker;
	} catch {
		return null;
	}
}

/**
 * Shape-guard for the US-001 fields that are optional on disk (backward
 * compatibility with CAM-195-era markers): `consecutiveCount` / `keyHash` /
 * `escalated` / `haltedAt` may be absent, but if present must carry the
 * correct type. Extracted from `readImplementBlockedMarker` to keep that
 * function's cognitive complexity within the project's lint budget.
 */
function isValidOptionalFields(obj: Record<string, unknown>): boolean {
	const consecutiveCountRaw = obj['consecutiveCount'];
	if (consecutiveCountRaw !== undefined && typeof consecutiveCountRaw !== 'number') return false;

	const keyHashRaw = obj['keyHash'];
	if (keyHashRaw !== undefined && typeof keyHashRaw !== 'string') return false;

	const escalatedRaw = obj['escalated'];
	if (escalatedRaw !== undefined && typeof escalatedRaw !== 'boolean') return false;

	const haltedAtRaw = obj['haltedAt'];
	if (haltedAtRaw !== undefined && typeof haltedAtRaw !== 'string') return false;

	return true;
}

/**
 * Write the implement-blocked marker to a persistent file (durable, not
 * consume-on-read; mirrors writeShipStalledMarker / writePlanEscalatedMarker).
 * Overwrites any previous marker (a fresh blocked terminal always reflects
 * the latest state). Never throws.
 */
export function writeImplementBlockedMarker(filePath: string, marker: ImplementBlockedMarker): void {
	try {
		writeFileSync(filePath, JSON.stringify(marker, null, 2), 'utf8');
	} catch {
		/* best-effort: a failed write just means the marker is not durable this tick */
	}
}

/**
 * Remove the implement-blocked marker file.
 *
 * Called when the same issue's implement loop is next re-armed (caller's
 * responsibility to check issueId match first). Silent no-op when the file
 * is already absent. Never throws (mirrors removeShipStalledMarker /
 * removePlanEscalatedMarker).
 */
export function removeImplementBlockedMarker(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		/* best-effort: file may already be absent */
	}
}

/**
 * Matches the BLOCKED_* sentinel token inside a marker `reason` string (e.g.
 * "Worker reported BLOCKED_QUALITY story=US-003 reason=tests_failed" ->
 * "BLOCKED_QUALITY"). The collapsed `WorkerOutcomeKind` ('blocked') is NOT
 * sufficient to distinguish BLOCKED_QUALITY from BLOCKED_AMBIGUITY etc.; the
 * specific token only survives in the reason/detail string (result.ts).
 */
const BLOCKED_TOKEN_RE = /BLOCKED_\w+/;

/** Stable fallback used when `reason` carries no BLOCKED_* token, so the dedup key stays deterministic. */
const UNKNOWN_BLOCKED_TOKEN = 'BLOCKED_UNKNOWN';

/** Stable fallback used when a marker's `story` is null (block occurred before any story was selected). */
const UNKNOWN_STORY_ID = 'no-story';

/** Default consecutive-count threshold at which `advanceBlockedMarker` escalates. */
const DEFAULT_ESCALATION_THRESHOLD = 3;

/** Extract the BLOCKED_* token from a marker reason string, falling back to a stable literal when absent. */
function extractBlockedToken(reason: string): string {
	return reason.match(BLOCKED_TOKEN_RE)?.[0] ?? UNKNOWN_BLOCKED_TOKEN;
}

/** Compute the sha256 dedup key over (storyId, BLOCKED_* token, prdHash). Uses Bun.CryptoHasher (never node:crypto). */
function computeDedupKey(storyId: string | null, token: string, prdHash: string): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(`${storyId ?? UNKNOWN_STORY_ID}:${token}:${prdHash}`);
	return hasher.digest('hex');
}

/**
 * Input to `advanceBlockedMarker`: the fields the caller (the production
 * writer) already knows about the CURRENT blocked terminal, before the
 * dedup-key/consecutive-count logic is applied.
 *   - writtenAt: caller-supplied ISO 8601 timestamp (keeps `advanceBlockedMarker`
 *     clock-free; also reused for `haltedAt` when this terminal escalates).
 */
export interface AdvanceBlockedMarkerParams {
	issueId: string;
	story: string | null;
	reason: string;
	writtenAt: string;
}

/**
 * Pure state-transition function (US-001, CAM-214): given the previous marker
 * (or null, e.g. first-ever block / marker was cleared on re-arm), the current
 * blocked terminal's params, and the current sha256 of prd.json, compute the
 * next `ImplementBlockedMarker`.
 *
 * Dedup key = sha256(storyId, BLOCKED_* token extracted from `params.reason`,
 * prdHash). When the new key matches `prev.keyHash`, `consecutiveCount` is
 * incremented; otherwise it resets to 1 and any prior `escalated` flag is
 * cleared. At `threshold` consecutive identical keys (default 3), `escalated`
 * is set true and `haltedAt` is stamped with `params.writtenAt`; counts below
 * threshold leave `escalated` falsy and `haltedAt` absent.
 *
 * Clock-free: `writtenAt`/`haltedAt` are both sourced from
 * `params.writtenAt`, never computed in here via `Date.now()` (mirrors the
 * existing loop.ts/host.ts clock-free-seam split).
 */
export function advanceBlockedMarker(
	prev: ImplementBlockedMarker | null,
	params: AdvanceBlockedMarkerParams,
	prdHash: string,
	threshold: number = DEFAULT_ESCALATION_THRESHOLD,
): ImplementBlockedMarker {
	const token = extractBlockedToken(params.reason);
	const keyHash = computeDedupKey(params.story, token, prdHash);
	const consecutiveCount = prev !== null && prev.keyHash === keyHash ? prev.consecutiveCount + 1 : 1;
	const escalated = consecutiveCount >= threshold;

	const marker: ImplementBlockedMarker = {
		issueId: params.issueId,
		story: params.story,
		reason: params.reason,
		writtenAt: params.writtenAt,
		consecutiveCount,
		keyHash,
	};
	if (escalated) {
		marker.escalated = true;
		marker.haltedAt = params.writtenAt;
	}
	return marker;
}
