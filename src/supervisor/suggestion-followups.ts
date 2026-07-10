// src/supervisor/suggestion-followups.ts
//
// Pure helpers (US-002, CAM-189) for turning reviewer SUGGESTION findings
// into deterministic, idempotent follow-up issues:
//   1. fingerprintFinding: stable short hash of a finding's normalized
//      file/line/text, used as the dedup key.
//   2. buildFollowUpIssue: title + description (with provenance and the
//      embedded fingerprint line) for a filed idea issue.
//   3. extractSuggestions / dedupSuggestions: filter a ReviewReport down to
//      the SUGGESTION findings that still need filing, given the currently
//      open backlog.
//
// This module is intentionally PURE: no git spawns, no fs reads. The US-003
// terminal hook in runSidecarLoop supplies the backlog (via
// readBacklogFromMain) and files the result via createLocalIssueOnMain.

import type { ReviewFinding, ReviewReport } from './review-report.ts';
import type { IssueEntry } from '../issues/types.ts';

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/** Length (hex chars) of the truncated sha256 fingerprint. */
const FINGERPRINT_LENGTH = 12;

/**
 * Stable short fingerprint of a SUGGESTION finding's normalized file, line,
 * and text. Two findings with the same text but a different file or line
 * fingerprint differently; a missing file or line is normalized to an empty
 * string, joined with "::" separators (never appears in a trimmed file path
 * or line number) so it can never collide with a distinct-text finding that
 * happens to share a normalized field.
 */
export function fingerprintFinding(finding: ReviewFinding): string {
	const normalizedFile = finding.file?.trim() ?? '';
	const normalizedLine = finding.line !== undefined ? String(finding.line) : '';
	const normalizedText = finding.text.trim();
	const input = [normalizedFile, normalizedLine, normalizedText].join('::');
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(input);
	return hasher.digest('hex').slice(0, FINGERPRINT_LENGTH);
}

// ---------------------------------------------------------------------------
// Issue builder
// ---------------------------------------------------------------------------

/** Marks the line in a filed issue's description that carries the dedup fingerprint. */
const SUGGESTION_FINGERPRINT_PREFIX = 'suggestion-fingerprint:';

/** Matches a suggestion-fingerprint line inside an issue description. */
const FINGERPRINT_LINE_RE = /suggestion-fingerprint:\s*([0-9a-f]+)/;

/** Max visible length of a filed follow-up issue's title before truncation. */
const TITLE_MAX_LEN = 80;

function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** Where the SUGGESTION was found: a source branch name, or a cycle id, plus the review round. */
export interface FollowUpProvenance {
	/** Source branch name or cycle id identifying where the review ran. */
	source: string;
	/** Completed review round number, when available. */
	round?: number;
	/**
	 * Parent issue number backing the PRD cycle whose review produced this
	 * SUGGESTION (PrdSnapshot.issueNumber, US-001 CAM-263). Undefined when the
	 * parent issue is genuinely unavailable (e.g. a hand-authored PRD with no
	 * backing issue); the filing path (makeProductionFileSuggestionsFn) is
	 * responsible for resolving this into a `derivedFrom` link, never this
	 * module (buildFollowUpIssue's title/description stay unchanged by this
	 * field -- derivedFrom is additive structured metadata, not prose).
	 */
	parentIssue?: number;
}

/** Title + description for a filed follow-up idea issue. */
export interface FollowUpIssue {
	title: string;
	description: string;
}

/**
 * Build the title and description for a follow-up idea issue from a
 * SUGGESTION finding. Title is the truncated finding text; description is
 * the full finding text plus provenance (source, round when available,
 * file:line when present) plus a suggestion-fingerprint line embedding the
 * finding's fingerprint hash, so a later dedup pass can recognize it.
 */
export function buildFollowUpIssue(
	finding: ReviewFinding,
	provenance: FollowUpProvenance,
): FollowUpIssue {
	const title = truncateText(finding.text, TITLE_MAX_LEN);

	const provenanceLines = [`Source: ${provenance.source}`];
	if (provenance.round !== undefined) {
		provenanceLines.push(`Review round: ${provenance.round}`);
	}
	if (finding.file !== undefined) {
		const location = finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
		provenanceLines.push(`Location: ${location}`);
	}

	const fingerprint = fingerprintFinding(finding);
	const description = [
		finding.text,
		'',
		...provenanceLines,
		'',
		`${SUGGESTION_FINGERPRINT_PREFIX} ${fingerprint}`,
	].join('\n');

	return { title, description };
}

// ---------------------------------------------------------------------------
// Extraction + dedup
// ---------------------------------------------------------------------------

/** Filters a ReviewReport's findings down to severity SUGGESTION only. */
export function extractSuggestions(report: ReviewReport): ReviewFinding[] {
	return report.findings.filter((finding) => finding.severity === 'SUGGESTION');
}

/**
 * Given the currently open backlog entries and a terminal ReviewReport,
 * returns only the SUGGESTION findings that still need filing: their
 * fingerprint does not already appear in any open issue's description, and
 * duplicates within the same report batch are collapsed to the first
 * occurrence.
 */
export function dedupSuggestions(backlog: IssueEntry[], report: ReviewReport): ReviewFinding[] {
	const openFingerprints = new Set<string>();
	for (const entry of backlog) {
		if (entry.status !== 'open' || entry.description === undefined) continue;
		const match = entry.description.match(FINGERPRINT_LINE_RE);
		const fingerprint = match?.[1];
		if (fingerprint !== undefined) {
			openFingerprints.add(fingerprint);
		}
	}

	const seenInBatch = new Set<string>();
	const toFile: ReviewFinding[] = [];
	for (const finding of extractSuggestions(report)) {
		const fingerprint = fingerprintFinding(finding);
		if (openFingerprints.has(fingerprint) || seenInBatch.has(fingerprint)) continue;
		seenInBatch.add(fingerprint);
		toFile.push(finding);
	}
	return toFile;
}
