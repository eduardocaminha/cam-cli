// test/issues/alloc.test.ts
//
// Tests for src/issues/alloc.ts (writeIssueFile).
//
// Oracle assertions:
//   - Filename is 4-digit zero-padded; id field inside is unpadded.
//   - Padding: 90 -> CAM-0090.json, 1000 -> CAM-1000.json.
//   - Both ids (90 and 1000) parse back from the written JSON as unpadded
//     strings ('CAM-90', 'CAM-1000').
//   - On a simulated CAS failure, the writer re-reads max id from main and
//     re-allocates (second attempt uses a higher id than the first).
//   - Successful write returns { id, filename, sha }.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import { writeIssueFile } from '../../src/issues/alloc.ts';
import type { SpawnFn } from '../../src/git/on-main.ts';
import type { IssueEntry } from '../../src/issues/types.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Empty SpawnSyncReturns<string> stub with success exit code. */
function ok(stdout = ''): SpawnSyncReturns<string> {
	return { stdout, stderr: '', status: 0, output: [], pid: 0, signal: null, error: undefined };
}

/** SpawnSyncReturns<string> stub signalling failure (exit 1). */
function fail(stderr = ''): SpawnSyncReturns<string> {
	return { stdout: '', stderr, status: 1, output: [], pid: 0, signal: null, error: undefined };
}

/**
 * Build the framed output that `git cat-file --batch` would emit for one entry.
 * Frame format: `<oid> blob <size>\n<content>\n`
 */
function frameEntry(entry: IssueEntry): string {
	const content = JSON.stringify(entry);
	const size = Buffer.byteLength(content, 'utf8');
	return `deadbeef0000000000000000000000000000000000 blob ${size}\n${content}\n`;
}

/**
 * Build a minimal SpawnFn spy for a single-success scenario.
 *
 * Handles:
 *   git rev-parse main       -> sha (initial + subsequent reads)
 *   git ls-tree              -> one path per entry in `entries`
 *   git cat-file --batch     -> framed output for `entries`
 *   git read-tree            -> ok
 *   git hash-object          -> fakeBlobSha
 *   git update-index         -> ok
 *   git write-tree           -> fakeTreeSha
 *   git commit-tree          -> fakeCommitSha
 *   git update-ref           -> ok (success on first call)
 */
function makeSpawnFn(entries: IssueEntry[], sha = 'aabbccd'): { spy: SpawnFn; calls: string[][] } {
	const calls: string[][] = [];
	const fakeBlobSha = 'blob0000000000000000000000000000000000000000';
	const fakeTreeSha = 'tree000000000000000000000000000000000000000';
	const fakeCommitSha = sha.padEnd(40, '0');

	const spy: SpawnFn = (_cmd, args, _opts) => {
		calls.push(args);
		const sub = args[1]; // args[0] is '-C', args[1] is 'cwd', args[2] is subcommand -- wait
		// Actually args are: ['-C', cwd, <subcommand>, ...rest]
		// so args[2] is the git subcommand
		const gitSub = args[2];

		if (gitSub === 'rev-parse') return ok(fakeCommitSha);
		if (gitSub === 'ls-tree') {
			const paths = entries.map((e, i) =>
				`scripts/cam/issues/CAM-${String(i + 1).padStart(4, '0')}.json`
			).join('\n');
			return ok(paths + '\n');
		}
		if (gitSub === 'cat-file') {
			return ok(entries.map(frameEntry).join(''));
		}
		if (gitSub === 'read-tree') return ok();
		if (gitSub === 'hash-object') return ok(fakeBlobSha + '\n');
		if (gitSub === 'update-index') return ok();
		if (gitSub === 'write-tree') return ok(fakeTreeSha + '\n');
		if (gitSub === 'commit-tree') return ok(fakeCommitSha + '\n');
		if (gitSub === 'update-ref') return ok();

		return ok();
	};

	return { spy, calls };
}

// ---------------------------------------------------------------------------
// Filename padding and id field
// ---------------------------------------------------------------------------

