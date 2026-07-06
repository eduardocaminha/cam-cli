// src/domain-docs/render.ts
//
// Pure types + validation + deterministic render/merge helpers for the
// domain-docs writer (CAM-118 US-001). No git, no fs, no I/O in this module:
// every export here is string-in/string-out so US-002 can inject a real
// filesystem/git layer around them.
//
// CONTEXT.md is glossary-only (term + definition), never implementation
// details, specs, or decisions -- see .claude/skills/domain-modeling/CONTEXT-FORMAT.md
// and the "Domain Model Convention" section of scripts/cam/CLAUDE.md.
// docs/adr/ files follow .claude/skills/domain-modeling/ADR-FORMAT.md.
//
// Project rule: no em-dash in rendered/persisted output. Use colon, comma,
// parens, or period instead.

/** A single glossary term destined for CONTEXT.md. */
export interface TermEntry {
	term: string;
	definition: string;
}

/** A single architectural decision record destined for docs/adr/. */
export interface AdrEntry {
	title: string;
	context: string;
	decision: string;
	consequences: string;
}

/** The structured payload the /cam-spec flow assembles for the domain-docs writer. */
export interface DomainDocsPayload {
	terms: TermEntry[];
	adrs: AdrEntry[];
}

/**
 * Validation result shape -- mirrors ValidationResult in src/issues/spec.ts
 * ({ ok, errors }).
 */
export interface ValidationResult {
	ok: boolean;
	errors: string[];
}

const LANGUAGE_HEADING = "## Language";
const DEFAULT_PREAMBLE = "# Context";

/** Returns true when v is a non-empty (non-blank) string. */
function isNonEmptyString(v: unknown): boolean {
	return typeof v === "string" && v.trim() !== "";
}

/**
 * Validates a DomainDocsPayload value. Returns { ok: true, errors: [] } on
 * success. An empty payload ({ terms: [], adrs: [] }) is a valid no-op.
 *
 * Rejects:
 *   - x is not an object (or is null / array)
 *   - terms is not an array, or any entry is missing a non-empty term/definition
 *   - adrs is not an array, or any entry is missing a non-empty
 *     title/context/decision/consequences
 */
export function validateDomainDocsPayload(x: unknown): ValidationResult {
	const errors: string[] = [];

	if (x === null || typeof x !== "object" || Array.isArray(x)) {
		errors.push("payload must be a non-null object");
		return { ok: false, errors };
	}

	const candidate = x as Record<string, unknown>;
	const terms = candidate["terms"];
	const adrs = candidate["adrs"];

	if (!Array.isArray(terms)) {
		errors.push("terms must be an array");
	} else {
		terms.forEach((entry, i) => {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
				errors.push(`terms[${i}] must be a non-null object`);
				return;
			}
			const t = entry as Record<string, unknown>;
			if (!isNonEmptyString(t["term"])) {
				errors.push(`terms[${i}].term must be a non-empty string`);
			}
			if (!isNonEmptyString(t["definition"])) {
				errors.push(`terms[${i}].definition must be a non-empty string`);
			}
		});
	}

	if (!Array.isArray(adrs)) {
		errors.push("adrs must be an array");
	} else {
		adrs.forEach((entry, i) => {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
				errors.push(`adrs[${i}] must be a non-null object`);
				return;
			}
			const a = entry as Record<string, unknown>;
			for (const field of ["title", "context", "decision", "consequences"] as const) {
				if (!isNonEmptyString(a[field])) {
					errors.push(`adrs[${i}].${field} must be a non-empty string`);
				}
			}
		});
	}

	return { ok: errors.length === 0, errors };
}

/** Renders a single term block: `**Term**:\nDefinition`. */
function renderTermBlock(entry: TermEntry): string {
	return `**${entry.term}**:\n${entry.definition}`;
}

/**
 * Parses the entries out of a "## Language" section body (the text AFTER the
 * heading, before any following top-level heading). Entries are separated by
 * one or more blank lines; each entry is `**Term**:\nDefinition`.
 */
