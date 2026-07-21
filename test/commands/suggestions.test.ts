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
	promoteSuggestionOnMain,
	dismissSuggestionOnMain,
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

// ---------------------------------------------------------------------------
// dismissSuggestionOnMain / promoteSuggestionOnMain (US-005, CAM-285; US-002,
// CAM-290 for promote's single-atomic-commit rewrite)
//
// A richer fake spawnFn is needed here vs. makeFakeSpawnFn above: promote
// additionally routes through writeIssueFile (its own allocateId ls-tree/
// cat-file lookup, plus the CAS commit-tree sequence), so this fake mirrors
// test/issue-file.test.ts's makeRecordingSpawn layered on top of the
// suggestions.jsonl `git show` handling above.
// ---------------------------------------------------------------------------

const PROJECT_TOML = 'issue_system = "local"\nissue_prefix = "CAM"\n';

/** Minimal SpawnSyncReturns<string> for a successful git call. */
function okResult(stdout = ''): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
}

interface FullFakeOpts {
	branch?: string;
	localMainSha?: string;
	originMainUpToDate?: boolean;
	suggestionsContent?: string;
	suggestionsMissing?: boolean;
	pushFails?: boolean;
}

/**
 * Full fake spawnFn covering both the on-main pen guard/read/commit sequence
 * AND writeIssueFile's own allocateId (empty backlog, ls-tree returns '') +
 * CAS commit-tree sequence. `commit-tree` is called exactly ONCE by a
 * successful promote (US-002, CAM-290): the filed issue JSON and the pen-line
 * removal are co-committed atomically in the same commit-tree call.
 */
function makeFullFakeSpawnFn(opts: FullFakeOpts = {}): { spawnFn: SpawnFn; calls: CallRecord[] } {
	const {
		branch = 'cam/issue-285',
		localMainSha = 'mainsha1234567890',
		originMainUpToDate = true,
		suggestionsContent = '',
		suggestionsMissing = false,
		pushFails = false,
	} = opts;

	const calls: CallRecord[] = [];
	let commitTreeCallCount = 0;

	const spawnFn: SpawnFn = (
		cmd: string,
		args: string[],
		options: { encoding: 'utf8'; env?: Record<string, string>; input?: string },
	): SpawnSyncReturns<string> => {
		calls.push({ cmd, args, input: options.input });
		const argsStr = args.join(' ');

		if (argsStr.includes('rev-parse') && argsStr.includes('--abbrev-ref') && argsStr.includes('HEAD')) {
			return okResult(`${branch}\n`);
		}
		if (argsStr.includes('rev-parse') && argsStr.includes('origin/main')) {
			return originMainUpToDate
				? okResult(`${localMainSha}\n`)
				: okResult('divergedremoteSha1234567\n');
		}
		if (argsStr.includes('rev-parse') && argsStr.includes('main') && !argsStr.includes('origin/main')) {
			return okResult(`${localMainSha}\n`);
		}
		if (argsStr.includes('fetch')) {
			return okResult();
		}
		if (argsStr.includes('show') && argsStr.includes('suggestions.jsonl')) {
			if (suggestionsMissing) return { ...okResult(''), status: 128 };
			return okResult(suggestionsContent);
		}
		if (argsStr.includes('ls-tree')) {
			return okResult(''); // empty backlog -> allocateId returns 1 (CAM-1)
		}
		if (argsStr.includes('cat-file')) {
			return okResult('');
		}
		if (argsStr.includes('read-tree')) {
			return okResult();
		}
		if (argsStr.includes('hash-object')) {
			return okResult('blobsha1234567890\n');
		}
		if (argsStr.includes('update-index')) {
			return okResult();
		}
		if (argsStr.includes('write-tree')) {
			return okResult('treesha1234567890\n');
		}
		if (argsStr.includes('commit-tree')) {
			commitTreeCallCount += 1;
			// promoteSuggestionOnMain fires commit-tree exactly once on success
			// (US-002, CAM-290: the filed issue and the pen-line removal are
			// co-committed atomically); dismissSuggestionOnMain also fires it once.
			const sha = commitTreeCallCount === 1 ? 'firstcommitsha1234567' : 'secondcommitsha123456';
			return okResult(`${sha}\n`);
		}
		if (argsStr.includes('update-ref')) {
			return okResult();
		}
		if (argsStr.includes('push')) {
			return pushFails ? { ...okResult(''), status: 1, stderr: 'Permission denied' } : okResult();
		}
		return okResult();
	};

	return { spawnFn, calls };
}