describe('writeIssueFile -- filename padding and id field', () => {
	test('id 90: filename is CAM-0090.json, id field is CAM-90 (unpadded)', () => {
		// Backlog: entries CAM-1..CAM-89 so allocateId returns 90.
		const entries: IssueEntry[] = Array.from({ length: 89 }, (_, i) => ({
			id: `CAM-${i + 1}`,
			title: `Issue ${i + 1}`,
			stage: 'idea' as const,
			status: 'open' as const,
			blockedBy: [],
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
		}));

		let writtenContent = '';
		const writtenFilenames: string[] = [];

		const spy: SpawnFn = (_cmd, args, opts) => {
			const gitSub = args[2];
			if (gitSub === 'rev-parse') return ok('aaa000'.padEnd(40, '0') + '\n');
			if (gitSub === 'ls-tree') {
				const paths = entries.map((e) =>
					`scripts/cam/issues/CAM-${String(numericSuffix(e.id)).padStart(4, '0')}.json`
				).join('\n');
				return ok(paths + '\n');
			}
			if (gitSub === 'cat-file') return ok(entries.map(frameEntry).join(''));
			if (gitSub === 'read-tree') return ok();
			if (gitSub === 'hash-object') {
				writtenContent = opts.input ?? '';
				return ok('blob' + '0'.repeat(36) + '\n');
			}
			if (gitSub === 'update-index') {
				// Capture the filename from --cacheinfo arg.
				const cacheinfo = args.find((a) => a.startsWith('100644,'));
				if (cacheinfo !== undefined) {
					const parts = cacheinfo.split(',');
					writtenFilenames.push(parts[2] ?? '');
				}
				return ok();
			}
			if (gitSub === 'write-tree') return ok('tree' + '0'.repeat(36) + '\n');
			if (gitSub === 'commit-tree') return ok('commit' + '0'.repeat(34) + '\n');
			if (gitSub === 'update-ref') return ok();
			return ok();
		};

		const result = writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Test issue 90',
			createdAt: '2026-06-28T00:00:00Z',
			spawnFn: spy,
		});

		// Filename (result.filename) must be padded.
		expect(result.filename).toBe('scripts/cam/issues/CAM-0090.json');

		// The update-index cacheinfo path must be padded.
		expect(writtenFilenames).toHaveLength(1);
		expect(writtenFilenames[0]).toBe('scripts/cam/issues/CAM-0090.json');

		// The id field INSIDE the written JSON must be unpadded.
		const parsed = JSON.parse(writtenContent) as IssueEntry;
		expect(parsed.id).toBe('CAM-90');

		// Returned id must be unpadded.
		expect(result.id).toBe('CAM-90');
	});

	test('id 1000: filename is CAM-1000.json (no leading zeros when N >= 1000)', () => {
		const entries: IssueEntry[] = Array.from({ length: 999 }, (_, i) => ({
			id: `CAM-${i + 1}`,
			title: `Issue ${i + 1}`,
			stage: 'idea' as const,
			status: 'open' as const,
			blockedBy: [],
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
		}));

		let writtenContent = '';
		const writtenFilenames: string[] = [];

		const spy: SpawnFn = (_cmd, args, opts) => {
			const gitSub = args[2];
			if (gitSub === 'rev-parse') return ok('bbb000'.padEnd(40, '0') + '\n');
			if (gitSub === 'ls-tree') {
				const paths = entries.map((e) =>
					`scripts/cam/issues/CAM-${String(numericSuffix(e.id)).padStart(4, '0')}.json`
				).join('\n');
				return ok(paths + '\n');
			}
			if (gitSub === 'cat-file') return ok(entries.map(frameEntry).join(''));
			if (gitSub === 'read-tree') return ok();
			if (gitSub === 'hash-object') {
				writtenContent = opts.input ?? '';
				return ok('blob' + '0'.repeat(36) + '\n');
			}
			if (gitSub === 'update-index') {
				const cacheinfo = args.find((a) => a.startsWith('100644,'));
				if (cacheinfo !== undefined) {
					const parts = cacheinfo.split(',');
					writtenFilenames.push(parts[2] ?? '');
				}
				return ok();
			}
			if (gitSub === 'write-tree') return ok('tree' + '0'.repeat(36) + '\n');
			if (gitSub === 'commit-tree') return ok('commit' + '0'.repeat(34) + '\n');
			if (gitSub === 'update-ref') return ok();
			return ok();
		};

		const result = writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Test issue 1000',
			createdAt: '2026-06-28T00:00:00Z',
			spawnFn: spy,
		});

		expect(result.filename).toBe('scripts/cam/issues/CAM-1000.json');
		expect(writtenFilenames[0]).toBe('scripts/cam/issues/CAM-1000.json');
		const parsed = JSON.parse(writtenContent) as IssueEntry;
		expect(parsed.id).toBe('CAM-1000');
		expect(result.id).toBe('CAM-1000');
	});

	test('freshly-created issue has updatedAt equal to createdAt (US-001, CAM-284)', () => {
		const entries: IssueEntry[] = [];
		let writtenContent = '';

		const spy: SpawnFn = (_cmd, args, opts) => {
			const gitSub = args[2];
			if (gitSub === 'rev-parse') return ok('ccc000'.padEnd(40, '0') + '\n');
			if (gitSub === 'ls-tree') return ok('');
			if (gitSub === 'cat-file') return ok(entries.map(frameEntry).join(''));
			if (gitSub === 'read-tree') return ok();
			if (gitSub === 'hash-object') {
				writtenContent = opts.input ?? '';
				return ok('blob' + '0'.repeat(36) + '\n');
			}
			if (gitSub === 'update-index') return ok();
			if (gitSub === 'write-tree') return ok('tree' + '0'.repeat(36) + '\n');
			if (gitSub === 'commit-tree') return ok('commit' + '0'.repeat(34) + '\n');
			if (gitSub === 'update-ref') return ok();
			return ok();
		};

		writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Fresh issue',
			createdAt: '2026-07-12T00:00:00Z',
			spawnFn: spy,
		});

		const parsed = JSON.parse(writtenContent) as IssueEntry;
		expect(parsed.updatedAt).toBe(parsed.createdAt);
		expect(parsed.updatedAt).toBe('2026-07-12T00:00:00Z');
	});

	test('id 90: roundtrip -- parsed id from written JSON is unpadded CAM-90', () => {
		// Companion to the above: explicit roundtrip assertion.
		const entries: IssueEntry[] = Array.from({ length: 89 }, (_, i) => ({
			id: `CAM-${i + 1}`,
			title: `Issue ${i + 1}`,
			stage: 'idea' as const,
			status: 'open' as const,
			blockedBy: [],
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
		}));

		let writtenContent = '';
		const spy: SpawnFn = (_cmd, args, opts) => {
			const gitSub = args[2];
			if (gitSub === 'rev-parse') return ok('ccc000'.padEnd(40, '0') + '\n');
			if (gitSub === 'ls-tree') {
				return ok(entries.map((e) => `scripts/cam/issues/${e.id}.json`).join('\n') + '\n');
			}
			if (gitSub === 'cat-file') return ok(entries.map(frameEntry).join(''));
			if (gitSub === 'read-tree') return ok();
			if (gitSub === 'hash-object') { writtenContent = opts.input ?? ''; return ok('blob' + '0'.repeat(36) + '\n'); }
			if (gitSub === 'update-index') return ok();
			if (gitSub === 'write-tree') return ok('tree' + '0'.repeat(36) + '\n');
			if (gitSub === 'commit-tree') return ok('commit' + '0'.repeat(34) + '\n');
			if (gitSub === 'update-ref') return ok();
			return ok();
		};

		writeIssueFile({ cwd: '/fake/cwd', title: 'Roundtrip', createdAt: '2026-06-28T00:00:00Z', spawnFn: spy });
		const parsed = JSON.parse(writtenContent) as IssueEntry;
		// Roundtrip: the parsed id must be unpadded.
		expect(parsed.id).toBe('CAM-90');
	});

	test('id 1000: roundtrip -- parsed id from written JSON is unpadded CAM-1000', () => {
		const entries: IssueEntry[] = Array.from({ length: 999 }, (_, i) => ({
			id: `CAM-${i + 1}`,
			title: `Issue ${i + 1}`,
			stage: 'idea' as const,
			status: 'open' as const,
			blockedBy: [],
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
		}));

		let writtenContent = '';
		const spy: SpawnFn = (_cmd, args, opts) => {
			const gitSub = args[2];
			if (gitSub === 'rev-parse') return ok('ddd000'.padEnd(40, '0') + '\n');
			if (gitSub === 'ls-tree') {
				return ok(entries.map((e) => `scripts/cam/issues/${e.id}.json`).join('\n') + '\n');
			}
			if (gitSub === 'cat-file') return ok(entries.map(frameEntry).join(''));
			if (gitSub === 'read-tree') return ok();
			if (gitSub === 'hash-object') { writtenContent = opts.input ?? ''; return ok('blob' + '0'.repeat(36) + '\n'); }
			if (gitSub === 'update-index') return ok();
			if (gitSub === 'write-tree') return ok('tree' + '0'.repeat(36) + '\n');
			if (gitSub === 'commit-tree') return ok('commit' + '0'.repeat(34) + '\n');
			if (gitSub === 'update-ref') return ok();
			return ok();
		};

		writeIssueFile({ cwd: '/fake/cwd', title: 'Roundtrip 1000', createdAt: '2026-06-28T00:00:00Z', spawnFn: spy });
		const parsed = JSON.parse(writtenContent) as IssueEntry;
		expect(parsed.id).toBe('CAM-1000');
	});
});

