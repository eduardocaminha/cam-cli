// test/commands/patterns-archive.test.ts
//
// Unit tests for src/commands/patterns-archive.ts (archivePatternsOnMain).
// CAM-231 US-001.
//
// Mirrors the fake-SpawnFn pattern of test/commands/journal-archive.test.ts:
// all external I/O is faked via injectable SpawnFn; no real git binary or
// filesystem is exercised (except the mkdtempSync inside commitTreeToMain).

import { test, expect, describe } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	archivePatternsOnMain,
	parsePatternsBullets,
	isResolved,
	type SpawnFn,
	type ArchivePatternsOnMainSuccess,
	type ArchivePatternsOnMainResult,
} from '../../src/commands/patterns-archive.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PREAMBLE = [
	'# Codebase Patterns',
	'',
	'Durable, never-truncated home for reusable project conventions.',
	'Add a bullet whenever a story reveals a reusable insight.',
].join('\n');

/** An unmarked (living invariant) bullet: never eligible for archiving. */
function makeLivingBullet(i: number): string {
	return `- **Living invariant ${i}**: always true, no resolved marker.`;
}

/** A resolved-marked bullet: eligible for archiving. */
function makeResolvedBullet(i: number, tag = '2026-05'): string {
	return `- **Resolved pattern ${i}** [resolved ${tag}]: superseded, safe to archive.`;
}

/** Build a fixture patterns.md from an ordered list of bullet strings. */
function buildPatternsFixture(bullets: string[], preamble = PREAMBLE): string {
	if (bullets.length === 0) return `${preamble}\n`;
	return `${preamble}\n\n${bullets.join('\n\n')}\n`;
}

function assertOk(
	result: ArchivePatternsOnMainResult,
): asserts result is ArchivePatternsOnMainSuccess {
	if (!result.ok) {
		throw new Error(
			`Expected ok:true but got ok:false, reason=${JSON.stringify((result as { reason: string }).reason)}`,
		);
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
	/** Content returned by `git show main:scripts/cam/patterns.md`. Null = missing. */
	patternsContent?: string | null;
	/** Content returned by `git show main:scripts/cam/patterns.archive.md`. Null = absent (lazy creation). */
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
		patternsContent = buildPatternsFixture([makeLivingBullet(0)]),
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
		if (args.includes('show') && args.some((a) => a.includes('patterns.archive.md'))) {
			return archiveContent === null
				? { stdout: '', stderr: 'fatal: path not in tree', status: 128, pid: 1, output: [], signal: null }
				: { stdout: archiveContent, stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('show') && args.some((a) => a.includes('patterns.md'))) {
			return patternsContent === null
				? { stdout: '', stderr: 'fatal: path not in tree', status: 128, pid: 1, output: [], signal: null }
				: { stdout: patternsContent, stderr: '', status: 0, pid: 1, output: [], signal: null };
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
// AC1: reuses shared on-main plumbing (checked by grep oracle + guard passthrough below)
// ---------------------------------------------------------------------------

describe('archivePatternsOnMain — AC2/AC3: marker-based selection, not position/age/count', () => {
	test('no marked bullets: clean no-op, archived:0, no commit', () => {
		const patternsContent = buildPatternsFixture([
			makeLivingBullet(0),
			makeLivingBullet(1),
			makeLivingBullet(2),
		]);
		const { spawnFn, calls } = makeFakeSpawnFn({ patternsContent });

		const result = archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn });

		expect(result).toEqual({ ok: true, archived: 0, sha: '' });
		expect(calls.find((c) => c.args.includes('hash-object'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('write-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('push'))).toBeUndefined();
	});

	test('an old-but-unmarked bullet is retained even among many marked ones', () => {
		const patternsContent = buildPatternsFixture([
			makeLivingBullet(0), // oldest, unmarked -- must survive
			makeResolvedBullet(1),
			makeResolvedBullet(2),
			makeResolvedBullet(3),
		]);
		const { spawnFn, calls } = makeFakeSpawnFn({ patternsContent });

		const result = archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn });

		assertOk(result);
		expect(result.archived).toBe(3);

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		const patternsWriteInput = hashCalls[0]?.input ?? '';
		expect(patternsWriteInput).toContain('Living invariant 0');
	});

	test('only bullets carrying the resolved marker move; unmarked bullets in any position are retained', () => {
		const patternsContent = buildPatternsFixture([
			makeResolvedBullet(0),
			makeLivingBullet(1),
			makeResolvedBullet(2),
			makeLivingBullet(3),
		]);
		const { spawnFn, calls } = makeFakeSpawnFn({ patternsContent });

		const result = archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn });

		assertOk(result);
		expect(result.archived).toBe(2);

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		const patternsWriteInput = hashCalls[0]?.input ?? '';
		const archiveWriteInput = hashCalls[1]?.input ?? '';

		expect(patternsWriteInput).not.toContain('Resolved pattern 0');
		expect(patternsWriteInput).not.toContain('Resolved pattern 2');
		expect(patternsWriteInput).toContain('Living invariant 1');
		expect(patternsWriteInput).toContain('Living invariant 3');

		expect(archiveWriteInput).toContain('Resolved pattern 0');
		expect(archiveWriteInput).toContain('Resolved pattern 2');
		expect(archiveWriteInput).not.toContain('Living invariant');
	});
});

// ---------------------------------------------------------------------------
// AC1: intro preamble always retained
// ---------------------------------------------------------------------------

describe('archivePatternsOnMain — AC1: preamble retention', () => {
	test('intro preamble is preserved verbatim even when everything else archives', () => {
		const patternsContent = buildPatternsFixture([makeResolvedBullet(0)]);
		const { spawnFn, calls } = makeFakeSpawnFn({ patternsContent });

		archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn });

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		const patternsWriteInput = hashCalls[0]?.input ?? '';
		expect(patternsWriteInput).toContain('# Codebase Patterns');
		expect(patternsWriteInput).toContain('Durable, never-truncated home');
	});
});

