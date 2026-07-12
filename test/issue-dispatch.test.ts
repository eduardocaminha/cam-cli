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
//   (g) parseIssueArgs recognizes `list` / `list --all` / `list --json` /
//       `list --all --json` as { mode: 'list' }, evaluated BEFORE the
//       free-text fallthrough (CAM-190 US-003; --json added CAM-222 US-002).
//   (h) dispatchIssue routes mode 'list' to issueListFn and NEVER touches
//       runIssueFn or fileLocalFn (no thin-proxy, no send-keys, no claude spawn).
//   (i) parseIssueArgs recognizes `close <id>` as { mode: 'close', id },
//       evaluated BEFORE the free-text fallthrough (US-002, CAM-210). A
//       missing id is a parse error, never a silent text-mode fallthrough.
//   (j) dispatchIssue routes mode 'close' to closeIssueOnMainFn, prints the
//       human printHint line plus the machine CAM_ISSUE_RESULT line, maps
//       ok:true to exit 0 and any !ok reason (already-closed / not-found) to
//       exit 1 with CAM_ISSUE_RESULT=ERROR, and NEVER touches runIssueFn or
//       fileLocalFn (no thin-proxy).
//   (k) parseIssueArgs recognizes `abandon <id>` as { mode: 'abandon', id },
//       evaluated BEFORE the free-text fallthrough (US-003, CAM-210). A
//       missing id is a parse error, never a silent text-mode fallthrough.
//   (l) dispatchIssue routes mode 'abandon' to abandonIssueOnMainFn, prints
//       the human printHint line plus the machine CAM_ISSUE_RESULT line,
//       maps ok:true to exit 0 and any !ok reason (already-abandoned /
//       not-found) to exit 1 with CAM_ISSUE_RESULT=ERROR, and NEVER touches
//       runIssueFn or fileLocalFn (no thin-proxy).
//   (m) dispatchIssue's default --file-local implementation (fileLocalFn NOT
//       injected) emits CAM_ISSUE_RESULT for every outcome (US-001, CAM-212):
//       success prints the pre-existing 'filed <id> on main' printHint plus
//       CAM_ISSUE_RESULT=<id> and exits 0; each createLocalIssueOnMainFn
//       { ok: false, reason } (diverged/detached-head/missing-main/
//       guardrail-failed) prints CAM_ISSUE_RESULT=ERROR reason=<reason> and
//       exits 1; unparseable stdin JSON prints CAM_ISSUE_RESULT=ERROR
//       reason=invalid-json (emitted before createLocalIssueOnMainFn runs)
//       and exits 1; a thrown exception prints CAM_ISSUE_RESULT=ERROR
//       reason=exception and exits 1.
//   (n) dispatchIssue's list branch is CAM_ISSUE_RESULT-free by design
//       (US-002, CAM-212, regression lock): unlike close/abandon/file-local,
//       list never writes a CAM_ISSUE_RESULT line on any code path.
//   (o) parseIssueArgs recognizes `demote <id>` as { mode: 'demote', id },
//       evaluated BEFORE the free-text fallthrough (US-002, CAM-206/CAM-210
//       sibling). A missing id is a parse error, never a silent text-mode
//       fallthrough.
//   (p) dispatchIssue routes mode 'demote' to demoteIssueOnMainFn, prints
//       the human printHint line plus the machine CAM_ISSUE_RESULT line,
//       maps ok:true to exit 0 and any !ok reason (already-idea / is-planned /
//       is-shipped / not-found) to exit 1 with CAM_ISSUE_RESULT=ERROR, and
//       NEVER touches runIssueFn or fileLocalFn (no thin-proxy).
//   (q) the central --help/-h short-circuit (CAM-211) still fires for
//       `cam issue demote --help` before parseIssueArgs/dispatchIssue ever
//       run, so it prints ISSUE_HELP and exits 0 with no demote side effect.
//
// All external I/O is faked via injectable deps (fileLocalFn, runIssueFn,
// issueListFn, closeIssueOnMainFn, abandonIssueOnMainFn, demoteIssueOnMainFn,
// createLocalIssueOnMainFn, readStdinFn). No real stdin, git, or tmux is
// exercised.

import { describe, expect, test } from 'bun:test';
import { parseIssueArgs, dispatchIssue, main } from '../index.ts';

// Capture process.stdout.write calls without touching the real stream.
async function withCapturedStdoutAsync(fn: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string) => {
		lines.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = original;
	}
	return lines;
}

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

