// test/ship-finalize.test.ts
//
// Unit tests for finalizeCycleClose() in src/commands/ship-finalize.ts.
//
// Coverage (US-004 acceptance criteria):
//   AC1: issue-writer seam is never invoked (readIssues/writeIssues removed
//        from options); issue file is byte-for-byte untouched after a run.
//   AC2: prd.json, handoff.json, progress.txt removed via git rm + commit
//        (unchanged behavior from prior impl).
//   AC3: resolveIssueId called for both numeric and string issueNumber;
//        stashFn called with resolved id BEFORE any git rm call;
//        unresolvable but non-null issueNumber throws (never stashes '<prefix>-0').
//   AC4: no git push to main in any spawn call.
//   AC5: github and linear backends unchanged (git rm + commit, no issue file).

import { describe, expect, test } from 'bun:test';
import {
	finalizeCycleClose,
	type FinalizeCycleCloseOptions,
	type SpawnFn,
} from '../src/commands/ship-finalize.ts';
import type { SpawnSyncReturns } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_TOML_NONE = 'issue_system = "local"\nissue_prefix = "CAM"\n';
const PROJECT_TOML_GITHUB = 'issue_system = "github"\nissue_prefix = "CAM"\n';
const PROJECT_TOML_LINEAR = 'issue_system = "linear"\nissue_prefix = "CAM"\n';

/** prd.json with numeric issueNumber (classic form). */
const PRD_JSON_NUMERIC = JSON.stringify({ issueNumber: 72, branchName: 'cam/CAM-72-test' });
/** prd.json with string issueNumber (CAM-113: /cam-next anchoring writes full string id). */
const PRD_JSON_STRING = JSON.stringify({ issueNumber: 'CAM-72', branchName: 'cam/CAM-72-test' });

/** Minimal passing SpawnSyncReturns<string> for a successful git call. */
function okResult(): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, '', ''], stdout: '', stderr: '', status: 0, signal: null };
}

interface SpawnCall {
	cmd: string;
	args: string[];
}

/**
 * Build a SpawnFn that records every call and returns success.
 *
 * For `git diff --cached --quiet` the returned status controls the
 * "nothing staged" guard:
 *   status 1 (default) = staged changes present  => commit proceeds
 *   status 0            = no staged changes        => commit is skipped
 *
 * For `git rev-parse --short HEAD` the returned stdout is `revParseSha`
 * (default 'abc1234').
 */
function makeRecordingSpawn(opts: { diffCachedStatus?: number; revParseSha?: string } = {}): { spawnFn: SpawnFn; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const diffStatus = opts.diffCachedStatus ?? 1;
	const sha = opts.revParseSha ?? 'abc1234';
	const spawnFn: SpawnFn = (cmd, args, _opts) => {
		calls.push({ cmd, args });
		if (args.includes('diff') && args.includes('--cached') && args.includes('--quiet')) {
			return { ...okResult(), status: diffStatus };
		}
		if (args.includes('rev-parse') && args.includes('--short')) {
			return { ...okResult(), stdout: sha + '\n' };
		}
		return okResult();
	};
	return { spawnFn, calls };
}

