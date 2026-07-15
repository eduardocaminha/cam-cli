// test/triage.test.ts
//
// Unit tests for runTriage() (src/commands/triage.ts) and
// dispatchTriage() (index.ts).
//
// US-004 cutover: triage now reads from per-file CAM-NNNN.json via
// readBacklogFromMain (ls-tree + cat-file --batch), and writes only the
// CHANGED entries as per-file commits. issues.local.json is never touched.
//
// Coverage (per US-004 acceptance criteria):
//
//   AC#1 - Gate runs before any write; rank is written to the serialized payload.
//     (a) When ranks change: commit-tree and update-ref come after ls-tree / cat-file.
//     (b) The serialized JSON payload (hash-object input) contains the new rank.
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
//   US-004 AC: no issues.local.json reference in any spawn call.
//
// All external I/O is faked via injectable deps. No real git binary or
// filesystem is exercised (except the mkdtemp inside commitTreeToMain,
// which is a non-git call and is cleaned up immediately).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import type { IssueEntry } from '../src/issues/types.ts';
import {
	runTriage,
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

// Individual IssueEntry fixtures (per-file format)

/** A single specified+open issue with wsjf, initially unranked. */
const ISSUE_CAM_1: IssueEntry = {
	id: 'CAM-1',
	title: 'First issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-06-28T00:00:00Z',
	updatedAt: '2026-06-28T00:00:00Z',
	wsjf: { value: 3, timeCriticality: 2, riskReduction: 1, jobSize: 2 },
	// rank: intentionally absent to test 'new' diff tag
};

/** Same issue but already ranked=1 (idempotent test). */
const ISSUE_CAM_1_RANKED: IssueEntry = { ...ISSUE_CAM_1, rank: 1 };

/** Cycle pair (CAM-2 -> CAM-3 -> CAM-2). */
const ISSUE_CAM_2: IssueEntry = {
	id: 'CAM-2',
	title: 'Cycle A',
	stage: 'specified',
	status: 'open',
	blockedBy: ['CAM-3'],
	createdAt: '2026-06-28T00:00:00Z',
	updatedAt: '2026-06-28T00:00:00Z',
	wsjf: { value: 1, timeCriticality: 1, riskReduction: 1, jobSize: 1 },
};
const ISSUE_CAM_3: IssueEntry = {
	id: 'CAM-3',
	title: 'Cycle B',
	stage: 'specified',
	status: 'open',
	blockedBy: ['CAM-2'],
	createdAt: '2026-06-28T00:00:00Z',
	updatedAt: '2026-06-28T00:00:00Z',
	wsjf: { value: 1, timeCriticality: 1, riskReduction: 1, jobSize: 1 },
};

/** Integrity violation: CAM-5 references CAM-99 which doesn't exist. */
const ISSUE_CAM_5: IssueEntry = {
	id: 'CAM-5',
	title: 'Issue with bad blocker',
	stage: 'specified',
	status: 'open',
	blockedBy: ['CAM-99'],
	createdAt: '2026-06-28T00:00:00Z',
	updatedAt: '2026-06-28T00:00:00Z',
	wsjf: { value: 1, timeCriticality: 1, riskReduction: 1, jobSize: 1 },
};

// US-001 fixtures: a backlog that yields BOTH a gate warning (cross-stage
// blocker) and a rank warning (missing wsjf), used to prove runTriage prints
// the same unified warnings list on the no-op path and the commit path.

/** Specified+open issue blocked by an idea-stage issue -> gate (cross-stage) warning. */
const ISSUE_CAM_30: IssueEntry = {
	id: 'CAM-30',
	title: 'Blocked by idea-stage issue',
	stage: 'specified',
	status: 'open',
	blockedBy: ['CAM-31'],
	createdAt: '2026-06-28T00:00:00Z',
	updatedAt: '2026-06-28T00:00:00Z',
	wsjf: { value: 3, timeCriticality: 2, riskReduction: 1, jobSize: 2 },
};
/** Same issue, already ranked=1 (matches computed rank; used for the no-op fixture). */
const ISSUE_CAM_30_RANKED: IssueEntry = { ...ISSUE_CAM_30, rank: 1 };

/** Idea-stage blocker: out-of-universe and not shipped -> triggers the gate warning. */
const ISSUE_CAM_31: IssueEntry = {
	id: 'CAM-31',
	title: 'Idea-stage blocker',
	stage: 'idea',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-06-28T00:00:00Z',
	updatedAt: '2026-06-28T00:00:00Z',
};

/** Specified+open issue with no wsjf field -> triggers the rank (WSJF-computation) warning. */
const ISSUE_CAM_32: IssueEntry = {
	id: 'CAM-32',
	title: 'Issue with no wsjf score',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-06-28T00:00:00Z',
	updatedAt: '2026-06-28T00:00:00Z',
};
/** Same issue, already ranked=2 (matches computed rank; used for the no-op fixture). */
const ISSUE_CAM_32_RANKED: IssueEntry = { ...ISSUE_CAM_32, rank: 2 };

/** Serialise a single IssueEntry to JSON (the on-disk file format). */
function toJson(entry: IssueEntry): string {
	return JSON.stringify(entry, null, 2) + '\n';
}

/** Framed blob output for git cat-file --batch. */
function frameBlobOutput(content: string, oid = 'someoid'): string {
	return `${oid} blob ${content.length}\n${content}\n`;
}

/**
 * Build the ls-tree output and cat-file --batch output for a list of entries.
 */
function buildBacklogFixture(entries: IssueEntry[]): {
	lsTreeOutput: string;
	catFileOutput: string;
} {
	const lines: string[] = [];
	const blobs: string[] = [];
	for (const entry of entries) {
		const n = parseInt(entry.id.split('-')[1] ?? '0', 10);
		const padded = `CAM-${String(n).padStart(4, '0')}.json`;
		lines.push(`scripts/cam/issues/${padded}`);
		const content = toJson(entry);
		blobs.push(frameBlobOutput(content, `oid${entry.id}`));
	}
	return {
		lsTreeOutput: lines.join('\n') + (lines.length > 0 ? '\n' : ''),
		catFileOutput: blobs.join(''),
	};
}

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
 *   - rev-parse origin/main       -> MAIN_SHA (in sync)
 *   - fetch origin main           -> ok
 *   - ls-tree main scripts/cam/issues/ -> lsTreeOutput
 *   - cat-file --batch             -> catFileOutput
 *   - read-tree / hash-object / update-index / write-tree / commit-tree / update-ref -> ok
 *   - push origin main            -> ok
 */
function makeOffMainSpawnFn(
	entries: IssueEntry[],
	calls: SpawnCall[],
): SpawnFn {
	const { lsTreeOutput, catFileOutput } = buildBacklogFixture(entries);

	return (cmd, args, options) => {
		calls.push({ cmd, args: [...args], options });
		const argsStr = args.join(' ');

		if (argsStr.includes('rev-parse') && argsStr.includes('--abbrev-ref')) {
			return okResult('feature-branch\n');
		}
		if (argsStr.includes('rev-parse') && argsStr.includes('origin/main')) {
			return okResult(`${MAIN_SHA}\n`);
		}
		if (argsStr.includes('rev-parse') && argsStr.includes('main') && !argsStr.includes('--short')) {
			return okResult(`${MAIN_SHA}\n`);
		}
		if (argsStr.includes('fetch')) {
			return okResult();
		}
		// git ls-tree -> file listing
		if (argsStr.includes('ls-tree') && argsStr.includes('scripts/cam/issues')) {
			return okResult(lsTreeOutput);
		}
		// git cat-file --batch -> blob content
		if (argsStr.includes('cat-file') && argsStr.includes('--batch')) {
			return okResult(catFileOutput);
		}
		if (argsStr.includes('hash-object')) {
			return okResult(`${BLOB_SHA}\n`);
		}
		if (argsStr.includes('write-tree')) {
			return okResult(`${TREE_SHA}\n`);
		}
		if (argsStr.includes('commit-tree')) {
			return okResult(`${COMMIT_SHA}\n`);
		}
		if (argsStr.includes('push')) {
			return okResult();
		}
		// read-tree, update-index, update-ref, etc.
		return okResult();
	};
}

/**
 * Recording spawnFn for the on-main path.
 * On-main: commitTreeToMain uses git plumbing (same as off-main, ref-only).
 */
function makeOnMainSpawnFn(entries: IssueEntry[], calls: SpawnCall[]): SpawnFn {
	const { lsTreeOutput, catFileOutput } = buildBacklogFixture(entries);

	return (cmd, args, options) => {
		calls.push({ cmd, args: [...args], options });
		const argsStr = args.join(' ');

		if (argsStr.includes('rev-parse') && argsStr.includes('--abbrev-ref')) {
			return okResult('main\n');
		}
		if (argsStr.includes('rev-parse') && argsStr.includes('origin/main')) {
			return okResult(`${MAIN_SHA}\n`);
		}
		if (argsStr.includes('rev-parse') && argsStr.includes('main') && !argsStr.includes('--short')) {
			return okResult(`${MAIN_SHA}\n`);
		}
		if (argsStr.includes('fetch')) return okResult();
		// git ls-tree -> file listing
		if (argsStr.includes('ls-tree') && argsStr.includes('scripts/cam/issues')) {
			return okResult(lsTreeOutput);
		}
		// git cat-file --batch -> blob content
		if (argsStr.includes('cat-file') && argsStr.includes('--batch')) {
			return okResult(catFileOutput);
		}
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
	test('(a) ls-tree/cat-file come before commit-tree and update-ref', () => {
		const calls: SpawnCall[] = [];
		const stdout: string[] = [];

		const result = runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn([ISSUE_CAM_1], calls),
			writeFile: () => {},
			writeStdout: (line) => stdout.push(line),
		});

		expect(result.ok).toBe(true);

		const lsTreeIdx = calls.findIndex((c) => c.args.join(' ').includes('ls-tree') && c.args.join(' ').includes('scripts/cam/issues'));
		const catFileIdx = calls.findIndex((c) => c.args.join(' ').includes('cat-file') && c.args.join(' ').includes('--batch'));
		const commitTreeIdx = calls.findIndex((c) => c.args.join(' ').includes('commit-tree'));
		const updateRefIdx = calls.findIndex((c) => c.args.join(' ').includes('update-ref'));

		expect(lsTreeIdx).toBeGreaterThanOrEqual(0);
		expect(catFileIdx).toBeGreaterThan(lsTreeIdx);
		expect(commitTreeIdx).toBeGreaterThan(catFileIdx);
		expect(updateRefIdx).toBeGreaterThan(catFileIdx);
	});

	test('(b) serialized payload (hash-object input) contains rank=1 on the issue', () => {
		const calls: SpawnCall[] = [];

		runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn([ISSUE_CAM_1], calls),
			writeFile: () => {},
			writeStdout: () => {},
		});

		const hashObjectCall = calls.find((c) => c.args.join(' ').includes('hash-object'));
		expect(hashObjectCall).toBeDefined();

		// In per-file mode, hash-object receives a single IssueEntry (not the whole backlog)
		const payload = JSON.parse(hashObjectCall!.options.input ?? '{}') as IssueEntry;
		expect(payload.id).toBe('CAM-1');
		expect(payload.rank).toBe(1);
	});

	test('(US-002 CAM-284) rank change bumps updatedAt via the injected clock, beyond original createdAt', () => {
		const calls: SpawnCall[] = [];
		const FIXED_TS = '2026-07-12T00:00:00.000Z';

		runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn([ISSUE_CAM_1], calls),
			writeFile: () => {},
			writeStdout: () => {},
			clock: () => FIXED_TS,
		});

		const hashObjectCall = calls.find((c) => c.args.join(' ').includes('hash-object'));
		expect(hashObjectCall).toBeDefined();

		const payload = JSON.parse(hashObjectCall!.options.input ?? '{}') as IssueEntry;
		expect(payload.updatedAt).toBe(FIXED_TS);
		expect(new Date(payload.updatedAt).getTime()).toBeGreaterThan(
			new Date(ISSUE_CAM_1.createdAt).getTime(),
		);
	});

	test('(US-004) no spawn call arg contains issues.local.json', () => {
		const calls: SpawnCall[] = [];

		runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn([ISSUE_CAM_1], calls),
			writeFile: () => {},
			writeStdout: () => {},
		});

		for (const call of calls) {
			for (const arg of call.args) {
				expect(arg).not.toContain('issues.local.json');
			}
		}
	});
});