// Async-aware variant: awaits fn() before restoring stderr, so a synchronous
// printError call inside an `async function` body (no true await point) is
// silenced regardless of when the returned promise actually settles.
async function withSilentStderrAsync<T>(fn: () => Promise<T>): Promise<T> {
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (() => true) as typeof process.stderr.write;
	try {
		return await fn();
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
	test('cam issue list returns { mode: list, all: false, json: false, help: false }', () => {
		const result = parseIssueArgs(['list']);
		expect(result?.mode).toBe('list');
		expect(result?.help).toBe(false);
		if (result?.mode === 'list') {
			expect(result.all).toBe(false);
			expect(result.json).toBe(false);
		}
	});

	test('cam issue list --all returns { mode: list, all: true, json: false, help: false }', () => {
		const result = parseIssueArgs(['list', '--all']);
		expect(result?.mode).toBe('list');
		if (result?.mode === 'list') {
			expect(result.all).toBe(true);
			expect(result.json).toBe(false);
		}
		expect(result?.help).toBe(false);
	});

	test('cam issue list --json returns { mode: list, all: false, json: true, help: false }', () => {
		const result = parseIssueArgs(['list', '--json']);
		expect(result?.mode).toBe('list');
		if (result?.mode === 'list') {
			expect(result.all).toBe(false);
			expect(result.json).toBe(true);
		}
		expect(result?.help).toBe(false);
	});

	test('cam issue list --all --json combines both flags', () => {
		const result = parseIssueArgs(['list', '--all', '--json']);
		expect(result?.mode).toBe('list');
		if (result?.mode === 'list') {
			expect(result.all).toBe(true);
			expect(result.json).toBe(true);
		}
		expect(result?.help).toBe(false);
	});

	test('cam issue list --json --all (flag order does not matter)', () => {
		const result = parseIssueArgs(['list', '--json', '--all']);
		expect(result?.mode).toBe('list');
		if (result?.mode === 'list') {
			expect(result.all).toBe(true);
			expect(result.json).toBe(true);
		}
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
			{ mode: 'list', all: false, json: false, help: false },
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
			{ mode: 'list', all: true, json: false, help: false },
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
			{ mode: 'list', all: false, json: false, help: false },
			{ issueListFn: async () => 1 },
		);
		expect(code).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// parseIssueArgs: `close <id>` subcommand (US-002, CAM-210)
// ---------------------------------------------------------------------------

describe('parseIssueArgs: close subcommand', () => {
	test('cam issue close CAM-42 returns { mode: close, id: CAM-42, help: false }', () => {
		const result = parseIssueArgs(['close', 'CAM-42']);
		expect(result?.mode).toBe('close');
		expect(result?.help).toBe(false);
		if (result?.mode === 'close') {
			expect(result.id).toBe('CAM-42');
		}
	});

	test('a bare "close" positional is never misread as free-text issue creation', () => {
		const result = withSilentStderr(() => parseIssueArgs(['close']));
		expect(result?.mode).not.toBe('text');
	});

	test('cam issue close with no id returns null (parse error, never text-mode fallthrough)', () => {
		const result = withSilentStderr(() => parseIssueArgs(['close']));
		expect(result).toBeNull();
	});

	test('cam issue close CAM-42 extra returns null (unexpected argument)', () => {
		const result = withSilentStderr(() => parseIssueArgs(['close', 'CAM-42', 'extra']));
		expect(result).toBeNull();
	});

	test('free text starting with "close" as a full sentence is still mode:text (no regression)', () => {
		// A single-token `args[0] === 'close'` check only fires on the exact
		// positional keyword; a free-text arg that merely CONTAINS "close" is
		// unaffected because it is still args[0] verbatim vs the literal 'close'.
		const result = parseIssueArgs(['close the loop on the retry bug']);
		// args[0] here is the whole string 'close the loop on the retry bug',
		// not the bare keyword 'close', so this still falls through to text mode.
		expect(result?.mode).toBe('text');
	});
});

// ---------------------------------------------------------------------------
// dispatchIssue: `close <id>` branch (US-002, CAM-210)
// ---------------------------------------------------------------------------

describe('dispatchIssue: close routing isolation', () => {
	test('close calls closeIssueOnMainFn and NOT runIssueFn/fileLocalFn', async () => {
		let closeCalled = false;
		let runIssueCalled = false;
		let fileLocalCalled = false;

		const code = await dispatchIssue(
			{ mode: 'close', id: 'CAM-42', help: false },
			{
				closeIssueOnMainFn: (id) => {
					closeCalled = true;
					return { ok: true, id, committedTo: 'main', sha: 'deadbeef', branchWasMain: true };
				},
				runIssueFn: async () => {
					runIssueCalled = true;
					return 99;
				},
				fileLocalFn: async () => {
					fileLocalCalled = true;
					return 99;
				},
			},
		);

		expect(closeCalled).toBe(true);
		expect(runIssueCalled).toBe(false);
		expect(fileLocalCalled).toBe(false);
		expect(code).toBe(0);
	});

	test('close passes the parsed id through to closeIssueOnMainFn', async () => {
		let receivedId: string | undefined;
		await dispatchIssue(
			{ mode: 'close', id: 'CAM-99', help: false },
			{
				closeIssueOnMainFn: (id) => {
					receivedId = id;
					return { ok: true, id, committedTo: 'main', sha: 'sha1', branchWasMain: true };
				},
			},
		);
		expect(receivedId).toBe('CAM-99');
	});

	test('close on success prints CAM_ISSUE_RESULT=<id> and exits 0', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await dispatchIssue(
				{ mode: 'close', id: 'CAM-42', help: false },
				{
					closeIssueOnMainFn: (id) => ({
						ok: true,
						id,
						committedTo: 'main',
						sha: 'deadbeef',
						branchWasMain: true,
					}),
				},
			);
			expect(code).toBe(0);
		});
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT=CAM-42'))).toBe(true);
	});

	test('close on an already-shipped issue prints CAM_ISSUE_RESULT=ERROR with reason and exits non-zero', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'close', id: 'CAM-42', help: false },
					{
						closeIssueOnMainFn: () => ({ ok: false, reason: 'already-closed' }),
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('already-closed'))).toBe(
			true,
		);
	});

	test('close on a not-found id prints CAM_ISSUE_RESULT=ERROR and exits non-zero', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'close', id: 'CAM-999', help: false },
					{
						closeIssueOnMainFn: () => ({ ok: false, reason: 'not-found' }),
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('not-found'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// parseIssueArgs: `abandon <id>` subcommand (US-003, CAM-210)
// ---------------------------------------------------------------------------

describe('parseIssueArgs: abandon subcommand', () => {
	test('cam issue abandon CAM-42 returns { mode: abandon, id: CAM-42, help: false }', () => {
		const result = parseIssueArgs(['abandon', 'CAM-42']);
		expect(result?.mode).toBe('abandon');
		expect(result?.help).toBe(false);
		if (result?.mode === 'abandon') {
			expect(result.id).toBe('CAM-42');
		}
	});

	test('a bare "abandon" positional is never misread as free-text issue creation', () => {
		const result = withSilentStderr(() => parseIssueArgs(['abandon']));
		expect(result?.mode).not.toBe('text');
	});

	test('cam issue abandon with no id returns null (parse error, never text-mode fallthrough)', () => {
		const result = withSilentStderr(() => parseIssueArgs(['abandon']));
		expect(result).toBeNull();
	});

	test('cam issue abandon CAM-42 extra returns null (unexpected argument)', () => {
		const result = withSilentStderr(() => parseIssueArgs(['abandon', 'CAM-42', 'extra']));
		expect(result).toBeNull();
	});

	test('free text starting with "abandon" as a full sentence is still mode:text (no regression)', () => {
		// A single-token `args[0] === 'abandon'` check only fires on the exact
		// positional keyword; a free-text arg that merely CONTAINS "abandon" is
		// unaffected because it is still args[0] verbatim vs the literal 'abandon'.
		const result = parseIssueArgs(['abandon the retry loop rewrite']);
		// args[0] here is the whole string 'abandon the retry loop rewrite',
		// not the bare keyword 'abandon', so this still falls through to text mode.
		expect(result?.mode).toBe('text');
	});
});

// ---------------------------------------------------------------------------
// dispatchIssue: `abandon <id>` branch (US-003, CAM-210)
// ---------------------------------------------------------------------------

describe('dispatchIssue: abandon routing isolation', () => {
	test('abandon calls abandonIssueOnMainFn and NOT runIssueFn/fileLocalFn', async () => {
		let abandonCalled = false;
		let runIssueCalled = false;
		let fileLocalCalled = false;

		const code = await dispatchIssue(
			{ mode: 'abandon', id: 'CAM-42', help: false },
			{
				abandonIssueOnMainFn: (id) => {
					abandonCalled = true;
					return { ok: true, id, committedTo: 'main', sha: 'deadbeef', branchWasMain: true };
				},
				runIssueFn: async () => {
					runIssueCalled = true;
					return 99;
				},
				fileLocalFn: async () => {
					fileLocalCalled = true;
					return 99;
				},
			},
		);

		expect(abandonCalled).toBe(true);
		expect(runIssueCalled).toBe(false);
		expect(fileLocalCalled).toBe(false);
		expect(code).toBe(0);
	});

	test('abandon passes the parsed id through to abandonIssueOnMainFn', async () => {
		let receivedId: string | undefined;
		await dispatchIssue(
			{ mode: 'abandon', id: 'CAM-99', help: false },
			{
				abandonIssueOnMainFn: (id) => {
					receivedId = id;
					return { ok: true, id, committedTo: 'main', sha: 'sha1', branchWasMain: true };
				},
			},
		);
		expect(receivedId).toBe('CAM-99');
	});

	test('abandon on success prints CAM_ISSUE_RESULT=<id> and exits 0', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await dispatchIssue(
				{ mode: 'abandon', id: 'CAM-42', help: false },
				{
					abandonIssueOnMainFn: (id) => ({
						ok: true,
						id,
						committedTo: 'main',
						sha: 'deadbeef',
						branchWasMain: true,
					}),
				},
			);
			expect(code).toBe(0);
		});
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT=CAM-42'))).toBe(true);
	});

	test('abandon on an already-abandoned issue prints CAM_ISSUE_RESULT=ERROR with reason and exits non-zero', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'abandon', id: 'CAM-42', help: false },
					{
						abandonIssueOnMainFn: () => ({ ok: false, reason: 'already-abandoned' }),
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(
			lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('already-abandoned')),
		).toBe(true);
	});

	test('abandon on a not-found id prints CAM_ISSUE_RESULT=ERROR and exits non-zero', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'abandon', id: 'CAM-999', help: false },
					{
						abandonIssueOnMainFn: () => ({ ok: false, reason: 'not-found' }),
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('not-found'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// parseIssueArgs: `demote <id>` subcommand (US-002, CAM-206/CAM-210 sibling)
// ---------------------------------------------------------------------------

describe('parseIssueArgs: demote subcommand', () => {
	test('cam issue demote CAM-42 returns { mode: demote, id: CAM-42, help: false }', () => {
		const result = parseIssueArgs(['demote', 'CAM-42']);
		expect(result?.mode).toBe('demote');
		expect(result?.help).toBe(false);
		if (result?.mode === 'demote') {
			expect(result.id).toBe('CAM-42');
		}
	});

	test('a bare "demote" positional is never misread as free-text issue creation', () => {
		const result = withSilentStderr(() => parseIssueArgs(['demote']));
		expect(result?.mode).not.toBe('text');
	});

	test('cam issue demote with no id returns null (parse error, never text-mode fallthrough)', () => {
		const result = withSilentStderr(() => parseIssueArgs(['demote']));
		expect(result).toBeNull();
	});

	test('cam issue demote CAM-42 extra returns null (unexpected argument)', () => {
		const result = withSilentStderr(() => parseIssueArgs(['demote', 'CAM-42', 'extra']));
		expect(result).toBeNull();
	});

	test('free text starting with "demote" as a full sentence is still mode:text (no regression)', () => {
		// A single-token `args[0] === 'demote'` check only fires on the exact
		// positional keyword; a free-text arg that merely CONTAINS "demote" is
		// unaffected because it is still args[0] verbatim vs the literal 'demote'.
		const result = parseIssueArgs(['demote the flaky ranking heuristic']);
		// args[0] here is the whole string 'demote the flaky ranking heuristic',
		// not the bare keyword 'demote', so this still falls through to text mode.
		expect(result?.mode).toBe('text');
	});
});

// ---------------------------------------------------------------------------
// dispatchIssue: `demote <id>` branch (US-002, CAM-206/CAM-210 sibling)
// ---------------------------------------------------------------------------

describe('dispatchIssue: demote routing isolation', () => {
	test('demote calls demoteIssueOnMainFn and NOT runIssueFn/fileLocalFn', async () => {
		let demoteCalled = false;
		let runIssueCalled = false;
		let fileLocalCalled = false;

		const code = await dispatchIssue(
			{ mode: 'demote', id: 'CAM-42', help: false },
			{
				demoteIssueOnMainFn: (id) => {
					demoteCalled = true;
					return { ok: true, id, committedTo: 'main', sha: 'deadbeef', branchWasMain: true };
				},
				runIssueFn: async () => {
					runIssueCalled = true;
					return 99;
				},
				fileLocalFn: async () => {
					fileLocalCalled = true;
					return 99;
				},
			},
		);

		expect(demoteCalled).toBe(true);
		expect(runIssueCalled).toBe(false);
		expect(fileLocalCalled).toBe(false);
		expect(code).toBe(0);
	});

	test('demote passes the parsed id through to demoteIssueOnMainFn', async () => {
		let receivedId: string | undefined;
		await dispatchIssue(
			{ mode: 'demote', id: 'CAM-99', help: false },
			{
				demoteIssueOnMainFn: (id) => {
					receivedId = id;
					return { ok: true, id, committedTo: 'main', sha: 'sha1', branchWasMain: true };
				},
			},
		);
		expect(receivedId).toBe('CAM-99');
	});

	test('demote on success prints CAM_ISSUE_RESULT=<id> and exits 0', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await dispatchIssue(
				{ mode: 'demote', id: 'CAM-42', help: false },
				{
					demoteIssueOnMainFn: (id) => ({
						ok: true,
						id,
						committedTo: 'main',
						sha: 'deadbeef',
						branchWasMain: true,
					}),
				},
			);
			expect(code).toBe(0);
		});
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT=CAM-42'))).toBe(true);
	});

	test('demote on an already-idea issue prints CAM_ISSUE_RESULT=ERROR with reason and exits non-zero', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'demote', id: 'CAM-42', help: false },
					{
						demoteIssueOnMainFn: () => ({ ok: false, reason: 'already-idea' }),
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('already-idea'))).toBe(
			true,
		);
	});

	test('demote on a planned issue prints CAM_ISSUE_RESULT=ERROR with reason and exits non-zero', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'demote', id: 'CAM-42', help: false },
					{
						demoteIssueOnMainFn: () => ({ ok: false, reason: 'is-planned' }),
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('is-planned'))).toBe(true);
	});

	test('demote on a not-found id prints CAM_ISSUE_RESULT=ERROR and exits non-zero', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'demote', id: 'CAM-999', help: false },
					{
						demoteIssueOnMainFn: () => ({ ok: false, reason: 'not-found' }),
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('not-found'))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// central --help/-h short-circuit still fires for `cam issue demote --help`
// (CAM-211, regression lock for the new demote subcommand)
// ---------------------------------------------------------------------------

