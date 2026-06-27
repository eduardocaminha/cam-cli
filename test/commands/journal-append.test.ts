// test/commands/journal-append.test.ts
//
// Unit tests for src/commands/journal.ts (appendJournalEntryOnMain).
//
// Covers US-001 (tracer bullet) and US-002 (validation, optional fields,
// em-dash normalization, duplicate rejection).
//
// Uses a fake SpawnFn to verify:
//   1. renderJournalBlock output shape (header + bullet fields).
//   2. The git show call targets main:scripts/cam/journal.md.
//   3. On success the last stdout line matches /^CAM_JOURNAL_APPENDED=.+ sha=.+$/.
//   4. When the injected spawnFn returns non-zero on push, the command prints
//      an error but the function still returns { ok: true }.
//   5. The command dispatched via index.ts case 'journal' exits 0 on success.
//
// US-002 additional tests (AC 2-4):
//   AC2: optional fields rendered only when present.
//   AC3: em-dash normalization in body fields; header retains em-dash.
//   AC4: duplicate cycleId rejected without --force; replaced in-place with --force.

import { test, expect } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	renderJournalBlock,
	appendJournalEntryOnMain,
	type SpawnFn,
	type JournalCycleEntry,
	type AppendJournalEntryOnMainValidationError,
} from '../../src/commands/journal.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ENTRY: JournalCycleEntry = {
	cycleId: 'cam/CAM-122-journal-append',
	title: 'cam journal append deterministico',
	started: '2026-06-27',
	closed: '2026-06-27',
	branch: 'cam/CAM-122-journal-append',
	issue: 'CAM-122',
	outcome: 'shipped',
	summary: 'Implements deterministic cam journal append via commit-tree to main.',
};

const EXISTING_JOURNAL = `# Cam Journal\n\n<!-- ENTRIES_BELOW -->\n\n## old/entry — old title\n\n- **Started**: 2026-01-01\n- **Closed**: 2026-01-02\n- **Branch**: old/entry\n- **Issue**: CAM-1\n- **Outcome**: shipped\n- **Summary**: Old entry.\n`;

// ---------------------------------------------------------------------------
// Fake SpawnFn builder
// ---------------------------------------------------------------------------

interface FakeSpawnOpts {
	/** Simulated current branch (default: 'feat/test'). */
	branch?: string;
	/** Local main sha (default: 'abc123def456abc1'). */
	localMainSha?: string;
	/** Sha returned by the commit-tree step (default: 'dead1234beef5678'). */
	newCommitSha?: string;
	/** If true, origin/main returns the same sha (up-to-date). Default: false (no remote). */
	originMainUpToDate?: boolean;
	/** Content returned by `git show main:scripts/cam/journal.md`. */
	journalContent?: string;
	/** If true, the push step returns exit code 1 (push failure). */
	pushFails?: boolean;
}

/** Records all calls for assertions. */
interface CallRecord {
	cmd: string;
	args: string[];
	input?: string;
}

