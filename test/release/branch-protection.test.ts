// test/release/branch-protection.test.ts
//
// Unit tests for configureBranchProtection (src/release/branch-protection.ts).
//
// All gh api calls are injected as fakes; no real gh binary or network is
// touched. Each test exercises a single behavior slice.
//
// AC-1: pure function with injectable SpawnFn, returns discriminated result.
// AC-2: PUT body contains all four required top-level fields.
// AC-3: PUT request sets Accept header to application/vnd.github+json.
// AC-4: GET verification accepts 'ci' in checks[] OR contexts[] (legacy).
// AC-5: fallback-warned on non-zero exit / 403 / no-admin / no-auth error.
// AC-6: CAM-84 prereqs checked; hint emitted when allow_auto_merge or
//        allow_squash_merge is off.
//
// US-002 (CAM-101).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	configureBranchProtection,
	BRANCH_PROTECTION_FALLBACK_HINT,
	type BranchProtectionResult,
	type SpawnFn,
} from '../../src/release/branch-protection.ts';
import { AUTOMERGE_NOTICE } from '../../src/logging/notices.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal SpawnSyncReturns<string> success value. */
function ok(stdout = ''): SpawnSyncReturns<string> {
	return {
		stdout,
		stderr: '',
		status: 0,
		pid: 1,
		output: [null, stdout, ''],
		signal: null,
		error: undefined,
	};
}

/** Build a minimal SpawnSyncReturns<string> failure value. */
function fail(
	stderr = '',
	stdout = '',
	status = 1,
): SpawnSyncReturns<string> {
	return {
		stdout,
		stderr,
		status,
		pid: 1,
		output: [null, stdout, stderr],
		signal: null,
		error: undefined,
	};
}

/** Minimal GET protection response with ci in the checks array. */
function protectionResponseChecks(): string {
	return JSON.stringify({
		required_status_checks: {
			strict: true,
			checks: [{ context: 'ci' }],
			contexts: [],
		},
	});
}

/** Minimal GET protection response with ci in the legacy contexts array. */
function protectionResponseContexts(): string {
	return JSON.stringify({
		required_status_checks: {
			strict: true,
			checks: [],
			contexts: ['ci'],
		},
	});
}

/** GET protection response without the ci check. */
function protectionResponseNoCi(): string {
	return JSON.stringify({
		required_status_checks: {
			strict: true,
			checks: [{ context: 'other-check' }],
			contexts: [],
		},
	});
}

/** Repo settings response with both CAM-84 prereqs enabled. */
function repoResponseOk(): string {
	return JSON.stringify({
		allow_auto_merge: true,
		allow_squash_merge: true,
	});
}

/** Repo settings response with allow_auto_merge disabled. */
function repoResponseNoAutoMerge(): string {
	return JSON.stringify({
		allow_auto_merge: false,
		allow_squash_merge: true,
	});
}

/** Repo settings response with allow_squash_merge disabled. */
function repoResponseNoSquash(): string {
	return JSON.stringify({
		allow_auto_merge: true,
		allow_squash_merge: false,
	});
}

interface CallRecord {
	cmd: string;
	args: string[];
	input?: string;
}

/**
 * Build a SpawnFn that sequences through the provided responses in order.
 * Records every call for assertion.
 */
function makeSeqSpawnFn(
	responses: SpawnSyncReturns<string>[],
): { spawnFn: SpawnFn; calls: CallRecord[] } {
	const calls: CallRecord[] = [];
	let idx = 0;

	function spawnFn(
		cmd: string,
		args: string[],
		options: { encoding: 'utf8'; input?: string },
	): SpawnSyncReturns<string> {
		calls.push({ cmd, args, input: options.input });
		const resp = responses[idx] ?? ok('');
		idx++;
		return resp;
	}

	return { spawnFn, calls };
}

/** Capture array for emitHint/emitWarning injection. */
function makeCaptures(): {
	hints: string[];
	warnings: Array<{ msg: string; hint?: string }>;
	emitHint: (msg: string) => void;
	emitWarning: (msg: string, hint?: string) => void;
} {
	const hints: string[] = [];
	const warnings: Array<{ msg: string; hint?: string }> = [];
	return {
		hints,
		warnings,
		emitHint: (msg) => hints.push(msg),
		emitWarning: (msg, hint) => warnings.push({ msg, hint }),
	};
}

const OWNER_REPO = 'test-org/test-repo';

// ---------------------------------------------------------------------------
// AC-1: function signature, result type
// ---------------------------------------------------------------------------

describe('AC-1: pure function with injectable SpawnFn and discriminated result', () => {
	test('returns BranchProtectionResult with outcome field', () => {
		const { spawnFn } = makeSeqSpawnFn([
			ok('{}'), // PUT
			ok(protectionResponseChecks()), // GET protection
			ok(repoResponseOk()), // GET repo
		]);
		const { emitHint, emitWarning } = makeCaptures();

		const result: BranchProtectionResult = configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		expect(typeof result.outcome).toBe('string');
		expect(['configured-and-verified', 'fallback-warned']).toContain(result.outcome);
	});
});

