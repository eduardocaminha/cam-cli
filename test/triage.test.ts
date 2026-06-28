// test/triage.test.ts
//
// Unit tests for runTriage() (src/commands/triage.ts) and
// dispatchTriage() (index.ts).
//
// Coverage (per US-004 acceptance criteria):
//
//   AC#1 - Gate runs before any write; rank is written to the serialized payload.
//     (a) When ranks change: no commit-tree/update-ref call fires before git-show.
//     (b) The serialized JSON payload (hash-object input:) contains the new rank.
//
//   AC#2 - Idempotent no-op: unchanged ranks produce no write/commit calls.
//     (c) Second run (issue.rank already matches computed rank) produces no
//         commit-tree or update-ref spawn call.
//
//   AC#3 - Sentinel output.
//     (d) Success path emits CAM_TRIAGE_RANKED=<n> changed=<m> sha=<sha>.
//     (e) No-op path emits CAM_TRIAGE_RANKED=<n> changed=0 sha=none.
//     (f) Gate-fail path emits CAM_TRIAGE_REJECTED=cycle:...
//     (g) Integrity-fail path emits CAM_TRIAGE_REJECTED=integrity:...
//
//   AC#4 - Gate hard-fail keeps prior ranks, no commit, exit 1.
//     (h) Cycle: result.ok===false, result.kind==='cycle', no commit-tree/update-ref.
//     (i) Integrity: result.ok===false, result.kind==='integrity', no commit.
//
// All external I/O is faked via injectable deps.  No real git binary or
// filesystem is exercised (except the mkdtemp inside commitTreeToMain,
// which is a non-git call and is cleaned up immediately).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	runTriage,
	type RunTriageOptions,
	type TriageResult,
	type SpawnFn,
} from '../src/commands/triage.ts';
import { dispatchTriage, type TriageDispatchDeps } from '../index.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MAIN_SHA = 'abc1234';
const BLOB_SHA = 'blobsha1';
const TREE_SHA = 'treesha1';
const COMMIT_SHA = 'commitsha123456';

/** Minimal SpawnSyncReturns<string> for a successful git call. */
function okResult(stdout = ''): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
}

/** Minimal SpawnSyncReturns<string> for a failing git call. */
function failResult(stderr = ''): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, '', stderr], stdout: '', stderr, status: 1, signal: null };
}

/** A single specified+open issue with wsjf, initially unranked. */
const ONE_ISSUE_BACKLOG = {
	next_id: 10,
	issues: [
		{
			id: 'CAM-1',
			title: 'First issue',
			stage: 'specified' as const,
			status: 'open' as const,
			blockedBy: [],
			createdAt: '2026-06-28T00:00:00Z',
			wsjf: { value: 3, timeCriticality: 2, riskReduction: 1, jobSize: 2 },
			// rank: intentionally absent to test 'new' diff tag
		},
	],
};

/** Same backlog but with rank already set to 1 (idempotent test). */
const ONE_ISSUE_BACKLOG_RANKED = {
	...ONE_ISSUE_BACKLOG,
	issues: ONE_ISSUE_BACKLOG.issues.map((e) => ({ ...e, rank: 1 })),
};

/** Two issues with a blockedBy cycle (CAM-2 -> CAM-3 -> CAM-2). */
const CYCLE_BACKLOG = {
	next_id: 10,
	issues: [
		{
			id: 'CAM-2',
			title: 'Cycle A',
			stage: 'specified' as const,
			status: 'open' as const,
			blockedBy: ['CAM-3'],
			createdAt: '2026-06-28T00:00:00Z',
			wsjf: { value: 1, timeCriticality: 1, riskReduction: 1, jobSize: 1 },
		},
		{
			id: 'CAM-3',
			title: 'Cycle B',
			stage: 'specified' as const,
			status: 'open' as const,
			blockedBy: ['CAM-2'],
			createdAt: '2026-06-28T00:00:00Z',
			wsjf: { value: 1, timeCriticality: 1, riskReduction: 1, jobSize: 1 },
		},
	],
};

