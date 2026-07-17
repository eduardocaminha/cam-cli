// src/supervisor/scope-proposal.ts
//
// Types and constants for the deterministic plan scope-proposal artifact
// (US-002, CAM-52) that the planner writes at plan completion, alongside
// prd.json.
//
// Shape mirrors the planner's 'Scope-Proposal Artifact' section in
// .claude/agents/subagent-planner.md: a fixed-shape summary { problem,
// inScopeStories, outOfScope, framing } where framing captures the
// MVP-vs-launch-ready split for the cycle.
//
// The planner (subagent-planner) is responsible for:
//   1. Populating a ScopeProposal and writing it as JSON to
//      SCOPE_PROPOSAL_FILENAME at plan completion (right after prd.json).
//   2. NOT committing this file: it is ephemeral and gitignored.
//
// The plan-runner reads the artifact via makeReadScopeProposal and narrates
// it at plan completion (structured-handback channel, patterns.md
// 'capture-pane is rendered markdown'). Per ADR-0038, validation is a
// hand-rolled TS guard consistent with makeReadPlanVerdict
// (plan-verdict-report.ts): no zod, no JSON-schema loader.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** MVP-vs-launch-ready framing for the scope proposal. */
export interface ScopeProposalFraming {
	/** What ships in THIS PRD to reach a minimal working slice. */
	mvp: string;
	/** What remains before the feature is launch-ready ("same as MVP" when nothing remains). */
	launchReady: string;
}

/**
 * Fixed-shape deterministic scope summary emitted at plan completion.
 * Mirrors the CONTEXT.md glossary entry 'scope-proposal artifact'.
 */
export interface ScopeProposal {
	/** One-sentence problem statement, from the issue body. */
	problem: string;
	/** Story ids from prd.json's userStories, copied verbatim. */
	inScopeStories: string[];
	/** Things deliberately deferred this cycle. `["none"]` when nothing is deferred. */
	outOfScope: string[];
	/** MVP-vs-launch-ready framing. */
	framing: ScopeProposalFraming;
}

/**
 * Relative path (from repo root) where the planner writes its scope-proposal
 * artifact. Symmetric to PLAN_VERDICT_REPORT_FILENAME in plan-verdict-report.ts.
 * The file is ephemeral and must NOT be committed (gitignored).
 */
export const SCOPE_PROPOSAL_FILENAME = 'scripts/cam/scope-proposal.json';

/**
 * Factory that builds a reader closure for the scope-proposal artifact.
 *
 * Returns a function `() => ScopeProposal | null` that:
 *   - Reads `<cwd>/scripts/cam/scope-proposal.json`.
 *   - Returns null on any read or parse error (graceful degradation).
 *   - Validates every required field (JSON reader shape guard pattern,
 *     patterns.md 'JSON reader shape guards': validate discriminator fields,
 *     not just typeof): `problem` is a string, `inScopeStories` and
 *     `outOfScope` are string arrays, `framing` is an object whose `mvp` and
 *     `launchReady` are strings.
 *
 * Mirrors makeReadPlanVerdict (plan-verdict-report.ts) as the precedent shape.
 */
export function makeReadScopeProposal(cwd: string): () => ScopeProposal | null {
	const proposalPath = join(cwd, SCOPE_PROPOSAL_FILENAME);
	return () => {
		try {
			if (!existsSync(proposalPath)) {
				return null;
			}
			const raw = readFileSync(proposalPath, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			if (!isScopeProposalShape(parsed)) {
				return null;
			}
			return parsed;
		} catch {
			return null;
		}
	};
}

/** Shape guard: every required field present with the correct type. */
function isScopeProposalShape(value: unknown): value is ScopeProposal {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	if (typeof obj['problem'] !== 'string') {
		return false;
	}
	if (!isStringArray(obj['inScopeStories']) || !isStringArray(obj['outOfScope'])) {
		return false;
	}
	const framing = obj['framing'];
	if (framing === null || typeof framing !== 'object' || Array.isArray(framing)) {
		return false;
	}
	const framingObj = framing as Record<string, unknown>;
	return typeof framingObj['mvp'] === 'string' && typeof framingObj['launchReady'] === 'string';
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
