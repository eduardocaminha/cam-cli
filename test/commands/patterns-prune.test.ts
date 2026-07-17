// test/commands/patterns-prune.test.ts
//
// Unit + real-git integration tests for src/commands/patterns-prune.ts
// (computePruneDecision / prunePatternRecordsOnMain).
//
// Mirrors the real-temp-git-repo section of test/commands/pattern-records.test.ts
// (AC oracle: exercise the on-main writer against a real temp git repo with
// real spawnSync, not a tautological mock).
//
// US-004, CAM-64 "mulch model" port.

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	computePruneDecision,
	prunePatternRecordsOnMain,
	PATTERN_RECORDS_ARCHIVE_JSONL_PATH,
	PRUNE_SCORE_THRESHOLD,
	TACTICAL_SHELF_LIFE_DAYS,
	OBSERVATIONAL_SHELF_LIFE_DAYS,
	type PrunePatternRecordsOnMainSuccess,
	type PrunePatternRecordsOnMainResult,
} from '../../src/commands/patterns-prune.ts';
import { appendPatternRecordOnMain, PATTERN_RECORDS_JSONL_PATH } from '../../src/commands/pattern-records.ts';
import { realOnMainSpawnFn } from '../../src/git/on-main.ts';
import type { PatternRecord } from '../../src/patterns/record.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse('2026-07-17T00:00:00.000Z');

function makeRecord(overrides: Partial<PatternRecord> = {}): PatternRecord {
	return {
		type: 'gotcha',
		classification: 'foundational',
		recorded_at: '2026-07-01T00:00:00.000Z',
		name: 'sample record',
		description: 'a sample pattern record for testing',
		evidence: 'src/somewhere.ts',
		dir_anchors: [],
		outcomes: [],
		...overrides,
	};
}

function assertOk(
	result: PrunePatternRecordsOnMainResult,
): asserts result is PrunePatternRecordsOnMainSuccess {
	if (!result.ok) {
		throw new Error(
			`Expected ok:true but got ok:false, reason=${JSON.stringify((result as { reason: string }).reason)}`,
		);
	}
}

