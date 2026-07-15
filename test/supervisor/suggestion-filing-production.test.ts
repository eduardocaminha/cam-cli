// test/supervisor/suggestion-filing-production.test.ts
//
// Unit tests for makeProductionFileSuggestionsFn (US-003, CAM-189; sink
// redirected from issue-filing to the suggestions pen in US-003, CAM-285).
//
// Coverage (acceptance criteria):
//   AC1: each surviving SUGGESTION is appended to scripts/cam/suggestions.jsonl
//        via appendSuggestionOnMain (not filed via fileCandidates/
//        createLocalIssueOnMain); the appended entry carries fingerprint,
//        title, body, sourceBranch, reviewRound, sourceIssue, filedAt.
//   AC2: dedup unions BOTH sources -- a SUGGESTION whose fingerprint already
//        appears in scripts/cam/suggestions.jsonl (the pen) OR in any open
//        backlog issue's description (readBacklogFromMain +
//        FINGERPRINT_LINE_RE) is not re-appended.
//   AC7 (closure-level): an appendSuggestionOnMain ok:false outcome (e.g. the
//        suggestions pen missing on main) is skip-and-warned (failedCount
//        recorded, a 'suggestion-filed' event logged) and never thrown.
//
// All git I/O is faked via an injectable SpawnFn (mirrors
// test/issue-file.test.ts's makeRecordingSpawn, extended with the
// `git show main:scripts/cam/suggestions.jsonl` branch test/commands/
// suggestions.test.ts's fake exercises); no real project.toml is needed --
// unlike the retired issue-filing sink, the pen sink never resolves an issue
// prefix.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { makeProductionFileSuggestionsFn } from '../../src/commands/sidecar.ts';
import type { SpawnFn as IssueFileSpawnFn } from '../../src/commands/issue-file.ts';
import { SUGGESTIONS_JSONL_PATH, type SuggestionEntry } from '../../src/commands/suggestions.ts';
import { buildFollowUpIssue, fingerprintFinding } from '../../src/supervisor/suggestion-followups.ts';
import type { FollowUpProvenance } from '../../src/supervisor/suggestion-followups.ts';
import { makeInMemoryEventLogger } from '../../src/supervisor/events.ts';
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
	/** ls-tree output (file listing for readBacklogFromMain). Default '' (empty backlog). */
	lsTreeOutput?: string;
	/** cat-file --batch output (backlog blob contents). Default '' (no blobs). */
	catFileOutput?: string;
	/** `git show main:scripts/cam/suggestions.jsonl` content. Default '' (empty pen). */
	suggestionsContent?: string;
	/** If true, `git show` for suggestions.jsonl returns non-zero (pen missing on main). */
	suggestionsMissing?: boolean;
}

