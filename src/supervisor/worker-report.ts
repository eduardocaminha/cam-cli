// src/supervisor/worker-report.ts
//
// Types and helpers for the per-story structured report that the implementer
// worker writes at exit (US-003).
//
// Shape mirrors the CAM-52 verdict so future structured-outputs work can reuse
// it without schema changes.
//
// The worker (subagent-implementer) is responsible for exactly one thing here:
//   1. Populating a WorkerReport and writing it as JSON to WORKER_REPORT_FILENAME.
//
// The sidecar (makeNotifyOrchestrator in host.ts) is the sole caller of
// buildWorkerReportSendKeysArgv. It reads the report file as a push signal and
// pushes the one-line summary to the orchestrator pane (%0) via send-keys.
// The worker does NOT self-push (US-003/CAM-78 removed that path).

/** Structured report written by the implementer at /exit. */
export interface WorkerReport {
	/** Outcome token: mirrors CAM_IMPLEMENTER_STATUS values (DONE, BLOCKED_QUALITY, etc.). */
	outcome: string;
	/** Story ID that was implemented (e.g. "US-003"). */
	story: string;
	/** Quality-gate results. */
	gates: {
		/** "ok" or "fail: <detail>". */
		typecheck: string;
		/** "<N> pass / <M> fail" or "fail: <detail>". */
		tests: string;
	};
	/** One-line human note: gotcha, "none", or error summary. */
	notes: string;
}

/**
 * Relative path (from repo root) where the worker writes its report file.
 * The supervisor reads this file to detect completion (push event, US-008).
 */
export const WORKER_REPORT_FILENAME = 'scripts/cam/worker-report.json';

/**
 * Format a one-line human summary from a WorkerReport.
 * Used as the payload pushed to the orchestrator pane via send-keys.
 *
 * Example: "[cam] US-003 DONE: typecheck ok, 42 pass / 0 fail"
 */
export function formatWorkerReportSummary(report: WorkerReport): string {
	return `[cam] ${report.story} ${report.outcome}: typecheck ${report.gates.typecheck}, ${report.gates.tests}`;
}

/**
 * Format a one-line verdict line for the review branch orchestrator notification.
 * Lives next to formatWorkerReportSummary as a pure formatter (no I/O).
 *
 * @param round       The completed review round number (prd.review.roundsCompleted).
 * @param lastVerdict The verdict stored in prd.review.lastVerdict after reviewDispatch.
 *
 * Examples:
 *   formatReviewVerdictLine(1, 'CLEAN')            -> '[cam] review round 1: CLEAN'
 *   formatReviewVerdictLine(2, 'FIXES_PENDING:3')  -> '[cam] review round 2: FIXES_PENDING:3'
 *   formatReviewVerdictLine(4, 'MAX_ROUNDS_DEBT')  -> '[cam] review round 4: MAX_ROUNDS_DEBT'
 */
export function formatReviewVerdictLine(round: number, lastVerdict: string): string {
	return `[cam] review round ${round}: ${lastVerdict}`;
}

/**
 * Build the tmux argv for pushing the worker's one-line summary to the
 * orchestrator pane via send-keys.
 *
 * Invariants (memory: sendkeys-literal-enter-gotcha):
 *   - NO `-l`. With `-l` every argument is literal, so "Enter" is typed as the
 *     text "Enter" and the summary never submits. The summary is a single
 *     non-key-name argv element, so tmux already sends its characters literally
 *     ({, }, ", ;, spaces all land verbatim) without `-l`.
 *   - `Enter` is a SEPARATE key argument, never concatenated to the summary
 *     string, and stays a recognised key so the line submits.
 *   - Both summary and Enter are in the SAME send-keys call (one round-trip).
 *
 * The returned array is the full argv after "tmux" (pass as args to
 * spawn('tmux', argv)).
 *
 * @param orchPane  The tmux pane target, typically "%0".
 * @param summary   The one-line text to send (no newline; Enter is added here).
 */
export function buildWorkerReportSendKeysArgv(orchPane: string, summary: string): string[] {
	// Atomic: summary + Enter in ONE send-keys call, WITHOUT -l. A `-l` flag makes
	// EVERY argument literal, so "Enter" would be TYPED as the text "Enter" instead
	// of submitting (empirically verified, CAM-55: `send-keys -l X Enter` lands the
	// string "XEnter" in the pane, never a carriage return). `summary` is a single
	// non-key-name argv element, so tmux already sends its characters literally
	// (incl. {, }, ", :, spaces); only "Enter" must stay a recognised key.
	return ['-L', 'cam', 'send-keys', '-t', orchPane, summary, 'Enter'];
}
