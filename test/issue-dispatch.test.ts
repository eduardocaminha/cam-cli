// test/issue-dispatch.test.ts
//
// Unit tests for dispatchIssue and parseIssueArgs.
//
// Coverage:
//   (a) parseIssueArgs recognizes --file-local and returns { mode: 'file-local',
//       fastTrack, derivedFrom } (US-002 extension of US-003).
//   (b) --fast-track sets fastTrack:true; --derived-from parses comma-separated
//       ids into derivedFrom; both flags are mutually exclusive.
//   (c) dispatchIssue routes --file-local to fileLocalFn BEFORE runIssueFn.
//   (d) The --file-local path NEVER calls the runIssue thin-proxy.
//   (e) The text path calls runIssueFn and NOT fileLocalFn.
//   (f) Exit codes are forwarded from the injected fakes.
//   (g) parseIssueArgs recognizes `list` / `list --all` as { mode: 'list' },
//       evaluated BEFORE the free-text fallthrough (CAM-190 US-003).
//   (h) dispatchIssue routes mode 'list' to issueListFn and NEVER touches
//       runIssueFn or fileLocalFn (no thin-proxy, no send-keys, no claude spawn).
//
// All external I/O is faked via injectable deps (fileLocalFn, runIssueFn,
// issueListFn). No real stdin, git, or tmux is exercised.

import { describe, expect, test } from 'bun:test';
import { parseIssueArgs, dispatchIssue } from '../index.ts';

// Suppress stderr for tests that expect errors.
function withSilentStderr<T>(fn: () => T): T {
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (() => true) as typeof process.stderr.write;
	try {
		return fn();
	} finally {
		process.stderr.write = original;
	}
}

// ---------------------------------------------------------------------------
// parseIssueArgs: --file-local mode recognition (US-003 baseline)
// ---------------------------------------------------------------------------