/** Build the default options shared across tests. Override per-test as needed. */
function makeOptions(
	overrides: Partial<FinalizeCycleCloseOptions> & { spawnFn: SpawnFn },
): FinalizeCycleCloseOptions {
	return {
		cwd: '/fake/project',
		readProjectToml: () => PROJECT_TOML_NONE,
		readPrd: () => PRD_JSON_NUMERIC,
		stashFn: () => {},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// AC1: issue-writer seam is never invoked
// ---------------------------------------------------------------------------

describe('AC1 (US-004): finalizeCycleClose never reads or writes any issues/ file', () => {
	test('local backend: stashFn called; no readIssues/writeIssues in options', () => {
		// The interface no longer has readIssues / writeIssues fields.
		// Verify stashFn IS called with the resolved id.
		const stashedIds: string[] = [];
		const { spawnFn } = makeRecordingSpawn();

		finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_NONE,
				stashFn: (id) => stashedIds.push(id),
			}),
		);

		expect(stashedIds).toEqual(['CAM-72']);
	});

	test('stashFn is called with the resolved id before any git rm call', () => {
		const callOrder: string[] = [];
		const { spawnFn, calls } = makeRecordingSpawn();

		// Wrap spawnFn to record rm order
		const wrappingSpawn: SpawnFn = (cmd, args, o) => {
			if (args.includes('rm')) callOrder.push('git-rm');
			return spawnFn(cmd, args, o);
		};

		finalizeCycleClose(
			makeOptions({
				spawnFn: wrappingSpawn,
				stashFn: () => callOrder.push('stash'),
			}),
		);

		// stash MUST appear before the first git rm
		const stashIdx = callOrder.indexOf('stash');
		const firstRmIdx = callOrder.indexOf('git-rm');
		expect(stashIdx).toBeGreaterThanOrEqual(0);
		expect(firstRmIdx).toBeGreaterThanOrEqual(0);
		expect(stashIdx).toBeLessThan(firstRmIdx);

		// ensure calls were actually recorded
		expect(calls.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// AC2: git rm + commit still runs (unchanged)
// ---------------------------------------------------------------------------

describe('AC2 (US-004): git rm + commit unchanged for local backend', () => {
	test('rms prd.json, handoff.json, progress.txt and commits', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		const result = finalizeCycleClose(makeOptions({ spawnFn }));

		// git rm -f --ignore-unmatch for each harness file
		const rmCalls = calls.filter(
			(c) =>
				c.args.includes('rm') &&
				c.args.includes('-f') &&
				c.args.includes('--ignore-unmatch'),
		);
		expect(rmCalls.length).toBe(3);
		const removedPaths = rmCalls.map((c) => c.args[c.args.length - 1]);
		expect(removedPaths).toContain('scripts/cam/prd.json');
		expect(removedPaths).toContain('scripts/cam/handoff.json');
		expect(removedPaths).toContain('scripts/cam/progress.txt');

		// commit happens
		const commitCall = calls.find((c) => c.args.includes('commit'));
		expect(commitCall).toBeDefined();
		expect(result.commitMessage).toBe(
			'chore(cam): close CAM-72 + drop per-branch harness state (CAM-27 hygiene)',
		);
	});

	test('no git add for any scripts/cam/issues/ path', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		finalizeCycleClose(makeOptions({ spawnFn }));

		const addIssuesCall = calls.find(
			(c) => c.args.includes('add') && c.args.some((a) => a.includes('scripts/cam/issues/')),
		);
		expect(addIssuesCall).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// AC3: resolveIssueId (string AND numeric), stash BEFORE git rm, fail loud
// ---------------------------------------------------------------------------

describe('AC3 (US-004): resolveIssueId + stash behavior', () => {
	test('numeric issueNumber: resolves to CAM-72 and stashes', () => {
		const stashedIds: string[] = [];
		const { spawnFn } = makeRecordingSpawn();

		const result = finalizeCycleClose(
			makeOptions({
				spawnFn,
				readPrd: () => PRD_JSON_NUMERIC,
				stashFn: (id) => stashedIds.push(id),
			}),
		);

		expect(result.issueId).toBe('CAM-72');
		expect(stashedIds).toEqual(['CAM-72']);
	});

	test('string issueNumber (CAM-72): resolves correctly and stashes', () => {
		const stashedIds: string[] = [];
		const { spawnFn } = makeRecordingSpawn();

		const result = finalizeCycleClose(
			makeOptions({
				spawnFn,
				readPrd: () => PRD_JSON_STRING,
				stashFn: (id) => stashedIds.push(id),
			}),
		);

		expect(result.issueId).toBe('CAM-72');
		expect(stashedIds).toEqual(['CAM-72']);
	});

	test('issueNumber=0 (invalid): throws and never stashes', () => {
		const stashedIds: string[] = [];
		const { spawnFn } = makeRecordingSpawn();

		expect(() =>
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readPrd: () => JSON.stringify({ issueNumber: 0 }),
					stashFn: (id) => stashedIds.push(id),
				}),
			),
		).toThrow();

		expect(stashedIds).toHaveLength(0);
	});

	test('issueNumber absent (null/undefined): stashFn not called, no throw', () => {
		const stashedIds: string[] = [];
		const { spawnFn } = makeRecordingSpawn();

		const result = finalizeCycleClose(
			makeOptions({
				spawnFn,
				readPrd: () => JSON.stringify({ branchName: 'cam/foo' }),
				stashFn: (id) => stashedIds.push(id),
			}),
		);

		// No stash when there is no issueNumber
		expect(stashedIds).toHaveLength(0);
		expect(result.issueId).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// AC4: no git push to main in any spawn call
// ---------------------------------------------------------------------------

describe('AC4 (US-004): no git push to main', () => {
	test('local backend: no spawn call is a git push to main', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		finalizeCycleClose(makeOptions({ spawnFn, readProjectToml: () => PROJECT_TOML_NONE }));

		const pushToMainCall = calls.find(
			(c) =>
				c.args.includes('push') &&
				(c.args.includes('main') || c.args.some((a) => a.endsWith('/main'))),
		);
		expect(pushToMainCall).toBeUndefined();
	});

	test('github backend: no spawn call is a git push to main', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		finalizeCycleClose(makeOptions({ spawnFn, readProjectToml: () => PROJECT_TOML_GITHUB }));

		const pushToMainCall = calls.find(
			(c) =>
				c.args.includes('push') &&
				(c.args.includes('main') || c.args.some((a) => a.endsWith('/main'))),
		);
		expect(pushToMainCall).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// AC5: github and linear backends unchanged (git rm + commit, no issue file)
// ---------------------------------------------------------------------------

describe('AC5 (US-004): github backend — git rm + commit, no issue file', () => {
	test('does NOT touch any issues/ file, still rms harness files and commits', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		const result = finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_GITHUB,
			}),
		);

		expect(result.issueBackend).toBe('github');

		// No git add for issues/
		const addIssuesCall = calls.find(
			(c) => c.args.includes('add') && c.args.some((a) => a.includes('scripts/cam/issues/')),
		);
		expect(addIssuesCall).toBeUndefined();

		// git rm still runs
		const rmCalls = calls.filter(
			(c) => c.args.includes('rm') && c.args.includes('-f') && c.args.includes('--ignore-unmatch'),
		);
		expect(rmCalls.length).toBe(3);

		// commit still happens
		expect(calls.find((c) => c.args.includes('commit'))).toBeDefined();
		expect(result.commitMessage).toBe(
			'chore(cam): close CAM-72 + drop per-branch harness state (CAM-27 hygiene)',
		);
	});

	test('stashFn is NOT called for github backend (US-R1-001: no spurious closeIssueOnMain)', () => {
		const stashedIds: string[] = [];
		const { spawnFn } = makeRecordingSpawn();

		finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_GITHUB,
				stashFn: (id) => stashedIds.push(id),
			}),
		);

		// stashFn must NOT be called for github: github closes its own issue
		// via the external system, not via closeIssueOnMain on the local store.
		expect(stashedIds).toHaveLength(0);
	});
});

describe('AC5 (US-004): linear backend — git rm + commit, no issue file', () => {
	test('does NOT touch any issues/ file, still rms harness files and commits', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		const result = finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_LINEAR,
			}),
		);

		expect(result.issueBackend).toBe('linear');
		const addIssuesCall = calls.find(
			(c) => c.args.includes('add') && c.args.some((a) => a.includes('scripts/cam/issues/')),
		);
		expect(addIssuesCall).toBeUndefined();
		const rmCalls = calls.filter(
			(c) => c.args.includes('rm') && c.args.includes('-f') && c.args.includes('--ignore-unmatch'),
		);
		expect(rmCalls.length).toBe(3);
		expect(calls.find((c) => c.args.includes('commit'))).toBeDefined();
	});

	test('stashFn is NOT called for linear backend (US-R1-001: no spurious closeIssueOnMain)', () => {
		const stashedIds: string[] = [];
		const { spawnFn } = makeRecordingSpawn();

		finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_LINEAR,
				stashFn: (id) => stashedIds.push(id),
			}),
		);

		// stashFn must NOT be called for linear: linear closes its own issue
		// via the external system, not via closeIssueOnMain on the local store.
		expect(stashedIds).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// dirty-prd.json: `git rm -f --ignore-unmatch` must be used
