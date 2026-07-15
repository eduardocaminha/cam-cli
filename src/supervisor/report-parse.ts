// src/supervisor/report-parse.ts
//
// Shared, hand-rolled, fail-closed parsers for the two structured exit reports
// written by cam workers: worker-report.json (implementer) and
// review-report.json (reviewer). Single source of truth so both the
// readFileSync consumers (host.ts) and the string-source consumer (result.ts)
// validate the same shape instead of duplicating ad-hoc guards.
//
// Contract: both parseWorkerReport and parseReviewReport take the raw file
// text, JSON.parse it internally, and NEVER throw. A report missing or
// mistyping its required discriminator (outcome+story for worker, verdict for
// review) yields null. Optional fields are validated only when present; their
// absence does not reject the report. A malformed nested field (present but
// wrong-shaped) is fail-closed: the whole report is rejected (null), not
// silently dropped.
//
// No zod / *.schema.json runtime loader: this project's convention is
// hand-rolled runtime guards (see the isObject idiom already used in
// result.ts and host.ts). Do not introduce a schema-validation dependency
// here.

import type { WorkerReport } from './worker-report.ts';
import type { ReviewFinding, ReviewReport } from './review-report.ts';

export type { WorkerReport, ReviewFinding, ReviewReport };

/** Runtime guard: is value a non-null, non-array object? */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Safely parse JSON text; returns null (never throws) on any parse error. */
function tryParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * Validate WorkerReport.gates when present: both typecheck and tests must be
 * strings. Returns false for any other shape (fail-closed).
 */
function isValidGates(gates: unknown): gates is { typecheck: string; tests: string } {
	if (!isObject(gates)) return false;
	return typeof gates.typecheck === 'string' && typeof gates.tests === 'string';
}

/**
 * Parse and validate a worker-report.json payload (raw file text).
 *
 * Required discriminator: outcome (string) + story (string). Missing or
 * mistyped -> null.
 *
 * Optional fields (gates, notes) are validated only when present:
 *   - gates: object with string typecheck + string tests, or absent.
 *   - notes: string, or absent.
 * A present-but-malformed optional field rejects the whole report (null).
 *
 * @param raw Raw JSON text (as read from scripts/cam/worker-report.json).
 * @returns The typed WorkerReport, or null (never throws).
 */
export function parseWorkerReport(raw: string): WorkerReport | null {
	const parsed = tryParseJson(raw);
	if (!isObject(parsed)) return null;

	const { outcome, story, gates, notes } = parsed;
	if (typeof outcome !== 'string' || typeof story !== 'string') return null;

	const report: WorkerReport = { outcome, story };

	if (gates !== undefined) {
		if (!isValidGates(gates)) return null;
		report.gates = gates;
	}

	if (notes !== undefined) {
		if (typeof notes !== 'string') return null;
		report.notes = notes;
	}

	return report;
}

/**
 * Validate a single findings[] entry: string severity + string text required;
 * optional file (string) and line (number) validated only when present.
 */
function isValidFinding(finding: unknown): finding is ReviewFinding {
	if (!isObject(finding)) return false;
	if (typeof finding.severity !== 'string') return false;
	if (typeof finding.text !== 'string') return false;
	if (finding.file !== undefined && typeof finding.file !== 'string') return false;
	if (finding.line !== undefined && typeof finding.line !== 'number') return false;
	return true;
}

/**
 * Parse and validate a review-report.json payload (raw file text).
 *
 * Required discriminator: verdict (string). Missing or mistyped -> null.
 *
 * Optional fields (findings, artifactOfRecord) are validated only when
 * present:
 *   - findings: array of valid finding entries, or absent (defaults to []
 *     since ReviewReport.findings is non-optional on the type).
 *   - artifactOfRecord: string, or absent.
 * A present-but-malformed optional field (non-array findings, or any
 * malformed entry) rejects the whole report (null).
 *
 * @param raw Raw JSON text (as read from scripts/cam/review-report.json).
 * @returns The typed ReviewReport, or null (never throws).
 */
export function parseReviewReport(raw: string): ReviewReport | null {
	const parsed = tryParseJson(raw);
	if (!isObject(parsed)) return null;

	const { verdict, findings, artifactOfRecord } = parsed;
	if (typeof verdict !== 'string') return null;

	let parsedFindings: ReviewFinding[] = [];
	if (findings !== undefined) {
		if (!Array.isArray(findings) || !findings.every(isValidFinding)) return null;
		parsedFindings = findings;
	}

	const report: ReviewReport = { verdict, findings: parsedFindings };

	if (artifactOfRecord !== undefined) {
		if (typeof artifactOfRecord !== 'string') return null;
		report.artifactOfRecord = artifactOfRecord;
	}

	return report;
}