// ---------------------------------------------------------------------------
// AC-2: PUT body contains all four required top-level fields
// ---------------------------------------------------------------------------

describe('AC-2: PUT body has all four required top-level fields', () => {
	test('body includes required_status_checks with strict:true and checks:[{context:"ci"}]', () => {
		const { spawnFn, calls } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		const { emitHint, emitWarning } = makeCaptures();

		configureBranchProtection({ ownerRepo: OWNER_REPO, spawnFn, emitHint, emitWarning });

		const putCall = calls[0];
		expect(putCall).toBeDefined();
		const body = JSON.parse(putCall?.input ?? '{}');
		expect(body.required_status_checks).toEqual({
			strict: true,
			checks: [{ context: 'ci' }],
		});
	});

	test('body includes enforce_admins:false', () => {
		const { spawnFn, calls } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		const { emitHint, emitWarning } = makeCaptures();

		configureBranchProtection({ ownerRepo: OWNER_REPO, spawnFn, emitHint, emitWarning });

		const body = JSON.parse(calls[0]?.input ?? '{}');
		expect(body.enforce_admins).toBe(false);
	});

	test('body includes required_pull_request_reviews:null', () => {
		const { spawnFn, calls } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		const { emitHint, emitWarning } = makeCaptures();

		configureBranchProtection({ ownerRepo: OWNER_REPO, spawnFn, emitHint, emitWarning });

		const body = JSON.parse(calls[0]?.input ?? '{}');
		expect(body.required_pull_request_reviews).toBeNull();
	});

	test('body includes restrictions:null', () => {
		const { spawnFn, calls } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		const { emitHint, emitWarning } = makeCaptures();

		configureBranchProtection({ ownerRepo: OWNER_REPO, spawnFn, emitHint, emitWarning });

		const body = JSON.parse(calls[0]?.input ?? '{}');
		expect(body.restrictions).toBeNull();
	});

	test('PUT command targets the correct endpoint', () => {
		const { spawnFn, calls } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		const { emitHint, emitWarning } = makeCaptures();

		configureBranchProtection({ ownerRepo: OWNER_REPO, spawnFn, emitHint, emitWarning });

		const putArgs = calls[0]?.args ?? [];
		expect(putArgs).toContain('-X');
		expect(putArgs[putArgs.indexOf('-X') + 1]).toBe('PUT');
		expect(putArgs).toContain(`repos/${OWNER_REPO}/branches/main/protection`);
	});
});

// ---------------------------------------------------------------------------
// AC-3: PUT Accept header
// ---------------------------------------------------------------------------

describe('AC-3: PUT request sets Accept header to application/vnd.github+json', () => {
	test('PUT args include -H and Accept: application/vnd.github+json', () => {
		const { spawnFn, calls } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		const { emitHint, emitWarning } = makeCaptures();

		configureBranchProtection({ ownerRepo: OWNER_REPO, spawnFn, emitHint, emitWarning });

		const putArgs = calls[0]?.args ?? [];
		expect(putArgs).toContain('-H');
		const hIdx = putArgs.indexOf('-H');
		expect(putArgs[hIdx + 1]).toBe('Accept: application/vnd.github+json');
	});
});

// ---------------------------------------------------------------------------
// AC-4: GET verification checks array AND deprecated contexts array
// ---------------------------------------------------------------------------

describe('AC-4: GET verification accepts ci in checks[] or contexts[]', () => {
	test('configured-and-verified when ci is in checks array', () => {
		const { spawnFn } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		const { emitHint, emitWarning } = makeCaptures();

		const result = configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		expect(result.outcome).toBe('configured-and-verified');
		expect(result.verified).toBe(true);
	});

	test('configured-and-verified when ci is in deprecated contexts array', () => {
		const { spawnFn } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseContexts()),
			ok(repoResponseOk()),
		]);
		const { emitHint, emitWarning } = makeCaptures();

		const result = configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		expect(result.outcome).toBe('configured-and-verified');
		expect(result.verified).toBe(true);
	});

	test('fallback-warned when ci is absent from both checks and contexts', () => {
		const { spawnFn } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseNoCi()),
		]);
		const { emitHint, emitWarning } = makeCaptures();

		const result = configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		expect(result.outcome).toBe('fallback-warned');
		expect(result.verified).toBe(false);
		expect(result.hint).toBe(BRANCH_PROTECTION_FALLBACK_HINT);
	});

	test('GET endpoint matches PUT endpoint', () => {
		const { spawnFn, calls } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		const { emitHint, emitWarning } = makeCaptures();

		configureBranchProtection({ ownerRepo: OWNER_REPO, spawnFn, emitHint, emitWarning });

		const putEndpoint = calls[0]?.args.find((a) =>
			a.includes('branches/main/protection'),
		);
		const getEndpoint = calls[1]?.args.find((a) =>
			a.includes('branches/main/protection'),
		);
		expect(getEndpoint).toBe(putEndpoint);
	});
});

// ---------------------------------------------------------------------------
// AC-5: fallback-warned on non-zero / 403 / no-admin / no-auth errors
// ---------------------------------------------------------------------------

