// src/release/branch-protection.ts
//
// configureBranchProtection() -- injectable gh-api helper that:
//   1. PUTs branch protection on main requiring the 'ci' and 'ci-container'
//      required checks.
//   2. GETs the same endpoint to verify the rule applied.
//   3. Degrades to a verify+warn path when the gh api call fails (no admin, no auth).
//   4. Checks CAM-84 prerequisites (Allow auto-merge + Allow squash merging).
//
// DOC DEPRECATION: required_status_checks.contexts is the deprecated form;
// checks:[{context}] is the current form. PUT uses
// checks:[{context:"ci"},{context:"ci-container"}], but GET verification
// accepts either form (GitHub mirrors them) and requires BOTH contexts.
//
// ALL FOUR TOP-LEVEL PUT FIELDS ARE REQUIRED -- omitting any yields a 422:
//   required_status_checks, enforce_admins, required_pull_request_reviews,
//   restrictions.
// enforce_admins:false (operator decision: emergency force-merge preserved).
// required_pull_request_reviews:null (gotcha: non-null blocks auto-merge forever).
// strict:true (operator decision: branch must be up to date before merging).
//
// All external dependencies are injectable so the function is fully
// unit-testable without a real gh binary or network.
//
// US-002 (CAM-101).

import type { SpawnSyncReturns } from 'node:child_process';
import { printHint, printWarning } from '../logging/color.ts';
import { AUTOMERGE_NOTICE } from '../logging/notices.ts';

// ---------------------------------------------------------------------------
// Injectable dependency types
// ---------------------------------------------------------------------------

/**
 * Subset of node:child_process spawnSync we need.
 * Injectable so unit tests never shell out to a real gh binary or network.
 *
 * Widened from ship-finalize.ts SpawnFn: adds optional `input` (stdin pipe)
 * needed for `gh api --input -` to stream the PUT body without a temp file.
 * This is a strict superset; callers that never pass `input` are compatible.
 */
export type SpawnFn = (
	cmd: string,
	args: string[],
	options: { encoding: 'utf8'; input?: string },
) => SpawnSyncReturns<string>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discriminated outcome for configureBranchProtection.
 *
 * - 'configured-and-verified': PUT applied and GET confirmed both 'ci' and
 *   'ci-container' checks.
 * - 'fallback-warned': gh api failed or verification inconclusive; operator
 *   hint was emitted; the function did NOT throw.
 */
export type BranchProtectionOutcome = 'configured-and-verified' | 'fallback-warned';

export interface BranchProtectionResult {
	outcome: BranchProtectionOutcome;
	/**
	 * Manual setup hint surfaced to the operator on the fallback-warned path.
	 * Present when outcome is 'fallback-warned'.
	 */
	hint?: string;
	/**
	 * True only on the configured-and-verified path.
	 * False or absent when PUT succeeded but GET did not confirm the check.
	 */
	verified?: boolean;
}

