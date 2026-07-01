// src/supervisor/plan-verdict-report.ts
//
// Types and constants for the per-plan-audit structured report that the auditor
// agent writes at exit (US-001, CAM-117 Half A).
//
// Shape mirrors the auditor's REAL output schema from .claude/agents/subagent-auditor.md
// 'Output format' block: top-level { verdict, summary, findings, metrics }, where each
// finding is { id, category, severity, storyId?, description, suggestion? }.
//
// The auditor (subagent-auditor) is responsible for:
//   1. Populating a PlanVerdictReport and writing it as JSON to
//      PLAN_VERDICT_REPORT_FILENAME before signalling completion.
//   2. NOT committing this file: it is ephemeral and gitignored.
//
// The plan-runner reads the report file as the structured verdict source
// (structured-handback channel, patterns.md 'capture-pane is rendered markdown').

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One finding from the auditor. */
export interface PlanVerdictFinding {
	/** Finding identifier (e.g. "A.completeness-001"). */
	id: string;
	/** Category string from the auditor schema (e.g. "A.completeness"). */
	category: string;
	/** Severity: "critical", "important", or "suggestion". */
	severity: string;
	/** Optional story ID this finding is scoped to. */
	storyId?: string;
	/** Human-readable description of what is wrong. */
	description: string;
	/** Optional suggestion for what to change. */
	suggestion?: string;
}

/**
 * Structured report written by the auditor at exit.
 * Mirrors the auditor's output schema verbatim so findings round-trip
 * into Half B (CAM-151 re-plan loop) with no schema change.
 * The `metrics` field is optional here: Half A does not branch on it.
 */
export interface PlanVerdictReport {
	/** Verdict: "APPROVE" or "BLOCK". The plan-runner branches ONLY on this field. */
	verdict: 'APPROVE' | 'BLOCK';
	/** One-sentence summary from the auditor. */
	summary: string;
	/** Zero or more structured findings; empty array on APPROVE with no issues. */
	findings: PlanVerdictFinding[];
	/** Optional per-severity counts; not consumed by Half A but preserved for Half B. */
	metrics?: Record<string, number>;
}

/**
 * Relative path (from repo root) where the auditor writes its report file.
 * Symmetric to REVIEW_REPORT_FILENAME in review-report.ts and
 * WORKER_REPORT_FILENAME in worker-report.ts.
 * The file is ephemeral and must NOT be committed (gitignored).
 */
export const PLAN_VERDICT_REPORT_FILENAME = 'scripts/cam/plan-verdict-report.json';

/**
 * Factory that builds a reader closure for the plan verdict report.
 *
 * Returns a function `() => PlanVerdictReport | null` that:
 *   - Reads `<cwd>/scripts/cam/plan-verdict-report.json`.
 *   - Returns null on any read or parse error (graceful degradation).
 *   - Validates the discriminator: rejects arrays and objects whose `verdict`
 *     field is not exactly the string 'APPROVE' or 'BLOCK' (JSON reader shape
 *     guard pattern, patterns.md 'JSON reader shape guards').
 *
 * Mirrors `makeReadReviewReport(cwd)` in host.ts as the precedent shape.
 */
export function makeReadPlanVerdict(cwd: string): () => PlanVerdictReport | null {
	const reportPath = join(cwd, PLAN_VERDICT_REPORT_FILENAME);
	return () => {
		try {
			if (!existsSync(reportPath)) {
				return null;
			}
			const raw = readFileSync(reportPath, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			// Shape guard (US-001, patterns.md 'JSON reader shape guards'):
			// - Must be a non-null, non-array object.
			// - `verdict` must be exactly 'APPROVE' or 'BLOCK'.
			// Anything else returns null so callers fall back gracefully.
			if (
				parsed !== null &&
				typeof parsed === 'object' &&
				!Array.isArray(parsed) &&
				((parsed as Record<string, unknown>)['verdict'] === 'APPROVE' ||
					(parsed as Record<string, unknown>)['verdict'] === 'BLOCK')
			) {
				return parsed as PlanVerdictReport;
			}
			return null;
		} catch {
			return null;
		}
	};
}