// ---------------------------------------------------------------------------
// AC4: lazy archive creation + cumulative append, verbatim + order preserved
// ---------------------------------------------------------------------------

describe('archivePatternsOnMain — AC4: lazy archive bootstrap + cumulative append', () => {
	test('archive.md absent on main -- bootstrapped with a minimal header', () => {
		const patternsContent = buildPatternsFixture([makeResolvedBullet(0), makeResolvedBullet(1)]);
		const { spawnFn, calls } = makeFakeSpawnFn({ patternsContent, archiveContent: null });

		archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn });

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		const archiveWriteInput = hashCalls[1]?.input ?? '';
		expect(archiveWriteInput).toContain('# Codebase Patterns Archive');
		expect(archiveWriteInput).toContain('Resolved pattern 0');
		expect(archiveWriteInput).toContain('Resolved pattern 1');
	});

	test('archive.md present on main -- cumulative append AFTER existing content, order preserved', () => {
		const existingArchive = '# Codebase Patterns Archive\n\n- **Old resolved entry** [resolved 2026-01]: already archived.\n';
		const patternsContent = buildPatternsFixture([makeResolvedBullet(5), makeResolvedBullet(6)]);
		const { spawnFn, calls } = makeFakeSpawnFn({ patternsContent, archiveContent: existingArchive });

		archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn });

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		const archiveWriteInput = hashCalls[1]?.input ?? '';

		const idxExisting = archiveWriteInput.indexOf('Old resolved entry');
		const idxNew5 = archiveWriteInput.indexOf('Resolved pattern 5');
		const idxNew6 = archiveWriteInput.indexOf('Resolved pattern 6');
		expect(idxExisting).toBeGreaterThanOrEqual(0);
		expect(idxNew5).toBeGreaterThan(idxExisting);
		expect(idxNew6).toBeGreaterThan(idxNew5);
	});
});

// ---------------------------------------------------------------------------
// AC5: one atomic 2-file commit + best-effort push; reads via git show only
// ---------------------------------------------------------------------------