/** Backlog with a missing-id integrity violation (CAM-5 references CAM-99 which doesn't exist). */
const INTEGRITY_BACKLOG = {
	next_id: 10,
	issues: [
		{
			id: 'CAM-5',
			title: 'Issue with bad blocker',
			stage: 'specified' as const,
			status: 'open' as const,
			blockedBy: ['CAM-99'],
			createdAt: '2026-06-28T00:00:00Z',
			wsjf: { value: 1, timeCriticality: 1, riskReduction: 1, jobSize: 1 },
		},
	],
};

interface SpawnCall {
	cmd: string;
	args: string[];
	options: { encoding: 'utf8'; env?: Record<string, string>; input?: string };
}

/**
 * Recording spawnFn for the off-main path.
 *
 * Simulates:
 *   - rev-parse --abbrev-ref HEAD -> 'feature-branch' (off-main)
 *   - rev-parse main              -> MAIN_SHA
 *   - rev-parse origin/main       -> MAIN_SHA (in sync, skip divergence error)
 *   - fetch origin main           -> ok (best-effort)
 *   - show main:scripts/...       -> provided backlogJson
 *   - read-tree / hash-object / update-index / write-tree / commit-tree / update-ref -> ok
 *   - push origin main            -> ok
 */
function makeOffMainSpawnFn(
	backlogJson: string,
	calls: SpawnCall[],
): SpawnFn {
	return (cmd, args, options) => {
		calls.push({ cmd, args: [...args], options });
		const argsStr = args.join(' ');

		// Branch detection (guard 0a)
		if (argsStr.includes('rev-parse') && argsStr.includes('--abbrev-ref')) {
			return okResult('feature-branch\n');
		}
		// Local main sha (guard 0b)
		if (argsStr.includes('rev-parse') && argsStr.includes('main') && !argsStr.includes('origin/main')) {
			return okResult(`${MAIN_SHA}\n`);
		}
		// fetch (guard 0c, best-effort)
		if (argsStr.includes('fetch')) {
			return okResult();
		}
		// origin/main sha (guard 0c)
		if (argsStr.includes('rev-parse') && argsStr.includes('origin/main')) {
			return okResult(`${MAIN_SHA}\n`);
		}
		// git show (read backlog)
		if (argsStr.includes('show') && argsStr.includes('issues.local.json')) {
			return okResult(backlogJson);
		}
		// hash-object (returns blob sha)
		if (argsStr.includes('hash-object')) {
			return okResult(`${BLOB_SHA}\n`);
		}
		// write-tree (returns tree sha)
		if (argsStr.includes('write-tree')) {
			return okResult(`${TREE_SHA}\n`);
		}
		// commit-tree (returns commit sha)
		if (argsStr.includes('commit-tree')) {
			return okResult(`${COMMIT_SHA}\n`);
		}
		// push
		if (argsStr.includes('push')) {
			return okResult();
		}
		// All other git commands (read-tree, update-index, update-ref): ok
		return okResult();
	};
}

/**
 * Recording spawnFn for the on-main path.
 */
function makeOnMainSpawnFn(backlogJson: string, calls: SpawnCall[]): SpawnFn {
	return (cmd, args, options) => {
		calls.push({ cmd, args: [...args], options });
		const argsStr = args.join(' ');

		if (argsStr.includes('rev-parse') && argsStr.includes('--abbrev-ref')) {
			return okResult('main\n');
		}
		if (argsStr.includes('rev-parse') && argsStr.includes('origin/main')) {
			return okResult(`${MAIN_SHA}\n`);
		}
		if (argsStr.includes('rev-parse') && argsStr.includes('main')) {
			return okResult(`${MAIN_SHA}\n`);
		}
		if (argsStr.includes('fetch')) return okResult();
		if (argsStr.includes('show') && argsStr.includes('issues.local.json')) {
			return okResult(backlogJson);
		}
		// git add / commit / rev-parse --short HEAD
		if (argsStr.includes('rev-parse') && argsStr.includes('--short')) {
			return okResult(`${COMMIT_SHA.substring(0, 7)}\n`);
		}
		if (argsStr.includes('push')) return okResult();
		return okResult();
	};
}

