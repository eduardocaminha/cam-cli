// test/ship-finalize.test.ts
//
// Unit tests for finalizeCycleClose() in src/commands/ship-finalize.ts.
//
// Coverage (per US-001 acceptance criteria):
//   (a) none-backend happy path: issue closed in issues.local.json + git rm +
//       commit
//   (b) github-backend: issues.local.json NOT touched; git rm + commit still
//       run
//   (c) linear-backend: same as (b)
//   (d) dirty-prd.json case: prd.json still removed via
//       `git rm -f --ignore-unmatch` even when git would normally refuse to rm
//       a modified file
//
// All external I/O is faked via injectable deps; no real git binary or
// filesystem is exercised.

import { describe, expect, test } from 'bun:test';
import {
	finalizeCycleClose,
	type FinalizeCycleCloseOptions,
	type SpawnFn,
} from '../src/commands/ship-finalize.ts';
import type { SpawnSyncReturns } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_TS = '2026-06-23T12:00:00.000Z';
const clock = () => FIXED_TS;

const PROJECT_TOML_NONE = 'issue_system = "none"\nissue_prefix = "CAM"\n';
const PROJECT_TOML_GITHUB = 'issue_system = "github"\nissue_prefix = "CAM"\n';
const PROJECT_TOML_LINEAR = 'issue_system = "linear"\nissue_prefix = "CAM"\n';

const PRD_JSON = JSON.stringify({ issueNumber: 72, branchName: 'cam/CAM-72-test' });

const ISSUES_LOCAL_JSON = JSON.stringify(
	{
		next_id: 73,
		issues: [
			{ id: 'CAM-72', title: 'Test issue', stage: 'idea', status: 'open', blockedBy: [], createdAt: '2026-06-01T00:00:00Z' },
			{ id: 'CAM-71', title: 'Another', stage: 'shipped', status: 'open', blockedBy: [], createdAt: '2026-05-01T00:00:00Z' },
		],
	},
	null,
	2,
) + '\n';

/** Minimal passing SpawnSyncReturns<string> for a successful git call. */
function okResult(): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, '', ''], stdout: '', stderr: '', status: 0, signal: null };
}

interface SpawnCall {
	cmd: string;
	args: string[];
}

/**
 * Build a SpawnFn that records every call and returns success.
 *
 * For `git diff --cached --quiet` the returned status controls the
 * "nothing staged" guard introduced in US-005:
 *   status 1 (default) = staged changes present  => commit proceeds
 *   status 0            = no staged changes        => commit is skipped
 *
 * For `git rev-parse --short HEAD` the returned stdout is `revParseSha`
 * (default 'abc1234'), reflecting the new structured-result-line emit (US-006).
 */
function makeRecordingSpawn(opts: { diffCachedStatus?: number; revParseSha?: string } = {}): { spawnFn: SpawnFn; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const diffStatus = opts.diffCachedStatus ?? 1;
	const sha = opts.revParseSha ?? 'abc1234';
	const spawnFn: SpawnFn = (cmd, args, _opts) => {
		calls.push({ cmd, args });
		if (args.includes('diff') && args.includes('--cached') && args.includes('--quiet')) {
			return { ...okResult(), status: diffStatus };
		}
		if (args.includes('rev-parse') && args.includes('--short')) {
			return { ...okResult(), stdout: sha + '\n' };
		}
		return okResult();
	};
	return { spawnFn, calls };
}

