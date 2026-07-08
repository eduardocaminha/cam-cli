// test/commands/journal-archive.test.ts
//
// Unit tests for src/commands/journal-archive.ts (archiveJournalOnMain).
// CAM-125 US-001.
//
// Mirrors the fake-SpawnFn pattern of test/commands/journal-append.test.ts:
// all external I/O is faked via injectable SpawnFn; no real git binary or
// filesystem is exercised (except the mkdtempSync inside commitTreeToMain).

import { test, expect, describe } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	archiveJournalOnMain,
	type SpawnFn,
	type ArchiveJournalOnMainSuccess,
	type ArchiveJournalOnMainResult,
} from '../../src/commands/journal-archive.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PREAMBLE = [
	'# Cam Journal',
	'',
	'This file is the orchestrator long-term memory for this project.',
	'',
	'## Format',
	'',
	'Template goes here.',
	'',
	'## Guidelines for the orchestrator',
	'',
	'Guideline text goes here.',
	'',
	'## Entries',
	'',
	'<!-- Entries are appended below. Do not remove this marker. -->',
	'<!-- ENTRIES_BELOW -->',
].join('\n');

/** One "clean" entry block: header + bullets, no trailing blank line. */
function makeEntry(i: number): string {
	return [
		`## cycle/${i} — title ${i}`,
		'',
		`- **Started**: 2026-0${(i % 9) + 1}-01`,
		`- **Closed**: 2026-0${(i % 9) + 1}-02`,
		`- **Branch**: cycle/${i}`,
		`- **Issue**: CAM-${i}`,
		'- **Outcome**: shipped',
		`- **Summary**: summary ${i}.`,
	].join('\n');
}

/** Build a fixture journal.md with `n` entries after the marker. */
function buildJournalFixture(n: number, preamble = PREAMBLE): string {
	if (n === 0) return `${preamble}\n`;
	const entries = Array.from({ length: n }, (_, i) => makeEntry(i));
	return `${preamble}\n\n${entries.join('\n\n')}\n`;
}

function assertOk(result: ArchiveJournalOnMainResult): asserts result is ArchiveJournalOnMainSuccess {
	if (!result.ok) {
		throw new Error(`Expected ok:true but got ok:false, reason=${JSON.stringify((result as { reason: string }).reason)}`);
	}
}

// ---------------------------------------------------------------------------
// Fake SpawnFn builder
// ---------------------------------------------------------------------------

interface CallRecord {
	cmd: string;
	args: string[];
	input?: string;
}

interface FakeSpawnOpts {
	/** Simulated current branch (default: 'feat/test'). */
	branch?: string;
	/** Local main sha (default: 'abc123def456abc1'). */
	localMainSha?: string;
	/** Sha returned by the commit-tree step (default: 'dead1234beef5678'). */
	newCommitSha?: string;
	/** If true, origin/main returns the same sha (up-to-date). Default: false (no remote). */
	originMainUpToDate?: boolean;
	/** Content returned by `git show main:scripts/cam/journal.md`. Null = missing. */
	journalContent?: string | null;
	/** Content returned by `git show main:scripts/cam/journal.archive.md`. Null = absent (lazy creation). */
	archiveContent?: string | null;
	/** If true, the push step returns exit code 1 (push failure). */
	pushFails?: boolean;
}