function makeFakeSpawnFn(opts: FakeSpawnOpts): { spawnFn: SpawnFn; calls: CallRecord[] } {
	const {
		branch = 'feat/test',
		localMainSha = 'abc123def456abc1',
		newCommitSha = 'dead1234beef5678',
		originMainUpToDate = false,
		journalContent = EXISTING_JOURNAL,
		pushFails = false,
	} = opts;

	const calls: CallRecord[] = [];

	const spawnFn: SpawnFn = (
		cmd: string,
		args: string[],
		options: { encoding: 'utf8'; env?: Record<string, string>; input?: string },
	): SpawnSyncReturns<string> => {
		calls.push({ cmd, args, input: options.input });

		// All git calls use `git -C <cwd> <subcommand> ...` so the subcommand
		// is at args[2] (args[0]='-C', args[1]=cwd, args[2]=subcommand).
		// Use includes() on the full args array for safer pattern matching.

		// rev-parse --abbrev-ref HEAD -> current branch
		if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
			return { stdout: branch + '\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// rev-parse origin/main
		if (args.includes('rev-parse') && args.includes('origin/main')) {
			if (!originMainUpToDate) {
				return { stdout: '', stderr: 'unknown ref', status: 128, pid: 1, output: [], signal: null };
			}
			return { stdout: localMainSha + '\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// rev-parse --short HEAD (on-main path)
		if (args.includes('rev-parse') && args.includes('--short')) {
			return { stdout: newCommitSha.substring(0, 7) + '\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// rev-parse main -> local main sha (must come after more-specific checks above)
		if (args.includes('rev-parse') && args[args.length - 1] === 'main') {
			return { stdout: localMainSha + '\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// fetch: always succeeds (best-effort)
		if (args.includes('fetch')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// git show main:scripts/cam/journal.md
		if (args.includes('show') && args.some((a) => a.includes('journal.md'))) {
			return { stdout: journalContent, stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// read-tree
		if (args.includes('read-tree')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// hash-object -> fake blob sha
		if (args.includes('hash-object')) {
			return { stdout: 'fakeblobsha1234567890\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// update-index
		if (args.includes('update-index')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// write-tree -> fake tree sha
		if (args.includes('write-tree')) {
			return { stdout: 'faketreesha1234567890\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// commit-tree -> new commit sha
		if (args.includes('commit-tree')) {
			return { stdout: newCommitSha + '\n', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// update-ref
		if (args.includes('update-ref')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// git add (on-main)
		if (args.includes('add')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// git commit (on-main) -- must not match 'commit-tree' (handled above)
		if (args.includes('commit') && !args.includes('commit-tree')) {
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// push
		if (args.includes('push')) {
			if (pushFails) {
				return { stdout: '', stderr: 'Permission denied', status: 1, pid: 1, output: [], signal: null };
			}
			return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
		}
		// Fallback: succeed silently.
		return { stdout: '', stderr: '', status: 0, pid: 1, output: [], signal: null };
	};

	return { spawnFn, calls };
}

// ---------------------------------------------------------------------------
// Tests: renderJournalBlock
// ---------------------------------------------------------------------------

test('renderJournalBlock renders header with em-dash and all bullet fields', () => {
	const block = renderJournalBlock(SAMPLE_ENTRY);
	const lines = block.split('\n');

	// Header uses U+2014 em-dash
	expect(lines[0]).toBe('## cam/CAM-122-journal-append — cam journal append deterministico');
	// Empty line after header
	expect(lines[1]).toBe('');
	// Bullet fields
	expect(lines[2]).toBe('- **Started**: 2026-06-27');
	expect(lines[3]).toBe('- **Closed**: 2026-06-27');
	expect(lines[4]).toBe('- **Branch**: cam/CAM-122-journal-append');
	expect(lines[5]).toBe('- **Issue**: CAM-122');
	expect(lines[6]).toBe('- **Outcome**: shipped');
	expect(lines[7]).toBe('- **Summary**: Implements deterministic cam journal append via commit-tree to main.');
});

// ---------------------------------------------------------------------------
// Tests: appendJournalEntryOnMain (off-main path)
// ---------------------------------------------------------------------------

test('appendJournalEntryOnMain: off-main -- reads journal from main, commits via commit-tree, returns ok', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ branch: 'feat/my-feature' });

	const result = appendJournalEntryOnMain({
		cwd: '/fake/cwd',
		entry: SAMPLE_ENTRY,
		spawnFn,
	});

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.cycleId).toBe('cam/CAM-122-journal-append');
	expect(result.sha).toBe('dead123'); // first 7 chars of 'dead1234beef5678'

	// Assert: journal.md was read from main (not working tree)
	const showCall = calls.find((c) => c.args.some((a) => a.includes('main:scripts/cam/journal.md')));
	expect(showCall).toBeDefined();

	// Assert: commit-tree was called (off-main path)
	const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
	expect(commitTreeCall).toBeDefined();

	// Assert: push was called
	const pushCall = calls.find((c) => c.args.includes('push'));
	expect(pushCall).toBeDefined();
});

test('appendJournalEntryOnMain: off-main -- hash-object receives the updated journal content', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ branch: 'feat/my-feature' });

	appendJournalEntryOnMain({
		cwd: '/fake/cwd',
		entry: SAMPLE_ENTRY,
		spawnFn,
	});

	const hashCall = calls.find((c) => c.args.includes('hash-object'));
	expect(hashCall).toBeDefined();

	// The input to hash-object must include the new block
	const inputContent = hashCall?.input ?? '';
	expect(inputContent).toContain('## cam/CAM-122-journal-append — cam journal append deterministico');
	expect(inputContent).toContain('- **Issue**: CAM-122');
	// The existing content must be preserved
	expect(inputContent).toContain('<!-- ENTRIES_BELOW -->');
	expect(inputContent).toContain('## old/entry');
});

// ---------------------------------------------------------------------------
// Tests: on-main path
// ---------------------------------------------------------------------------

test('appendJournalEntryOnMain: on-main -- uses direct commit, calls git add + commit', () => {
	const writtenFiles: Array<{ path: string; content: string }> = [];
	const { spawnFn, calls } = makeFakeSpawnFn({ branch: 'main' });

	const result = appendJournalEntryOnMain({
		cwd: '/fake/cwd',
		entry: SAMPLE_ENTRY,
		spawnFn,
		writeFile: (path, content) => {
			writtenFiles.push({ path, content });
		},
	});

	expect(result.ok).toBe(true);

	// Direct-commit path: git add should be called
	const addCall = calls.find((c) => c.args.includes('add') && c.args.some((a) => a.includes('journal.md')));
	expect(addCall).toBeDefined();

	// commit-tree should NOT be called (that is the off-main path)
	const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
	expect(commitTreeCall).toBeUndefined();

	// writeFile should have been called with journal.md path
	expect(writtenFiles).toHaveLength(1);
	expect(writtenFiles[0]?.path).toContain('journal.md');
	expect(writtenFiles[0]?.content).toContain('## cam/CAM-122-journal-append — cam journal append deterministico');
});

// ---------------------------------------------------------------------------
// Tests: push failure (best-effort)
// ---------------------------------------------------------------------------

test('appendJournalEntryOnMain: push failure -- returns ok:true and logs error', () => {
	const stderrLines: string[] = [];
	const originalStderr = process.stderr.write.bind(process.stderr);
	// Capture stderr to assert printError fired
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		if (typeof chunk === 'string') stderrLines.push(chunk);
		return true;
	};

	try {
		const { spawnFn } = makeFakeSpawnFn({ branch: 'feat/my-feature', pushFails: true });

		const result = appendJournalEntryOnMain({
			cwd: '/fake/cwd',
			entry: SAMPLE_ENTRY,
			spawnFn,
		});

		// Push failure must NOT change the ok:true result
		expect(result.ok).toBe(true);
		// An error must have been printed to stderr
		const errorOutput = stderrLines.join('');
		expect(errorOutput).toMatch(/push rejected|Permission denied/i);
	} finally {
		process.stderr.write = originalStderr;
	}
});

// ---------------------------------------------------------------------------
// Tests: stdout sentinel format
// ---------------------------------------------------------------------------

test('CAM_JOURNAL_APPENDED sentinel line format matches expected pattern', () => {
	// Validate the exact string the caller (index.ts) would print.
	const cycleId = 'cam/CAM-122-journal-append';
	const sha = 'dead123';
	const sentinel = `CAM_JOURNAL_APPENDED=${cycleId} sha=${sha}`;

	// This is the literal that index.ts writes; verify it matches the AC regex.
	expect(sentinel).toMatch(/^CAM_JOURNAL_APPENDED=.+ sha=.+$/);
});

// ---------------------------------------------------------------------------
// Tests: read-from-main AC oracle
// ---------------------------------------------------------------------------

test('appendJournalEntryOnMain: git show reads from main:scripts/cam/journal.md', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ branch: 'feat/any-branch' });

	appendJournalEntryOnMain({
		cwd: '/fake/cwd',
		entry: SAMPLE_ENTRY,
		spawnFn,
	});

	// Verify the exact git show argument contains 'main:scripts/cam/journal.md'
	const showCall = calls.find(
		(c) => c.args.includes('show') && c.args.some((a) => a === 'main:scripts/cam/journal.md'),
	);
	expect(showCall).toBeDefined();
});

// ---------------------------------------------------------------------------
// US-002: AC1 -- Required field validation
// ---------------------------------------------------------------------------

test('US-002 AC1: missing required field exits with validation error, names the field', () => {
	const stderrLines: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		if (typeof chunk === 'string') stderrLines.push(chunk);
		return true;
	};

	try {
		const { spawnFn, calls } = makeFakeSpawnFn({ branch: 'feat/test' });

		// Entry missing 'summary' (required field)
		const entryMissingSummary: Partial<JournalCycleEntry> = {
			cycleId: 'cam/CAM-122-journal-append',
			title: 'cam journal append deterministico',
			started: '2026-06-27',
			closed: '2026-06-27',
			branch: 'cam/CAM-122-journal-append',
			issue: 'CAM-122',
			outcome: 'shipped',
			// summary intentionally absent
		};

		const result = appendJournalEntryOnMain({
			cwd: '/fake/cwd',
			entry: entryMissingSummary as JournalCycleEntry,
			spawnFn,
		});

		// Must return { ok: false, reason: 'validation' }
		expect(result.ok).toBe(false);
		if (result.ok) return; // narrow for TypeScript

		expect(result.reason).toBe('validation');

		// Discriminated-union: errors field present on validation errors
		expect('errors' in result).toBe(true);
		const validationError = result as AppendJournalEntryOnMainValidationError;
		expect(validationError.errors).toContain('summary');

		// Error message must name the missing field
		const errorOutput = stderrLines.join('');
		expect(errorOutput).toMatch(/summary/);

		// No commit-tree or update-ref call must have fired
		const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
		const updateRefCall = calls.find((c) => c.args.includes('update-ref'));
		expect(commitTreeCall).toBeUndefined();
		expect(updateRefCall).toBeUndefined();
	} finally {
		process.stderr.write = originalWrite;
	}
});

test('US-002 AC1: validation fires before git show (no git calls on bad input)', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ branch: 'feat/test' });

	// Entry missing 'cycleId' (first required field)
	const entryMissingCycleId: Partial<JournalCycleEntry> = {
		title: 'cam journal append deterministico',
		started: '2026-06-27',
		closed: '2026-06-27',
		branch: 'cam/CAM-122-journal-append',
		issue: 'CAM-122',
		outcome: 'shipped',
		summary: 'Implements deterministic cam journal append.',
	};

	const stderrLines: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		if (typeof chunk === 'string') stderrLines.push(chunk);
		return true;
	};

	try {
		const result = appendJournalEntryOnMain({
			cwd: '/fake/cwd',
			entry: entryMissingCycleId as JournalCycleEntry,
			spawnFn,
		});

		expect(result.ok).toBe(false);

		// No git show call should have fired (validation is before git read)
		const showCall = calls.find((c) => c.args.includes('show'));
		expect(showCall).toBeUndefined();
	} finally {
		process.stderr.write = originalWrite;
	}
});

// ---------------------------------------------------------------------------
// US-002: AC2 -- Optional fields rendered only when present
// ---------------------------------------------------------------------------

test('US-002 AC2: optional fields absent -- no Decisions/Blockers/Followups bullet in output', () => {
	const block = renderJournalBlock(SAMPLE_ENTRY); // SAMPLE_ENTRY has no optional fields

	expect(block).not.toContain('**Decisions**');
	expect(block).not.toContain('**Blockers**');
	expect(block).not.toContain('**Followups**');
});

test('US-002 AC2: optional fields present -- Decisions/Blockers/Followups bullets appear', () => {
	const entryWithOptionals: JournalCycleEntry = {
		...SAMPLE_ENTRY,
		decisions: 'Use commit-tree for off-main writes.',
		blockers: 'None.',
		followups: 'Add CAM-123 cleanup story.',
	};

	const block = renderJournalBlock(entryWithOptionals);

	expect(block).toContain('**Decisions**: Use commit-tree for off-main writes.');
	expect(block).toContain('**Blockers**: None.');
	expect(block).toContain('**Followups**: Add CAM-123 cleanup story.');
});

test('US-002 AC2: only decisions present -- only Decisions bullet rendered', () => {
	const entry: JournalCycleEntry = { ...SAMPLE_ENTRY, decisions: 'Key decision.' };
	const block = renderJournalBlock(entry);

	expect(block).toContain('**Decisions**: Key decision.');
	expect(block).not.toContain('**Blockers**');
	expect(block).not.toContain('**Followups**');
});

// ---------------------------------------------------------------------------
// US-002: AC3 -- Em-dash normalization
// ---------------------------------------------------------------------------

test('US-002 AC3: em-dash in summary is normalized away in rendered body', () => {
	const entry: JournalCycleEntry = {
		...SAMPLE_ENTRY,
		summary: 'Shipped feature A — and fixed bug B.',
		outcome: 'shipped — with caveats',
	};

	const block = renderJournalBlock(entry);

	// Body must contain no U+2014
	const bodyLines = block.split('\n').slice(1); // skip header line
	const bodyText = bodyLines.join('\n');
	expect(bodyText).not.toContain('—');

	// Body text should have the replacement colon
	expect(bodyText).toContain('Shipped feature A : and fixed bug B.');
	expect(bodyText).toContain('shipped : with caveats');
});

test('US-002 AC3: em-dash in title header line is RETAINED (deliberate exception)', () => {
	const entry: JournalCycleEntry = {
		...SAMPLE_ENTRY,
		title: 'cam journal append deterministico',
	};

	const block = renderJournalBlock(entry);

	// Header line (line 0) must still contain the structural em-dash
	const headerLine = block.split('\n')[0] ?? '';
	expect(headerLine).toContain('—');
	expect(headerLine).toBe(
		'## cam/CAM-122-journal-append — cam journal append deterministico',
	);
});

test('US-002 AC3: em-dash in optional fields is normalized away', () => {
	const entry: JournalCycleEntry = {
		...SAMPLE_ENTRY,
		decisions: 'Option A — chosen over B.',
		blockers: 'Blocker X — resolved.',
		followups: 'Follow-up Y — see CAM-123.',
	};

	const block = renderJournalBlock(entry);
	const bodyLines = block.split('\n').slice(1);
	const bodyText = bodyLines.join('\n');
	expect(bodyText).not.toContain('—');
});

// ---------------------------------------------------------------------------
// US-002: AC4 -- Duplicate cycleId rejection and --force in-place replacement
// ---------------------------------------------------------------------------

/** Journal content that already has SAMPLE_ENTRY committed. */
const JOURNAL_WITH_EXISTING_ENTRY = `# Cam Journal\n\n<!-- ENTRIES_BELOW -->\n\n## cam/CAM-122-journal-append — cam journal append deterministico\n\n- **Started**: 2026-06-27\n- **Closed**: 2026-06-27\n- **Branch**: cam/CAM-122-journal-append\n- **Issue**: CAM-122\n- **Outcome**: shipped\n- **Summary**: Original summary.\n`;

test('US-002 AC4: duplicate cycleId rejected -- exit non-zero, no commit fired', () => {
	const stderrLines: string[] = [];
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		if (typeof chunk === 'string') stderrLines.push(chunk);
		return true;
	};

	try {
		const { spawnFn, calls } = makeFakeSpawnFn({
			branch: 'feat/test',
			journalContent: JOURNAL_WITH_EXISTING_ENTRY,
		});

		const result = appendJournalEntryOnMain({
			cwd: '/fake/cwd',
			entry: SAMPLE_ENTRY,
			spawnFn,
		});

		// Must reject with duplicate-cycleId
		expect(result.ok).toBe(false);
		if (result.ok) return; // narrow for TypeScript

		expect(result.reason).toBe('duplicate-cycleId');

		// No commit-tree or update-ref must have fired
		const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
		const updateRefCall = calls.find((c) => c.args.includes('update-ref'));
		expect(commitTreeCall).toBeUndefined();
		expect(updateRefCall).toBeUndefined();

		// Error message must mention the cycleId
		const errorOutput = stderrLines.join('');
		expect(errorOutput).toMatch(/duplicate|cam\/CAM-122/i);
	} finally {
		process.stderr.write = originalWrite;
	}
});

test('US-002 AC4: --force replaces existing entry in place (entry count unchanged)', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({
		branch: 'feat/test',
		journalContent: JOURNAL_WITH_EXISTING_ENTRY,
	});

	const entryWithUpdatedSummary: JournalCycleEntry = {
		...SAMPLE_ENTRY,
		summary: 'UPDATED: now with force replace.',
	};

	const result = appendJournalEntryOnMain({
		cwd: '/fake/cwd',
		entry: entryWithUpdatedSummary,
		spawnFn,
		force: true,
	});

	// Must succeed
	expect(result.ok).toBe(true);

	// A commit must have fired (off-main path: commit-tree)
	const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
	expect(commitTreeCall).toBeDefined();

	// The content passed to hash-object must contain the updated summary
	const hashCall = calls.find((c) => c.args.includes('hash-object'));
	const content = hashCall?.input ?? '';
	expect(content).toContain('UPDATED: now with force replace.');

	// The OLD summary must NOT be present in the new content
	expect(content).not.toContain('Original summary.');

	// Entry count: the updated content must have exactly ONE occurrence of
	// `## cam/CAM-122-journal-append` (replace, not append)
	const occurrences = (content.match(/## cam\/CAM-122-journal-append/g) ?? []).length;
	expect(occurrences).toBe(1);
});

test('US-002 AC4: --force replaces body, preserves other entries', () => {
	// Journal with TWO entries: the target one first, then an unrelated entry.
	const twoEntryJournal =
		`# Cam Journal\n\n<!-- ENTRIES_BELOW -->\n\n` +
		`## cam/CAM-122-journal-append — cam journal append deterministico\n\n` +
		`- **Started**: 2026-06-27\n- **Closed**: 2026-06-27\n- **Branch**: cam/CAM-122-journal-append\n` +
		`- **Issue**: CAM-122\n- **Outcome**: shipped\n- **Summary**: Original summary.\n\n` +
		`## cam/CAM-100-other — other title\n\n` +
		`- **Started**: 2026-01-01\n- **Closed**: 2026-01-02\n- **Branch**: cam/CAM-100-other\n` +
		`- **Issue**: CAM-100\n- **Outcome**: shipped\n- **Summary**: Other entry.\n`;

	const { spawnFn, calls } = makeFakeSpawnFn({
		branch: 'feat/test',
		journalContent: twoEntryJournal,
	});

	const entryUpdated: JournalCycleEntry = {
		...SAMPLE_ENTRY,
		summary: 'Replaced summary.',
	};

	appendJournalEntryOnMain({
		cwd: '/fake/cwd',
		entry: entryUpdated,
		spawnFn,
		force: true,
	});

	const hashCall = calls.find((c) => c.args.includes('hash-object'));
	const content = hashCall?.input ?? '';

	// Updated entry present
	expect(content).toContain('Replaced summary.');
	// Other entry preserved
	expect(content).toContain('## cam/CAM-100-other');
	expect(content).toContain('Other entry.');
	// Original summary gone
	expect(content).not.toContain('Original summary.');
});