// ---------------------------------------------------------------------------
// AC#1 - Gate runs before any write; rank written to serialized payload
// ---------------------------------------------------------------------------

describe('runTriage: AC#1 gate-before-write ordering', () => {
	test('(a) no write call fires before git-show (commit-tree and update-ref come after show)', () => {
		const calls: SpawnCall[] = [];
		const backlogJson = JSON.stringify(ONE_ISSUE_BACKLOG, null, 2) + '\n';
		const stdout: string[] = [];

		const result = runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn(backlogJson, calls),
			clock: () => '2026-06-28T12:00:00.000Z',
			writeFile: () => {},
			writeStdout: (line) => stdout.push(line),
		});

		expect(result.ok).toBe(true);

		const showIdx = calls.findIndex((c) => c.args.join(' ').includes('show') && c.args.join(' ').includes('issues.local.json'));
		const commitTreeIdx = calls.findIndex((c) => c.args.join(' ').includes('commit-tree'));
		const updateRefIdx = calls.findIndex((c) => c.args.join(' ').includes('update-ref'));

		expect(showIdx).toBeGreaterThanOrEqual(0);
		expect(commitTreeIdx).toBeGreaterThan(showIdx);
		expect(updateRefIdx).toBeGreaterThan(showIdx);
	});

	test('(b) serialized payload (hash-object input) contains rank=1 on the issue', () => {
		const calls: SpawnCall[] = [];
		const backlogJson = JSON.stringify(ONE_ISSUE_BACKLOG, null, 2) + '\n';

		runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn(backlogJson, calls),
			clock: () => '2026-06-28T12:00:00.000Z',
			writeFile: () => {},
			writeStdout: () => {},
		});

		const hashObjectCall = calls.find((c) => c.args.join(' ').includes('hash-object'));
		expect(hashObjectCall).toBeDefined();

		const payload = JSON.parse(hashObjectCall!.options.input ?? '{}') as { issues: Array<{ id: string; rank?: number }> };
		const cam1 = payload.issues.find((e) => e.id === 'CAM-1');
		expect(cam1?.rank).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC#2 - Idempotent no-op
// ---------------------------------------------------------------------------