function makeFakeSpawnFn(opts: FakeSpawnOpts = {}): { spawnFn: SpawnFn; calls: CallRecord[] } {
	const {
		branch = 'feat/test',
		localMainSha = 'abc123def456abc1',
		newCommitSha = 'dead1234beef5678',
		originMainUpToDate = false,
		journalContent = buildJournalFixture(5),
		archiveContent = null,
		pushFails = false,
	} = opts;

	const calls: CallRecord[] = [];

	const spawnFn: SpawnFn = (cmd, args, options): SpawnSyncReturns<string> => {
		calls.push({ cmd, args, input: options.input });

		if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
			return { stdout: `${branch}\n`, stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('rev-parse') && args.includes('origin/main')) {
			if (!originMainUpToDate) {
				return { stdout: '', stderr: 'unknown ref', status: 128, pid: 1, output: [], signal: null };
			}
			return { stdout: `${localMainSha}\n`, stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('rev-parse') && args[args.length - 1] === 'main') {
			return { stdout: `${localMainSha}\n`, stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('fetch')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('show') && args.some((a) => a.includes('journal.archive.md'))) {
			return archiveContent === null
				? { stdout: '', stderr: 'fatal: path not in tree', status: 128, pid: 1, output: [], signal: null }
				: { stdout: archiveContent, stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('show') && args.some((a) => a.includes('journal.md'))) {
			return journalContent === null
				? { stdout: '', stderr: 'fatal: path not in tree', status: 128, pid: 1, output: [], signal: null }
				: { stdout: journalContent, stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('read-tree')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('hash-object')) {
			return { stdout: 'fakeblobsha1234567890\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('update-index')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('write-tree')) {
			return { stdout: 'faketreesha1234567890\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('commit-tree')) {
			return { stdout: `${newCommitSha}\n`, stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('update-ref')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('push')) {
			if (pushFails) {
				return { stdout: '', stderr: 'Permission denied', status: 1, pid: 1, output: [], signal: null };
			}
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
	};

	return { spawnFn, calls };
}

// ---------------------------------------------------------------------------
// AC1: module surface + injectable options + default threshold
// ---------------------------------------------------------------------------

describe('archiveJournalOnMain — AC1: injectable options, defaults', () => {
	test('default threshold (50): 5 entries -- no-op', () => {
		const { spawnFn } = makeFakeSpawnFn({ journalContent: buildJournalFixture(5) });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn });

		assertOk(result);
		expect(result.archived).toBe(0);
		expect(result.entries).toBe(5);
	});

	test('explicit threshold overrides the default', () => {
		const { spawnFn } = makeFakeSpawnFn({ journalContent: buildJournalFixture(9) });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 5 });

		assertOk(result);
		expect(result.archived).toBeGreaterThan(0);
	});

	test('injected clock drives the pointer-line date, not real time', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({ journalContent: buildJournalFixture(9) });

		archiveJournalOnMain({
			cwd: '/fake/cwd',
			spawnFn,
			threshold: 5,
			clock: () => new Date('2020-01-15T00:00:00.000Z'),
		});

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		const journalWriteInput = hashCalls[0]?.input ?? '';
		expect(journalWriteInput).toContain('2020-01-15');
	});
});

// ---------------------------------------------------------------------------
// AC2: marker-relative entry counting (preamble headers never counted)
// ---------------------------------------------------------------------------

describe('archiveJournalOnMain — AC2: marker-relative entry counting', () => {
	test('preamble headers (## Format, ## Guidelines, ## Entries) are never counted', () => {
		const { spawnFn } = makeFakeSpawnFn({ journalContent: buildJournalFixture(5) });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 50 });

		assertOk(result);
		// PREAMBLE has 3 '## ' headers of its own; if counted, entries would be 8.
		expect(result.entries).toBe(5);
	});

	test('entries with zero post-marker headers -- entries:0, no-op', () => {
		const { spawnFn } = makeFakeSpawnFn({ journalContent: buildJournalFixture(0) });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 0 });

		assertOk(result);
		expect(result.entries).toBe(0);
		expect(result.archived).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC3: no-op below/at threshold -- zero mutation calls
// ---------------------------------------------------------------------------

describe('archiveJournalOnMain — AC3: no-op performs NO mutation', () => {
	test('entries <= threshold: returns {ok:true, archived:0, entries}, no hash-object/write-tree/commit-tree/update-ref', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({ journalContent: buildJournalFixture(5) });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 50 });

		expect(result).toEqual({ ok: true, archived: 0, entries: 5, sha: '' });

		expect(calls.find((c) => c.args.includes('hash-object'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('write-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('push'))).toBeUndefined();
	});

	test('entries exactly AT threshold: still a no-op (strictly greater-than triggers archiving)', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({ journalContent: buildJournalFixture(10) });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 10 });

		assertOk(result);
		expect(result.archived).toBe(0);
		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// AC4: archiving path -- verbatim, ordered move; cumulative append; bootstrap
// ---------------------------------------------------------------------------

describe('archiveJournalOnMain — AC4: archiving moves the oldest floor(count/3) verbatim', () => {
	test('9 entries over threshold -- archives floor(9/3)=3 oldest, in original order', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({ journalContent: buildJournalFixture(9) });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 5 });

		assertOk(result);
		expect(result.archived).toBe(3);
		expect(result.entries).toBe(9);

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		expect(hashCalls).toHaveLength(2);
		const journalWriteInput = hashCalls[0]?.input ?? '';
		const archiveWriteInput = hashCalls[1]?.input ?? '';

		// Archived (oldest 3: 0,1,2) land byte-identically in the archive file,
		// in original chronological order.
		expect(archiveWriteInput).toContain(makeEntry(0));
		expect(archiveWriteInput).toContain(makeEntry(1));
		expect(archiveWriteInput).toContain(makeEntry(2));
		const idx0 = archiveWriteInput.indexOf('cycle/0');
		const idx1 = archiveWriteInput.indexOf('cycle/1');
		const idx2 = archiveWriteInput.indexOf('cycle/2');
		expect(idx0).toBeLessThan(idx1);
		expect(idx1).toBeLessThan(idx2);

		// Archived entries are gone from journal.md; remaining (3..8) stay.
		expect(journalWriteInput).not.toContain('cycle/0 —');
		expect(journalWriteInput).not.toContain('cycle/1 —');
		expect(journalWriteInput).not.toContain('cycle/2 —');
		expect(journalWriteInput).toContain(makeEntry(3));
		expect(journalWriteInput).toContain(makeEntry(8));
	});

	test('minimum 1 archived when floor(count/3) rounds to 0', () => {
		const { spawnFn } = makeFakeSpawnFn({ journalContent: buildJournalFixture(2) });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 1 });

		assertOk(result);
		expect(result.archived).toBe(1);
	});

	test('archive.md absent on main -- bootstrapped with a minimal header', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({
			journalContent: buildJournalFixture(9),
			archiveContent: null,
		});

		archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 5 });

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		const archiveWriteInput = hashCalls[1]?.input ?? '';
		expect(archiveWriteInput).toContain('# Cam Journal Archive');
		expect(archiveWriteInput).toContain('<!-- ENTRIES_BELOW -->');
		expect(archiveWriteInput).toContain('cycle/0');
	});

	test('archive.md present on main -- cumulative append AFTER existing content', () => {
		const existingArchive = `# Cam Journal Archive\n\n<!-- ENTRIES_BELOW -->\n\n${makeEntry(100)}\n`;
		const { spawnFn, calls } = makeFakeSpawnFn({
			journalContent: buildJournalFixture(9),
			archiveContent: existingArchive,
		});

		archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 5 });

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		const archiveWriteInput = hashCalls[1]?.input ?? '';

		// Existing archived entry (100) still present, BEFORE the newly archived ones.
		const idxExisting = archiveWriteInput.indexOf('cycle/100');
		const idxNew0 = archiveWriteInput.indexOf('cycle/0 —');
		expect(idxExisting).toBeGreaterThanOrEqual(0);
		expect(idxNew0).toBeGreaterThan(idxExisting);
	});
});