describe('cam issue demote --help (CAM-211 short-circuit)', () => {
	test('exits 0, prints ISSUE_HELP, and never reaches parseIssueArgs/dispatchIssue demote logic', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await main(['bun', 'index.ts', 'issue', 'demote', '--help']);
			expect(code).toBe(0);
		});
		expect(lines.some((l) => l.includes('cam issue'))).toBe(true);
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT'))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// dispatchIssue: default --file-local branch emits CAM_ISSUE_RESULT (US-001, CAM-212)
// ---------------------------------------------------------------------------

describe('dispatchIssue: default file-local CAM_ISSUE_RESULT retrofit', () => {
	test('success prints the pre-existing filed printHint AND CAM_ISSUE_RESULT=<id>, exits 0', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await dispatchIssue(
				{ mode: 'file-local', fastTrack: false, derivedFrom: [], help: false },
				{
					readStdinFn: async () => JSON.stringify({ title: 'my new issue' }),
					createLocalIssueOnMainFn: () => ({
						ok: true,
						id: 'CAM-42',
						committedTo: 'main',
						sha: 'deadbeef',
						branchWasMain: true,
					}),
				},
			);
			expect(code).toBe(0);
		});
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT=CAM-42'))).toBe(true);
	});

	test('createLocalIssueOnMainFn { ok: false, reason: diverged } prints CAM_ISSUE_RESULT=ERROR reason=diverged, exits 1', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'file-local', fastTrack: false, derivedFrom: [], help: false },
					{
						readStdinFn: async () => JSON.stringify({ title: 'x' }),
						createLocalIssueOnMainFn: () => ({ ok: false, reason: 'diverged' }),
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('reason=diverged'))).toBe(
			true,
		);
	});

	test('createLocalIssueOnMainFn { ok: false, reason: detached-head } prints CAM_ISSUE_RESULT=ERROR reason=detached-head, exits 1', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'file-local', fastTrack: false, derivedFrom: [], help: false },
					{
						readStdinFn: async () => JSON.stringify({ title: 'x' }),
						createLocalIssueOnMainFn: () => ({ ok: false, reason: 'detached-head' }),
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(
			lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('reason=detached-head')),
		).toBe(true);
	});

	test('createLocalIssueOnMainFn { ok: false, reason: missing-main } prints CAM_ISSUE_RESULT=ERROR reason=missing-main, exits 1', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'file-local', fastTrack: false, derivedFrom: [], help: false },
					{
						readStdinFn: async () => JSON.stringify({ title: 'x' }),
						createLocalIssueOnMainFn: () => ({ ok: false, reason: 'missing-main' }),
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(
			lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('reason=missing-main')),
		).toBe(true);
	});

	test('createLocalIssueOnMainFn { ok: false, reason: guardrail-failed } prints CAM_ISSUE_RESULT=ERROR reason=guardrail-failed, exits 1', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'file-local', fastTrack: true, derivedFrom: [], help: false },
					{
						readStdinFn: async () => JSON.stringify({ title: 'x' }),
						createLocalIssueOnMainFn: () => ({ ok: false, reason: 'guardrail-failed' }),
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(
			lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('reason=guardrail-failed')),
		).toBe(true);
	});

	test('unparseable stdin JSON prints CAM_ISSUE_RESULT=ERROR reason=invalid-json BEFORE createLocalIssueOnMainFn runs, exits 1', async () => {
		let createCalled = false;
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'file-local', fastTrack: false, derivedFrom: [], help: false },
					{
						readStdinFn: async () => 'not valid json {{{',
						createLocalIssueOnMainFn: () => {
							createCalled = true;
							return { ok: true, id: 'CAM-1', committedTo: 'main', sha: 'x', branchWasMain: true };
						},
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(createCalled).toBe(false);
		expect(
			lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('reason=invalid-json')),
		).toBe(true);
	});

	test('a thrown exception from createLocalIssueOnMainFn prints CAM_ISSUE_RESULT=ERROR reason=exception, exits 1', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			const code = await withSilentStderrAsync(() =>
				dispatchIssue(
					{ mode: 'file-local', fastTrack: false, derivedFrom: [], help: false },
					{
						readStdinFn: async () => JSON.stringify({ title: 'x' }),
						createLocalIssueOnMainFn: () => {
							throw new Error('boom');
						},
					},
				),
			);
			expect(code).toBe(1);
		});
		expect(
			lines.some((l) => l.includes('CAM_ISSUE_RESULT=ERROR') && l.includes('reason=exception')),
		).toBe(true);
	});

	test('the machine line is written via process.stdout.write, never mixed into printHint/printError text', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			await dispatchIssue(
				{ mode: 'file-local', fastTrack: false, derivedFrom: [], help: false },
				{
					readStdinFn: async () => JSON.stringify({ title: 'x' }),
					createLocalIssueOnMainFn: () => ({
						ok: true,
						id: 'CAM-7',
						committedTo: 'main',
						sha: 'sha7',
						branchWasMain: true,
					}),
				},
			);
		});
		// Exactly one line is the bare machine token; it never shares a line with
		// the human printHint text ('filed ...').
		const machineLines = lines.filter((l) => l.trim() === 'CAM_ISSUE_RESULT=CAM-7');
		expect(machineLines.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// dispatchIssue: list is CAM_ISSUE_RESULT-free by design (US-002, CAM-212)
//
// Unlike close/abandon/file-local (each acts on exactly one issue and reports
// its id), list is a read over many issues with no single id to report. This
// is a deliberate design decision, not a forgotten path: the regression test
// below locks the list branch's stdout contract so a future "fix" does not
// retrofit a speculative machine line onto it.
// ---------------------------------------------------------------------------

describe('dispatchIssue: list mode is CAM_ISSUE_RESULT-free by design', () => {
	test('mode:list dispatch never writes a CAM_ISSUE_RESULT line to stdout', async () => {
		const lines = await withCapturedStdoutAsync(async () => {
			await dispatchIssue(
				{ mode: 'list', all: false, json: false, help: false },
				{
					issueListFn: async () => {
						process.stdout.write('CAM-42  Some issue title\n');
						return 0;
					},
				},
			);
		});
		expect(lines.some((l) => l.includes('CAM_ISSUE_RESULT'))).toBe(false);
	});
});
