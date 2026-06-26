// src/commands/setup-merge-mode.ts
//
// Pure, headlessly-testable helper for the merge-mode setup step.
//
// applyMergeMode() is extracted from the cam init flow so it can be
// unit-tested without touching the Ink/readline render path or a real gh
// binary (CAM-84 precedent).
//
// US-003 (CAM-101).

import type { SpawnFn } from '../release/branch-protection.ts';
import { configureBranchProtection } from '../release/branch-protection.ts';
import type { MergeMode } from '../config/models.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApplyMergeModeOutcome =
	| 'immediate-no-op'
	| 'configured-and-verified'
	| 'fallback-warned';

export interface ApplyMergeModeOptions {
	mergeMode: MergeMode;
	/**
	 * Owner/repo slug (e.g. "acme/my-repo"). If not provided, resolved via
	 * `gh repo view --json nameWithOwner` using the injected spawnFn.
	 * Injectable for tests so no real gh call is needed.
	 */
	ownerRepo?: string;
	/** Injectable spawnFn for all subprocess calls (gh api, gh repo view). */
	spawnFn: SpawnFn;
	emitHint?: (msg: string) => void;
	emitWarning?: (msg: string, hint?: string) => void;
	/** Receives the human-readable result line. */
	emitResult?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface NameWithOwnerResponse {
	nameWithOwner?: unknown;
}

function resolveOwnerRepo(spawnFn: SpawnFn): string | null {
	const result = spawnFn(
		'gh',
		['repo', 'view', '--json', 'nameWithOwner'],
		{ encoding: 'utf8' },
	);
	if ((result.status ?? 1) !== 0) return null;
	try {
		const parsed = JSON.parse(result.stdout) as NameWithOwnerResponse;
		const name = parsed.nameWithOwner;
		if (typeof name === 'string' && name.length > 0) return name;
	} catch {
		// parse error: fall through
	}
	return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply the merge-mode configuration step during cam init.
 *
 * - When mergeMode is 'immediate': no-op, returns 'immediate-no-op'.
 * - When mergeMode is 'ci-gated': invokes configureBranchProtection() and
 *   returns the outcome ('configured-and-verified' or 'fallback-warned').
 *
 * Never throws. All external I/O goes through the injected spawnFn.
 */
export function applyMergeMode(opts: ApplyMergeModeOptions): ApplyMergeModeOutcome {
	if (opts.mergeMode !== 'ci-gated') {
		return 'immediate-no-op';
	}

	const ownerRepo = opts.ownerRepo ?? resolveOwnerRepo(opts.spawnFn);
	if (!ownerRepo) {
		(opts.emitWarning ?? (() => {}))(
			'Could not resolve repo owner/name — branch protection skipped',
		);
		(opts.emitHint ?? (() => {}))(
			'Run `gh auth login` then re-run `cam init` to enable branch protection.',
		);
		(opts.emitResult ?? (() => {}))('⚠ Branch protection skipped (could not resolve repo)');
		return 'fallback-warned';
	}

	const bpResult = configureBranchProtection({
		ownerRepo,
		spawnFn: opts.spawnFn,
		emitHint: opts.emitHint,
		emitWarning: opts.emitWarning,
	});

	const line =
		bpResult.outcome === 'configured-and-verified'
			? '✓ Branch protection configured (ci check required on main)'
			: '⚠ Branch protection not fully applied — see hint above';

	(opts.emitResult ?? (() => {}))(line);

	return bpResult.outcome;
}
