// src/supervisor/behavioral-gate.ts
//
// Pure parser for per-story behavioral oracle directives (US-001, CAM-116).
//
// The CAM-109 planner appends [oracle: <kind-or-command>] suffixes to each
// acceptance criterion; this module extracts and classifies them so the shared
// behavioral gate (US-002) has a machine-readable target to drive and assert.
//
// Design:
//   - Pure: no I/O, no side-effects.
//   - Mirrors parseReviewVerdict in src/supervisor/review.ts.
//   - noUncheckedIndexedAccess: all regex capture groups guarded via ?? ''.

// ---------------------------------------------------------------------------
// Oracle directive types
// ---------------------------------------------------------------------------

/**
 * A shell command that must exit 0 to satisfy the criterion.
 * Examples: "bun run typecheck", "bun test", "grep -q 'x' path/to/file".
 */
export interface NamedCommandOracle {
	kind: 'named-command';
	/** The exact shell command to run. */
	command: string;
}

/**
 * A file-level assertion command (file-assert prefix, payload is the command).
 * Examples: "git diff --quiet src/supervisor/review-report.ts".
 */
export interface FileAssertOracle {
	kind: 'file-assert';
	/** The shell command to run as the file-level assertion. */
	command: string;
}

/** A criterion that requires reviewer or human judgment. Use sparingly. */
export interface ReviewerJudgmentOracle {
	kind: 'reviewer-judgment';
}

/**
 * A tmux-pty driven criterion: the verification tool is tmux-pty and the
 * criterion names an artifact reference the tool produces/checks.
 */
export interface TmuxPtyOracle {
	kind: 'tmux-pty';
	/** Verification tool name -- always 'tmux-pty'. */
	toolName: 'tmux-pty';
	/** The artifact reference the criterion names. */
	artifactRef: string;
}

/**
 * Returned for a malformed or empty oracle text. Never throws -- an
 * unparseable oracle must not crash the gate (AC3).
 */
export interface NoRunnableOracle {
	kind: 'no-oracle';
	/** The raw oracle text that could not be classified. */
	raw: string;
}

/** Discriminated union of all possible oracle directive shapes. */
export type OracleDirective =
	| NamedCommandOracle
	| FileAssertOracle
	| ReviewerJudgmentOracle
	| TmuxPtyOracle
	| NoRunnableOracle;

/** One oracle-carrying criterion paired with its parsed directive. */
export interface CriterionOracle {
	/** Zero-based index of the criterion in the acceptanceCriteria array. */
	criterionIndex: number;
	/** The parsed oracle directive for this criterion. */
	directive: OracleDirective;
}

// ---------------------------------------------------------------------------
// Parser implementation
// ---------------------------------------------------------------------------

/**
 * Matches the LAST [oracle: ...] suffix on a criterion string.
 * The leading `.*` is greedy: it consumes as much as possible so that
 * `\[oracle:` anchors to the LAST occurrence in the string (important when
 * the criterion text also mentions [oracle: ...] as an example in prose).
 * Capture group 1: the trimmed oracle text (may be empty for "[oracle: ]").
 * The suffix may be followed only by optional whitespace at end of string.
 */
const ORACLE_SUFFIX_RE = /.*\[oracle:\s*(.*?)\s*\]\s*$/;

/**
 * Classify the inner oracle text into a typed OracleDirective.
 */
function classifyOracleText(raw: string): OracleDirective {
	if (raw === '') {
		return { kind: 'no-oracle', raw };
	}

	if (raw === 'reviewer-judgment') {
		return { kind: 'reviewer-judgment' };
	}

	if (raw.startsWith('file-assert ')) {
		const command = raw.slice('file-assert '.length).trim();
		if (command === '') {
			return { kind: 'no-oracle', raw };
		}
		return { kind: 'file-assert', command };
	}

	if (raw.startsWith('tmux-pty ')) {
		const artifactRef = raw.slice('tmux-pty '.length).trim();
		if (artifactRef === '') {
			return { kind: 'no-oracle', raw };
		}
		return { kind: 'tmux-pty', toolName: 'tmux-pty', artifactRef };
	}

	// Everything else is a named-command (exact shell command to run).
	return { kind: 'named-command', command: raw };
}

/**
 * Extract and parse the [oracle: ...] directive from one acceptance criterion.
 *
 * Returns null when the criterion carries no [oracle: ...] suffix (criteria
 * without an oracle yield no directive per AC1).
 *
 * Returns a NoRunnableOracle when the suffix is present but the oracle text is
 * malformed or empty (graceful -- never throws, per AC3).
 */
export function parseOracleDirective(criterion: string): OracleDirective | null {
	const m = ORACLE_SUFFIX_RE.exec(criterion);
	if (m === null) return null;

	const raw = m[1] ?? '';
	return classifyOracleText(raw);
}

/**
 * Parse all [oracle: ...] directives from a PRD story's acceptanceCriteria.
 *
 * Returns one CriterionOracle per criterion that carries an [oracle: ...] suffix.
 * Criteria without a suffix are skipped (yield no entry in the result).
 * Malformed oracle text yields { kind: 'no-oracle' } rather than throwing.
 *
 * @param criteria - The acceptanceCriteria array from a PRD story record.
 * @returns Ordered list of criterion index + directive pairs.
 */
export function parseOracleDirectives(criteria: string[]): CriterionOracle[] {
	const results: CriterionOracle[] = [];

	for (let i = 0; i < criteria.length; i++) {
		const criterion = criteria[i];
		if (criterion === undefined) continue;

		const directive = parseOracleDirective(criterion);
		if (directive !== null) {
			results.push({ criterionIndex: i, directive });
		}
	}

	return results;
}