// ---------------------------------------------------------------------------
// CAS failure: re-reads and re-allocates
// ---------------------------------------------------------------------------

describe('writeIssueFile -- CAS failure re-reads and re-allocates', () => {
	test('first update-ref fails; second attempt reads fresh backlog and allocates a new id', () => {
		// First attempt: backlog has CAM-1..CAM-5 -> allocateId returns 6.
		// After CAS failure, another writer adds CAM-6 to main.
		// Second attempt: backlog has CAM-1..CAM-6 -> allocateId returns 7.

		const initialEntries: IssueEntry[] = Array.from({ length: 5 }, (_, i) => ({
			id: `CAM-${i + 1}`,
			title: `Issue ${i + 1}`,
			stage: 'idea' as const,
			status: 'open' as const,
			blockedBy: [],
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
		}));

		const updatedEntries: IssueEntry[] = [
			...initialEntries,
			{ id: 'CAM-6', title: 'Concurrent issue', stage: 'idea', status: 'open', blockedBy: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
		];

		let updateRefCallCount = 0;
		let lsTreeCallCount = 0;
		const allocatedIds: string[] = [];
		let writtenContent = '';

		const spy: SpawnFn = (_cmd, args, opts) => {
			const gitSub = args[2];

			if (gitSub === 'rev-parse') {
				return ok('sha0' + '0'.repeat(36) + '\n');
			}

			if (gitSub === 'ls-tree') {
				lsTreeCallCount++;
				// First ls-tree call: initial backlog (CAM-1..5).
				// Second ls-tree call: updated backlog (CAM-1..6).
				const entries = lsTreeCallCount <= 1 ? initialEntries : updatedEntries;
				const paths = entries.map((e) =>
					`scripts/cam/issues/CAM-${String(numericSuffix(e.id)).padStart(4, '0')}.json`
				).join('\n');
				return ok(paths + '\n');
			}

			if (gitSub === 'cat-file') {
				// Match the current set of entries (based on lsTree count).
				const entries = lsTreeCallCount <= 1 ? initialEntries : updatedEntries;
				return ok(entries.map(frameEntry).join(''));
			}

			if (gitSub === 'read-tree') return ok();

			if (gitSub === 'hash-object') {
				writtenContent = opts.input ?? '';
				// Capture the allocated id from the content being written.
				try {
					const entry = JSON.parse(writtenContent) as IssueEntry;
					allocatedIds.push(entry.id);
				} catch { /* ignore */ }
				return ok('blob' + '0'.repeat(36) + '\n');
			}

			if (gitSub === 'update-index') return ok();
			if (gitSub === 'write-tree') return ok('tree' + '0'.repeat(36) + '\n');
			if (gitSub === 'commit-tree') return ok('sha1' + '0'.repeat(36) + '\n');

			if (gitSub === 'update-ref') {
				updateRefCallCount++;
				// First update-ref: fail (CAS conflict).
				// Second update-ref: succeed.
				if (updateRefCallCount === 1) return fail('ref conflict');
				return ok();
			}

			return ok();
		};

		const result = writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Re-allocated issue',
			createdAt: '2026-06-28T00:00:00Z',
			spawnFn: spy,
		});

		// Two update-ref calls were made (one failure + one success).
		expect(updateRefCallCount).toBe(2);

		// Two allocations were made with distinct ids.
		expect(allocatedIds).toHaveLength(2);
		expect(allocatedIds[0]).toBe('CAM-6'); // First attempt: max=5 -> next=6.
		expect(allocatedIds[1]).toBe('CAM-7'); // Second attempt: max=6 -> next=7.

		// Final result uses the second (re-allocated) id.
		expect(result.id).toBe('CAM-7');
		expect(result.filename).toBe('scripts/cam/issues/CAM-0007.json');
	});
});

