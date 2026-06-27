/**
 * Lifecycle stage of an issue in the cam issue system.
 *
 * idea       -> raw capture, no spec yet
 * specified  -> spec written (Epico B), ready for planning
 * planned    -> ranked + WSJF scored, ready for implementation
 * shipped    -> implemented and merged
 */
export type IssueStage = "idea" | "specified" | "planned" | "shipped";

/**
 * Open/closed status of an issue.
 *
 * open      -> active
 * abandoned -> closed without shipping (won't-fix / cancelled)
 */
export type IssueStatus = "open" | "abandoned";

/**
 * WSJF scoring fields (Weighted Shortest Job First).
 * All four components are required when wsjf is present.
 */
export interface WsjfScore {
	value: number;
	timeCriticality: number;
	riskReduction: number;
	jobSize: number;
}

/**
 * Single issue entry in issues.local.json.
 *
 * Required fields form the minimum viable record (Epico A).
 * Optional fields (wsjf, rank, spec) are populated in later epicos.
 */
export interface IssueEntry {
	id: string;
	title: string;
	stage: IssueStage;
	status: IssueStatus;
	blockedBy: string[];
	createdAt: string;
	description?: string;
	wsjf?: WsjfScore;
	rank?: number;
	spec?: unknown;
}

/**
 * Shape of the issues.local.json file on disk.
 */
export interface IssuesLocalJson {
	next_id: number;
	issues: IssueEntry[];
}