function parseLanguageEntries(section: string): TermEntry[] {
	const trimmed = section.trim();
	if (trimmed === "") return [];

	const blocks = trimmed.split(/\n\n+/);
	const entries: TermEntry[] = [];
	for (const block of blocks) {
		const match = /^\*\*(.+?)\*\*:\n([\s\S]*)$/.exec(block);
		if (!match) continue;
		const term = (match[1] ?? "").trim();
		const definition = (match[2] ?? "").trim();
		if (term === "") continue;
		entries.push({ term, definition });
	}
	return entries;
}

interface ParsedContext {
	preamble: string;
	entries: TermEntry[];
}

/** Parses an existing CONTEXT.md into its preamble (title/description) and glossary entries. */
function parseContextMd(md: string): ParsedContext {
	const idx = md.indexOf(LANGUAGE_HEADING);
	if (idx === -1) {
		return { preamble: md.trimEnd(), entries: [] };
	}
	const preamble = md.slice(0, idx).trimEnd();
	const languageSection = md.slice(idx + LANGUAGE_HEADING.length);
	return { preamble, entries: parseLanguageEntries(languageSection) };
}

/** Reconstructs CONTEXT.md from a preamble and a list of glossary entries. */
function renderContextMd(preamble: string, entries: TermEntry[]): string {
	const body = entries.map(renderTermBlock).join("\n\n");
	const languageSection = body === "" ? LANGUAGE_HEADING : `${LANGUAGE_HEADING}\n\n${body}`;
	return `${preamble}\n\n${languageSection}\n`;
}

/**
 * Merges new glossary terms into an existing CONTEXT.md (or creates a fresh
 * one, glossary-only, when existing is null). Updates the definition in
 * place when a term already exists (matched by trimmed term text); appends
 * otherwise. Idempotent: merging the same terms twice yields byte-identical
 * output.
 */
export function mergeContextMd(existing: string | null, terms: TermEntry[]): string {
	const parsed = existing === null ? { preamble: DEFAULT_PREAMBLE, entries: [] } : parseContextMd(existing);
	const mergedEntries: TermEntry[] = [...parsed.entries];

	for (const incoming of terms) {
		const term = incoming.term.trim();
		const definition = incoming.definition.trim();
		const idx = mergedEntries.findIndex((e) => e.term === term);
		if (idx === -1) {
			mergedEntries.push({ term, definition });
		} else {
			mergedEntries[idx] = { term, definition };
		}
	}

	return renderContextMd(parsed.preamble, mergedEntries);
}

/**
 * Renders a single ADR file body as a section skeleton (title + Context +
 * Decision + Consequences), per .claude/skills/domain-modeling/ADR-FORMAT.md.
 */
export function renderAdr(number: string, adr: AdrEntry): string {
	return [
		`# ADR ${number}: ${adr.title.trim()}`,
		"",
		"## Context",
		"",
		adr.context.trim(),
		"",
		"## Decision",
		"",
		adr.decision.trim(),
		"",
		"## Consequences",
		"",
		adr.consequences.trim(),
		"",
	].join("\n");
}

/**
 * Returns the next sequential ADR number (zero-padded to 4 digits) given the
 * existing filenames in docs/adr/. Scans each filename for a leading 4-digit
 * prefix (e.g. "0009-foo.md" -> 9) and returns max + 1. Empty input -> "0001".
 */
export function nextAdrNumber(existingFilenames: string[]): string {
	let max = 0;
	for (const name of existingFilenames) {
		const match = /^(\d{4})-/.exec(name);
		if (!match) continue;
		const num = Number(match[1] ?? "0");
		if (Number.isFinite(num) && num > max) max = num;
	}
	return String(max + 1).padStart(4, "0");
}

/** Slugifies an ADR title for use in its filename (lowercase, hyphen-separated). */
export function slugifyAdrTitle(title: string): string {
	return title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Returns the target filename for an ADR: NNNN-<slug-from-title>.md. */
export function adrFilename(number: string, title: string): string {
	return `${number}-${slugifyAdrTitle(title)}.md`;
}
