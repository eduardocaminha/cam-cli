// src/config/toml.ts
//
// Minimal TOML reader + writer for `~/.config/cam/config.toml`.
//
// Why a hand-rolled writer? Bun ships `Bun.TOML.parse` (verified against
// https://bun.com/reference/bun/TOML/parse — current API is `parse(input: string): object`)
// but does NOT ship a stringifier (tracked in oven-sh/bun#22219). The official
// recommendation is the `@std/toml` package on JSR, but we don't want a runtime
// dep just for serializing a 2-key config file.
//
// The writer here intentionally supports only the subset of TOML the cam CLI
// emits and consumes: top-level string/boolean/number scalars, plus single-level
// `[section]` tables with string/boolean/number scalars. Arrays, nested tables,
// inline tables, multi-line strings, and dates are deliberately out of scope —
// if the schema ever grows past that, swap in `@std/toml`.
//
// The PRESERVATION contract: `loadConfig(p)` parses the existing file via
// `Bun.TOML.parse` (full TOML support — we don't restrict reads); `saveConfig`
// emits only what we know how to serialize. A round-trip on a config that uses
// out-of-scope features will lose those features. That's acceptable for our
// own writes; the file is owned by cam CLI, not hand-edited by users for
// novel TOML features.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type TomlScalar = string | boolean | number;
export type TomlSection = Record<string, TomlScalar>;
export type TomlConfig = Record<string, TomlScalar | TomlSection>;

/**
 * Optional comment lines to render under a `[section]` header, keyed by
 * section name. Each entry is rendered as its own `# <line>` line, placed
 * immediately after the `[section]` header and before that section's active
 * keys. A section can carry comments with zero active keys (pass `{}` as the
 * section's value in `TomlConfig`) to scaffold a fully commented-out example
 * block — the section header still emits, but no live keys follow.
 *
 * Comments are non-semantic: TOML strips `#` to end-of-line, so
 * `parseToml(stringifyToml(config, comments))` deep-equals `config` — the
 * comment text never appears as a key in the parsed result.
 */
export type TomlComments = Record<string, string[]>;

/**
 * Stringify a TOML scalar value. Strings get double-quoted with `\` and `"`
 * escaped; booleans/numbers use their canonical representation.
 *
 * NOTE: We don't currently emit any string that would contain a control
 * character or non-ASCII glyph (the only writes are config values like
 * `bypassPermissions`), so the escape table is intentionally minimal.
 * If a future caller passes through user-supplied strings, expand the escape
 * set per https://toml.io/en/v1.0.0#string.
 */
function stringifyScalar(value: TomlScalar): string {
	if (typeof value === 'string') {
		const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		return `"${escaped}"`;
	}
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error(`toml: cannot serialize non-finite number ${value}`);
		}
		return String(value);
	}
	throw new Error(`toml: unsupported scalar type ${typeof value}`);
}

/**
 * Serialize a `TomlConfig` to a TOML string.
 *
 * Emit order:
 *   1. All top-level scalars first (sorted by key for stable output).
 *   2. Then each section with its keys (sorted by key within the section,
 *      sections themselves sorted by section name).
 *
 * Stability matters: round-tripping via parse → modify → serialize is part of
 * the test contract, and unstable key order would cause spurious diffs in any
 * future "is the config dirty?" check.
 *
 * `comments` is optional and fully backward-compatible: omitting it (or
 * passing `undefined`) produces byte-identical output to calling
 * `stringifyToml(config)` before this parameter existed. When supplied, it
 * renders `# `-prefixed comment lines under the matching `[section]` header
 * (see `TomlComments`) — useful for `cam init` to scaffold self-documenting
 * example sections without adding live keys.
 */