// ---------------------------------------------------------------------------
// AC#2 - Idempotent no-op
// ---------------------------------------------------------------------------

describe('runTriage: AC#2 idempotent no-op', () => {
	test('(c) when all ranks unchanged, no commit-tree or update-ref call is made', () => {
		const calls: SpawnCall[] = [];

		const result = runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn([ISSUE_CAM_1_RANKED], calls),
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
		const stdout: string[] = [];

		runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn([ISSUE_CAM_1], []),
			writeFile: () => {},
			writeStdout: (line) => stdout.push(line),
		});

		const joined = stdout.join('');
		expect(joined).toMatch(/CAM_TRIAGE_RANKED=1 changed=1 sha=/);
	});

	test('(e) no-op path emits CAM_TRIAGE_RANKED=1 changed=0 sha=none', () => {
		const stdout: string[] = [];

		runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn([ISSUE_CAM_1_RANKED], []),
			writeFile: () => {},
			writeStdout: (line) => stdout.push(line),
		});

		const joined = stdout.join('');
		expect(joined).toContain('CAM_TRIAGE_RANKED=1 changed=0 sha=none');
	});

	test('(f) cycle gate-fail emits CAM_TRIAGE_REJECTED=cycle:', () => {
		const stdout: string[] = [];

		runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn([ISSUE_CAM_2, ISSUE_CAM_3], []),
			writeFile: () => {},
			writeStdout: (line) => stdout.push(line),
		});

		const joined = stdout.join('');
		expect(joined).toMatch(/CAM_TRIAGE_REJECTED=cycle:/);
	});

	test('(g) integrity gate-fail emits CAM_TRIAGE_REJECTED=integrity:', () => {
		const stdout: string[] = [];

		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			runTriage({
				cwd: '/fake/repo',
				spawnFn: makeOffMainSpawnFn([ISSUE_CAM_5], []),
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

		const result = runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn([ISSUE_CAM_2, ISSUE_CAM_3], calls),
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

		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		let result: TriageResult;
		try {
			result = runTriage({
				cwd: '/fake/repo',
				spawnFn: makeOffMainSpawnFn([ISSUE_CAM_5], calls),
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
// on-main path
// ---------------------------------------------------------------------------

describe('runTriage: on-main path', () => {
	test('on-main path uses commit-tree (ref-only), never git add + commit', () => {
		const calls: SpawnCall[] = [];

		const result = runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOnMainSpawnFn([ISSUE_CAM_1], calls),
			writeStdout: () => {},
		});

		expect(result.ok).toBe(true);

		// on-main: commit-tree MUST be called (ref-only path, same as off-main)
		const hasCommitTree = calls.some((c) => c.args.includes('commit-tree'));
		expect(hasCommitTree).toBe(true);

		// git add must NOT be called (that was the old commitOnMain path, now removed)
		const hasGitAdd = calls.some((c) => c.args.includes('add'));
		expect(hasGitAdd).toBe(false);
	});

	test('on-main: no issues.local.json in any spawn call', () => {
		const calls: SpawnCall[] = [];

		runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOnMainSpawnFn([ISSUE_CAM_1], calls),
			writeFile: () => {},
			writeStdout: () => {},
		});

		for (const call of calls) {
			for (const arg of call.args) {
				expect(arg).not.toContain('issues.local.json');
			}
		}
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
				spawnFn: (_cmd, args) => {
					if (args.includes('--abbrev-ref')) return okResult('HEAD\n');
					return okResult();
				},
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
				spawnFn: (_cmd, args) => {
					const argsStr = args.join(' ');
					if (argsStr.includes('--abbrev-ref')) return okResult('feature\n');
					if (argsStr.includes('origin/main')) return okResult('differentsha\n');
					if (argsStr.includes('rev-parse') && argsStr.includes('main') && !argsStr.includes('--short')) {
						return okResult(`${MAIN_SHA}\n`);
					}
					if (argsStr.includes('fetch')) return okResult();
					return okResult(MAIN_SHA + '\n');
				},
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
// US-001: unified warnings source (gate + rank) on BOTH the no-op and commit paths
// ---------------------------------------------------------------------------

describe('runTriage: unified warnings source (US-001)', () => {
	test('no-op run prints both the gate warning and the rank warning', () => {
		const stdout: string[] = [];

		const result = runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn(
				[ISSUE_CAM_30_RANKED, ISSUE_CAM_31, ISSUE_CAM_32_RANKED],
				[],
			),
			writeFile: () => {},
			writeStdout: (line) => stdout.push(line),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.changed).toBe(0);

		const joined = stdout.join('');
		expect(joined).toContain('warning: Cross-stage blocker: CAM-30 is blocked by CAM-31');
		expect(joined).toContain('warning: CAM-32: wsjf field absent');
	});

	test('commit run prints both the gate warning and the rank warning', () => {
		const stdout: string[] = [];

		const result = runTriage({
			cwd: '/fake/repo',
			spawnFn: makeOffMainSpawnFn([ISSUE_CAM_30, ISSUE_CAM_31, ISSUE_CAM_32], []),
			writeFile: () => {},
			writeStdout: (line) => stdout.push(line),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.changed).toBeGreaterThan(0);

		const joined = stdout.join('');
		expect(joined).toContain('warning: Cross-stage blocker: CAM-30 is blocked by CAM-31');
		expect(joined).toContain('warning: CAM-32: wsjf field absent');
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