// ---------------------------------------------------------------------------
// Successful write -- result shape
// ---------------------------------------------------------------------------

describe('writeIssueFile -- result shape', () => {
	test('returns { id, filename, sha } on success', () => {
		const entries: IssueEntry[] = [{ id: 'CAM-1', title: 'First', stage: 'idea', status: 'open', blockedBy: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }];
		const fakeCommitSha = 'abcdef1234567890'.padEnd(40, '0');

		const spy: SpawnFn = (_cmd, args, _opts) => {
			const gitSub = args[2];
			if (gitSub === 'rev-parse') return ok(fakeCommitSha + '\n');
			if (gitSub === 'ls-tree') return ok('scripts/cam/issues/CAM-0001.json\n');
			if (gitSub === 'cat-file') return ok(entries.map(frameEntry).join(''));
			if (gitSub === 'read-tree') return ok();
			if (gitSub === 'hash-object') return ok('blob' + '0'.repeat(36) + '\n');
			if (gitSub === 'update-index') return ok();
			if (gitSub === 'write-tree') return ok('tree' + '0'.repeat(36) + '\n');
			if (gitSub === 'commit-tree') return ok(fakeCommitSha + '\n');
			if (gitSub === 'update-ref') return ok();
			return ok();
		};

		const result = writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Second issue',
			createdAt: '2026-06-28T00:00:00Z',
			spawnFn: spy,
		});

		expect(result.id).toBe('CAM-2');
		expect(result.filename).toBe('scripts/cam/issues/CAM-0002.json');
		// sha is first 7 chars of the fakeCommitSha
		expect(result.sha).toBe(fakeCommitSha.substring(0, 7));
	});

	test('empty backlog: allocates id=1, filename is CAM-0001.json', () => {
		const spy: SpawnFn = (_cmd, args, _opts) => {
			const gitSub = args[2];
			if (gitSub === 'rev-parse') return ok('sha' + '0'.repeat(37) + '\n');
			if (gitSub === 'ls-tree') return ok('');          // empty backlog
			if (gitSub === 'read-tree') return ok();
			if (gitSub === 'hash-object') return ok('blob' + '0'.repeat(36) + '\n');
			if (gitSub === 'update-index') return ok();
			if (gitSub === 'write-tree') return ok('tree' + '0'.repeat(36) + '\n');
			if (gitSub === 'commit-tree') return ok('commit' + '0'.repeat(34) + '\n');
			if (gitSub === 'update-ref') return ok();
			return ok();
		};

		const result = writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Very first issue',
			createdAt: '2026-06-28T00:00:00Z',
			spawnFn: spy,
		});

		expect(result.id).toBe('CAM-1');
		expect(result.filename).toBe('scripts/cam/issues/CAM-0001.json');
	});
});

