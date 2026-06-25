// test/issue-dispatch.test.ts
//
// Unit tests for dispatchIssue (US-003: cam issue --file-local CLI surface).
//
// Coverage (per US-003 acceptance criteria):
//   (a) parseIssueArgs recognizes --file-local and returns { mode: 'file-local' }
//       distinct from the free-text { mode: 'text' } shape.
//   (b) dispatchIssue routes --file-local to fileLocalFn BEFORE runIssueFn.
//   (c) The --file-local path NEVER calls the runIssue thin-proxy.
//   (d) The text path calls runIssueFn and NOT fileLocalFn.
//   (e) Exit codes are forwarded from the injected fakes.
//
// All external I/O is faked via injectable deps (fileLocalFn, runIssueFn).
// No real stdin, git, or tmux is exercised.

import { describe, expect, test } from 'bun:test';
import { parseIssueArgs, dispatchIssue } from '../index.ts';

// ---------------------------------------------------------------------------
// parseIssueArgs: --file-local mode recognition
// ---------------------------------------------------------------------------

describe('parseIssueArgs: --file-local recognition', () => {
	test('recognizes --file-local and returns { mode: file-local, help: false }', () => {
		const result = parseIssueArgs(['--file-local']);
		expect(result).not.toBeNull();
		expect(result?.mode).toBe('file-local');
		expect(result?.help).toBe(false);
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

	test('--file-local with extra arg returns null (unexpected argument)', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			const result = parseIssueArgs(['--file-local', 'extra']);
			expect(result).toBeNull();
		} finally {
			process.stderr.write = original;
		}
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
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseIssueArgs([])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
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
			{ mode: 'file-local', help: false },
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
			{ mode: 'file-local', help: false },
			{
				fileLocalFn: async () => 0,
				runIssueFn: async () => 99,
			},
		);
		expect(code).toBe(0);
	});

	test('--file-local returns 1 when fileLocalFn fails', async () => {
		const code = await dispatchIssue(
			{ mode: 'file-local', help: false },
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
});
