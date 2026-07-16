// test/supervisor/in-progress-conflict.test.ts
//
// Unit + real-git tests for the in-progress-work conflict gate (US-004,
// CAM-241/153).
//
// Coverage:
//   AC1: hasIncompletePrd / isCamFeatureBranch / detectInProgressConflict --
//        the pure detection predicates (mirrors decideNextAction's partition).
//   AC1: readHeadBranchName -- real git tmpdir, proves the branch-name read
//        against `git symbolic-ref --short HEAD` (main, cam/*, detached HEAD).
//   AC2: buildInProgressConflictContext -- free-text context naming which
//        half fired.
//   AC3: makeInProgressConflictResolver -- continue/ship/abandon resolution,
//        including the destructive abandon path against a REAL tmpdir +
//        real git repo (rm handoff.json, rm prd.json, git checkout main).

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	IN_PROGRESS_CONFLICT_GATE,
	IN_PROGRESS_CONFLICT_OPTIONS,
	hasIncompletePrd,
	isCamFeatureBranch,
	detectInProgressConflict,
	buildInProgressConflictContext,
	readHeadBranchName,
	makeInProgressConflictResolver,
	type InProgressConflictResolverDeps,
} from '../../src/supervisor/in-progress-conflict.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import type { CamGate } from '../../src/supervisor/gate.ts';
import type { SpawnFn } from '../../src/supervisor/loop.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('IN_PROGRESS_CONFLICT_GATE and IN_PROGRESS_CONFLICT_OPTIONS are the exact discriminator/options (AC2)', () => {
	expect(IN_PROGRESS_CONFLICT_GATE).toBe('in-progress-conflict');
	expect(IN_PROGRESS_CONFLICT_OPTIONS).toEqual(['continue', 'ship', 'abandon']);
});

// ---------------------------------------------------------------------------
// AC1: hasIncompletePrd
// ---------------------------------------------------------------------------