// ---------------------------------------------------------------------------
// US-002: specSource / derivedFrom / wsjf written into IssueEntry
// ---------------------------------------------------------------------------

describe('writeIssueFile -- specSource / derivedFrom / wsjf (US-002)', () => {
	test('specSource:operator sets stage to specified in written JSON', () => {
		let writtenContent = '';
		const { spy } = makeSpawnFn([]);
		const wrappedSpy: SpawnFn = (_cmd, args, opts) => {
			if (args[2] === 'hash-object') { writtenContent = opts.input ?? ''; }
			return spy(_cmd, args, opts);
		};

		writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Fast-track operator issue',
			description: 'A description',
			specSource: 'operator',
			wsjf: { value: 5, timeCriticality: 3, riskReduction: 2, jobSize: 4 },
			createdAt: '2026-06-30T00:00:00Z',
			spawnFn: wrappedSpy,
		});

		const entry = JSON.parse(writtenContent) as {
			stage: string;
			specSource: string;
			wsjf: { value: number };
		};
		expect(entry.stage).toBe('specified');
		expect(entry.specSource).toBe('operator');
		expect(entry.wsjf.value).toBe(5);
	});

	test('specSource:derived sets stage to specified in written JSON', () => {
		let writtenContent = '';
		const { spy } = makeSpawnFn([]);
		const wrappedSpy: SpawnFn = (_cmd, args, opts) => {
			if (args[2] === 'hash-object') { writtenContent = opts.input ?? ''; }
			return spy(_cmd, args, opts);
		};

		writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Derived fix',
			description: 'A fix derived from parent',
			specSource: 'derived',
			derivedFrom: ['CAM-42'],
			wsjf: { value: 8, timeCriticality: 6, riskReduction: 5, jobSize: 3 },
			createdAt: '2026-06-30T00:00:00Z',
			spawnFn: wrappedSpy,
		});

		const entry = JSON.parse(writtenContent) as {
			stage: string;
			specSource: string;
			derivedFrom: string[];
			wsjf: { value: number };
		};
		expect(entry.stage).toBe('specified');
		expect(entry.specSource).toBe('derived');
		expect(entry.derivedFrom).toEqual(['CAM-42']);
		expect(entry.wsjf.value).toBe(8);
	});

	test('no specSource keeps default stage:idea and omits specSource from JSON', () => {
		let writtenContent = '';
		const { spy } = makeSpawnFn([]);
		const wrappedSpy: SpawnFn = (_cmd, args, opts) => {
			if (args[2] === 'hash-object') { writtenContent = opts.input ?? ''; }
			return spy(_cmd, args, opts);
		};

		writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Normal idea issue',
			createdAt: '2026-06-30T00:00:00Z',
			spawnFn: wrappedSpy,
		});

		const entry = JSON.parse(writtenContent) as { stage: string; specSource?: string };
		expect(entry.stage).toBe('idea');
		expect(entry.specSource).toBeUndefined();
	});

	test('wsjf is omitted from JSON when not provided', () => {
		let writtenContent = '';
		const { spy } = makeSpawnFn([]);
		const wrappedSpy: SpawnFn = (_cmd, args, opts) => {
			if (args[2] === 'hash-object') { writtenContent = opts.input ?? ''; }
			return spy(_cmd, args, opts);
		};

		writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Normal idea issue',
			createdAt: '2026-06-30T00:00:00Z',
			spawnFn: wrappedSpy,
		});

		const entry = JSON.parse(writtenContent) as { wsjf?: unknown };
		expect(entry.wsjf).toBeUndefined();
	});

	test('empty derivedFrom array is omitted from JSON', () => {
		let writtenContent = '';
		const { spy } = makeSpawnFn([]);
		const wrappedSpy: SpawnFn = (_cmd, args, opts) => {
			if (args[2] === 'hash-object') { writtenContent = opts.input ?? ''; }
			return spy(_cmd, args, opts);
		};

		writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Operator issue with empty derivedFrom',
			description: 'A description',
			specSource: 'operator',
			derivedFrom: [],  // empty: should be omitted from JSON
			wsjf: { value: 3, timeCriticality: 2, riskReduction: 1, jobSize: 2 },
			createdAt: '2026-06-30T00:00:00Z',
			spawnFn: wrappedSpy,
		});

		const entry = JSON.parse(writtenContent) as { derivedFrom?: string[] };
		expect(entry.derivedFrom).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// US-001 (CAM-290): extraFiles co-commit + commitMessage override