function daysAgoIso(days: number): string {
	return new Date(NOW_MS - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// computePruneDecision (pure, no git)
// ---------------------------------------------------------------------------

describe('computePruneDecision — AC2: confirmationScore-driven demotion, one tier', () => {
	test('foundational, low score (one failure outcome) -> demote to tactical', () => {
		const record = makeRecord({
			classification: 'foundational',
			recorded_at: daysAgoIso(1),
			outcomes: [{ status: 'failure', recorded_at: daysAgoIso(1) }],
		});
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({
			action: 'demote',
			to: 'tactical',
		});
	});

	test('tactical, low score -> demote to observational', () => {
		const record = makeRecord({
			classification: 'tactical',
			recorded_at: daysAgoIso(1),
			outcomes: [{ status: 'failure', recorded_at: daysAgoIso(1) }],
		});
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({
			action: 'demote',
			to: 'observational',
		});
	});

	test('observational, low score -> archive (terminal tier, no 4th classification string)', () => {
		const record = makeRecord({
			classification: 'observational',
			recorded_at: daysAgoIso(1),
			outcomes: [{ status: 'failure', recorded_at: daysAgoIso(1) }],
		});
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({ action: 'archive' });
	});

	test('score exactly at threshold is NOT demoted (strict below-threshold only)', () => {
		// One success outcome -> confirmationScore === 1 === PRUNE_SCORE_THRESHOLD.
		const record = makeRecord({
			classification: 'foundational',
			recorded_at: daysAgoIso(1),
			outcomes: [{ status: 'success', recorded_at: daysAgoIso(1) }],
		});
		expect(PRUNE_SCORE_THRESHOLD).toBe(1);
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({ action: 'keep' });
	});

	test('zero outcomes -- exempt from score-based demotion regardless of classification', () => {
		const record = makeRecord({ classification: 'foundational', outcomes: [] });
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({ action: 'keep' });
	});

	test('mixed outcomes with a net score above threshold: kept', () => {
		const record = makeRecord({
			classification: 'foundational',
			recorded_at: daysAgoIso(1),
			outcomes: [
				{ status: 'success', recorded_at: daysAgoIso(1) },
				{ status: 'success', recorded_at: daysAgoIso(1) },
				{ status: 'failure', recorded_at: daysAgoIso(1) },
			],
		});
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({ action: 'keep' });
	});
});

describe('computePruneDecision — AC3: shelf-life staleness archives directly, foundational exempt', () => {
	test('tactical older than 30d (from recorded_at) -- archived directly, even with a healthy score', () => {
		const record = makeRecord({
			classification: 'tactical',
			recorded_at: daysAgoIso(TACTICAL_SHELF_LIFE_DAYS + 1),
			outcomes: [{ status: 'success', recorded_at: daysAgoIso(TACTICAL_SHELF_LIFE_DAYS + 1) }],
		});
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({ action: 'archive' });
	});

	test('tactical at exactly 30d -- NOT yet stale (strict greater-than)', () => {
		const record = makeRecord({
			classification: 'tactical',
			recorded_at: daysAgoIso(TACTICAL_SHELF_LIFE_DAYS),
		});
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({ action: 'keep' });
	});

	test('tactical younger than 30d -- kept', () => {
		const record = makeRecord({ classification: 'tactical', recorded_at: daysAgoIso(5) });
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({ action: 'keep' });
	});

	test('observational older than 14d -- archived directly', () => {
		const record = makeRecord({
			classification: 'observational',
			recorded_at: daysAgoIso(OBSERVATIONAL_SHELF_LIFE_DAYS + 1),
		});
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({ action: 'archive' });
	});

	test('observational younger than 14d -- kept', () => {
		const record = makeRecord({ classification: 'observational', recorded_at: daysAgoIso(5) });
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({ action: 'keep' });
	});

	test('foundational is exempt from shelf-life no matter how old', () => {
		const record = makeRecord({ classification: 'foundational', recorded_at: daysAgoIso(9999) });
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({ action: 'keep' });
	});

	test('age is measured from the MOST RECENT of recorded_at and outcomes, not recorded_at alone', () => {
		// recorded_at is old (would be stale alone), but a recent outcome keeps it fresh.
		const record = makeRecord({
			classification: 'tactical',
			recorded_at: daysAgoIso(TACTICAL_SHELF_LIFE_DAYS + 100),
			outcomes: [{ status: 'success', recorded_at: daysAgoIso(1) }],
		});
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({ action: 'keep' });
	});

	test('shelf-life staleness wins outright over a healthy score (archive, not merely demote)', () => {
		const record = makeRecord({
			classification: 'observational',
			recorded_at: daysAgoIso(OBSERVATIONAL_SHELF_LIFE_DAYS + 1),
			outcomes: [
				{ status: 'success', recorded_at: daysAgoIso(OBSERVATIONAL_SHELF_LIFE_DAYS + 1) },
				{ status: 'success', recorded_at: daysAgoIso(OBSERVATIONAL_SHELF_LIFE_DAYS + 1) },
			],
		});
		expect(computePruneDecision(record, { cwd: '/fake', nowMs: NOW_MS })).toEqual({ action: 'archive' });
	});
});

describe('computePruneDecision — AC4: anchor-decay demotes one tier, "optional" (only fires when dir_anchors non-empty)', () => {
	test('all dir_anchors missing -- demoted one tier', () => {
		const record = makeRecord({ classification: 'foundational', dir_anchors: ['src/gone/', 'also/gone.ts'] });
		const result = computePruneDecision(record, {
			cwd: '/fake',
			nowMs: NOW_MS,
			existsFn: () => false,
		});
		expect(result).toEqual({ action: 'demote', to: 'tactical' });
	});

	test('at least one dir_anchor still exists -- NOT anchor-decayed', () => {
		const record = makeRecord({ classification: 'foundational', dir_anchors: ['src/gone/', 'src/still-here/'] });
		const result = computePruneDecision(record, {
			cwd: '/fake',
			nowMs: NOW_MS,
			existsFn: (path) => path.endsWith('still-here/'),
		});
		expect(result).toEqual({ action: 'keep' });
	});

	test('empty dir_anchors -- never anchor-decayed (the "optional" part of AC4)', () => {
		const record = makeRecord({ classification: 'foundational', dir_anchors: [] });
		const result = computePruneDecision(record, {
			cwd: '/fake',
			nowMs: NOW_MS,
			existsFn: () => false,
		});
		expect(result).toEqual({ action: 'keep' });
	});

	test('anchor-decay resolves anchors relative to cwd', () => {
		const record = makeRecord({ classification: 'foundational', dir_anchors: ['src/x/'] });
		const seen: string[] = [];
		computePruneDecision(record, {
			cwd: '/project/root',
			nowMs: NOW_MS,
			existsFn: (path) => {
				seen.push(path);
				return false;
			},
		});
		expect(seen).toEqual([join('/project/root', 'src/x/')]);
	});

	test('score-triggered AND anchor-decay-triggered together still demote only ONE tier, not two', () => {
		const record = makeRecord({
			classification: 'foundational',
			recorded_at: daysAgoIso(1),
			dir_anchors: ['src/gone/'],
			outcomes: [{ status: 'failure', recorded_at: daysAgoIso(1) }],
		});
		const result = computePruneDecision(record, {
			cwd: '/fake',
			nowMs: NOW_MS,
			existsFn: () => false,
		});
		expect(result).toEqual({ action: 'demote', to: 'tactical' });
	});
});

// ---------------------------------------------------------------------------
// prunePatternRecordsOnMain (real git integration)
// ---------------------------------------------------------------------------

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0;

const dirsToCleanup: string[] = [];

afterEach(() => {
	for (const d of dirsToCleanup) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
	dirsToCleanup.length = 0;
});

interface RepoHandles {
	dir: string;
	run: (args: string[]) => SpawnSyncReturns<string>;
}

function makeTmpRepo(): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-patterns-prune-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) => spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);
	run(['commit', '--allow-empty', '-m', 'chore: initial harness state']);

	return { dir, run };
}