const FIXED_TS = '2026-07-12T02:00:00.000Z';
const clock = () => FIXED_TS;

// --- dismissSuggestionOnMain ---

test('dismissSuggestionOnMain: removes the matching line, commits, pushes; other lines untouched', () => {
	const existing = `${JSON.stringify(SAMPLE_ENTRY)}\n${JSON.stringify(OTHER_ENTRY)}\n`;
	const { spawnFn, calls } = makeFullFakeSpawnFn({ suggestionsContent: existing });

	const result = dismissSuggestionOnMain({
		cwd: '/fake/project',
		fingerprint: SAMPLE_ENTRY.fingerprint,
		spawnFn,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.fingerprint).toBe(SAMPLE_ENTRY.fingerprint);
	expect(result.sha).toBe('firstco'); // first (only) commit-tree call, 'firstcommitsha1234567'.slice(0,7)

	const hashCall = calls.find((c) => c.args.includes('hash-object'));
	const written = hashCall?.input ?? '';
	expect(written).toContain(JSON.stringify(OTHER_ENTRY));
	expect(written).not.toContain(SAMPLE_ENTRY.fingerprint);

	const pushCall = calls.find((c) => c.args.includes('push'));
	expect(pushCall).toBeDefined();
});

test('dismissSuggestionOnMain: byte-preserves all other lines verbatim', () => {
	const existing = `${JSON.stringify(OTHER_ENTRY)}\n${JSON.stringify(SAMPLE_ENTRY)}\n`;
	const { spawnFn, calls } = makeFullFakeSpawnFn({ suggestionsContent: existing });

	dismissSuggestionOnMain({
		cwd: '/fake/project',
		fingerprint: SAMPLE_ENTRY.fingerprint,
		spawnFn,
	});

	const hashCall = calls.find((c) => c.args.includes('hash-object'));
	expect(hashCall?.input).toBe(`${JSON.stringify(OTHER_ENTRY)}\n`);
});

test('dismissSuggestionOnMain: unknown fingerprint -- error, no commit, pen untouched', () => {
	const stderrLines: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		if (typeof chunk === 'string') stderrLines.push(chunk);
		return true;
	};

	try {
		const existing = `${JSON.stringify(OTHER_ENTRY)}\n`;
		const { spawnFn, calls } = makeFullFakeSpawnFn({ suggestionsContent: existing });

		const result = dismissSuggestionOnMain({
			cwd: '/fake/project',
			fingerprint: 'deadbeef0000',
			spawnFn,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('not-found');
		expect(stderrLines.join('')).toMatch(/unknown fingerprint/i);

		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
	} finally {
		process.stderr.write = originalWrite;
	}
});

test('dismissSuggestionOnMain: pen missing on main -- suggestions-missing, no commit', () => {
	const { spawnFn, calls } = makeFullFakeSpawnFn({ suggestionsMissing: true });

	const result = dismissSuggestionOnMain({
		cwd: '/fake/project',
		fingerprint: SAMPLE_ENTRY.fingerprint,
		spawnFn,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe('suggestions-missing');
	expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
});

test('dismissSuggestionOnMain: diverged main -- error, no mutation', () => {
	const { spawnFn, calls } = makeFullFakeSpawnFn({ originMainUpToDate: false });

	const result = dismissSuggestionOnMain({
		cwd: '/fake/project',
		fingerprint: SAMPLE_ENTRY.fingerprint,
		spawnFn,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe('diverged');
	expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
});

// --- promoteSuggestionOnMain ---

test('promoteSuggestionOnMain: files a real issue via writeIssueFile, preserves derivedFrom, embeds fingerprint line, then removes the pen line -- all in ONE atomic commit', () => {
	const existing = `${JSON.stringify(SAMPLE_ENTRY)}\n${JSON.stringify(OTHER_ENTRY)}\n`;
	const { spawnFn, calls } = makeFullFakeSpawnFn({ suggestionsContent: existing });

	const result = promoteSuggestionOnMain({
		cwd: '/fake/project',
		fingerprints: [SAMPLE_ENTRY.fingerprint],
		spawnFn,
		clock,
		readProjectToml: () => PROJECT_TOML,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.fingerprints).toEqual([SAMPLE_ENTRY.fingerprint]);
	expect(result.issueId).toBe('CAM-1');
	expect(result.sha).toBe('firstco'); // the ONE commit-tree call: issue + pen removal together

	// Exactly one commit-tree call: the filed issue and the pen-line removal
	// land in a single atomic on-main commit (US-002, CAM-290).
	const commitTreeCalls = calls.filter((c) => c.args.includes('commit-tree'));
	expect(commitTreeCalls.length).toBe(1);

	// The filed issue's content (hash-object input) carries derivedFrom from
	// sourceIssue (285 -> 'CAM-285') and the suggestion-fingerprint line.
	const issueHashCall = calls.find(
		(c) => c.args.includes('hash-object') && (c.input ?? '').includes('derivedFrom'),
	);
	expect(issueHashCall).toBeDefined();
	const issueContent = issueHashCall?.input ?? '';
	expect(issueContent).toContain('"derivedFrom"');
	expect(issueContent).toContain('CAM-285');
	expect(issueContent).toContain(`suggestion-fingerprint: ${SAMPLE_ENTRY.fingerprint}`);
	expect(issueContent).toContain(SAMPLE_ENTRY.body);

	// The pen removal (hash-object input for suggestions.jsonl) keeps the OTHER
	// entry byte-identical and drops the promoted one.
	const penHashCall = calls.find(
		(c) => c.args.includes('hash-object') && (c.input ?? '') === `${JSON.stringify(OTHER_ENTRY)}\n`,
	);
	expect(penHashCall).toBeDefined();

	const pushCalls = calls.filter((c) => c.args.includes('push'));
	expect(pushCalls.length).toBeGreaterThanOrEqual(1);
});

test('promoteSuggestionOnMain: unknown fingerprint -- not-found, no issue filed, pen untouched', () => {
	const stderrLines: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		if (typeof chunk === 'string') stderrLines.push(chunk);
		return true;
	};

	try {
		const existing = `${JSON.stringify(OTHER_ENTRY)}\n`;
		const { spawnFn, calls } = makeFullFakeSpawnFn({ suggestionsContent: existing });

		const result = promoteSuggestionOnMain({
			cwd: '/fake/project',
			fingerprints: ['deadbeef0000'],
			spawnFn,
			clock,
			readProjectToml: () => PROJECT_TOML,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('not-found');
		expect(stderrLines.join('')).toMatch(/unknown fingerprint/i);

		expect(calls.find((c) => c.args.includes('ls-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
	} finally {
		process.stderr.write = originalWrite;
	}
});

test('promoteSuggestionOnMain: entry with no sourceIssue -- files without derivedFrom', () => {
	const entryNoSourceIssue: SuggestionEntry = { ...OTHER_ENTRY };
	const existing = `${JSON.stringify(entryNoSourceIssue)}\n`;
	const { spawnFn, calls } = makeFullFakeSpawnFn({ suggestionsContent: existing });

	const result = promoteSuggestionOnMain({
		cwd: '/fake/project',
		fingerprints: [entryNoSourceIssue.fingerprint],
		spawnFn,
		clock,
		readProjectToml: () => PROJECT_TOML,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;

	const issueHashCall = calls.find(
		(c) => c.args.includes('hash-object') && (c.input ?? '').includes('suggestion-fingerprint'),
	);
	expect(issueHashCall).toBeDefined();
	expect(issueHashCall?.input ?? '').not.toContain('derivedFrom');
});

test('promoteSuggestionOnMain: pen missing on main -- suggestions-missing, no issue filed', () => {
	const { spawnFn, calls } = makeFullFakeSpawnFn({ suggestionsMissing: true });

	const result = promoteSuggestionOnMain({
		cwd: '/fake/project',
		fingerprints: [SAMPLE_ENTRY.fingerprint],
		spawnFn,
		clock,
		readProjectToml: () => PROJECT_TOML,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe('suggestions-missing');
	expect(calls.find((c) => c.args.includes('ls-tree'))).toBeUndefined();
});

test('promoteSuggestionOnMain: diverged main -- error before any lookup or mutation', () => {
	const { spawnFn, calls } = makeFullFakeSpawnFn({ originMainUpToDate: false });

	const result = promoteSuggestionOnMain({
		cwd: '/fake/project',
		fingerprints: [SAMPLE_ENTRY.fingerprint],
		spawnFn,
		clock,
		readProjectToml: () => PROJECT_TOML,
	});

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.reason).toBe('diverged');
	expect(calls.find((c) => c.args.includes('show'))).toBeUndefined();
	expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
});

// ---------------------------------------------------------------------------
// CAS-retry per-attempt recompute regressions (US-002, CAM-300): a fake
// update-ref rejects exactly once (a losing CAS attempt), and the pen's
// `git show` returns DIFFERENT content on the winning (post-failure) read
// than on the first read -- modeling a concurrent writer landing a commit
// in between. Each on-main pen writer must re-derive its whole-file
// suggestions.jsonl content from that fresh read on every attempt, not reuse
// a rewrite computed once, up front, from the pre-mutation content.
// ---------------------------------------------------------------------------

const CONCURRENT_ENTRY: SuggestionEntry = {
	fingerprint: 'concurrent0001',
	title: 'Concurrently added suggestion',
	body: 'Appended by a different writer mid-CAS-retry.',
	sourceBranch: 'cam/issue-999',
	filedAt: '2026-07-15T00:00:00.000Z',
};

/**
 * Fake SpawnFn for appendSuggestionOnMain/dismissSuggestionOnMain: fails
 * update-ref exactly once, and returns `initialContent` for the first TWO
 * `git show` calls (the up-front pre-mutation read, then the first CAS
 * attempt's per-attempt recompute read) and `concurrentContent` from the
 * third call onward (the post-failure retry's per-attempt recompute read).
 */
function makeCasRetryFakeSpawnFn(opts: {
	initialContent: string;
	concurrentContent: string;
}): { spawnFn: SpawnFn; calls: CallRecord[] } {
	const { initialContent, concurrentContent } = opts;
	const calls: CallRecord[] = [];
	let showCallCount = 0;
	let updateRefCallCount = 0;

	const spawnFn: SpawnFn = (
		cmd: string,
		args: string[],
		options: { encoding: 'utf8'; env?: Record<string, string>; input?: string },
	): SpawnSyncReturns<string> => {
		calls.push({ cmd, args, input: options.input });

		if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
			return { stdout: 'feat/test\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('rev-parse') && args.includes('origin/main')) {
			return { stdout: '', stderr: 'unknown ref', status: 128, pid: 1, output: [], signal: null };
		}
		if (args.includes('rev-parse') && args[args.length - 1] === 'main') {
			return { stdout: 'mainsha1234567890\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('fetch')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('show') && args.some((a) => a.includes('suggestions.jsonl'))) {
			showCallCount++;
			return {
				stdout: showCallCount <= 2 ? initialContent : concurrentContent,
				stderr: '',
				status: 0,
				pid: 1,
				output: [],
				signal: null,
			};
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
			return { stdout: 'winningcommitsha123456\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('update-ref')) {
			updateRefCallCount++;
			if (updateRefCallCount === 1) {
				return { stdout: '', stderr: 'ref conflict', status: 1, pid: 1, output: [], signal: null };
			}
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		if (args.includes('push')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
	};

	return { spawnFn, calls };
}

test('appendSuggestionOnMain: CAS retry -- per-attempt recompute survives a concurrently-added line (US-002, CAM-300)', () => {
	const initialContent = `${JSON.stringify(OTHER_ENTRY)}\n`;
	const concurrentContent = `${JSON.stringify(OTHER_ENTRY)}\n${JSON.stringify(CONCURRENT_ENTRY)}\n`;
	const { spawnFn, calls } = makeCasRetryFakeSpawnFn({ initialContent, concurrentContent });

	const result = appendSuggestionOnMain({
		cwd: '/fake/cwd',
		entry: SAMPLE_ENTRY,
		spawnFn,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	if (result.skipped) throw new Error('expected append, not skip');

	// One losing attempt + one winning attempt.
	const updateRefCalls = calls.filter((c) => c.args.includes('update-ref'));
	expect(updateRefCalls.length).toBe(2);

	// The winning (last) hash-object write must contain the concurrently
	// added line AND the entry being appended, alongside the pre-existing
	// one -- none of the three clobbered by the stale first read.
	const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
	const winningContent = hashCalls[hashCalls.length - 1]?.input ?? '';
	expect(winningContent).toContain(CONCURRENT_ENTRY.fingerprint);
	expect(winningContent).toContain(SAMPLE_ENTRY.fingerprint);
	expect(winningContent).toContain(OTHER_ENTRY.fingerprint);
});

test('dismissSuggestionOnMain: CAS retry -- per-attempt recompute survives a concurrently-added line while still removing the targeted fingerprint (US-002, CAM-300)', () => {
	const initialContent = `${JSON.stringify(SAMPLE_ENTRY)}\n${JSON.stringify(OTHER_ENTRY)}\n`;
	const concurrentContent =
		`${JSON.stringify(SAMPLE_ENTRY)}\n${JSON.stringify(OTHER_ENTRY)}\n${JSON.stringify(CONCURRENT_ENTRY)}\n`;
	const { spawnFn, calls } = makeCasRetryFakeSpawnFn({ initialContent, concurrentContent });

	const result = dismissSuggestionOnMain({
		cwd: '/fake/project',
		fingerprint: SAMPLE_ENTRY.fingerprint,
		spawnFn,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;

	const updateRefCalls = calls.filter((c) => c.args.includes('update-ref'));
	expect(updateRefCalls.length).toBe(2);

	const hashCalls = calls.filter((c) => c.args.includes('hash-object'));
	const winningContent = hashCalls[hashCalls.length - 1]?.input ?? '';
	expect(winningContent).toContain(CONCURRENT_ENTRY.fingerprint);
	expect(winningContent).toContain(OTHER_ENTRY.fingerprint);
	expect(winningContent).not.toContain(SAMPLE_ENTRY.fingerprint);
});

/**
 * Fake SpawnFn for promoteSuggestionOnMain's CAS-retry scenario: layers the
 * same show-content-flip + one-time update-ref rejection on top of
 * makeFullFakeSpawnFn's writeIssueFile plumbing (empty backlog -> CAM-1).
 */
function makeCasRetryFullFakeSpawnFn(opts: {
	initialContent: string;
	concurrentContent: string;
}): { spawnFn: SpawnFn; calls: CallRecord[] } {
	const { initialContent, concurrentContent } = opts;
	const calls: CallRecord[] = [];
	let showCallCount = 0;
	let updateRefCallCount = 0;

	const spawnFn: SpawnFn = (
		cmd: string,
		args: string[],
		options: { encoding: 'utf8'; env?: Record<string, string>; input?: string },
	): SpawnSyncReturns<string> => {
		calls.push({ cmd, args, input: options.input });
		const argsStr = args.join(' ');

		if (argsStr.includes('rev-parse') && argsStr.includes('--abbrev-ref') && argsStr.includes('HEAD')) {
			return okResult('cam/issue-285\n');
		}
		if (argsStr.includes('rev-parse') && argsStr.includes('origin/main')) {
			return okResult('mainsha1234567890\n');
		}
		if (argsStr.includes('rev-parse') && argsStr.includes('main') && !argsStr.includes('origin/main')) {
			return okResult('mainsha1234567890\n');
		}
		if (argsStr.includes('fetch')) {
			return okResult();
		}
		if (argsStr.includes('show') && argsStr.includes('suggestions.jsonl')) {
			showCallCount++;
			return okResult(showCallCount <= 2 ? initialContent : concurrentContent);
		}
		if (argsStr.includes('ls-tree')) {
			return okResult(''); // empty backlog -> allocateId returns 1 (CAM-1)
		}
		if (argsStr.includes('cat-file')) {
			return okResult('');
		}
		if (argsStr.includes('read-tree')) {
			return okResult();
		}
		if (argsStr.includes('hash-object')) {
			return okResult('blobsha1234567890\n');
		}
		if (argsStr.includes('update-index')) {
			return okResult();
		}
		if (argsStr.includes('write-tree')) {
			return okResult('treesha1234567890\n');
		}
		if (argsStr.includes('commit-tree')) {
			return okResult('winningcommitsha123456\n');
		}
		if (argsStr.includes('update-ref')) {
			updateRefCallCount++;
			if (updateRefCallCount === 1) {
				return { ...okResult(''), status: 1, stderr: 'ref conflict' };
			}
			return okResult();
		}
		if (argsStr.includes('push')) {
			return okResult();
		}
		return okResult();
	};

	return { spawnFn, calls };
}

test('promoteSuggestionOnMain: CAS retry -- per-attempt recompute survives a concurrently-added line alongside the filed issue, and still removes the promoted line (US-002, CAM-300)', () => {
	const initialContent = `${JSON.stringify(SAMPLE_ENTRY)}\n${JSON.stringify(OTHER_ENTRY)}\n`;
	const concurrentContent =
		`${JSON.stringify(SAMPLE_ENTRY)}\n${JSON.stringify(OTHER_ENTRY)}\n${JSON.stringify(CONCURRENT_ENTRY)}\n`;
	const { spawnFn, calls } = makeCasRetryFullFakeSpawnFn({ initialContent, concurrentContent });

	const result = promoteSuggestionOnMain({
		cwd: '/fake/project',
		fingerprints: [SAMPLE_ENTRY.fingerprint],
		spawnFn,
		clock,
		readProjectToml: () => PROJECT_TOML,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.issueId).toBe('CAM-1');

	// One losing attempt + one winning attempt (the atomic single-commit
	// design from CAM-290 is preserved WITHIN the winning attempt: both the
	// issue JSON and the pen removal are hashed+indexed before that attempt's
	// single write-tree/commit-tree/update-ref call).
	const updateRefCalls = calls.filter((c) => c.args.includes('update-ref'));
	expect(updateRefCalls.length).toBe(2);

	// The winning pen-file hash-object write (identified by the SuggestionEntry-
	// only field `sourceBranch`) keeps the concurrently-added line and the
	// untouched other entry, while dropping the promoted (SAMPLE_ENTRY) line.
	const penHashCalls = calls.filter(
		(c) => c.args.includes('hash-object') && (c.input ?? '').includes('sourceBranch'),
	);
	const winningPenContent = penHashCalls[penHashCalls.length - 1]?.input ?? '';
	expect(winningPenContent).toContain(CONCURRENT_ENTRY.fingerprint);
	expect(winningPenContent).toContain(OTHER_ENTRY.fingerprint);
	expect(winningPenContent).not.toContain(SAMPLE_ENTRY.fingerprint);

	// The filed issue JSON (co-committed in the SAME winning attempt) still
	// carries the promoted fingerprint.
	const issueHashCall = calls.find(
		(c) => c.args.includes('hash-object') && (c.input ?? '').includes('suggestion-fingerprint'),
	);
	expect(issueHashCall).toBeDefined();
	expect(issueHashCall?.input ?? '').toContain(`suggestion-fingerprint: ${SAMPLE_ENTRY.fingerprint}`);
});

// ---------------------------------------------------------------------------
// Variadic composite promote (US-001, CAM-378)
// ---------------------------------------------------------------------------

test('promote composes multiple fingerprints into one issue', () => {
	const existing = `${JSON.stringify(SAMPLE_ENTRY)}\n${JSON.stringify(OTHER_ENTRY)}\n`;
	const { spawnFn, calls } = makeFullFakeSpawnFn({ suggestionsContent: existing });

	const result = promoteSuggestionOnMain({
		cwd: '/fake/project',
		fingerprints: [SAMPLE_ENTRY.fingerprint, OTHER_ENTRY.fingerprint],
		spawnFn,
		clock,
		readProjectToml: () => PROJECT_TOML,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.fingerprints).toEqual([SAMPLE_ENTRY.fingerprint, OTHER_ENTRY.fingerprint]);
	expect(result.issueId).toBe('CAM-1');

	// Exactly ONE commit-tree call: the composite issue and BOTH pen-line
	// removals land in a single atomic on-main commit.
	const commitTreeCalls = calls.filter((c) => c.args.includes('commit-tree'));
	expect(commitTreeCalls.length).toBe(1);

	// The filed issue's description carries a suggestion-fingerprint line for
	// EVERY promoted entry, and merges both entries' derivedFrom/provenance
	// (not only the first entry's).
	const issueHashCall = calls.find(
		(c) => c.args.includes('hash-object') && (c.input ?? '').includes('suggestion-fingerprint'),
	);
	expect(issueHashCall).toBeDefined();
	const issueContent = issueHashCall?.input ?? '';
	expect(issueContent).toContain(`suggestion-fingerprint: ${SAMPLE_ENTRY.fingerprint}`);
	expect(issueContent).toContain(`suggestion-fingerprint: ${OTHER_ENTRY.fingerprint}`);
	expect(issueContent).toContain(SAMPLE_ENTRY.body);
	expect(issueContent).toContain(OTHER_ENTRY.body);
	expect(issueContent).toContain('"derivedFrom"');
	expect(issueContent).toContain('CAM-285'); // SAMPLE_ENTRY.sourceIssue -> CAM-285

	// Both promoted pen lines are removed; nothing else was in the pen.
	const penHashCall = calls.find(
		(c) => c.args.includes('hash-object') && (c.input ?? '').trim() === '',
	);
	expect(penHashCall).toBeDefined();

	// The commit message names BOTH promoted fingerprints, joined.
	const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
	expect(
		commitTreeCall?.args.some((a) =>
			a.includes(`${SAMPLE_ENTRY.fingerprint}+${OTHER_ENTRY.fingerprint}`),
		),
	).toBe(true);
});

test('promote with an unknown fingerprint mutates nothing', () => {
	const stderrLines: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		if (typeof chunk === 'string') stderrLines.push(chunk);
		return true;
	};

	try {
		const existing = `${JSON.stringify(SAMPLE_ENTRY)}\n${JSON.stringify(OTHER_ENTRY)}\n`;
		const { spawnFn, calls } = makeFullFakeSpawnFn({ suggestionsContent: existing });

		const result = promoteSuggestionOnMain({
			cwd: '/fake/project',
			fingerprints: [SAMPLE_ENTRY.fingerprint, 'deadbeef0000'],
			spawnFn,
			clock,
			readProjectToml: () => PROJECT_TOML,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('not-found');
		expect(stderrLines.join('')).toMatch(/unknown fingerprint/i);

		// All-or-nothing: no issue filed, no CAS/commit machinery touched, pen
		// untouched -- even though the FIRST fingerprint in the list is valid.
		expect(calls.find((c) => c.args.includes('ls-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('hash-object'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('push'))).toBeUndefined();
	} finally {
		process.stderr.write = originalWrite;
	}
});