describe('parseIssueArgs: --file-local recognition', () => {
	test('recognizes --file-local and returns { mode: file-local, fastTrack: false, derivedFrom: [], help: false }', () => {
		const result = parseIssueArgs(['--file-local']);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe('file-local');
		expect(result?.help).toBe(false);
		if (result?.mode === 'file-local') {
			expect(result.fastTrack).toBe(false);
			expect(result.derivedFrom).toEqual([]);
		}
	});

	test('free-text path returns { mode: text, text: <arg>, help: false }', () => {
		const result = parseIssueArgs(['my issue text']);
		expect(result?.mode).toBe('text');
		// Narrow to text mode to access text field.
		if (result?.mode === 'text') {
			expect(result.text).toBe('my issue text');
		}
		expect(result?.help).toBe(false);
	});

	test('--file-local with unknown extra arg returns null (unexpected argument)', () => {
		const result = withSilentStderr(() => parseIssueArgs(['--file-local', 'extra']));
		expect(result).toBeNull();
	});

	test('--file-local is distinct from the free-text { text } shape', () => {
		const fileLocal = parseIssueArgs(['--file-local']);
		const freeText = parseIssueArgs(['some text']);
		// mode discriminates the two shapes
		expect(fileLocal?.mode).toBe('file-local');
		expect(freeText?.mode).toBe('text');
	});

	test('--help still returns help shape', () => {
		const result = parseIssueArgs(['--help']);
		expect(result?.help).toBe(true);
	});

	test('-h still returns help shape', () => {
		const result = parseIssueArgs(['-h']);
		expect(result?.help).toBe(true);
	});

	test('empty args still returns null', () => {
		const result = withSilentStderr(() => parseIssueArgs([]));
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseIssueArgs: `list` subcommand (US-003, CAM-190)
// ---------------------------------------------------------------------------

describe('parseIssueArgs: list subcommand', () => {
	test('cam issue list returns { mode: list, all: false, help: false }', () => {
		const result = parseIssueArgs(['list']);
		expect(result?.mode).toBe('list');
		expect(result?.help).toBe(false);
		if (result?.mode === 'list') {
			expect(result.all).toBe(false);
		}
	});

	test('cam issue list --all returns { mode: list, all: true, help: false }', () => {
		const result = parseIssueArgs(['list', '--all']);
		expect(result?.mode).toBe('list');
		if (result?.mode === 'list') {
			expect(result.all).toBe(true);
		}
		expect(result?.help).toBe(false);
	});

	test('a bare "list" positional is never misread as free-text issue creation', () => {
		const result = parseIssueArgs(['list']);
		expect(result?.mode).not.toBe('text');
	});

	test('cam issue list <unexpected> returns null', () => {
		const result = withSilentStderr(() => parseIssueArgs(['list', 'bogus']));
		expect(result).toBeNull();
	});

	test('free text starting with a different word is still mode:text (no regression)', () => {
		const result = parseIssueArgs(['fix the flaky retry test']);
		expect(result?.mode).toBe('text');
		if (result?.mode === 'text') {
			expect(result.text).toBe('fix the flaky retry test');
		}
	});
});

// ---------------------------------------------------------------------------
// parseIssueArgs: --fast-track flag (US-002)
// ---------------------------------------------------------------------------

describe('parseIssueArgs: --fast-track', () => {
	test('--file-local --fast-track returns fastTrack:true derivedFrom:[]', () => {
		const result = parseIssueArgs(['--file-local', '--fast-track']);
		expect(result?.mode).toBe('file-local');
		if (result?.mode === 'file-local') {
			expect(result.fastTrack).toBe(true);
			expect(result.derivedFrom).toEqual([]);
		}
	});

	test('--file-local --fast-track preserves mode:file-local', () => {
		const result = parseIssueArgs(['--file-local', '--fast-track']);
		expect(result?.mode).toBe('file-local');
		expect(result?.help).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// parseIssueArgs: --derived-from flag (US-002)
// ---------------------------------------------------------------------------

describe('parseIssueArgs: --derived-from', () => {
	test('--file-local --derived-from CAM-42 returns derivedFrom:["CAM-42"]', () => {
		const result = parseIssueArgs(['--file-local', '--derived-from', 'CAM-42']);
		expect(result?.mode).toBe('file-local');
		if (result?.mode === 'file-local') {
			expect(result.fastTrack).toBe(false);
			expect(result.derivedFrom).toEqual(['CAM-42']);
		}
	});

	test('--derived-from accepts comma-separated list: CAM-42,CAM-43', () => {
		const result = parseIssueArgs(['--file-local', '--derived-from', 'CAM-42,CAM-43']);
		if (result?.mode === 'file-local') {
			expect(result.derivedFrom).toEqual(['CAM-42', 'CAM-43']);
		}
	});

	test('--derived-from without a value returns null', () => {
		const result = withSilentStderr(() => parseIssueArgs(['--file-local', '--derived-from']));
		expect(result).toBeNull();
	});

	test('--fast-track and --derived-from together return null (mutually exclusive)', () => {
		const result = withSilentStderr(() =>
			parseIssueArgs(['--file-local', '--fast-track', '--derived-from', 'CAM-42'])
		);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// dispatchIssue: --file-local branch NEVER calls runIssue thin-proxy
// ---------------------------------------------------------------------------

describe('dispatchIssue: routing isolation', () => {
	test('--file-local calls fileLocalFn and NOT runIssueFn', async () => {
		let fileLocalCalled = false;
		let runIssueCalled = false;

		await dispatchIssue(
			{ mode: 'file-local', fastTrack: false, derivedFrom: [], help: false },
			{
				fileLocalFn: async () => {
					fileLocalCalled = true;
					return 0;
				},
				runIssueFn: async () => {
					runIssueCalled = true;
					return 0;
				},
			},
		);

		expect(fileLocalCalled).toBe(true);
		// NEVER calls the runIssue thin-proxy on the --file-local path.
		expect(runIssueCalled).toBe(false);
	});

	test('text path calls runIssueFn and NOT fileLocalFn', async () => {
		let fileLocalCalled = false;
		let runIssueCalled = false;

		await dispatchIssue(
			{ mode: 'text', text: 'some issue text', help: false },
			{
				fileLocalFn: async () => {
					fileLocalCalled = true;
					return 0;
				},
				runIssueFn: async () => {
					runIssueCalled = true;
					return 0;
				},
			},
		);

		expect(runIssueCalled).toBe(true);
		expect(fileLocalCalled).toBe(false);
	});

	test('--file-local returns 0 when fileLocalFn succeeds', async () => {
		const code = await dispatchIssue(
			{ mode: 'file-local', fastTrack: false, derivedFrom: [], help: false },
			{
				fileLocalFn: async () => 0,
				runIssueFn: async () => 99,
			},
		);
		expect(code).toBe(0);
	});

	test('--file-local returns 1 when fileLocalFn fails', async () => {
		const code = await dispatchIssue(
			{ mode: 'file-local', fastTrack: false, derivedFrom: [], help: false },
			{
				fileLocalFn: async () => 1,
				runIssueFn: async () => 0,
			},
		);
		expect(code).toBe(1);
	});

	test('text path returns runIssueFn exit code', async () => {
		const code = await dispatchIssue(
			{ mode: 'text', text: 'test issue', help: false },
			{
				fileLocalFn: async () => 99,
				runIssueFn: async () => 0,
			},
		);
		expect(code).toBe(0);
	});

	test('text path forwards non-zero exit code from runIssueFn', async () => {
		const code = await dispatchIssue(
			{ mode: 'text', text: 'test issue', help: false },
			{
				fileLocalFn: async () => 0,
				runIssueFn: async () => 1,
			},
		);
		expect(code).toBe(1);
	});

	test('--file-local with --fast-track still routes to fileLocalFn', async () => {
		let fileLocalCalled = false;
		await dispatchIssue(
			{ mode: 'file-local', fastTrack: true, derivedFrom: [], help: false },
			{
				fileLocalFn: async () => { fileLocalCalled = true; return 0; },
				runIssueFn: async () => 99,
			},
		);
		expect(fileLocalCalled).toBe(true);
	});

	test('--file-local with --derived-from still routes to fileLocalFn', async () => {
		let fileLocalCalled = false;
		await dispatchIssue(
			{ mode: 'file-local', fastTrack: false, derivedFrom: ['CAM-42'], help: false },
			{
				fileLocalFn: async () => { fileLocalCalled = true; return 0; },
				runIssueFn: async () => 99,
			},
		);
		expect(fileLocalCalled).toBe(true);
	});

	test('mode:list calls issueListFn and NEVER runIssueFn or fileLocalFn (no thin-proxy)', async () => {
		let issueListCalled = false;
		let runIssueCalled = false;
		let fileLocalCalled = false;

		const code = await dispatchIssue(
			{ mode: 'list', all: false, help: false },
			{
				issueListFn: async () => {
					issueListCalled = true;
					return 0;
				},
				runIssueFn: async () => {
					runIssueCalled = true;
					return 0;
				},
				fileLocalFn: async () => {
					fileLocalCalled = true;
					return 0;
				},
			},
		);

		expect(issueListCalled).toBe(true);
		expect(runIssueCalled).toBe(false);
		expect(fileLocalCalled).toBe(false);
		expect(code).toBe(0);
	});

	test('mode:list --all still routes to issueListFn only', async () => {
		let issueListCalled = false;
		await dispatchIssue(
			{ mode: 'list', all: true, help: false },
			{
				issueListFn: async () => {
					issueListCalled = true;
					return 0;
				},
				runIssueFn: async () => 99,
				fileLocalFn: async () => 99,
			},
		);
		expect(issueListCalled).toBe(true);
	});

	test('mode:list forwards issueListFn exit code', async () => {
		const code = await dispatchIssue(
			{ mode: 'list', all: false, help: false },
			{ issueListFn: async () => 1 },
		);
		expect(code).toBe(1);
	});
});