describe('runTriage: AC#2 idempotent no-op', () => {
	test('(c) when all ranks unchanged, no commit-tree or update-ref call is made', () => {
		const calls: SpawnCall[] = [];
		const backlogJson = JSON.stringify(ONE_ISSUE_BACKLOG_RANKED, null, 2) + '\n';

		const result = runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn(backlogJson, calls),
			clock: () => '2026-06-28T12:00:00.000Z',
			writeFile: () => {},
			writeStdout: () => {},
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.changed).toBe(0);
		expect(result.sha).toBe('none');

		const hasWrite = calls.some(
			(c) => c.args.join(' ').includes('commit-tree') || c.args.join(' ').includes('update-ref'),
		);
		expect(hasWrite).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC#3 - Sentinel output
// ---------------------------------------------------------------------------

describe('runTriage: AC#3 sentinel output', () => {
	test('(d) success path emits CAM_TRIAGE_RANKED=1 changed=1 sha=<sha>', () => {
		const backlogJson = JSON.stringify(ONE_ISSUE_BACKLOG, null, 2) + '\n';
		const stdout: string[] = [];

		runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn(backlogJson, []),
			clock: () => '2026-06-28T12:00:00.000Z',
			writeFile: () => {},
			writeStdout: (line) => stdout.push(line),
		});

		const joined = stdout.join('');
		expect(joined).toMatch(/CAM_TRIAGE_RANKED=1 changed=1 sha=/);
	});

	test('(e) no-op path emits CAM_TRIAGE_RANKED=1 changed=0 sha=none', () => {
		const backlogJson = JSON.stringify(ONE_ISSUE_BACKLOG_RANKED, null, 2) + '\n';
		const stdout: string[] = [];

		runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn(backlogJson, []),
			clock: () => '2026-06-28T12:00:00.000Z',
			writeFile: () => {},
			writeStdout: (line) => stdout.push(line),
		});

		const joined = stdout.join('');
		expect(joined).toContain('CAM_TRIAGE_RANKED=1 changed=0 sha=none');
	});

	test('(f) cycle gate-fail emits CAM_TRIAGE_REJECTED=cycle:', () => {
		const backlogJson = JSON.stringify(CYCLE_BACKLOG, null, 2) + '\n';
		const stdout: string[] = [];

		runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn(backlogJson, []),
			clock: () => '2026-06-28T12:00:00.000Z',
			writeFile: () => {},
			writeStdout: (line) => stdout.push(line),
		});

		const joined = stdout.join('');
		expect(joined).toMatch(/CAM_TRIAGE_REJECTED=cycle:/);
	});

	test('(g) integrity gate-fail emits CAM_TRIAGE_REJECTED=integrity:', () => {
		const backlogJson = JSON.stringify(INTEGRITY_BACKLOG, null, 2) + '\n';
		const stdout: string[] = [];

		// Suppress printError output to stderr in this test.
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			runTriage({
				cwd: '/fake/repo',
				spawnFn: makeOffMainSpawnFn(backlogJson, []),
				clock: () => '2026-06-28T12:00:00.000Z',
				writeFile: () => {},
				writeStdout: (line) => stdout.push(line),
			});
		} finally {
			process.stderr.write = origWrite;
		}

		const joined = stdout.join('');
		expect(joined).toMatch(/CAM_TRIAGE_REJECTED=integrity:/);
	});
});

// ---------------------------------------------------------------------------
// AC#4 - Gate hard-fail: no commit, result ok:false
// ---------------------------------------------------------------------------