describe('AC-5: fallback-warned on gh api failure, does NOT throw', () => {
	test('fallback-warned when PUT exits non-zero', () => {
		const { spawnFn } = makeSeqSpawnFn([fail('some error', '', 1)]);
		const { emitHint, emitWarning, hints, warnings } = makeCaptures();

		let result: BranchProtectionResult | undefined;
		expect(() => {
			result = configureBranchProtection({
				ownerRepo: OWNER_REPO,
				spawnFn,
				emitHint,
				emitWarning,
			});
		}).not.toThrow();

		expect(result?.outcome).toBe('fallback-warned');
		expect(result?.hint).toBe(BRANCH_PROTECTION_FALLBACK_HINT);
		expect(hints).toContain(BRANCH_PROTECTION_FALLBACK_HINT);
		expect(warnings.length).toBeGreaterThan(0);
	});

	test('fallback-warned with no-admin detail when stderr contains 403', () => {
		const { spawnFn } = makeSeqSpawnFn([
			fail('HTTP 403: Must have admin rights to Repository.', '', 1),
		]);
		const { emitHint, emitWarning, warnings } = makeCaptures();

		const result = configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		expect(result.outcome).toBe('fallback-warned');
		const warning = warnings[0];
		expect(warning?.hint).toContain('no admin');
	});

	test('fallback-warned with no-admin detail when stderr contains no admin text', () => {
		const { spawnFn } = makeSeqSpawnFn([
			fail('must have admin rights to perform this action', '', 1),
		]);
		const { emitHint, emitWarning, warnings } = makeCaptures();

		const result = configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		expect(result.outcome).toBe('fallback-warned');
		expect(warnings[0]?.hint).toContain('no admin');
	});

	test('fallback-warned when stderr contains bad credentials', () => {
		const { spawnFn } = makeSeqSpawnFn([
			fail('Bad credentials', '', 1),
		]);
		const { emitHint, emitWarning, warnings } = makeCaptures();

		const result = configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		expect(result.outcome).toBe('fallback-warned');
		expect(warnings[0]?.hint).toContain('no admin');
	});

	test('fallback-warned when GET fails after successful PUT', () => {
		const { spawnFn } = makeSeqSpawnFn([
			ok('{}'), // PUT succeeds
			fail('server error', '', 500), // GET fails
		]);
		const { emitHint, emitWarning } = makeCaptures();

		const result = configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		expect(result.outcome).toBe('fallback-warned');
		expect(result.hint).toBe(BRANCH_PROTECTION_FALLBACK_HINT);
	});

	test('hint string contains manual setup instructions', () => {
		const { spawnFn } = makeSeqSpawnFn([fail('', '', 1)]);
		const { emitHint, emitWarning, hints } = makeCaptures();

		configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		const hint = hints.find((h) => h.includes("Settings > Branches"));
		expect(hint).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// AC-6: CAM-84 prerequisites check
// ---------------------------------------------------------------------------

describe('AC-6: CAM-84 prereqs checked, hint emitted when either is off', () => {
	test('no hint when both allow_auto_merge and allow_squash_merge are true', () => {
		const { spawnFn } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		const { emitHint, emitWarning, hints } = makeCaptures();

		const result = configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		expect(result.outcome).toBe('configured-and-verified');
		const automergeHints = hints.filter((h) => h.includes('auto-merge'));
		expect(automergeHints.length).toBe(0);
	});

	test('AUTOMERGE_NOTICE hint emitted when allow_auto_merge is false', () => {
		const { spawnFn } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseNoAutoMerge()),
		]);
		const { emitHint, emitWarning, hints } = makeCaptures();

		const result = configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		expect(result.outcome).toBe('configured-and-verified');
		expect(hints).toContain(AUTOMERGE_NOTICE);
	});

	test('AUTOMERGE_NOTICE hint emitted when allow_squash_merge is false', () => {
		const { spawnFn } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseNoSquash()),
		]);
		const { emitHint, emitWarning, hints } = makeCaptures();

		const result = configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		expect(result.outcome).toBe('configured-and-verified');
		expect(hints).toContain(AUTOMERGE_NOTICE);
	});

	test('success outcome is NOT blocked when repo GET fails', () => {
		const { spawnFn } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			fail('network error', '', 1), // repo GET fails
		]);
		const { emitHint, emitWarning } = makeCaptures();

		const result = configureBranchProtection({
			ownerRepo: OWNER_REPO,
			spawnFn,
			emitHint,
			emitWarning,
		});

		// Best-effort: repo GET failure does not downgrade the outcome.
		expect(result.outcome).toBe('configured-and-verified');
		expect(result.verified).toBe(true);
	});

	test('repo GET uses correct endpoint (repos/{owner}/{repo})', () => {
		const { spawnFn, calls } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		const { emitHint, emitWarning } = makeCaptures();

		configureBranchProtection({ ownerRepo: OWNER_REPO, spawnFn, emitHint, emitWarning });

		const repoGetArgs = calls[2]?.args ?? [];
		expect(repoGetArgs).toContain(`repos/${OWNER_REPO}`);
	});
});
