// test/commands/suggestions.test.ts
//
// Unit tests for src/commands/suggestions.ts (SuggestionEntry model +
// appendSuggestionOnMain / readSuggestionsFromMain).
//
// Mirrors test/commands/journal-append.test.ts's fake-SpawnFn approach.
// CAM-285 US-001.

import { test, expect } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	appendSuggestionOnMain,
	readSuggestionsFromMain,
	SUGGESTIONS_JSONL_PATH,
	type SpawnFn,
	type SuggestionEntry,
	type AppendSuggestionOnMainValidationError,
} from '../../src/commands/suggestions.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ENTRY: SuggestionEntry = {
	fingerprint: 'abc123def456',
	title: 'Consider extracting the shared helper',
	body: 'Consider extracting the shared helper into its own module.',
	sourceBranch: 'cam/issue-285',
	reviewRound: 1,
	sourceIssue: 285,
	filedAt: '2026-07-12T00:00:00.000Z',
};

const OTHER_ENTRY: SuggestionEntry = {
	fingerprint: 'ffeeddccbbaa',
	title: 'Another suggestion',
	body: 'Another suggestion body text.',
	sourceBranch: 'cam/issue-286',
	filedAt: '2026-07-12T01:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Fake SpawnFn builder (mirrors test/commands/journal-append.test.ts)
// ---------------------------------------------------------------------------

interface FakeSpawnOpts {
	branch?: string;
	localMainSha?: string;
	newCommitSha?: string;
	originMainUpToDate?: boolean;
	/** Content returned by `git show main:scripts/cam/suggestions.jsonl`. */
	suggestionsContent?: string;
	/** If true, `git show` for suggestions.jsonl returns non-zero (missing file). */
	suggestionsMissing?: boolean;
	pushFails?: boolean;
}

interface CallRecord {
	cmd: string;
	args: string[];
	input?: string;
}

function makeFakeSpawnFn(opts: FakeSpawnOpts = {}): { spawnFn: SpawnFn; calls: CallRecord[] } {
	const {
		branch = 'feat/test',
		localMainSha = 'abc123def456abc1',
		newCommitSha = 'dead1234beef5678',
		originMainUpToDate = false,
		suggestionsContent = '',
		suggestionsMissing = false,
		pushFails = false,
	} = opts;

	const calls: CallRecord[] = [];

	const spawnFn: SpawnFn = (
		cmd: string,
		args: string[],
		options: { encoding: 'utf8'; env?: Record<string, string>; input?: string },
	): SpawnSyncReturns<string> => {
		calls.push({ cmd, args, input: options.input });

		if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
			return { stdout: branch + '\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('rev-parse') && args.includes('origin/main')) {
			if (!originMainUpToDate) {
				return { stdout: '', stderr: 'unknown ref', status: 128, pid: 1, output: [], signal: null };
			}
			return { stdout: localMainSha + '\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('rev-parse') && args[args.length - 1] === 'main') {
			return { stdout: localMainSha + '\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('fetch')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('show') && args.some((a) => a.includes('suggestions.jsonl'))) {
			if (suggestionsMissing) {
				return { stdout: '', stderr: 'fatal: path not found', status: 128, pid: 1, output: [], signal: null };
			}
			return { stdout: suggestionsContent, stderr: '', status: 0, pid: 1, output: [], signal: null };
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
			return { stdout: newCommitSha + '\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
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
// AC1: SuggestionEntry shape (typecheck-level; exercised via fixture usage
// above). Runtime coverage below via append/read round-trips.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AC2 + AC5: append reads from main (not working tree), commits via
// commit-tree, appends exactly one JSON line.
// ---------------------------------------------------------------------------

test('appendSuggestionOnMain: reads suggestions.jsonl from main, commits via commit-tree, returns ok', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ suggestionsContent: '' });

	const result = appendSuggestionOnMain({
		cwd: '/fake/cwd',
		entry: SAMPLE_ENTRY,
		spawnFn,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.fingerprint).toBe(SAMPLE_ENTRY.fingerprint);
	if (result.skipped) throw new Error('expected append, not skip');
	expect(result.sha).toBe('dead123');

	const showCall = calls.find((c) => c.args.some((a) => a === `main:${SUGGESTIONS_JSONL_PATH}`));
	expect(showCall).toBeDefined();

	const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
	expect(commitTreeCall).toBeDefined();

	const pushCall = calls.find((c) => c.args.includes('push'));
	expect(pushCall).toBeDefined();
});

test('appendSuggestionOnMain: hash-object receives exactly one new JSON line appended to existing content', () => {
	const existing = `${JSON.stringify(OTHER_ENTRY)}\n`;
	const { spawnFn, calls } = makeFakeSpawnFn({ suggestionsContent: existing });

	appendSuggestionOnMain({
		cwd: '/fake/cwd',
		entry: SAMPLE_ENTRY,
		spawnFn,
	});

	const hashCall = calls.find((c) => c.args.includes('hash-object'));
	const content = hashCall?.input ?? '';
	const lines = content.split('\n').filter((l) => l.length > 0);
	expect(lines).toHaveLength(2);
	expect(JSON.parse(lines[0] ?? '')).toEqual(OTHER_ENTRY);
	expect(JSON.parse(lines[1] ?? '')).toEqual(SAMPLE_ENTRY);
});

// ---------------------------------------------------------------------------
// AC3: no bootstrap of a missing file.
// ---------------------------------------------------------------------------

test('appendSuggestionOnMain: suggestions.jsonl missing on main -- returns suggestions-missing, no commit fires', () => {
	const stderrLines: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		if (typeof chunk === 'string') stderrLines.push(chunk);
		return true;
	};

	try {
		const { spawnFn, calls } = makeFakeSpawnFn({ suggestionsMissing: true });

		const result = appendSuggestionOnMain({
			cwd: '/fake/cwd',
			entry: SAMPLE_ENTRY,
			spawnFn,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('suggestions-missing');

		const errorOutput = stderrLines.join('');
		expect(errorOutput).toMatch(/suggestions\.jsonl missing/i);

		const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
		const updateRefCall = calls.find((c) => c.args.includes('update-ref'));
		expect(commitTreeCall).toBeUndefined();
		expect(updateRefCall).toBeUndefined();
	} finally {
		process.stderr.write = originalWrite;
	}
});

// ---------------------------------------------------------------------------
// AC4: per-line dedup on fingerprint.
// ---------------------------------------------------------------------------

test('appendSuggestionOnMain: fingerprint already present -- skips, no commit fires', () => {
	const existing = `${JSON.stringify(SAMPLE_ENTRY)}\n`;
	const { spawnFn, calls } = makeFakeSpawnFn({ suggestionsContent: existing });

	const result = appendSuggestionOnMain({
		cwd: '/fake/cwd',
		entry: { ...SAMPLE_ENTRY, body: 'a different body, same fingerprint' },
		spawnFn,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	if (!result.skipped) throw new Error('expected skip, not append');
	expect(result.fingerprint).toBe(SAMPLE_ENTRY.fingerprint);

	const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
	const updateRefCall = calls.find((c) => c.args.includes('update-ref'));
	expect(commitTreeCall).toBeUndefined();
	expect(updateRefCall).toBeUndefined();
});

test('appendSuggestionOnMain: distinct fingerprint alongside an existing entry -- appends (no false-positive dedup)', () => {
	const existing = `${JSON.stringify(OTHER_ENTRY)}\n`;
	const { spawnFn } = makeFakeSpawnFn({ suggestionsContent: existing });

	const result = appendSuggestionOnMain({
		cwd: '/fake/cwd',
		entry: SAMPLE_ENTRY,
		spawnFn,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.skipped).toBe(false);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('appendSuggestionOnMain: missing required field -- validation error, no git calls fire', () => {
	const stderrLines: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		if (typeof chunk === 'string') stderrLines.push(chunk);
		return true;
	};

	try {
		const { spawnFn, calls } = makeFakeSpawnFn();

		const entryMissingBody: Partial<SuggestionEntry> = {
			fingerprint: SAMPLE_ENTRY.fingerprint,
			title: SAMPLE_ENTRY.title,
			sourceBranch: SAMPLE_ENTRY.sourceBranch,
			filedAt: SAMPLE_ENTRY.filedAt,
			// body intentionally absent
		};

		const result = appendSuggestionOnMain({
			cwd: '/fake/cwd',
			entry: entryMissingBody as SuggestionEntry,
			spawnFn,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('validation');
		expect('errors' in result).toBe(true);
		const validationError = result as AppendSuggestionOnMainValidationError;
		expect(validationError.errors).toContain('body');

		const errorOutput = stderrLines.join('');
		expect(errorOutput).toMatch(/body/);

		const showCall = calls.find((c) => c.args.includes('show'));
		expect(showCall).toBeUndefined();
	} finally {
		process.stderr.write = originalWrite;
	}
});

// ---------------------------------------------------------------------------
// Push failure is best-effort.
// ---------------------------------------------------------------------------

test('appendSuggestionOnMain: push failure -- returns ok:true (skipped:false) and logs error', () => {
	const stderrLines: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		if (typeof chunk === 'string') stderrLines.push(chunk);
		return true;
	};

	try {
		const { spawnFn } = makeFakeSpawnFn({ pushFails: true });

		const result = appendSuggestionOnMain({
			cwd: '/fake/cwd',
			entry: SAMPLE_ENTRY,
			spawnFn,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.skipped).toBe(false);

		const errorOutput = stderrLines.join('');
		expect(errorOutput).toMatch(/push rejected|Permission denied/i);
	} finally {
		process.stderr.write = originalWrite;
	}
});

// ---------------------------------------------------------------------------
// AC5: readSuggestionsFromMain
// ---------------------------------------------------------------------------

test('readSuggestionsFromMain: parses multiple JSONL lines into SuggestionEntry[]', () => {
	const content = `${JSON.stringify(OTHER_ENTRY)}\n${JSON.stringify(SAMPLE_ENTRY)}\n`;
	const { spawnFn } = makeFakeSpawnFn({ suggestionsContent: content });

	const entries = readSuggestionsFromMain('/fake/cwd', spawnFn);

	expect(entries).toHaveLength(2);
	expect(entries[0]).toEqual(OTHER_ENTRY);
	expect(entries[1]).toEqual(SAMPLE_ENTRY);
});

test('readSuggestionsFromMain: tolerates trailing newline and blank lines', () => {
	const content = `${JSON.stringify(SAMPLE_ENTRY)}\n\n`;
	const { spawnFn } = makeFakeSpawnFn({ suggestionsContent: content });

	const entries = readSuggestionsFromMain('/fake/cwd', spawnFn);

	expect(entries).toHaveLength(1);
	expect(entries[0]).toEqual(SAMPLE_ENTRY);
});

test('readSuggestionsFromMain: empty file content -- returns []', () => {
	const { spawnFn } = makeFakeSpawnFn({ suggestionsContent: '' });

	const entries = readSuggestionsFromMain('/fake/cwd', spawnFn);

	expect(entries).toEqual([]);
});

test('readSuggestionsFromMain: file missing on main -- returns [] (treated as empty pen)', () => {
	const { spawnFn } = makeFakeSpawnFn({ suggestionsMissing: true });

	const entries = readSuggestionsFromMain('/fake/cwd', spawnFn);

	expect(entries).toEqual([]);
});

test('readSuggestionsFromMain: reads from main:scripts/cam/suggestions.jsonl (not working tree)', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ suggestionsContent: '' });

	readSuggestionsFromMain('/fake/cwd', spawnFn);

	const showCall = calls.find(
		(c) => c.args.includes('show') && c.args.some((a) => a === `main:${SUGGESTIONS_JSONL_PATH}`),
	);
	expect(showCall).toBeDefined();
});