// ---------------------------------------------------------------------------

describe('dirty prd.json case', () => {
	test('prd.json is still removed via git rm -f --ignore-unmatch even if dirty', () => {
		const { spawnFn, calls } = makeRecordingSpawn();

		finalizeCycleClose(makeOptions({ spawnFn }));

		const prdRmCall = calls.find(
			(c) =>
				c.args.includes('rm') &&
				c.args.includes('-f') &&
				c.args.includes('--ignore-unmatch') &&
				c.args.includes('scripts/cam/prd.json'),
		);
		expect(prdRmCall).toBeDefined();

		expect(prdRmCall!.args).toContain('-f');
		expect(prdRmCall!.args).toContain('--ignore-unmatch');
		const rmIdx = prdRmCall!.args.indexOf('rm');
		const fIdx = prdRmCall!.args.indexOf('-f');
		const ignoreIdx = prdRmCall!.args.indexOf('--ignore-unmatch');
		expect(rmIdx).toBeLessThan(fIdx);
		expect(fIdx).toBeLessThan(ignoreIdx);
	});
});

// ---------------------------------------------------------------------------
// structured result line (emitOk assertions)
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes from a string for plain-text assertions. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1B) required for ANSI stripping
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('finalizeCycleClose — structured result line', () => {
	test('happy path (local backend) emits line with issue-id, removed files, and sha', () => {
		const captured: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			if (typeof chunk === 'string') captured.push(chunk);
			else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString('utf8'));
			return true;
		}) as unknown as typeof process.stdout.write;

		let error: unknown;
		try {
			const { spawnFn } = makeRecordingSpawn({ revParseSha: 'def5678' });
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readProjectToml: () => PROJECT_TOML_NONE,
					stashFn: () => {},
				}),
			);
		} catch (e) {
			error = e;
		} finally {
			process.stdout.write = origWrite;
		}

		expect(error).toBeUndefined();

		const plain = stripAnsi(captured.join(''));
		expect(plain).toContain('closed CAM-72');
		expect(plain).toContain('prd.json');
		expect(plain).toContain('handoff.json');
		expect(plain).toContain('progress.txt');
		expect(plain).toContain('sha def5678');
	});

	test('github backend emits line noting issue-close handled by github', () => {
		const captured: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			if (typeof chunk === 'string') captured.push(chunk);
			else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString('utf8'));
			return true;
		}) as unknown as typeof process.stdout.write;

		try {
			const { spawnFn } = makeRecordingSpawn({ revParseSha: 'aaa0001' });
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readProjectToml: () => PROJECT_TOML_GITHUB,
				}),
			);
		} finally {
			process.stdout.write = origWrite;
		}

		const plain = stripAnsi(captured.join(''));
		expect(plain).toContain('closed CAM-72');
		expect(plain).toContain('github');
		expect(plain).toContain('sha aaa0001');
	});

	test('no-op (prd absent) emits a clear skip message, not silent', () => {
		const captured: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			if (typeof chunk === 'string') captured.push(chunk);
			else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString('utf8'));
			return true;
		}) as unknown as typeof process.stdout.write;

		try {
			const { spawnFn } = makeRecordingSpawn();
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readPrd: () => { throw new Error('ENOENT'); },
				}),
			);
		} finally {
			process.stdout.write = origWrite;
		}

		const plain = stripAnsi(captured.join(''));
		expect(plain.length).toBeGreaterThan(0);
		const lower = plain.toLowerCase();
		expect(lower.includes('skipped') || lower.includes('already closed')).toBe(true);
	});

	test('no-op (nothing staged) emits a clear skip message, not silent', () => {
		const captured: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			if (typeof chunk === 'string') captured.push(chunk);
			else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString('utf8'));
			return true;
		}) as unknown as typeof process.stdout.write;

		try {
			const { spawnFn } = makeRecordingSpawn({ diffCachedStatus: 0 });
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readProjectToml: () => PROJECT_TOML_GITHUB,
				}),
			);
		} finally {
			process.stdout.write = origWrite;
		}

		const plain = stripAnsi(captured.join(''));
		expect(plain.length).toBeGreaterThan(0);
		const lower = plain.toLowerCase();
		expect(lower.includes('skipped') || lower.includes('nothing staged')).toBe(true);
	});
});