/** Minimal recording IssueFileSpawnFn fixture, mirrors test/issue-file.test.ts's makeRecordingSpawn. */
function makeRecordingSpawn(opts: RecordingSpawnOpts = {}): { spawnFn: IssueFileSpawnFn; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const branch = opts.branch ?? 'cam/feature';
	const lsTreeOutput = opts.lsTreeOutput ?? '';
	const catFileOutput = opts.catFileOutput ?? '';
	const suggestionsContent = opts.suggestionsContent ?? '';
	const suggestionsMissing = opts.suggestionsMissing ?? false;

	const spawnFn: IssueFileSpawnFn = (_cmd, args, options) => {
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
		if (a.includes('show') && args.some((arg) => arg === `main:${SUGGESTIONS_JSONL_PATH}`)) {
			if (suggestionsMissing) {
				return { pid: 1, output: [null, '', ''], stdout: '', stderr: 'fatal: path not found', status: 128, signal: null };
			}
			return okResult(suggestionsContent);
		}
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

/** Parses the entry JSON-line appended in a hash-object call's stdin. */
function parseAppendedEntry(call: SpawnCall | undefined): SuggestionEntry {
	const content = call?.input ?? '';
	const lines = content.split('\n').filter((l) => l.length > 0);
	const lastLine = lines.at(-1) ?? '{}';
	return JSON.parse(lastLine) as SuggestionEntry;
}

// ---------------------------------------------------------------------------
// AC1: appended via appendSuggestionOnMain
// ---------------------------------------------------------------------------

describe('AC1: makeProductionFileSuggestionsFn -- appends via appendSuggestionOnMain', () => {
	test('a fixture report with 2 SUGGESTIONs pens 2 entries carrying fingerprint/title/body/sourceBranch/reviewRound/sourceIssue/filedAt', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const { logger, events } = makeInMemoryEventLogger();
		const fileSuggestionsFn = makeProductionFileSuggestionsFn('/fake/cwd', spawnFn, logger);

		const { penned, dupSkipped } = fileSuggestionsFn(makeReport([FINDING_A, FINDING_B]), { ...PROVENANCE, parentIssue: 285 });

		expect(penned).toBe(2);
		expect(dupSkipped).toBe(0);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('suggestion-filed');

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		expect(hashCalls).toHaveLength(2);

		const entryA = parseAppendedEntry(hashCalls[0]);
		expect(entryA.fingerprint).toBe(fingerprintFinding(FINDING_A));
		expect(entryA.title).toBe(buildFollowUpIssue(FINDING_A, PROVENANCE).title);
		expect(entryA.body).toBe(FINDING_A.text);
		expect(entryA.sourceBranch).toBe(PROVENANCE.source);
		expect(entryA.reviewRound).toBe(PROVENANCE.round);
		expect(entryA.sourceIssue).toBe(285);
		expect(typeof entryA.filedAt).toBe('string');
		expect(entryA.filedAt.length).toBeGreaterThan(0);
	});

	test('the working branch is never touched: no checkout/switch spawn call', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'cam/pr-189-suggestion-followups' });
		const fileSuggestionsFn = makeProductionFileSuggestionsFn('/fake/cwd', spawnFn, () => {});

		fileSuggestionsFn(makeReport([FINDING_A]), PROVENANCE);

		for (const call of calls) {
			expect(call.args).not.toContain('checkout');
			expect(call.args).not.toContain('switch');
		}
	});

	test('zero SUGGESTIONs -> penned 0, no event logged', () => {
		const { spawnFn } = makeRecordingSpawn();
		const { logger, events } = makeInMemoryEventLogger();
		const fileSuggestionsFn = makeProductionFileSuggestionsFn('/fake/cwd', spawnFn, logger);

		const { penned, dupSkipped } = fileSuggestionsFn(makeReport([]), PROVENANCE);

		expect(penned).toBe(0);
		expect(dupSkipped).toBe(0);
		expect(events).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC2: dedup unions BOTH the open backlog AND the pen
// ---------------------------------------------------------------------------

describe('AC2: makeProductionFileSuggestionsFn -- dedup unions open backlog and the pen', () => {
	test('a SUGGESTION whose fingerprint already appears in an open backlog issue is NOT re-penned', () => {
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
		const fileSuggestionsFn = makeProductionFileSuggestionsFn('/fake/cwd', spawnFn, logger);

		const { penned, dupSkipped } = fileSuggestionsFn(makeReport([FINDING_A, FINDING_B]), PROVENANCE);

		// Only FINDING_B (not already filed/penned) gets a real append attempt.
		expect(penned).toBe(1);
		expect(dupSkipped).toBe(1);

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		expect(hashCalls).toHaveLength(1);
		const entry = parseAppendedEntry(hashCalls[0]);
		expect(entry.fingerprint).toBe(fingerprintFinding(FINDING_B));

		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('suggestion-filed');
		const detail = events[0]?.detail as { penned: number; dupSkipped: number; failedCount: number };
		expect(detail.penned).toBe(1);
		expect(detail.dupSkipped).toBe(1);
		expect(detail.failedCount).toBe(0);
	});

	test('a SUGGESTION whose fingerprint already appears in the pen (not the backlog) is NOT re-penned (issues 277-280 stay un-re-penned)', () => {
		const existingPenEntry: SuggestionEntry = {
			fingerprint: fingerprintFinding(FINDING_A),
			title: 'Already in the pen',
			body: FINDING_A.text,
			sourceBranch: 'cam/some-earlier-branch',
			filedAt: '2026-07-01T00:00:00Z',
		};
		const suggestionsContent = `${JSON.stringify(existingPenEntry)}\n`;

		const { spawnFn, calls } = makeRecordingSpawn({ suggestionsContent });
		const fileSuggestionsFn = makeProductionFileSuggestionsFn('/fake/cwd', spawnFn, () => {});

		const { penned, dupSkipped } = fileSuggestionsFn(makeReport([FINDING_A, FINDING_B]), PROVENANCE);

		expect(penned).toBe(1);
		expect(dupSkipped).toBe(1);

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		expect(hashCalls).toHaveLength(1);
		const entry = parseAppendedEntry(hashCalls[0]);
		expect(entry.fingerprint).toBe(fingerprintFinding(FINDING_B));
	});

	test('a batch where every finding is already filed (backlog) or penned (pen) yields penned:0 (files/pens 0)', () => {
		const filedA = buildFollowUpIssue(FINDING_A, PROVENANCE);
		const backlogEntry = {
			id: 'CAM-50',
			title: filedA.title,
			stage: 'idea',
			status: 'open',
			blockedBy: [] as string[],
			createdAt: '2026-07-08T00:00:00Z',
			description: filedA.description,
		};
		const entryJson = `${JSON.stringify(backlogEntry, null, 2)}\n`;
		const existingPenEntry: SuggestionEntry = {
			fingerprint: fingerprintFinding(FINDING_B),
			title: 'Already in the pen',
			body: FINDING_B.text,
			sourceBranch: 'cam/some-earlier-branch',
			filedAt: '2026-07-01T00:00:00Z',
		};

		const { spawnFn, calls } = makeRecordingSpawn({
			lsTreeOutput: 'scripts/cam/issues/CAM-0050.json\n',
			catFileOutput: frameBlobOutput(entryJson),
			suggestionsContent: `${JSON.stringify(existingPenEntry)}\n`,
		});
		const fileSuggestionsFn = makeProductionFileSuggestionsFn('/fake/cwd', spawnFn, () => {});

		const { penned, dupSkipped } = fileSuggestionsFn(makeReport([FINDING_A, FINDING_B]), PROVENANCE);

		expect(penned).toBe(0);
		expect(dupSkipped).toBe(2);
		expect(calls.find((c) => c.args.includes('hash-object'))).toBeUndefined();
	});

	test('collapses an in-batch duplicate (same finding appearing twice in one report)', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const fileSuggestionsFn = makeProductionFileSuggestionsFn('/fake/cwd', spawnFn, () => {});

		const { penned, dupSkipped } = fileSuggestionsFn(makeReport([FINDING_A, FINDING_A]), PROVENANCE);

		expect(penned).toBe(1);
		expect(dupSkipped).toBe(1);
		expect(calls.filter((c) => c.args.includes('hash-object'))).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// sourceIssue threaded from provenance.parentIssue
// ---------------------------------------------------------------------------

describe('sourceIssue threaded from provenance.parentIssue', () => {
	test('parentIssue present -> entry.sourceIssue equals it', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const fileSuggestionsFn = makeProductionFileSuggestionsFn('/fake/cwd', spawnFn, () => {});

		fileSuggestionsFn(makeReport([FINDING_A]), { ...PROVENANCE, parentIssue: 263 });

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		expect(hashCalls).toHaveLength(1);
		const entry = parseAppendedEntry(hashCalls[0]);
		expect(entry.sourceIssue).toBe(263);
	});

	test('parentIssue absent -> entry.sourceIssue key is omitted (not a malformed value)', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const fileSuggestionsFn = makeProductionFileSuggestionsFn('/fake/cwd', spawnFn, () => {});

		fileSuggestionsFn(makeReport([FINDING_A]), PROVENANCE);

		const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
		expect(hashCalls).toHaveLength(1);
		const entry = parseAppendedEntry(hashCalls[0]);
		expect(entry.sourceIssue).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// AC7 (closure-level): appendSuggestionOnMain ok:false -> skip-and-warn
// ---------------------------------------------------------------------------

describe('AC7: makeProductionFileSuggestionsFn -- appendSuggestionOnMain ok:false is skip-and-warned', () => {
	test('suggestions pen missing on main -> penned 0, failedCount recorded, never throws', () => {
		const { spawnFn } = makeRecordingSpawn({ suggestionsMissing: true });
		const { logger, events } = makeInMemoryEventLogger();
		const fileSuggestionsFn = makeProductionFileSuggestionsFn('/fake/cwd', spawnFn, logger);

		let caught: unknown;
		let result: { penned: number; dupSkipped: number } | undefined;
		try {
			result = fileSuggestionsFn(makeReport([FINDING_A, FINDING_B]), PROVENANCE);
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeUndefined();
		expect(result?.penned).toBe(0);
		expect(result?.dupSkipped).toBe(0);

		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('suggestion-filed');
		const detail = events[0]?.detail as { failedCount: number };
		expect(detail.failedCount).toBe(2);
	});
});