test.skipIf(!gitAvailable)(
	'Real git: no eligible records -- clean no-op, no commit, working tree untouched',
	() => {
		const { dir, run } = makeTmpRepo();
		mkdirSync(join(dir, 'src'), { recursive: true });

		appendPatternRecordOnMain({
			cwd: dir,
			record: makeRecord({ classification: 'foundational', recorded_at: '2026-07-16T00:00:00.000Z' }),
			spawnFn: realOnMainSpawnFn,
		});
		const mainShaBefore = run(['rev-parse', 'main']).stdout.trim();

		const result = prunePatternRecordsOnMain({ cwd: dir, spawnFn: realOnMainSpawnFn, nowMs: NOW_MS });

		expect(result).toEqual({ ok: true, pruned: 0, demoted: 0, archived: 0, sha: '' });
		expect(run(['rev-parse', 'main']).stdout.trim()).toBe(mainShaBefore);
	},
);

test.skipIf(!gitAvailable)(
	'Real git: demotes a low-score record one tier, keeps it in the active store',
	() => {
		const { dir, run } = makeTmpRepo();

		const seeded = appendPatternRecordOnMain({
			cwd: dir,
			record: makeRecord({
				classification: 'foundational',
				recorded_at: daysAgoIso(1),
				outcomes: [{ status: 'failure', recorded_at: daysAgoIso(1) }],
			}),
			spawnFn: realOnMainSpawnFn,
		});
		expect(seeded.ok).toBe(true);

		const result = prunePatternRecordsOnMain({ cwd: dir, spawnFn: realOnMainSpawnFn, nowMs: NOW_MS });

		assertOk(result);
		expect(result.demoted).toBe(1);
		expect(result.archived).toBe(0);
		expect(result.pruned).toBe(1);

		const stored = run(['show', `main:${PATTERN_RECORDS_JSONL_PATH}`]).stdout;
		const lines = stored.split('\n').filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? '').classification).toBe('tactical');

		// Working tree (off-main feature branch, if any) stays clean.
		expect(run(['status', '--porcelain']).stdout.trim()).toBe('');
	},
);

test.skipIf(!gitAvailable)(
	'Real git: archives a stale observational record into pattern-records.archive.jsonl, removes it from the active store',
	() => {
		const { dir, run } = makeTmpRepo();

		appendPatternRecordOnMain({
			cwd: dir,
			record: makeRecord({ classification: 'foundational', name: 'survivor', recorded_at: daysAgoIso(1) }),
			spawnFn: realOnMainSpawnFn,
		});
		appendPatternRecordOnMain({
			cwd: dir,
			record: makeRecord({
				classification: 'observational',
				name: 'stale one',
				recorded_at: daysAgoIso(OBSERVATIONAL_SHELF_LIFE_DAYS + 1),
			}),
			spawnFn: realOnMainSpawnFn,
		});

		const result = prunePatternRecordsOnMain({ cwd: dir, spawnFn: realOnMainSpawnFn, nowMs: NOW_MS });

		assertOk(result);
		expect(result.archived).toBe(1);
		expect(result.demoted).toBe(0);

		const activeLines = run(['show', `main:${PATTERN_RECORDS_JSONL_PATH}`])
			.stdout.split('\n')
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as PatternRecord);
		expect(activeLines).toHaveLength(1);
		expect(activeLines[0]?.name).toBe('survivor');

		const archiveLines = run(['show', `main:${PATTERN_RECORDS_ARCHIVE_JSONL_PATH}`])
			.stdout.split('\n')
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as PatternRecord);
		expect(archiveLines).toHaveLength(1);
		expect(archiveLines[0]?.name).toBe('stale one');
	},
);