describe('hasIncompletePrd (AC1)', () => {
	test('null prd -> false', () => {
		expect(hasIncompletePrd(null)).toBe(false);
	});

	test('prd with no userStories field -> false', () => {
		expect(hasIncompletePrd({})).toBe(false);
	});

	test('prd with all stories passing -> false', () => {
		const prd: PrdSnapshot = { userStories: [{ id: 'US-001', passes: true }] };
		expect(hasIncompletePrd(prd)).toBe(false);
	});

	test('prd with a non-operator passes:false story -> true', () => {
		const prd: PrdSnapshot = { userStories: [{ id: 'US-001', passes: false }] };
		expect(hasIncompletePrd(prd)).toBe(true);
	});

	test('prd with ONLY an operator-required passes:false story -> false', () => {
		const prd: PrdSnapshot = { userStories: [{ id: 'US-001', passes: false, requires: 'operator' }] };
		expect(hasIncompletePrd(prd)).toBe(false);
	});

	test('prd with a mix (operator incomplete + non-operator complete) -> false', () => {
		const prd: PrdSnapshot = {
			userStories: [
				{ id: 'US-001', passes: true },
				{ id: 'US-002', passes: false, requires: 'operator' },
			],
		};
		expect(hasIncompletePrd(prd)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC1: isCamFeatureBranch
// ---------------------------------------------------------------------------

describe('isCamFeatureBranch (AC1)', () => {
	test('null -> false', () => {
		expect(isCamFeatureBranch(null)).toBe(false);
	});

	test('undefined -> false', () => {
		expect(isCamFeatureBranch(undefined)).toBe(false);
	});

	test('"main" -> false', () => {
		expect(isCamFeatureBranch('main')).toBe(false);
	});

	test('"cam/issue-42" -> true', () => {
		expect(isCamFeatureBranch('cam/issue-42')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC1/AC4: detectInProgressConflict
// ---------------------------------------------------------------------------

describe('detectInProgressConflict (AC1, AC4)', () => {
	test('clean prd + non-cam branch -> false (AC4: no conflict)', () => {
		const prd: PrdSnapshot = { userStories: [{ id: 'US-001', passes: true }] };
		expect(detectInProgressConflict(prd, 'main')).toBe(false);
	});

	test('incomplete non-operator story alone -> true', () => {
		const prd: PrdSnapshot = { userStories: [{ id: 'US-001', passes: false }] };
		expect(detectInProgressConflict(prd, 'main')).toBe(true);
	});

	test('cam/* branch alone -> true', () => {
		const prd: PrdSnapshot = { userStories: [{ id: 'US-001', passes: true }] };
		expect(detectInProgressConflict(prd, 'cam/issue-99')).toBe(true);
	});

	test('both halves true -> true', () => {
		const prd: PrdSnapshot = { userStories: [{ id: 'US-001', passes: false }] };
		expect(detectInProgressConflict(prd, 'cam/issue-99')).toBe(true);
	});

	test('null prd + non-cam branch -> false', () => {
		expect(detectInProgressConflict(null, 'main')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC2: buildInProgressConflictContext
// ---------------------------------------------------------------------------

describe('buildInProgressConflictContext (AC2)', () => {
	test('names the prd half when only prd fires', () => {
		const prd: PrdSnapshot = { userStories: [{ id: 'US-001', passes: false }] };
		const context = buildInProgressConflictContext(prd, 'main');
		expect(context).toContain('passes:false non-operator story');
		expect(context).not.toContain('feature branch');
	});

	test('names the branch half when only the branch fires', () => {
		const prd: PrdSnapshot = { userStories: [{ id: 'US-001', passes: true }] };
		const context = buildInProgressConflictContext(prd, 'cam/issue-42');
		expect(context).toContain('feature branch "cam/issue-42"');
		expect(context).not.toContain('passes:false');
	});

	test('names BOTH halves when both fire', () => {
		const prd: PrdSnapshot = { userStories: [{ id: 'US-001', passes: false }] };
		const context = buildInProgressConflictContext(prd, 'cam/issue-42');
		expect(context).toContain('passes:false');
		expect(context).toContain('feature branch "cam/issue-42"');
	});
});

// ---------------------------------------------------------------------------
// AC1: readHeadBranchName -- REAL git tmpdir
// ---------------------------------------------------------------------------

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0;

const realSpawnFn: SpawnFn = (cmd, args) => {
	const r = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8' });
	return { stdout: typeof r.stdout === 'string' ? r.stdout : '', exitCode: r.status };
};

function makeTmpGitRepo(branch: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-in-progress-conflict-'));
	const run = (args: string[]) => spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
	run(['init']);
	run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);
	writeFileSync(join(dir, 'seed.txt'), 'seed\n');
	run(['add', 'seed.txt']);
	run(['commit', '-m', 'chore: initial seed']);
	return dir;
}

describe('readHeadBranchName (AC1, real git)', () => {
	test.skipIf(!gitAvailable)('HEAD on main -> "main"', () => {
		const dir = makeTmpGitRepo('main');
		try {
			expect(readHeadBranchName(realSpawnFn, dir)).toBe('main');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.skipIf(!gitAvailable)('HEAD on a cam/* feature branch -> the branch name', () => {
		const dir = makeTmpGitRepo('cam/issue-77');
		try {
			expect(readHeadBranchName(realSpawnFn, dir)).toBe('cam/issue-77');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.skipIf(!gitAvailable)('detached HEAD -> null', () => {
		const dir = makeTmpGitRepo('main');
		try {
			const sha = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { stdio: 'pipe', encoding: 'utf8' })
				.stdout.trim();
			spawnSync('git', ['-C', dir, 'checkout', sha], { stdio: 'pipe' });
			expect(readHeadBranchName(realSpawnFn, dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// AC3: makeInProgressConflictResolver
// ---------------------------------------------------------------------------

function makeGate(decision?: string): CamGate {
	return { gate: IN_PROGRESS_CONFLICT_GATE, options: [...IN_PROGRESS_CONFLICT_OPTIONS], context: 'test', decision };
}

describe('makeInProgressConflictResolver (AC3, spy deps)', () => {
	test("'continue' -> 'implementing', no side effects", () => {
		const calls: string[] = [];
		const deps: InProgressConflictResolverDeps = {
			removeHandoffFn: () => calls.push('removeHandoff'),
			removePrdFn: () => calls.push('removePrd'),
			checkoutMainFn: () => calls.push('checkoutMain'),
		};
		const resolver = makeInProgressConflictResolver(deps);
		expect(resolver(makeGate('continue'))).toBe('implementing');
		expect(calls).toEqual([]);
	});

	test("'ship' -> 'shipping', no side effects", () => {
		const calls: string[] = [];
		const deps: InProgressConflictResolverDeps = {
			removeHandoffFn: () => calls.push('removeHandoff'),
			removePrdFn: () => calls.push('removePrd'),
			checkoutMainFn: () => calls.push('checkoutMain'),
		};
		const resolver = makeInProgressConflictResolver(deps);
		expect(resolver(makeGate('ship'))).toBe('shipping');
		expect(calls).toEqual([]);
	});

	test("'abandon' -> removeHandoffFn, removePrdFn, checkoutMainFn (in order), returns 'planning'", () => {
		const calls: string[] = [];
		const deps: InProgressConflictResolverDeps = {
			removeHandoffFn: () => calls.push('removeHandoff'),
			removePrdFn: () => calls.push('removePrd'),
			checkoutMainFn: () => calls.push('checkoutMain'),
		};
		const resolver = makeInProgressConflictResolver(deps);
		expect(resolver(makeGate('abandon'))).toBe('planning');
		expect(calls).toEqual(['removeHandoff', 'removePrd', 'checkoutMain']);
	});

	test('an unregistered/undefined decision fails safe to "idle" (unreachable in production; pollAndResolveGate re-validates first)', () => {
		const deps: InProgressConflictResolverDeps = {
			removeHandoffFn: () => {},
			removePrdFn: () => {},
			checkoutMainFn: () => {},
		};
		const resolver = makeInProgressConflictResolver(deps);
		expect(resolver(makeGate(undefined))).toBe('idle');
	});
});

// ---------------------------------------------------------------------------
// AC3: abandon path against a REAL tmpdir + real git repo (deterministic,
// per prd.json notes: "test it against a real tmpdir")
// ---------------------------------------------------------------------------

describe('abandon path (AC3, real tmpdir + real git)', () => {
	test.skipIf(!gitAvailable)(
		'rm handoff.json + rm prd.json + git checkout main, all deterministically applied',
		() => {
			const dir = makeTmpGitRepo('cam/issue-153');
			try {
				mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });
				const handoffPath = join(dir, 'scripts/cam/handoff.json');
				const prdPath = join(dir, 'scripts/cam/prd.json');
				writeFileSync(handoffPath, '{}');
				writeFileSync(prdPath, '{}');
				// git checkout main needs a real 'main' ref to land on; create it from
				// the current commit before abandoning the cam/* branch.
				spawnSync('git', ['-C', dir, 'branch', 'main'], { stdio: 'pipe' });

				expect(existsSync(handoffPath)).toBe(true);
				expect(existsSync(prdPath)).toBe(true);
				expect(readHeadBranchName(realSpawnFn, dir)).toBe('cam/issue-153');

				const deps: InProgressConflictResolverDeps = {
					removeHandoffFn: () => {
						try { unlinkSync(handoffPath); } catch { /* best-effort */ }
					},
					removePrdFn: () => {
						try { unlinkSync(prdPath); } catch { /* best-effort */ }
					},
					checkoutMainFn: () => {
						spawnSync('git', ['-C', dir, 'checkout', 'main'], { stdio: 'pipe' });
					},
				};
				const resolver = makeInProgressConflictResolver(deps);
				const nextPhase = resolver(makeGate('abandon'));

				expect(nextPhase).toBe('planning');
				expect(existsSync(handoffPath)).toBe(false);
				expect(existsSync(prdPath)).toBe(false);
				expect(readHeadBranchName(realSpawnFn, dir)).toBe('main');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
