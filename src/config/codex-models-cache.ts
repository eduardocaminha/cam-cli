// src/config/codex-models-cache.ts
//
// Resilient reader + pure selector over the codex CLI's undocumented
// `~/.codex/models_cache.json` (US-002, CAM-398). The codex dispatch path
// currently pins a single hardcoded model slug in project.toml; when that
// slug goes dead (codex retires/renames it), dispatch fails outright with no
// fallback. This module picks the top currently-available slug from the
// cache codex itself maintains, so a dead pin is no longer the only thing
// standing between cam and a working codex dispatch.
//
// Schema is undocumented and version-fragile: codex-cli 0.144.6 has no
// public `codex models` command, so the shape here
// ({ models: [ { slug, display_name, visibility, supported_in_api,
// priority } ] }) is inferred from the live cache file, not a spec. Every
// drift from that shape (missing file, unreadable file, non-JSON content, a
// missing/non-array `models` field, a malformed entry, or a cache with no
// eligible entries) is therefore treated as a structured not-ok result and
// NEVER thrown -- US-003 turns not-ok into pin-fallback or a fail-closed
// abort, so this module must never surface an exception to its caller.
//
// Mirrors the codexAuthCheck DI-seam idiom (src/supervisor/codex-auth.ts):
// a synchronous point-read (curated Bun-only invariant carve-out) behind an
// injectable reader function type, so callers can inject a fake without
// touching the real home directory.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A single normalized, filter-eligible entry from the models cache. */
export interface CodexModelCacheEntry {
	slug: string;
	priority: number;
}

/** The selector/reader resolved a top slug. */
export interface CodexModelSelectionOk {
	ok: true;
	slug: string;
}

/** The selector/reader could not resolve a slug; `reason` is diagnostic, not necessarily operator-facing. */
export interface CodexModelSelectionNotOk {
	ok: false;
	reason: string;
}

export type CodexModelSelection = CodexModelSelectionOk | CodexModelSelectionNotOk;

/** Result of validating and filtering a single raw `models[]` entry. */
type CodexModelEntryCheck =
	| { ok: true; candidate: CodexModelCacheEntry | null }
	| { ok: false; reason: string };

/**
 * Validates one raw `models[]` entry's shape and, if valid, reports whether
 * it is filter-eligible (`visibility === 'list' && supported_in_api ===
 * true`). Split out of {@link selectTopCodexModel} to keep that function's
 * branching within the lint complexity budget.
 */
function checkCodexModelEntry(raw: unknown, index: number): CodexModelEntryCheck {
	if (typeof raw !== 'object' || raw === null) {
		return { ok: false, reason: `models cache entry at index ${index} is not an object` };
	}
	const entry = raw as Record<string, unknown>;
	if (typeof entry.slug !== 'string') {
		return { ok: false, reason: `models cache entry at index ${index} has a non-string slug` };
	}
	if (typeof entry.priority !== 'number') {
		return { ok: false, reason: `models cache entry '${entry.slug}' has a non-number priority` };
	}
	const eligible = entry.visibility === 'list' && entry.supported_in_api === true;
	return { ok: true, candidate: eligible ? { slug: entry.slug, priority: entry.priority } : null };
}

/**
 * Pure selector over already-parsed cache JSON.
 *
 * Filters `models` entries to `visibility === 'list' && supported_in_api ===
 * true`, sorts the survivors by `priority` ascending (stable for ties via
 * `Array.prototype.sort`, stable since the ES2019 spec change), and returns
 * the top slug. Never throws: any schema drift (not an object, missing/
 * non-array `models`, a non-object entry, a non-string `slug`, or a
 * non-number `priority`) short-circuits to a structured not-ok result,
 * because an undocumented, version-fragile schema is not safe to partially
 * trust -- a cache that drifted in one place may have drifted anywhere.
 */
export function selectTopCodexModel(parsed: unknown): CodexModelSelection {
	if (typeof parsed !== 'object' || parsed === null) {
		return { ok: false, reason: 'models cache content is not an object' };
	}

	const models = (parsed as Record<string, unknown>).models;
	if (!Array.isArray(models)) {
		return { ok: false, reason: "models cache 'models' field is missing or not an array" };
	}

	const candidates: CodexModelCacheEntry[] = [];
	for (let index = 0; index < models.length; index++) {
		const checked = checkCodexModelEntry(models[index], index);
		if (!checked.ok) {
			return checked;
		}
		if (checked.candidate) {
			candidates.push(checked.candidate);
		}
	}

	if (candidates.length === 0) {
		return {
			ok: false,
			reason: "no models cache entry is visibility='list' and supported_in_api=true",
		};
	}

	candidates.sort((a, b) => a.priority - b.priority);
	const top = candidates[0];
	if (!top) {
		return {
			ok: false,
			reason: "no models cache entry is visibility='list' and supported_in_api=true",
		};
	}
	return { ok: true, slug: top.slug };
}

/** Injectable reader function type (DI seam), so callers can inject a fake without touching the real home directory. */
export type CodexModelsCacheReader = (path?: string) => CodexModelSelection;

/**
 * Default production reader: reads and parses `~/.codex/models_cache.json`
 * (or an explicit `path` override, used by tests and by callers that already
 * know the resolved home directory) and runs it through
 * {@link selectTopCodexModel}. Never throws: a missing file, an unreadable
 * file, and non-JSON content each resolve to a structured not-ok result.
 *
 * Synchronous `existsSync`/`readFileSync` are a deliberate point-read
 * (curated invariant: the Bun-only rule carves out `node:fs` sync reads for
 * this shape), mirroring `codexAuthCheck`'s point-read idiom.
 */
export const readCodexModelsCache: CodexModelsCacheReader = (
	path: string = join(homedir(), '.codex', 'models_cache.json'),
): CodexModelSelection => {
	if (!existsSync(path)) {
		return { ok: false, reason: `models cache file not found at ${path}` };
	}

	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (err) {
		return {
			ok: false,
			reason: `failed to read models cache file at ${path}: ${(err as Error).message}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return {
			ok: false,
			reason: `models cache file at ${path} is not valid JSON: ${(err as Error).message}`,
		};
	}

	return selectTopCodexModel(parsed);
};