// ---------------------------------------------------------------------------

describe('writeIssueFile -- extraFiles co-commit (US-001, CAM-290)', () => {
	test('extraFiles are hashed+indexed into the same commit-tree as the issue file; exactly ONE commit-tree call on success', () => {
		const { spy: baseSpy } = makeSpawnFn([]);
		let commitTreeCallCount = 0;
		const indexedPaths: string[] = [];

		const spy: SpawnFn = (_cmd, args, opts) => {
			const gitSub = args[2];
			if (gitSub === 'commit-tree') commitTreeCallCount++;
			if (gitSub === 'update-index') {
				const cacheinfo = args.find((a) => a.startsWith('100644,'));
				if (cacheinfo !== undefined) {
					const parts = cacheinfo.split(',');
					indexedPaths.push(parts[2] ?? '');
				}
			}
			return baseSpy(_cmd, args, opts);
		};

		const result = writeIssueFile({
			cwd: '/fake/cwd',
			title: 'With companion file',
			createdAt: '2026-07-13T00:00:00Z',
			extraFiles: [{ path: 'scripts/cam/suggestions.md', content: 'updated pen\n' }],
			spawnFn: spy,
		});

		// Exactly one commit-tree invocation on the (single, successful) attempt.
		expect(commitTreeCallCount).toBe(1);

		// The temp index received both the issue file and the extraFiles path.
		expect(indexedPaths).toContain(result.filename);
		expect(indexedPaths).toContain('scripts/cam/suggestions.md');
	});

	test('extraFiles content is re-indexed on every CAS attempt (re-hashed alongside the re-allocated id)', () => {
		const initialEntries: IssueEntry[] = Array.from({ length: 5 }, (_, i) => ({
			id: `CAM-${i + 1}`,
			title: `Issue ${i + 1}`,
			stage: 'idea' as const,
			status: 'open' as const,
			blockedBy: [],
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-01-01T00:00:00Z',
		}));
		const updatedEntries: IssueEntry[] = [
			...initialEntries,
			{ id: 'CAM-6', title: 'Concurrent issue', stage: 'idea', status: 'open', blockedBy: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
		];

		let updateRefCallCount = 0;
		let lsTreeCallCount = 0;
		let extraFileIndexCount = 0;

		const spy: SpawnFn = (_cmd, args, opts) => {
			const gitSub = args[2];

			if (gitSub === 'rev-parse') return ok('sha0' + '0'.repeat(36) + '\n');

			if (gitSub === 'ls-tree') {
				lsTreeCallCount++;
				const entries = lsTreeCallCount <= 1 ? initialEntries : updatedEntries;
				const paths = entries.map((e) =>
					`scripts/cam/issues/CAM-${String(numericSuffix(e.id)).padStart(4, '0')}.json`
				).join('\n');
				return ok(paths + '\n');
			}

			if (gitSub === 'cat-file') {
				const entries = lsTreeCallCount <= 1 ? initialEntries : updatedEntries;
				return ok(entries.map(frameEntry).join(''));
			}

			if (gitSub === 'read-tree') return ok();

			if (gitSub === 'hash-object') {
				if ((opts.input ?? '').includes('companion content')) extraFileIndexCount++;
				return ok('blob' + '0'.repeat(36) + '\n');
			}

			if (gitSub === 'update-index') return ok();
			if (gitSub === 'write-tree') return ok('tree' + '0'.repeat(36) + '\n');
			if (gitSub === 'commit-tree') return ok('sha1' + '0'.repeat(36) + '\n');

			if (gitSub === 'update-ref') {
				updateRefCallCount++;
				if (updateRefCallCount === 1) return fail('ref conflict');
				return ok();
			}

			return ok();
		};

		writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Re-allocated issue with companion',
			createdAt: '2026-06-28T00:00:00Z',
			extraFiles: [{ path: 'scripts/cam/suggestions.md', content: 'companion content\n' }],
			spawnFn: spy,
		});

		// Two CAS attempts occurred (one failure + one success); extraFiles content
		// must have been re-hashed on both.
		expect(updateRefCallCount).toBe(2);
		expect(extraFileIndexCount).toBe(2);
	});

	test('commitMessage override receives the freshly-allocated id and is used for commit-tree', () => {
		const { spy: baseSpy } = makeSpawnFn([]);
		let capturedCommitMsg = '';

		const spy: SpawnFn = (_cmd, args, opts) => {
			if (args[2] === 'commit-tree') {
				const msgIdx = args.indexOf('-m');
				capturedCommitMsg = msgIdx >= 0 ? (args[msgIdx + 1] ?? '') : '';
			}
			return baseSpy(_cmd, args, opts);
		};

		const result = writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Suggestion promotion',
			createdAt: '2026-07-13T00:00:00Z',
			commitMessage: (id) => `chore(cam): suggestions promote fp123 -> ${id}`,
			spawnFn: spy,
		});

		expect(capturedCommitMsg).toBe(`chore(cam): suggestions promote fp123 -> ${result.id}`);
	});

	test('default commit message (no commitMessage override) stays chore(cam): file <id>', () => {
		const { spy: baseSpy } = makeSpawnFn([]);
		let capturedCommitMsg = '';

		const spy: SpawnFn = (_cmd, args, opts) => {
			if (args[2] === 'commit-tree') {
				const msgIdx = args.indexOf('-m');
				capturedCommitMsg = msgIdx >= 0 ? (args[msgIdx + 1] ?? '') : '';
			}
			return baseSpy(_cmd, args, opts);
		};

		const result = writeIssueFile({
			cwd: '/fake/cwd',
			title: 'Normal issue',
			createdAt: '2026-07-13T00:00:00Z',
			spawnFn: spy,
		});

		expect(capturedCommitMsg).toBe(`chore(cam): file ${result.id}`);
	});
});

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function numericSuffix(id: string): number {
	const s = id.split('-').at(-1);
	if (s === undefined) return 0;
	const n = Number(s);
	return Number.isNaN(n) ? 0 : n;
}