export interface ConfigureBranchProtectionOptions {
	/** Owner/repo slug, e.g. "acme-org/my-repo". */
	ownerRepo: string;
	/** Injectable spawnFn for all gh api subprocess calls. */
	spawnFn: SpawnFn;
	/**
	 * Optional hint emitter. Defaults to printHint from logging/color.ts.
	 * Injectable for tests.
	 */
	emitHint?: (msg: string) => void;
	/**
	 * Optional warning emitter. Defaults to printWarning from logging/color.ts.
	 * Injectable for tests.
	 */
	emitWarning?: (msg: string, hint?: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACCEPT_HEADER = 'Accept: application/vnd.github+json';
/**
 * Required status checks. Both must be present as required checks: 'ci'
 * (US-101) and 'ci-container' (US-002, CAM-244) so Renovate's
 * container-scoped automerge rules wait on container validation.
 */
const REQUIRED_CHECK_NAMES = ['ci', 'ci-container'] as const;

/**
 * Manual branch-protection hint surfaced to the operator when the automated
 * configure step fails. Parallels AUTOMERGE_NOTICE from logging/notices.ts.
 */
export const BRANCH_PROTECTION_FALLBACK_HINT =
	"To enable manually: Settings > Branches > Add rule for 'main', check 'Require status checks to pass before merging', and add 'ci' and 'ci-container' as required checks.";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ProtectionGetResponse {
	required_status_checks?: {
		checks?: Array<{ context?: string }>;
		contexts?: string[];
	};
}

interface RepoSettingsResponse {
	allow_auto_merge?: boolean;
	allow_squash_merge?: boolean;
}

/** Return true when the given check name appears in either the checks or contexts array. */
function hasCheck(rsc: ProtectionGetResponse['required_status_checks'], name: string): boolean {
	if (!rsc) return false;
	if (Array.isArray(rsc.checks) && rsc.checks.some((c) => c.context === name)) {
		return true;
	}
	if (Array.isArray(rsc.contexts) && rsc.contexts.includes(name)) {
		return true;
	}
	return false;
}

/** Return true when BOTH required checks appear in either the checks or contexts array. */
function hasAllRequiredChecks(parsed: ProtectionGetResponse): boolean {
	const rsc = parsed.required_status_checks;
	return REQUIRED_CHECK_NAMES.every((name) => hasCheck(rsc, name));
}

/** Return true when the stdout/stderr text signals a permission or auth failure. */
function isPermissionError(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		text.includes('403') ||
		lower.includes('must have admin rights') ||
		lower.includes('no admin') ||
		lower.includes('not authorized') ||
		lower.includes('bad credentials')
	);
}

/** Build the protection PUT body (all four required top-level fields). */
function buildProtectionBody(): string {
	return JSON.stringify({
		required_status_checks: {
			strict: true,
			checks: REQUIRED_CHECK_NAMES.map((context) => ({ context })),
		},
		enforce_admins: false,
		required_pull_request_reviews: null,
		restrictions: null,
	});
}

// ---------------------------------------------------------------------------
// Step helpers (extracted to keep configureBranchProtection under complexity
// limits; CAM-60 factory/helper pattern)
// ---------------------------------------------------------------------------

type EmitWarningFn = (msg: string, hint?: string) => void;
type EmitHintFn = (msg: string) => void;

/**
 * PUT the branch protection rule.
 * Returns a fallback BranchProtectionResult on failure, null on success.
 */
function attemptProtectionPut(
	spawnFn: SpawnFn,
	ownerRepo: string,
	bodyJson: string,
	emitWarning: EmitWarningFn,
	emitHint: EmitHintFn,
): BranchProtectionResult | null {
	const endpoint = `repos/${ownerRepo}/branches/main/protection`;
	const putResult = spawnFn(
		'gh',
		['api', '-X', 'PUT', '--input', '-', '-H', ACCEPT_HEADER, endpoint],
		{ encoding: 'utf8', input: bodyJson },
	);
	if ((putResult.status ?? 1) !== 0) {
		const errText = ((putResult.stderr ?? '') + (putResult.stdout ?? '')).trim();
		const detail = isPermissionError(errText)
			? 'no admin rights on this repo'
			: errText.slice(0, 80) || 'gh api returned non-zero exit';
		emitWarning('branch-protection configure failed', detail);
		emitHint(BRANCH_PROTECTION_FALLBACK_HINT);
		return { outcome: 'fallback-warned', hint: BRANCH_PROTECTION_FALLBACK_HINT };
	}
	return null; // PUT succeeded
}

/**
 * GET-verify the protection rule.
 * Returns a fallback BranchProtectionResult when the check is not confirmed,
 * null when verified OK.
 */
function verifyProtectionGet(
	spawnFn: SpawnFn,
	ownerRepo: string,
	emitWarning: EmitWarningFn,
	emitHint: EmitHintFn,
): BranchProtectionResult | null {
	const endpoint = `repos/${ownerRepo}/branches/main/protection`;
	const getResult = spawnFn('gh', ['api', '-H', ACCEPT_HEADER, endpoint], { encoding: 'utf8' });
	if ((getResult.status ?? 1) !== 0) {
		emitWarning('branch-protection verify failed', 'could not read protection settings after PUT');
		emitHint(BRANCH_PROTECTION_FALLBACK_HINT);
		return { outcome: 'fallback-warned', hint: BRANCH_PROTECTION_FALLBACK_HINT };
	}
	let verified = false;
	try {
		const parsed = JSON.parse(getResult.stdout) as ProtectionGetResponse;
		verified = hasAllRequiredChecks(parsed);
	} catch {
		verified = false;
	}
	if (!verified) {
		emitWarning(
			'branch-protection applied but ci/ci-container checks not found in verification response',
		);
		emitHint(BRANCH_PROTECTION_FALLBACK_HINT);
		return { outcome: 'fallback-warned', hint: BRANCH_PROTECTION_FALLBACK_HINT, verified: false };
	}
	return null; // verified OK
}

/**
 * Best-effort CAM-84 prereq check (Allow auto-merge + Allow squash merging).
 * Never blocks success; emits a hint if either setting is missing.
 */
function checkAutoMergePrereqs(
	spawnFn: SpawnFn,
	ownerRepo: string,
	emitHint: EmitHintFn,
): void {
	const repoResult = spawnFn(
		'gh', ['api', '-H', ACCEPT_HEADER, `repos/${ownerRepo}`], { encoding: 'utf8' },
	);
	if ((repoResult.status ?? 1) !== 0) return; // best-effort: skip on failure
	try {
		const repo = JSON.parse(repoResult.stdout) as RepoSettingsResponse;
		if (repo.allow_auto_merge !== true || repo.allow_squash_merge !== true) {
			emitHint(AUTOMERGE_NOTICE);
		}
	} catch {
		// Parse error: skip silently.
	}
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Configure branch protection on main requiring the 'ci' and 'ci-container'
 * status checks.
 *
 * Steps:
 *   1. PUT branch protection rule via gh api (all four required top-level fields).
 *   2. GET the same endpoint to verify both checks were applied.
 *   3. GET the repo settings to surface CAM-84 prereq hints (best-effort).
 *
 * Never throws. On gh api failure or verification failure, degrades to
 * 'fallback-warned' and emits a manual setup hint via emitHint.
 */
export function configureBranchProtection(
	opts: ConfigureBranchProtectionOptions,
): BranchProtectionResult {
	const { ownerRepo, spawnFn } = opts;
	const emitHint = opts.emitHint ?? printHint;
	const emitWarning = opts.emitWarning ?? printWarning;

	const bodyJson = buildProtectionBody();

	const putErr = attemptProtectionPut(spawnFn, ownerRepo, bodyJson, emitWarning, emitHint);
	if (putErr !== null) return putErr;

	const verifyErr = verifyProtectionGet(spawnFn, ownerRepo, emitWarning, emitHint);
	if (verifyErr !== null) return verifyErr;

	checkAutoMergePrereqs(spawnFn, ownerRepo, emitHint);
	return { outcome: 'configured-and-verified', verified: true };
}
