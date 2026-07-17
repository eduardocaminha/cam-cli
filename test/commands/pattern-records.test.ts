// test/commands/pattern-records.test.ts
//
// Unit + real-git integration tests for src/commands/pattern-records.ts
// (appendPatternRecordOnMain / readPatternRecordsFromMain /
// fingerprintPatternRecord).
//
// Mirrors test/commands/issue-specify.test.ts's real-temp-git-repo section
// (AC4: exercise append + dedup against a real temp git repo with real
// spawnSync, not a tautological mock).
//
// US-002, CAM-64 "mulch model" port.

import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	appendPatternRecordOnMain,
	fingerprintPatternRecord,
	readPatternRecordsFromMain,
	PATTERN_RECORDS_JSONL_PATH,
	type AppendPatternRecordOnMainValidationError,
} from '../../src/commands/pattern-records.ts';
import { realOnMainSpawnFn, type SpawnFn } from '../../src/git/on-main.ts';
import type { PatternRecord } from '../../src/patterns/record.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_RECORD: PatternRecord = {
	type: 'gotcha',
	classification: 'tactical',
	recorded_at: '2026-07-17T00:00:00.000Z',
	name: 'commitTreeToMain CAS retry',
	description: 'Every CAS retry must re-read main, not reuse a stale whole-file rewrite.',
	evidence: 'src/git/on-main.ts',
	dir_anchors: ['src/git/'],
	outcomes: [],
};

const OTHER_RECORD: PatternRecord = {
	type: 'gotcha',
	classification: 'observational',
	recorded_at: '2026-07-17T01:00:00.000Z',
	name: 'noUncheckedIndexedAccess guard',
	description: 'Array indexing is T | undefined under strict mode; always guard.',
	evidence: 'tsconfig.json',
	dir_anchors: ['src/'],
	outcomes: [],
};

// ---------------------------------------------------------------------------
// fingerprintPatternRecord
// ---------------------------------------------------------------------------

test('fingerprintPatternRecord: stable for identical name/description/dir_anchors', () => {
	const a = fingerprintPatternRecord(SAMPLE_RECORD);
	const b = fingerprintPatternRecord({ ...SAMPLE_RECORD, evidence: 'a different evidence string' } as PatternRecord);
	expect(a).toBe(b);
	expect(a).toHaveLength(12);
});

test('fingerprintPatternRecord: differs when name/description/dir_anchors differ', () => {
	const a = fingerprintPatternRecord(SAMPLE_RECORD);
	const b = fingerprintPatternRecord(OTHER_RECORD);
	expect(a).not.toBe(b);
});

// ---------------------------------------------------------------------------
// Validation (pure, no git calls)
// ---------------------------------------------------------------------------