describe('archivePatternsOnMain — AC5: atomic multi-file commit + push', () => {
	test('exactly one commit-tree call carries both files via a single write-tree', () => {
		const patternsContent = buildPatternsFixture([makeResolvedBullet(0), makeLivingBullet(1)]);
		const { spawnFn, calls } = makeFakeSpawnFn({ patternsContent });

		const result = archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn });

		assertOk(result);
		expect(calls.filter((c) => c.args.includes('write-tree'))).toHaveLength(1);
		expect(calls.filter((c) => c.args.includes('commit-tree'))).toHaveLength(1);
		const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
		expect(commitTreeCall?.args).toContain('chore(cam): patterns archive 1 entries');
	});

	test('push is called exactly once (best-effort)', () => {
		const patternsContent = buildPatternsFixture([makeResolvedBullet(0)]);
		const { spawnFn, calls } = makeFakeSpawnFn({ patternsContent });

		archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn });

		expect(calls.filter((c) => c.args.includes('push'))).toHaveLength(1);
	});

	test('push failure does not flip the result to ok:false', () => {
		const patternsContent = buildPatternsFixture([makeResolvedBullet(0)]);
		const { spawnFn } = makeFakeSpawnFn({ patternsContent, pushFails: true });

		const result = archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn });

		assertOk(result);
		expect(result.archived).toBe(1);
	});

	test('both files are read via git show main:<path>, never the working tree', () => {
		const patternsContent = buildPatternsFixture([makeResolvedBullet(0)]);
		const { spawnFn, calls } = makeFakeSpawnFn({ patternsContent });

		archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn });

		const patternsShow = calls.find(
			(c) => c.args.includes('show') && c.args.some((a) => a === 'main:scripts/cam/patterns.md'),
		);
		const archiveShow = calls.find(
			(c) => c.args.includes('show') && c.args.some((a) => a === 'main:scripts/cam/patterns.archive.md'),
		);
		expect(patternsShow).toBeDefined();
		expect(archiveShow).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Guard passthrough (checkMainUpToDate reuse)
// ---------------------------------------------------------------------------

describe('archivePatternsOnMain — shared guard passthrough', () => {
	test('detached HEAD -- returns reason:detached-head, no reads or mutations', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({ branch: 'HEAD' });

		const result = archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn });

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

		const result = archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn: spawnFnDiverged });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('diverged');
	});

	test('missing local main branch -- returns reason:missing-main', () => {
		const { spawnFn } = makeFakeSpawnFn();
		const spawnFnMissingMain: SpawnFn = (cmd, args, options) => {
			if (args.includes('rev-parse') && args[args.length - 1] === 'main') {
				return { stdout: '', stderr: 'unknown ref', status: 128, pid: 1, output: [], signal: null };
			}
			return spawnFn(cmd, args, options);
		};

		const result = archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn: spawnFnMissingMain });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('missing-main');
	});

	test('patterns.md missing on main -- returns reason:patterns-missing, no commit fires', () => {
		const { spawnFn, calls } = makeFakeSpawnFn({ patternsContent: null });

		const result = archivePatternsOnMain({ cwd: '/fake/cwd', spawnFn });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('patterns-missing');
		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// US-001: count-agnostic real-file smoke test
//
// Runs the real scripts/cam/patterns.md through parsePatternsBullets/isResolved
// and cross-checks the resolved-bullet segmentation against an independent
// raw marker scan, so future format drift in the real file is caught
// mechanically instead of relying only on synthetic fixtures. The resolved
// count is NOT asserted as a hardcoded literal: only the equivalence
// relation between the parser's segmentation and an independent raw-text
// regex scan is asserted, so this stays green regardless of how many
// bullets carry the marker at any point in time.
// ---------------------------------------------------------------------------

describe('parsePatternsBullets/isResolved — real scripts/cam/patterns.md smoke test', () => {
	test('parses non-empty bullets from the real file and matches an independent marker scan', async () => {
		const realContent = await Bun.file('scripts/cam/patterns.md').text();

		const parsed = parsePatternsBullets(realContent);
		expect(parsed.blocks.length).toBeGreaterThan(0);

		const resolvedByParser = parsed.blocks.filter(isResolved).length;

		// Independent raw-text scan: a fresh global regex over the whole file,
		// not reusing RESOLVED_MARKER_RE or isResolved, so this is a genuine
		// cross-check of the parser's block segmentation rather than a
		// tautological re-application of the same predicate.
		const rawMarkerMatches = realContent.match(/\[resolved \d{4}-\d{2}\]/g) ?? [];

		expect(resolvedByParser).toBe(rawMarkerMatches.length);
	});
});
