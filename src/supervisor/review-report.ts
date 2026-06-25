// src/supervisor/review-report.ts
//
// Types and constants for the per-review structured report that the reviewer
// agent writes at exit (US-001, CAM-75).
//
// Shape mirrors worker-report.ts (WorkerReport / WORKER_REPORT_FILENAME) so the
// sidecar can source review findings from a structured file instead of scraping
// rendered pane markdown (the "structured-handback" model from CAM-75/CAM-77).
//
// The reviewer (subagent-reviewer) is responsible for:
//   1. Populating a ReviewReport and writing it as JSON to REVIEW_REPORT_FILENAME
//      before emitting the terminal verdict tag.
//   2. NOT committing this file: it is ephemeral and overwritten on each review
//      invocation. It is gitignored at both .gitignore and templates/.gitignore.
//
// The supervisor reads the report file as the structured findings source.
// Future stories (US-002+) will wire this into the review dispatch loop;
// this module (US-001) only mandates the writer-side schema + constant.

/** One finding from the reviewer. */
export interface ReviewFinding {
	/** Severity category: "CRITICAL", "WARNING", or "SUGGESTION". */
	severity: string;
	/** Optional source file path associated with this finding. */
	file?: string;
	/** Optional line number within the file. */
	line?: number;
	/** Human-readable finding text. */
	text: string;
}

/** Structured report written by the reviewer at exit. */
export interface ReviewReport {
	/** Verdict string matching the terminal tag content: "CLEAN" or "FIXES_PENDING:N". */
	verdict: string;
	/** Zero or more findings; empty array when verdict is CLEAN. */
	findings: ReviewFinding[];
}

/**
 * Relative path (from repo root) where the reviewer writes its report file.
 * Symmetric to WORKER_REPORT_FILENAME in worker-report.ts.
 * The file is ephemeral and must NOT be committed (gitignored).
 */
export const REVIEW_REPORT_FILENAME = 'scripts/cam/review-report.json';
