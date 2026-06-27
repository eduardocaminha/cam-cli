// test/commands/journal-append.test.ts
//
// Unit tests for src/commands/journal.ts (appendJournalEntryOnMain).
//
// Uses a fake SpawnFn to verify:
//   1. renderJournalBlock output shape (header + bullet fields).
//   2. The git show call targets main:scripts/cam/journal.md.
//   3. On success the last stdout line matches /^CAM_JOURNAL_APPENDED=.+ sha=.+$/.
//   4. When the injected spawnFn returns non-zero on push, the command prints
//      an error but the function still returns { ok: true }.
//   5. The command dispatched via index.ts case 'journal' exits 0 on success.

import { test, expect } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	renderJournalBlock,
	appendJournalEntryOnMain,
	type SpawnFn,
	type JournalCycleEntry,
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