describe('runTriage: AC#4 gate hard-fail', () => {
	test('(h) cycle: result.ok===false, kind===cycle, no commit-tree/update-ref', () => {
		const calls: SpawnCall[] = [];
		const backlogJson = JSON.stringify(CYCLE_BACKLOG, null, 2) + '\n';

		const result = runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn(backlogJson, calls),
			clock: () => '2026-06-28T12:00:00.000Z',
			writeFile: () => {},
			writeStdout: () => {},
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('cycle');

		const hasWrite = calls.some(
			(c) => c.args.join(' ').includes('commit-tree') || c.args.join(' ').includes('update-ref'),
		);
		expect(hasWrite).toBe(false);
	});

	test('(i) integrity: result.ok===false, kind===integrity, no commit', () => {
		const calls: SpawnCall[] = [];
		const backlogJson = JSON.stringify(INTEGRITY_BACKLOG, null, 2) + '\n';

		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		let result: TriageResult;
		try {
			result = runTriage({
				cwd: '/fake/repo',
				spawnFn: makeOffMainSpawnFn(backlogJson, calls),
				clock: () => '2026-06-28T12:00:00.000Z',
				writeFile: () => {},
				writeStdout: () => {},
			});
		} finally {
			process.stderr.write = origWrite;
		}

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('integrity');

		const hasWrite = calls.some(
			(c) => c.args.join(' ').includes('commit-tree') || c.args.join(' ').includes('update-ref'),
		);
		expect(hasWrite).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Additional paths: on-main and guard failures
// ---------------------------------------------------------------------------

describe('runTriage: on-main path', () => {
	test('on-main path uses git add + commit (not commit-tree)', () => {
		const calls: SpawnCall[] = [];
		const backlogJson = JSON.stringify(ONE_ISSUE_BACKLOG, null, 2) + '\n';
		const written: Array<{ path: string; text: string }> = [];

		const result = runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOnMainSpawnFn(backlogJson, calls),
			clock: () => '2026-06-28T12:00:00.000Z',
			writeFile: (path, text) => written.push({ path, text }),
			writeStdout: () => {},
		});

		expect(result.ok).toBe(true);

		// on-main: must call git add and git commit, NOT commit-tree
		const hasGitAdd = calls.some((c) => c.args.includes('add'));
		const hasGitCommit = calls.some((c) => c.args.includes('commit') && !c.args.includes('commit-tree') && !c.args.includes('-m') === false);
		const hasCommitTree = calls.some((c) => c.args.includes('commit-tree'));

		expect(hasGitAdd).toBe(true);
		expect(hasCommitTree).toBe(false);

		// writeFile should have been called with the serialized JSON
		expect(written.length).toBeGreaterThan(0);
		const file = written.find((w) => w.path.includes('issues.local.json'));
		expect(file).toBeDefined();
		const payload = JSON.parse(file!.text) as { issues: Array<{ id: string; rank?: number }> };
		const cam1 = payload.issues.find((e) => e.id === 'CAM-1');
		expect(cam1?.rank).toBe(1);
	});
});

describe('runTriage: guard failures', () => {
	test('detached HEAD returns ok:false, kind:guard, reason:detached-head', () => {
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		let result: TriageResult;
		try {
			result = runTriage({
				cwd: '/fake/repo',
				spawnFn: (cmd, args) => {
					if (args.includes('--abbrev-ref')) return okResult('HEAD\n');
					return okResult();
				},
				clock: () => '',
				writeStdout: () => {},
			});
		} finally {
			process.stderr.write = origWrite;
		}
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('guard');
		if (result.kind !== 'guard') return;
		expect(result.reason).toBe('detached-head');
	});

	test('diverged main returns ok:false, kind:guard, reason:diverged', () => {
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		let result: TriageResult;
		try {
			result = runTriage({
				cwd: '/fake/repo',
				spawnFn: (cmd, args) => {
					const argsStr = args.join(' ');
					if (argsStr.includes('--abbrev-ref')) return okResult('feature\n');
					if (argsStr.includes('origin/main')) return okResult('differentsha\n');
					if (argsStr.includes('rev-parse main') || (argsStr.includes('rev-parse') && argsStr.endsWith('main'))) {
						return okResult(`${MAIN_SHA}\n`);
					}
					if (argsStr.includes('fetch')) return okResult();
					return okResult(MAIN_SHA + '\n');
				},
				clock: () => '',
				writeStdout: () => {},
			});
		} finally {
			process.stderr.write = origWrite;
		}
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('guard');
		if (result.kind !== 'guard') return;
		expect(result.reason).toBe('diverged');
	});
});

// ---------------------------------------------------------------------------
// dispatchTriage: routing tests
// ---------------------------------------------------------------------------

describe('dispatchTriage', () => {
	test('success result: returns exit code 0', () => {
		const deps: TriageDispatchDeps = {
			triageFn: () => ({ ok: true, ranked: 1, changed: 1, sha: 'abc1234' }),
		};
		expect(dispatchTriage(deps)).toBe(0);
	});

	test('guard failure: returns exit code 1', () => {
		const deps: TriageDispatchDeps = {
			triageFn: () => ({ ok: false, kind: 'guard', reason: 'detached-head' }),
		};
		expect(dispatchTriage(deps)).toBe(1);
	});

	test('cycle gate failure: returns exit code 1', () => {
		const deps: TriageDispatchDeps = {
			triageFn: () => ({ ok: false, kind: 'cycle', errors: ['Cycle detected: CAM-2 -> CAM-3 -> CAM-2'] }),
		};
		expect(dispatchTriage(deps)).toBe(1);
	});

	test('no-op result (changed=0): returns exit code 0', () => {
		const deps: TriageDispatchDeps = {
			triageFn: () => ({ ok: true, ranked: 1, changed: 0, sha: 'none' }),
		};
		expect(dispatchTriage(deps)).toBe(0);
	});
});