test('appendPatternRecordOnMain: malformed record fails isPatternRecord -- validation error, no git calls fire', () => {
	const stderrLines: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		if (typeof chunk === 'string') stderrLines.push(chunk);
		return true;
	};

	try {
		const calls: string[] = [];
		const spawnFn: SpawnFn = (_cmd, args) => {
			calls.push(args.join(' '));
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		};

		const malformed = { ...SAMPLE_RECORD, classification: 'not-a-real-tier' } as unknown as PatternRecord;

		const result = appendPatternRecordOnMain({
			cwd: '/fake/cwd',
			record: malformed,
			spawnFn,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('validation');
		expect('errors' in result).toBe(true);
		const validationError = result as AppendPatternRecordOnMainValidationError;
		expect(validationError.errors.length).toBeGreaterThan(0);

		expect(stderrLines.join('')).toMatch(/invalid pattern record/i);
		expect(calls).toHaveLength(0);
	} finally {
		process.stderr.write = originalWrite;
	}
});

// ---------------------------------------------------------------------------
// Real-git integration (AC4): real temp git repo, real spawnSync.
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
	const dir = mkdtempSync(join(tmpdir(), 'cam-pattern-records-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);
	run(['commit', '--allow-empty', '-m', 'chore: initial harness state']);

	return { dir, run };
}

test.skipIf(!gitAvailable)(
	'Real git: appendPatternRecordOnMain bootstraps the missing store, commits on main, working tree untouched',
	() => {
		const { dir, run } = makeTmpRepo();
		const mainSha0 = run(['rev-parse', 'main']).stdout.trim();

		run(['checkout', '-b', 'feat/pattern-records-test']);
		const featureSha0 = run(['rev-parse', 'HEAD']).stdout.trim();

		const result = appendPatternRecordOnMain({
			cwd: dir,
			record: SAMPLE_RECORD,
			spawnFn: realOnMainSpawnFn,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		if (result.skipped) throw new Error('expected append, not skip');

		// Feature-branch HEAD (off-main working tree) untouched.
		expect(run(['rev-parse', 'HEAD']).stdout.trim()).toBe(featureSha0);

		// main advanced past the pre-append sha and now carries the record.
		const mainSha1 = run(['rev-parse', 'main']).stdout.trim();
		expect(mainSha1).not.toBe(mainSha0);

		const stored = run(['show', `main:${PATTERN_RECORDS_JSONL_PATH}`]).stdout;
		const lines = stored.split('\n').filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? '')).toEqual(SAMPLE_RECORD);
	},
);

test.skipIf(!gitAvailable)(
	'Real git: appendPatternRecordOnMain dedups a duplicate record -- appends 0 lines, no new commit',
	() => {
		const { dir, run } = makeTmpRepo();

		const first = appendPatternRecordOnMain({
			cwd: dir,
			record: SAMPLE_RECORD,
			spawnFn: realOnMainSpawnFn,
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		if (first.skipped) throw new Error('expected first append to land');

		const mainShaAfterFirst = run(['rev-parse', 'main']).stdout.trim();

		const second = appendPatternRecordOnMain({
			cwd: dir,
			record: { ...SAMPLE_RECORD, evidence: 'a different evidence string, same identity' },
			spawnFn: realOnMainSpawnFn,
		});

		expect(second.ok).toBe(true);
		if (!second.ok) return;
		if (!second.skipped) throw new Error('expected duplicate to be skipped');
		expect(second.fingerprint).toBe(first.fingerprint);

		// No new commit landed on main for the duplicate.
		expect(run(['rev-parse', 'main']).stdout.trim()).toBe(mainShaAfterFirst);

		const stored = run(['show', `main:${PATTERN_RECORDS_JSONL_PATH}`]).stdout;
		const lines = stored.split('\n').filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
	},
);

test.skipIf(!gitAvailable)(
	'Real git: appendPatternRecordOnMain appends a distinct record alongside an existing one',
	() => {
		const { dir, run } = makeTmpRepo();

		appendPatternRecordOnMain({ cwd: dir, record: OTHER_RECORD, spawnFn: realOnMainSpawnFn });
		const result = appendPatternRecordOnMain({
			cwd: dir,
			record: SAMPLE_RECORD,
			spawnFn: realOnMainSpawnFn,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.skipped).toBe(false);

		const stored = run(['show', `main:${PATTERN_RECORDS_JSONL_PATH}`]).stdout;
		const lines = stored.split('\n').filter((l) => l.length > 0);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? '')).toEqual(OTHER_RECORD);
		expect(JSON.parse(lines[1] ?? '')).toEqual(SAMPLE_RECORD);
	},
);

test.skipIf(!gitAvailable)(
	'Real git: readPatternRecordsFromMain reads from main (not working tree) and skips unparseable lines fail-closed',
	() => {
		const { dir, run } = makeTmpRepo();

		appendPatternRecordOnMain({ cwd: dir, record: SAMPLE_RECORD, spawnFn: realOnMainSpawnFn });

		// Manually commit a store with one valid line and one corrupt line,
		// directly on main -- exercises the fail-closed skip in
		// parsePatternRecordsJsonl via readPatternRecordsFromMain.
		const corruptContent =
			`${JSON.stringify(SAMPLE_RECORD)}\n` +
			'{not valid json\n' +
			`${JSON.stringify({ ...OTHER_RECORD, classification: 'not-a-real-tier' })}\n` +
			`${JSON.stringify(OTHER_RECORD)}\n`;

		writeFileSync(join(dir, 'scripts', 'cam', 'pattern-records.jsonl'), corruptContent);
		run(['add', 'scripts/cam/pattern-records.jsonl']);
		run(['commit', '-m', 'test: seed corrupt lines']);

		const records = readPatternRecordsFromMain(dir, realOnMainSpawnFn);

		expect(records).toHaveLength(2);
		expect(records).toEqual([SAMPLE_RECORD, OTHER_RECORD]);
	},
);

test.skipIf(!gitAvailable)(
	'Real git: readPatternRecordsFromMain returns [] when the store is absent from main',
	() => {
		const { dir } = makeTmpRepo();

		const records = readPatternRecordsFromMain(dir, realOnMainSpawnFn);

		expect(records).toEqual([]);
	},
);
