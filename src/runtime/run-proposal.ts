/**
 * One idea outside the current issue that the executor found while
 * implementing it. The structured result carries drafts; the store turns each
 * accepted draft into a durable proposal. A proposal is evidence only: it never
 * touches run state, the issue, its spec, the approval, the backlog or the
 * order in which work runs.
 */
export interface ProposalDraft {
	title: string;
	evidence: string;
}

export type ProposalRelationship = 'derived-from';

export type ProposalStatus = 'pending';

export interface RunProposal extends ProposalDraft {
	id: string;
	relationship: ProposalRelationship;
	status: ProposalStatus;
	sourceRunId: string;
	sourceIssueId: string;
	createdAt: string;
	updatedAt: string;
}

/** Enforced on the structured result and again on every write. */
export const PROPOSAL_LIMITS = {
	maxItems: 3,
	title: 120,
	evidence: 600,
} as const;

function proposalText(value: unknown, limit: number): string {
	return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/**
 * Accepts any shape: an unusable item is dropped instead of failing the run
 * that produced it, because capture is never worth losing verified work over.
 */
export function normalizeProposalDrafts(value: unknown): ProposalDraft[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => {
			const record = item !== null && typeof item === 'object' && !Array.isArray(item)
				? item as Record<string, unknown>
				: {};
			return {
				title: proposalText(record['title'], PROPOSAL_LIMITS.title),
				evidence: proposalText(record['evidence'], PROPOSAL_LIMITS.evidence),
			};
		})
		.filter((draft) => draft.title.length > 0 && draft.evidence.length > 0)
		.slice(0, PROPOSAL_LIMITS.maxItems);
}