// ---------------------------------------------------------------------------
// AC5: journal.md preserves preamble + marker, gets a dated pointer line
// ---------------------------------------------------------------------------

describe('archiveJournalOnMain — AC5: journal.md rewrite shape', () => {
	test('preamble and marker preserved verbatim; pointer line references the archive path and clock date', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({ journalContent: buildJournalFixture(9) });

		archiveJournalOnMain({
			cwd: '/fake/cwd',
			spawnFn,
			threshold: 5,
			clock: () => new Date('2026-07-08T12:00:00.000Z'),
		});

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		const journalWriteInput = hashCalls[0]?.input ?? '';

		expect(journalWriteInput).toContain('## Format');
		expect(journalWriteInput).toContain('## Guidelines for the orchestrator');
		expect(journalWriteInput).toContain('<!-- ENTRIES_BELOW -->');
		expect(journalWriteInput).toContain('scripts/cam/journal.archive.md');
		expect(journalWriteInput).toContain('2026-07-08');
		// Remaining (newest) entries still follow the pointer line.
		expect(journalWriteInput).toContain(makeEntry(8));
	});
});

// ---------------------------------------------------------------------------
// AC6: one atomic 2-file commit + best-effort push; reads via git show only
// ---------------------------------------------------------------------------

describe('archiveJournalOnMain — AC6: atomic multi-file commit + push', () => {
	test('exactly one commit-tree call carries both files via a single write-tree', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({ journalContent: buildJournalFixture(9) });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 5 });

		assertOk(result);
		expect(calls.filter((c) => c.args.includes('write-tree'))).toHaveLength(1);
		expect(calls.filter((c) => c.args.includes('commit-tree'))).toHaveLength(1);
		const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
		expect(commitTreeCall?.args).toContain(`chore(cam): journal archive 3 entries`);
	});

	test('push is called exactly once (best-effort)', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({ journalContent: buildJournalFixture(9) });

		archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 5 });

		expect(calls.filter((c) => c.args.includes('push'))).toHaveLength(1);
	});

	test('push failure does not flip the result to ok:false', () => {
		const { spawnFn } = makeFakeSpawnFn({ journalContent: buildJournalFixture(9), pushFails: true });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 5 });

		assertOk(result);
		expect(result.archived).toBe(3);
	});

	test('both files are read via git show main:<path>, never the working tree', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({ journalContent: buildJournalFixture(9) });

		archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn, threshold: 5 });

		const journalShow = calls.find(
			(c) => c.args.includes('show') && c.args.some((a) => a === 'main:scripts/cam/journal.md'),
		);
		const archiveShow = calls.find(
			(c) => c.args.includes('show') && c.args.some((a) => a === 'main:scripts/cam/journal.archive.md'),
		);
		expect(journalShow).toBeDefined();
		expect(archiveShow).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Guard passthrough (checkMainUpToDate reuse)
