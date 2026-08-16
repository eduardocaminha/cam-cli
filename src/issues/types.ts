import type { Spec } from "./spec.ts";

/**
 * Lifecycle stage of a Gateship issue.
 *
 * idea       -> raw capture, no spec yet
 * specified  -> spec written (Epico B), ready for planning
 * planned    -> accepted for implementation
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
 * Legacy WSJF metadata. Gateship preserves it when reading old issue records
 * but no longer computes or uses it for ordering.
 */
export interface WsjfScore {
	value: number;
	timeCriticality: number;
	riskReduction: number;
	jobSize: number;
}

/**
 * Single issue entry in the per-file backlog (.gateship/issues/GSHIP-NNNN.json).
 *
 * Required fields form the minimum viable record (Epico A).
 * `wsjf` and `rank` are inert legacy fields kept only for old backlog records.
 */
export interface IssueEntry {
	id: string;
	title: string;
	stage: IssueStage;
	status: IssueStatus;
	blockedBy: string[];
	createdAt: string;
	updatedAt: string;
	description?: string;
	wsjf?: WsjfScore;
	rank?: number;
	spec?: Spec;
	specSource?: "interview" | "derived" | "operator";
	derivedFrom?: string[];
	type?: "feat" | "fix" | "chore" | "docs";
	/** Durable justification recorded when `status` becomes `abandoned`. */
	abandonedReason?: string;
}
