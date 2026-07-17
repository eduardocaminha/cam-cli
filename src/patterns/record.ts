// src/patterns/record.ts
//
// Typed pattern-record schema, hand-rolled guard, and confirmation-scoring
// (US-001, CAM-64 "mulch model" port).
//
// Structured PatternRecord entries replace free-text scripts/cam/patterns.md
// bullets as the going-forward write path. This module owns:
//   - PatternRecord: the typed record shape.
//   - isPatternRecord: a hand-rolled typeof guard (ADR-0038 style -- no zod,
//     no JSON-schema-validator loader). Fail-closed: returns false on any
//     malformed input, never throws.
//   - parsePatternRecordsJsonl: a JSONL parser that skips/drops unparseable
//     or malformed lines rather than throwing.
//   - confirmationScore: successCount + 0.5 * partialCount over a record's
//     outcomes[], feeding the future decay/demotion gate (US-004,
//     `cam patterns prune`).
//
// No zod / *.schema.json runtime loader: this project's convention is
// hand-rolled runtime guards (see src/supervisor/report-parse.ts, ADR-0038).
// Do not introduce a schema-validation dependency here.

/** Confidence/authority tier, orthogonal to a record's accumulated outcome history. */
export type PatternClassification = 'foundational' | 'tactical' | 'observational';

/** Result of applying a pattern once; appended to PatternRecord.outcomes[]. */
export type PatternOutcomeStatus = 'success' | 'failure' | 'partial';

/** A single outcome entry recorded each time the pattern is applied. */
export interface PatternOutcome {
	status: PatternOutcomeStatus;
	/** ISO 8601 timestamp of when this outcome was recorded. */
	recorded_at: string;
}

/**
 * A schema-validated pattern record, replacing a free-text patterns.md
 * bullet. `dir_anchors` scopes the record to the directories/paths a story
 * touches, letting grep-on-demand filter records by subsystem.
 */
export interface PatternRecord {
	type: string;
	classification: PatternClassification;
	/** ISO 8601 timestamp of when the record was first written. */
	recorded_at: string;
	name: string;
	description: string;
	evidence: string;
	dir_anchors: string[];
	outcomes: PatternOutcome[];
}

/** Runtime guard: is value a non-null, non-array object? */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPatternClassification(value: unknown): value is PatternClassification {
	return value === 'foundational' || value === 'tactical' || value === 'observational';
}

function isPatternOutcomeStatus(value: unknown): value is PatternOutcomeStatus {
	return value === 'success' || value === 'failure' || value === 'partial';
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isPatternOutcome(value: unknown): value is PatternOutcome {
	if (!isObject(value)) return false;
	if (!isPatternOutcomeStatus(value.status)) return false;
	if (typeof value.recorded_at !== 'string') return false;
	return true;
}

/**
 * Hand-rolled typeof guard (ADR-0038 style: no zod, no JSON-schema-validator
 * loader). Fail-closed: returns false for any malformed input, never throws.
 */
export function isPatternRecord(value: unknown): value is PatternRecord {
	if (!isObject(value)) return false;
	if (typeof value.type !== 'string') return false;
	if (!isPatternClassification(value.classification)) return false;
	if (typeof value.recorded_at !== 'string') return false;
	if (typeof value.name !== 'string') return false;
	if (typeof value.description !== 'string') return false;
	if (typeof value.evidence !== 'string') return false;
	if (!isStringArray(value.dir_anchors)) return false;
	if (!Array.isArray(value.outcomes) || !value.outcomes.every(isPatternOutcome)) return false;
	return true;
}

/**
 * Parse a JSONL blob of pattern records. Fail-closed per line: a line that
 * fails JSON.parse, or parses but fails isPatternRecord, is dropped silently
 * rather than thrown. Blank lines are skipped.
 *
 * @param raw Raw JSONL text (one PatternRecord per line).
 * @returns The subset of lines that parsed into valid PatternRecords.
 */
export function parsePatternRecordsJsonl(raw: string): PatternRecord[] {
	const records: PatternRecord[] = [];
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (isPatternRecord(parsed)) records.push(parsed);
	}
	return records;
}

/**
 * Confirmation score for a pattern record: successCount + 0.5 * partialCount
 * over its outcomes[]. `failure` entries contribute 0. Feeds the decay/
 * demotion gate (US-004, `cam patterns prune`): a low score signals an
 * unconfirmed or under-performing pattern.
 */
export function confirmationScore(record: PatternRecord): number {
	let successCount = 0;
	let partialCount = 0;
	for (const outcome of record.outcomes) {
		if (outcome.status === 'success') successCount += 1;
		else if (outcome.status === 'partial') partialCount += 1;
	}
	return successCount + 0.5 * partialCount;
}