// ---------------------------------------------------------------------------

describe('archiveJournalOnMain — shared guard passthrough', () => {
	test('detached HEAD -- returns reason:detached-head, no reads or mutations', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({ branch: 'HEAD' });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('detached-head');
		expect(calls.find((c) => c.args.includes('show'))).toBeUndefined();
	});

	test('diverged local main -- returns reason:diverged', () => {
		const { spawnFn } = makeFakeSpawnFn({ originMainUpToDate: false });
		// Force a divergent origin sha (different from local main).
		const spawnFnDiverged: SpawnFn = (cmd, args, options) => {
			if (args.includes('rev-parse') && args.includes('origin/main')) {
				return { stdout: 'differentsha1234567\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
			}
			return spawnFn(cmd, args, options);
		};

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn: spawnFnDiverged });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('diverged');
	});

	test('journal.md missing on main -- returns reason:journal-missing, no commit fires', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({ journalContent: null });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('journal-missing');
		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
	});

	test('marker absent from journal.md content -- returns reason:marker-missing', () => {
		const { spawnFn } = makeFakeSpawnFn({ journalContent: '# Cam Journal\n\nNo marker here.\n' });

		const result = archiveJournalOnMain({ cwd: '/fake/cwd', spawnFn });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('marker-missing');
	});
});