export function stringifyToml(config: TomlConfig, comments?: TomlComments): string {
	const topLevel: Array<[string, TomlScalar]> = [];
	const sections: Array<[string, TomlSection]> = [];

	for (const [key, value] of Object.entries(config)) {
		if (value === null || value === undefined) continue;
		if (typeof value === 'object') {
			sections.push([key, value as TomlSection]);
		} else {
			topLevel.push([key, value]);
		}
	}

	topLevel.sort(([a], [b]) => a.localeCompare(b));
	sections.sort(([a], [b]) => a.localeCompare(b));

	const lines: string[] = [];
	for (const [key, value] of topLevel) {
		lines.push(`${key} = ${stringifyScalar(value)}`);
	}
	for (const [name, section] of sections) {
		if (lines.length > 0) lines.push('');
		lines.push(...renderSectionLines(name, section, comments?.[name]));
	}
	return `${lines.join('\n')}\n`;
}

/** Render a single `[name]` section header plus its optional comment lines and sorted entries. */
function renderSectionLines(name: string, section: TomlSection, commentLines?: string[]): string[] {
	const lines: string[] = [`[${name}]`];
	for (const commentLine of commentLines ?? []) {
		lines.push(`# ${commentLine}`);
	}
	const entries = Object.entries(section).sort(([a], [b]) => a.localeCompare(b));
	for (const [key, value] of entries) {
		lines.push(`${key} = ${stringifyScalar(value)}`);
	}
	return lines;
}

/**
 * Parse a TOML string via Bun's built-in parser. Returns an empty object for
 * an empty input string (Bun.TOML.parse('') returns `{}`, verified locally).
 * Throws `SyntaxError`-shaped errors for malformed input — callers in
 * `commands/init.ts` catch and surface those via `printError`.
 */
export function parseToml(text: string): TomlConfig {
	if (text.length === 0) return {};
	// Bun.TOML.parse signature: `parse(input: string): object`.
	// Type-asserting to TomlConfig is safe at runtime — we don't trust the
	// shape past `object`, but every consumer below re-checks types before
	// using fields.
	return Bun.TOML.parse(text) as TomlConfig;
}

/**
 * Load `path` if it exists; return `{}` for missing files. Reads via
 * `node:fs.readFileSync` rather than `Bun.file().text()` so the same code
 * works in tests under tmp-dirs without spinning up Bun's filesystem layer.
 *
 * The `null`-safe contract is important: `cam init` must work both on a
 * fresh machine (no `~/.config/cam/`) AND on a machine with prior config.
 * Returning `{}` for "missing file" means callers can mutate-and-save without
 * branching on existence.
 */
export function loadConfig(path: string): TomlConfig {
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, 'utf8');
	return parseToml(raw);
}

/**
 * Write `config` to `path`, creating parent directories as needed.
 * The directory chain is created with `recursive: true` so a fresh machine
 * (no `~/.config/`) gets the full path created in one call.
 *
 * The serialized output always ends in `\n` (trailing newline is part of
 * `stringifyToml`'s contract — matches the convention in the rest of the
 * repo and keeps `git diff` clean).
 */
export function saveConfig(path: string, config: TomlConfig): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, stringifyToml(config), 'utf8');
}

/**
 * Merge `updates` into the config at `path`, preserving any pre-existing keys
 * that aren't being overwritten.
 *
 * Used by `cam init` to set `permission_mode = "bypassPermissions"` without
 * clobbering keys a future story (or a hand-edit) may have added. Top-level
 * scalar updates and section-table updates both behave additively:
 *   - top-level scalar update → replaces that one key
 *   - section update → merges into existing section (new keys added,
 *     existing keys overwritten by the update, sibling keys preserved).
 */
export function mergeIntoConfig(path: string, updates: TomlConfig): TomlConfig {
	const current = loadConfig(path);
	const merged: TomlConfig = { ...current };
	for (const [key, value] of Object.entries(updates)) {
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
			const existing = merged[key];
			const existingSection: TomlSection =
				existing !== null && typeof existing === 'object' && !Array.isArray(existing)
					? (existing as TomlSection)
					: {};
			merged[key] = { ...existingSection, ...(value as TomlSection) };
		} else {
			merged[key] = value as TomlScalar;
		}
	}
	saveConfig(path, merged);
	return merged;
}
