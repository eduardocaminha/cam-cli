// test/supervisor/suggestion-filing-production.test.ts
//
// Unit tests for makeProductionFileSuggestionsFn (US-003, CAM-189), the
// production fileSuggestionsFn closure wired into runSidecarLoop by
// buildSidecarLoopDeps (src/commands/sidecar.ts).
//
// Coverage (acceptance criteria):
//   AC4: each SUGGESTION is filed via createLocalIssueOnMain's on-main
//        commit-tree path (default filing: no specSource -> stage 'idea',
//        status 'open'); a fixture report with 2 SUGGESTIONs files 2 issues.
//   AC5: dedup is live end-to-end -- a SUGGESTION whose fingerprint already
//        appears in an open issue's description (read via
//        readBacklogFromMain) is NOT re-filed; a batch where every finding
//        is already filed yields filedIds:[] (files 0).
//   AC7 (closure-level): a createLocalIssueOnMain ok:false outcome (e.g.
//        detached HEAD) is skip-and-warned (failedCount recorded, a
//        'suggestion-filed' event logged) and never thrown.
//
// All git I/O is faked via an injectable SpawnFn (mirrors
// test/issue-file.test.ts's makeRecordingSpawn); only scripts/cam/project.toml
// is read from a real temporary directory (createLocalIssueOnMain's
// readProjectToml parameter is not itself injectable through this closure).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeProductionFileSuggestionsFn } from '../../src/commands/sidecar.ts';
import type { SpawnFn as IssueFileSpawnFn } from '../../src/commands/issue-file.ts';
import { buildFollowUpIssue } from '../../src/supervisor/suggestion-followups.ts';
import type { FollowUpProvenance } from '../../src/supervisor/suggestion-followups.ts';
import { makeInMemoryEventLogger, type WorkerEvent } from '../../src/supervisor/events.ts';
import type { ReviewReport, ReviewFinding } from '../../src/supervisor/review-report.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROVENANCE: FollowUpProvenance = { source: 'cam/pr-189-suggestion-followups', round: 2 };

const FINDING_A: ReviewFinding = { severity: 'SUGGESTION', text: 'Extract this helper.', file: 'src/a.ts', line: 1 };
const FINDING_B: ReviewFinding = { severity: 'SUGGESTION', text: 'Rename this variable.', file: 'src/b.ts', line: 2 };

function makeReport(findings: ReviewFinding[]): ReviewReport {
	return { verdict: 'CLEAN', findings };
}

function okResult(stdout = ''): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
}

function frameBlobOutput(content: string): string {
	return `abc123 blob ${content.length}\n${content}\n`;
}

interface SpawnCall {
	args: string[];
	input?: string;
}

interface RecordingSpawnOpts {
	/** `git rev-parse --abbrev-ref HEAD` output. Default 'cam/feature'. */
	branch?: string;
	/** ls-tree output (file listing for readBacklogFromMain / allocateId). Default '' (empty backlog). */
	lsTreeOutput?: string;
	/** cat-file --batch output (blob contents). Default '' (no blobs). */
	catFileOutput?: string;
}

/** Minimal recording IssueFileSpawnFn fixture, mirrors test/issue-file.test.ts's makeRecordingSpawn. */
function makeRecordingSpawn(opts: RecordingSpawnOpts = {}): { spawnFn: IssueFileSpawnFn; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const branch = opts.branch ?? 'cam/feature';
	const lsTreeOutput = opts.lsTreeOutput ?? '';
	const catFileOutput = opts.catFileOutput ?? '';

	const spawnFn: IssueFileSpawnFn = (cmd, args, options) => {
		calls.push({ args, input: options.input });
		const a = args.join(' ');

		if (a.includes('rev-parse') && a.includes('--abbrev-ref') && a.includes('HEAD')) {
			return okResult(`${branch}\n`);
		}
		if (a.includes('rev-parse') && a.includes('origin/main')) {
			return okResult('mainsha1234567890\n');
		}
		if (a.includes('rev-parse') && a.includes('main') && !a.includes('--abbrev-ref') && !a.includes('origin/main')) {
			return okResult('mainsha1234567890\n');
		}
		if (a.includes('fetch')) return okResult();
		if (a.includes('ls-tree') && a.includes('scripts/cam/issues')) return okResult(lsTreeOutput);
		if (a.includes('cat-file') && a.includes('--batch')) return okResult(catFileOutput);
		if (a.includes('read-tree')) return okResult();
		if (a.includes('hash-object')) return okResult('blobsha1234\n');
		if (a.includes('update-index')) return okResult();
		if (a.includes('write-tree')) return okResult('treesha1234\n');
		if (a.includes('commit-tree')) return okResult('newcommitsha1234567\n');
		if (a.includes('update-ref')) return okResult();
		if (a.includes('push') && a.includes('origin')) return okResult();
		return okResult();
	};

	return { spawnFn, calls };
}