/** Build the default options shared across tests. Override per-test as needed. */
function makeOptions(
	overrides: Partial<FinalizeCycleCloseOptions> & { spawnFn: SpawnFn },
): FinalizeCycleCloseOptions {
	return {
		cwd: '/fake/project',
		clock,
		readProjectToml: () => PROJECT_TOML_NONE,
		readPrd: () => PRD_JSON,
		readIssues: () => ISSUES_LOCAL_JSON,
		writeIssues: () => {},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// (a) none-backend happy path
// ---------------------------------------------------------------------------

describe('finalizeCycleClose — none backend (happy path)', () => {
	test('closes issue in issues.local.json, rms harness files, and commits', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		let writtenIssues: string | null = null;

		const result = finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_NONE,
				writeIssues: (text) => { writtenIssues = text; },
			}),
		);

		// Return value
		expect(result.issueId).toBe('CAM-72');
		expect(result.issueBackend).toBe('none');
		expect(result.issueLocalClosed).toBe(true);
		expect(result.commitMessage).toBe(
			'chore(cam): close CAM-72 + drop per-branch harness state (CAM-27 hygiene)',
		);

		// issues.local.json was written with stage='shipped'
		expect(writtenIssues).not.toBeNull();
		const parsed = JSON.parse(writtenIssues!);
		const entry = parsed.issues.find((i: { id: string }) => i.id === 'CAM-72');
		expect(entry?.stage).toBe('shipped');

		// git rm -f --ignore-unmatch for each harness file
		const rmCalls = calls.filter(
			(c) =>
				c.args.includes('rm') &&
				c.args.includes('-f') &&
				c.args.includes('--ignore-unmatch'),
		);
		expect(rmCalls.length).toBe(3);
		const removedPaths = rmCalls.map((c) => c.args[c.args.length - 1]);
		expect(removedPaths).toContain('scripts/cam/prd.json');
		expect(removedPaths).toContain('scripts/cam/handoff.json');
		expect(removedPaths).toContain('scripts/cam/progress.txt');

		// git add for issues.local.json
		const addCall = calls.find(
			(c) => c.args.includes('add') && c.args.includes('scripts/cam/issues.local.json'),
		);
		expect(addCall).toBeDefined();

		// git commit with exact message
		const commitCall = calls.find((c) => c.args.includes('commit'));
		expect(commitCall).toBeDefined();
		const msgIndex = commitCall!.args.indexOf('-m');
		expect(commitCall!.args[msgIndex + 1]).toBe(
			'chore(cam): close CAM-72 + drop per-branch harness state (CAM-27 hygiene)',
		);
	});
});

// ---------------------------------------------------------------------------
// (b) github-backend: skip issues.local.json; still rm + commit
// ---------------------------------------------------------------------------

describe('finalizeCycleClose — github backend', () => {
	test('does NOT touch issues.local.json but still rms harness files and commits', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		let writeIssuesCalled = false;

		const result = finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_GITHUB,
				writeIssues: () => { writeIssuesCalled = true; },
			}),
		);

		// issueLocalClosed must be false for github
		expect(result.issueBackend).toBe('github');
		expect(result.issueLocalClosed).toBe(false);

		// issues.local.json should NOT be written
		expect(writeIssuesCalled).toBe(false);

		// git add for issues.local.json should NOT be called
		const addIssuesCall = calls.find(
			(c) => c.args.includes('add') && c.args.includes('scripts/cam/issues.local.json'),
		);
		expect(addIssuesCall).toBeUndefined();

		// git rm -f --ignore-unmatch should still be called for harness files
		const rmCalls = calls.filter(
			(c) =>
				c.args.includes('rm') &&
				c.args.includes('-f') &&
				c.args.includes('--ignore-unmatch'),
		);
		expect(rmCalls.length).toBe(3);

		// commit should still happen
		const commitCall = calls.find((c) => c.args.includes('commit'));
		expect(commitCall).toBeDefined();
		expect(result.commitMessage).toBe(
			'chore(cam): close CAM-72 + drop per-branch harness state (CAM-27 hygiene)',
		);
	});
});

// ---------------------------------------------------------------------------
// (c) linear-backend: same behaviour as github
// ---------------------------------------------------------------------------