test.skipIf(!gitAvailable)(
	'Real git: archive file is cumulative across multiple prune runs (lazy bootstrap, then append)',
	() => {
		const { dir, run } = makeTmpRepo();

		appendPatternRecordOnMain({
			cwd: dir,
			record: makeRecord({
				classification: 'observational',
				name: 'first stale',
				recorded_at: daysAgoIso(OBSERVATIONAL_SHELF_LIFE_DAYS + 1),
			}),
			spawnFn: realOnMainSpawnFn,
		});
		const first = prunePatternRecordsOnMain({ cwd: dir, spawnFn: realOnMainSpawnFn, nowMs: NOW_MS });
		assertOk(first);
		expect(first.archived).toBe(1);

		appendPatternRecordOnMain({
			cwd: dir,
			record: makeRecord({
				classification: 'observational',
				name: 'second stale',
				recorded_at: daysAgoIso(OBSERVATIONAL_SHELF_LIFE_DAYS + 1),
			}),
			spawnFn: realOnMainSpawnFn,
		});
		const second = prunePatternRecordsOnMain({ cwd: dir, spawnFn: realOnMainSpawnFn, nowMs: NOW_MS });
		assertOk(second);
		expect(second.archived).toBe(1);

		const archiveLines = run(['show', `main:${PATTERN_RECORDS_ARCHIVE_JSONL_PATH}`])
			.stdout.split('\n')
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l) as PatternRecord);
		expect(archiveLines).toHaveLength(2);
		expect(archiveLines.map((r) => r.name)).toEqual(['first stale', 'second stale']);
	},
);

test.skipIf(!gitAvailable)(
	'Real git: demotes an anchor-decayed record even though its score is healthy',
	() => {
		const { dir, run } = makeTmpRepo();

		appendPatternRecordOnMain({
			cwd: dir,
			record: makeRecord({
				classification: 'tactical',
				recorded_at: daysAgoIso(1),
				dir_anchors: ['this/path/does/not/exist/'],
				outcomes: [{ status: 'success', recorded_at: daysAgoIso(1) }],
			}),
			spawnFn: realOnMainSpawnFn,
		});

		const result = prunePatternRecordsOnMain({ cwd: dir, spawnFn: realOnMainSpawnFn, nowMs: NOW_MS });

		assertOk(result);
		expect(result.demoted).toBe(1);

		const stored = run(['show', `main:${PATTERN_RECORDS_JSONL_PATH}`]).stdout;
		const lines = stored.split('\n').filter((l) => l.length > 0);
		expect(JSON.parse(lines[0] ?? '').classification).toBe('observational');
	},
);

test.skipIf(!gitAvailable)(
	'Real git: never touches the working tree off-main -- feature-branch HEAD unchanged',
	() => {
		const { dir, run } = makeTmpRepo();

		appendPatternRecordOnMain({
			cwd: dir,
			record: makeRecord({
				classification: 'observational',
				recorded_at: daysAgoIso(OBSERVATIONAL_SHELF_LIFE_DAYS + 1),
			}),
			spawnFn: realOnMainSpawnFn,
		});

		run(['checkout', '-b', 'feat/prune-test']);
		const featureSha0 = run(['rev-parse', 'HEAD']).stdout.trim();

		const result = prunePatternRecordsOnMain({ cwd: dir, spawnFn: realOnMainSpawnFn, nowMs: NOW_MS });

		assertOk(result);
		expect(result.archived).toBe(1);
		expect(run(['rev-parse', 'HEAD']).stdout.trim()).toBe(featureSha0);
	},
);

describe('prunePatternRecordsOnMain — shared guard passthrough', () => {
	test.skipIf(!gitAvailable)('detached HEAD -- returns reason:detached-head, no mutation', () => {
		const { dir, run } = makeTmpRepo();
		const mainSha = run(['rev-parse', 'main']).stdout.trim();
		run(['checkout', mainSha]);

		const result = prunePatternRecordsOnMain({ cwd: dir, spawnFn: realOnMainSpawnFn, nowMs: NOW_MS });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('detached-head');
	});
});