/** Real temp dir with a minimal scripts/cam/project.toml (readProjectToml is not injectable). */
function makeTempProjectDir(): { cwd: string; cleanup: () => void } {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-suggestion-filing-prod-'));
	mkdirSync(join(cwd, 'scripts', 'cam'), { recursive: true });
	writeFileSync(join(cwd, 'scripts/cam/project.toml'), 'issue_prefix = "CAM"\n', 'utf8');
	return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// AC4: filed via createLocalIssueOnMain, default filing (stage 'idea')
// ---------------------------------------------------------------------------

describe('AC4: makeProductionFileSuggestionsFn -- files via createLocalIssueOnMain', () => {
	test('a fixture report with 2 SUGGESTIONs files 2 issues, both stage:idea, no specSource', () => {
		const { cwd, cleanup } = makeTempProjectDir();
		try {
			const { spawnFn, calls } = makeRecordingSpawn();
			const { logger, events } = makeInMemoryEventLogger();
			const fileSuggestionsFn = makeProductionFileSuggestionsFn(cwd, spawnFn, logger);

			const { filedIds, dupSkipped } = fileSuggestionsFn(makeReport([FINDING_A, FINDING_B]), PROVENANCE);

			expect(filedIds).toHaveLength(2);
			expect(dupSkipped).toBe(0);
			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('suggestion-filed');

			const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
			expect(hashCalls).toHaveLength(2);
			for (const call of hashCalls) {
				const entry = JSON.parse(call.input ?? '{}') as { stage: string; specSource?: string; status: string };
				expect(entry.stage).toBe('idea');
				expect(entry.status).toBe('open');
				expect(entry.specSource).toBeUndefined();
			}
		} finally {
			cleanup();
		}
	});

	test('the working branch is never touched: no checkout/switch spawn call', () => {
		const { cwd, cleanup } = makeTempProjectDir();
		try {
			const { spawnFn, calls } = makeRecordingSpawn({ branch: 'cam/pr-189-suggestion-followups' });
			const fileSuggestionsFn = makeProductionFileSuggestionsFn(cwd, spawnFn, () => {});

			fileSuggestionsFn(makeReport([FINDING_A]), PROVENANCE);

			for (const call of calls) {
				expect(call.args).not.toContain('checkout');
				expect(call.args).not.toContain('switch');
			}
		} finally {
			cleanup();
		}
	});

	test('zero SUGGESTIONs -> filedIds empty, no event logged', () => {
		const { cwd, cleanup } = makeTempProjectDir();
		try {
			const { spawnFn } = makeRecordingSpawn();
			const { logger, events } = makeInMemoryEventLogger();
			const fileSuggestionsFn = makeProductionFileSuggestionsFn(cwd, spawnFn, logger);

			const { filedIds, dupSkipped } = fileSuggestionsFn(makeReport([]), PROVENANCE);

			expect(filedIds).toEqual([]);
			expect(dupSkipped).toBe(0);
			expect(events).toHaveLength(0);
		} finally {
			cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// AC5: dedup end-to-end
// ---------------------------------------------------------------------------

describe('AC5: makeProductionFileSuggestionsFn -- dedup end-to-end via readBacklogFromMain', () => {
	test('a SUGGESTION whose fingerprint already appears in an open issue is NOT re-filed', () => {
		const { cwd, cleanup } = makeTempProjectDir();
		try {
			const alreadyFiled = buildFollowUpIssue(FINDING_A, PROVENANCE);
			const existingEntry = {
				id: 'CAM-50',
				title: alreadyFiled.title,
				stage: 'idea',
				status: 'open',
				blockedBy: [] as string[],
				createdAt: '2026-07-08T00:00:00Z',
				description: alreadyFiled.description,
			};
			const entryJson = `${JSON.stringify(existingEntry, null, 2)}\n`;

			const { spawnFn, calls } = makeRecordingSpawn({
				lsTreeOutput: 'scripts/cam/issues/CAM-0050.json\n',
				catFileOutput: frameBlobOutput(entryJson),
			});
			const { logger, events } = makeInMemoryEventLogger();
			const fileSuggestionsFn = makeProductionFileSuggestionsFn(cwd, spawnFn, logger);

			const { filedIds, dupSkipped } = fileSuggestionsFn(makeReport([FINDING_A, FINDING_B]), PROVENANCE);

			// Only FINDING_B (not already filed) gets a real filing attempt.
			expect(filedIds).toHaveLength(1);
			expect(dupSkipped).toBe(1);

			const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
			expect(hashCalls).toHaveLength(1);
			const filedEntry = JSON.parse(hashCalls[0]?.input ?? '{}') as { title: string };
			expect(filedEntry.title).toBe(buildFollowUpIssue(FINDING_B, PROVENANCE).title);

			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('suggestion-filed');
			const detail = events[0]?.detail as { filedIds: string[]; dupSkipped: number; failedCount: number };
			expect(detail.dupSkipped).toBe(1);
			expect(detail.failedCount).toBe(0);
		} finally {
			cleanup();
		}
	});

	test('a batch where every finding is already filed yields filedIds:[] (files 0)', () => {
		const { cwd, cleanup } = makeTempProjectDir();
		try {
			const filedA = buildFollowUpIssue(FINDING_A, PROVENANCE);
			const filedB = buildFollowUpIssue(FINDING_B, PROVENANCE);
			const entries = [
				{ id: 'CAM-50', title: filedA.title, stage: 'idea', status: 'open', blockedBy: [] as string[], createdAt: '2026-07-08T00:00:00Z', description: filedA.description },
				{ id: 'CAM-51', title: filedB.title, stage: 'idea', status: 'open', blockedBy: [] as string[], createdAt: '2026-07-08T00:00:00Z', description: filedB.description },
			];
			const entryAJson = `${JSON.stringify(entries[0], null, 2)}\n`;
			const entryBJson = `${JSON.stringify(entries[1], null, 2)}\n`;
			const catFileOutput = frameBlobOutput(entryAJson) + frameBlobOutput(entryBJson);

			const { spawnFn, calls } = makeRecordingSpawn({
				lsTreeOutput: 'scripts/cam/issues/CAM-0050.json\nscripts/cam/issues/CAM-0051.json\n',
				catFileOutput,
			});
			const fileSuggestionsFn = makeProductionFileSuggestionsFn(cwd, spawnFn, () => {});

			const { filedIds, dupSkipped } = fileSuggestionsFn(makeReport([FINDING_A, FINDING_B]), PROVENANCE);

			expect(filedIds).toEqual([]);
			expect(dupSkipped).toBe(2);
			expect(calls.find((c) => c.args.includes('hash-object'))).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test('collapses an in-batch duplicate (same finding appearing twice in one report)', () => {
		const { cwd, cleanup } = makeTempProjectDir();
		try {
			const { spawnFn, calls } = makeRecordingSpawn();
			const fileSuggestionsFn = makeProductionFileSuggestionsFn(cwd, spawnFn, () => {});

			const { filedIds, dupSkipped } = fileSuggestionsFn(makeReport([FINDING_A, FINDING_A]), PROVENANCE);

			expect(filedIds).toHaveLength(1);
			expect(dupSkipped).toBe(1);
			expect(calls.filter((c) => c.args.includes('hash-object'))).toHaveLength(1);
		} finally {
			cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// AC7 (closure-level): createLocalIssueOnMain ok:false -> skip-and-warn
// ---------------------------------------------------------------------------

describe('AC7: makeProductionFileSuggestionsFn -- createLocalIssueOnMain ok:false is skip-and-warned', () => {
	test('detached HEAD -> filedIds empty, failedCount recorded, never throws', () => {
		const { cwd, cleanup } = makeTempProjectDir();
		try {
			const { spawnFn } = makeRecordingSpawn({ branch: 'HEAD' });
			const { logger, events } = makeInMemoryEventLogger();
			const fileSuggestionsFn = makeProductionFileSuggestionsFn(cwd, spawnFn, logger);

			let caught: unknown;
			let result: { filedIds: string[]; dupSkipped: number } | undefined;
			try {
				result = fileSuggestionsFn(makeReport([FINDING_A, FINDING_B]), PROVENANCE);
			} catch (e) {
				caught = e;
			}

			expect(caught).toBeUndefined();
			expect(result?.filedIds).toEqual([]);
			expect(result?.dupSkipped).toBe(0);

			expect(events).toHaveLength(1);
			expect(events[0]?.kind).toBe('suggestion-filed');
			const detail = events[0]?.detail as { failedCount: number };
			expect(detail.failedCount).toBe(2);
		} finally {
			cleanup();
		}
	});
});