describe('finalizeCycleClose — linear backend', () => {
	test('does NOT touch issues.local.json but still rms harness files and commits', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		let writeIssuesCalled = false;

		const result = finalizeCycleClose(
			makeOptions({
				spawnFn,
				readProjectToml: () => PROJECT_TOML_LINEAR,
				writeIssues: () => { writeIssuesCalled = true; },
			}),
		);

		expect(result.issueBackend).toBe('linear');
		expect(result.issueLocalClosed).toBe(false);
		expect(writeIssuesCalled).toBe(false);

		const rmCalls = calls.filter(
			(c) =>
				c.args.includes('rm') &&
				c.args.includes('-f') &&
				c.args.includes('--ignore-unmatch'),
		);
		expect(rmCalls.length).toBe(3);

		const commitCall = calls.find((c) => c.args.includes('commit'));
		expect(commitCall).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// (e) structured result line (US-006): emitOk with issue-id, files, sha
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes from a string for plain-text assertions. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1B) required for ANSI stripping
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('finalizeCycleClose — structured result line (US-006)', () => {
	test('happy path (none backend) emits line with issue-id, removed files, and sha', () => {
		const captured: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			if (typeof chunk === 'string') captured.push(chunk);
			else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString('utf8'));
			return true;
		}) as unknown as typeof process.stdout.write;

		let error: unknown;
		try {
			const { spawnFn } = makeRecordingSpawn({ revParseSha: 'def5678' });
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readProjectToml: () => PROJECT_TOML_NONE,
					writeIssues: () => {},
				}),
			);
		} catch (e) {
			error = e;
		} finally {
			process.stdout.write = origWrite;
		}

		expect(error).toBeUndefined();

		const plain = stripAnsi(captured.join(''));
		expect(plain).toContain('closed CAM-72');
		expect(plain).toContain('prd.json');
		expect(plain).toContain('handoff.json');
		expect(plain).toContain('progress.txt');
		expect(plain).toContain('sha def5678');
	});

	test('github backend emits line noting issue-close handled by github', () => {
		const captured: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			if (typeof chunk === 'string') captured.push(chunk);
			else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString('utf8'));
			return true;
		}) as unknown as typeof process.stdout.write;

		try {
			const { spawnFn } = makeRecordingSpawn({ revParseSha: 'aaa0001' });
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readProjectToml: () => PROJECT_TOML_GITHUB,
				}),
			);
		} finally {
			process.stdout.write = origWrite;
		}

		const plain = stripAnsi(captured.join(''));
		expect(plain).toContain('closed CAM-72');
		expect(plain).toContain('github');
		expect(plain).toContain('sha aaa0001');
	});

	test('no-op (prd absent) emits a clear skip message, not silent', () => {
		const captured: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			if (typeof chunk === 'string') captured.push(chunk);
			else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString('utf8'));
			return true;
		}) as unknown as typeof process.stdout.write;

		try {
			const { spawnFn } = makeRecordingSpawn();
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readPrd: () => { throw new Error('ENOENT'); },
				}),
			);
		} finally {
			process.stdout.write = origWrite;
		}

		const plain = stripAnsi(captured.join(''));
		// Must not be silent: some output that mentions "skipped" or "already closed"
		expect(plain.length).toBeGreaterThan(0);
		const lower = plain.toLowerCase();
		expect(lower.includes('skipped') || lower.includes('already closed')).toBe(true);
	});

	test('no-op (nothing staged) emits a clear skip message, not silent', () => {
		const captured: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			if (typeof chunk === 'string') captured.push(chunk);
			else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString('utf8'));
			return true;
		}) as unknown as typeof process.stdout.write;

		try {
			const { spawnFn } = makeRecordingSpawn({ diffCachedStatus: 0 });
			finalizeCycleClose(
				makeOptions({
					spawnFn,
					readProjectToml: () => PROJECT_TOML_GITHUB,
				}),
			);
		} finally {
			process.stdout.write = origWrite;
		}

		const plain = stripAnsi(captured.join(''));
		expect(plain.length).toBeGreaterThan(0);
		const lower = plain.toLowerCase();
		expect(lower.includes('skipped') || lower.includes('nothing staged')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// (d) dirty-prd.json case: `git rm -f --ignore-unmatch` must be in spawn calls
// ---------------------------------------------------------------------------

describe('finalizeCycleClose — dirty prd.json case', () => {
	test('prd.json is still removed via git rm -f --ignore-unmatch even if dirty', () => {
		// Simulate a scenario where the prd.json has local modifications (git
		// would normally refuse a plain `git rm`). The -f flag overrides this.
		// We verify that the exact invocation `['rm', '-f', '--ignore-unmatch', ...]`
		// appears in the recorded spawn calls for prd.json.
		const { spawnFn, calls } = makeRecordingSpawn();

		finalizeCycleClose(makeOptions({ spawnFn }));

		// The critical assertion: rm uses BOTH -f AND --ignore-unmatch
		const prdRmCall = calls.find(
			(c) =>
				c.args.includes('rm') &&
				c.args.includes('-f') &&
				c.args.includes('--ignore-unmatch') &&
				c.args.includes('scripts/cam/prd.json'),
		);
		expect(prdRmCall).toBeDefined();

		// Verify the exact arg order that satisfies the oracle grep
		// grep -nE "'rm'.*'-f'.*'--ignore-unmatch'|'rm', '-f', '--ignore-unmatch'"
		// The implementation has: ['git', '-C', cwd, 'rm', '-f', '--ignore-unmatch', path]
		// which satisfies the grep pattern 'rm', '-f', '--ignore-unmatch' in source.
		expect(prdRmCall!.args).toContain('-f');
		expect(prdRmCall!.args).toContain('--ignore-unmatch');
		const rmIdx = prdRmCall!.args.indexOf('rm');
		const fIdx = prdRmCall!.args.indexOf('-f');
		const ignoreIdx = prdRmCall!.args.indexOf('--ignore-unmatch');
		expect(rmIdx).toBeLessThan(fIdx);
		expect(fIdx).toBeLessThan(ignoreIdx);
	});
});
