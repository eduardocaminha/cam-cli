// test/commands/suggestions-cli.test.ts
//
// Unit tests for the `cam suggestions` CLI wiring in index.ts:
// parseSuggestionsArgs, dispatchSuggestions, SUGGESTIONS_HELP registration.
//
// Mirrors the injectable-deps test pattern of test/commands/patterns-cli.test.ts.
//
// CAM-285 US-004 (cam suggestions list CLI: parser + dispatch skeleton + help).

import { test, expect, describe } from 'bun:test';
import type {
	SuggestionEntry,
	PromoteSuggestionOnMainResult,
	DismissSuggestionOnMainResult,
} from '../../src/commands/suggestions.ts';
import { dispatchSuggestions, parseSuggestionsArgs } from '../../index.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ENTRY: SuggestionEntry = {
	fingerprint: 'abc123def456',
	title: 'Consider extracting the shared helper',
	body: 'Consider extracting the shared helper into its own module.',
	sourceBranch: 'cam/issue-285',
	reviewRound: 2,
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
// parseSuggestionsArgs
// ---------------------------------------------------------------------------

describe('parseSuggestionsArgs', () => {
	test('--help returns { help: true }', () => {
		expect(parseSuggestionsArgs(['--help'])).toEqual({ help: true });
	});

	test('-h returns { help: true }', () => {
		expect(parseSuggestionsArgs(['-h'])).toEqual({ help: true });
	});

	test('no args returns { help: true } (bare `cam suggestions` shows usage, does not error)', () => {
		expect(parseSuggestionsArgs([])).toEqual({ help: true });
	});

	test('list returns { mode: "list", help: false }', () => {
		expect(parseSuggestionsArgs(['list'])).toEqual({ mode: 'list', help: false });
	});

	test('unknown subcommand returns null (triggers printFatalHint)', () => {
		const stdoutLines: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			if (typeof chunk === 'string') stdoutLines.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			expect(parseSuggestionsArgs(['unknown'])).toBeNull();
			expect(stdoutLines.join('')).toContain('cam suggestions list');
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test('unknown flag after list returns null', () => {
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			expect(parseSuggestionsArgs(['list', '--bogus'])).toBeNull();
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test('promote <fingerprint> returns { mode: "promote", help: false, fingerprint }', () => {
		expect(parseSuggestionsArgs(['promote', 'abc123def456'])).toEqual({
			mode: 'promote',
			help: false,
			fingerprint: 'abc123def456',
		});
	});

	test('dismiss <fingerprint> returns { mode: "dismiss", help: false, fingerprint }', () => {
		expect(parseSuggestionsArgs(['dismiss', 'abc123def456'])).toEqual({
			mode: 'dismiss',
			help: false,
			fingerprint: 'abc123def456',
		});
	});

	test('promote with no fingerprint returns null', () => {
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			expect(parseSuggestionsArgs(['promote'])).toBeNull();
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test('dismiss with a trailing extra arg returns null', () => {
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			expect(parseSuggestionsArgs(['dismiss', 'abc123def456', 'extra'])).toBeNull();
		} finally {
			process.stdout.write = originalWrite;
		}
	});
});

// ---------------------------------------------------------------------------
// dispatchSuggestions
// ---------------------------------------------------------------------------

describe('dispatchSuggestions', () => {
	test('help mode: prints SUGGESTIONS_HELP and returns 0 without touching readFn', () => {
		let readCalled = false;
		const parsed = parseSuggestionsArgs(['--help']);
		expect(parsed).not.toBeNull();
		if (!parsed) return;

		const stdoutLines: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			if (typeof chunk === 'string') stdoutLines.push(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			const code = dispatchSuggestions(parsed, {
				readFn: (): SuggestionEntry[] => {
					readCalled = true;
					return [];
				},
			});
			expect(code).toBe(0);
			expect(readCalled).toBe(false);
			expect(stdoutLines.join('')).toContain('cam suggestions');
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test('empty pen: prints a friendly empty-state line, not an error', () => {
		const stdoutLines: string[] = [];
		const parsed = parseSuggestionsArgs(['list']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchSuggestions(parsed, {
			readFn: (): SuggestionEntry[] => [],
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(0);
		expect(stdoutLines.join('')).toContain('No pending SUGGESTIONs in the pen.');
	});

	test('non-empty pen: renders fingerprint, title, source, and round for each entry', () => {
		const stdoutLines: string[] = [];
		const parsed = parseSuggestionsArgs(['list']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchSuggestions(parsed, {
			readFn: (): SuggestionEntry[] => [SAMPLE_ENTRY, OTHER_ENTRY],
			writeStdout: (line) => stdoutLines.push(line),
		});

		const output = stdoutLines.join('');
		expect(code).toBe(0);
		expect(output).toContain(SAMPLE_ENTRY.fingerprint);
		expect(output).toContain(SAMPLE_ENTRY.title);
		expect(output).toContain(SAMPLE_ENTRY.sourceBranch);
		expect(output).toContain('round 2');
		expect(output).toContain(OTHER_ENTRY.fingerprint);
		expect(output).toContain(OTHER_ENTRY.title);
		expect(output).toContain(OTHER_ENTRY.sourceBranch);
	});

	test('entry without reviewRound omits the round suffix', () => {
		const stdoutLines: string[] = [];
		const parsed = parseSuggestionsArgs(['list']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		dispatchSuggestions(parsed, {
			readFn: (): SuggestionEntry[] => [OTHER_ENTRY],
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(stdoutLines.join('')).not.toContain('round');
	});

	test('promote: success routes through promoteFn and prints CAM_SUGGESTIONS_PROMOTED', () => {
		const stdoutLines: string[] = [];
		const parsed = parseSuggestionsArgs(['promote', SAMPLE_ENTRY.fingerprint]);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		let receivedFingerprint: string | undefined;
		const code = dispatchSuggestions(parsed, {
			promoteFn: (fingerprint: string): PromoteSuggestionOnMainResult => {
				receivedFingerprint = fingerprint;
				return {
					ok: true,
					fingerprint,
					issueId: 'CAM-286',
					issueSha: 'abc1234',
					penSha: 'def5678',
				};
			},
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(0);
		expect(receivedFingerprint).toBe(SAMPLE_ENTRY.fingerprint);
		expect(stdoutLines.join('')).toContain('CAM_SUGGESTIONS_PROMOTED=abc123def456 issue=CAM-286');
	});

	test('promote: failure returns non-zero without printing a CAM_SUGGESTIONS_PROMOTED line', () => {
		const stdoutLines: string[] = [];
		const parsed = parseSuggestionsArgs(['promote', 'deadbeef0000']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchSuggestions(parsed, {
			promoteFn: (): PromoteSuggestionOnMainResult => ({ ok: false, reason: 'not-found' }),
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(1);
		expect(stdoutLines.join('')).not.toContain('CAM_SUGGESTIONS_PROMOTED');
	});

	test('dismiss: success routes through dismissFn and prints CAM_SUGGESTIONS_DISMISSED', () => {
		const stdoutLines: string[] = [];
		const parsed = parseSuggestionsArgs(['dismiss', SAMPLE_ENTRY.fingerprint]);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		let receivedFingerprint: string | undefined;
		const code = dispatchSuggestions(parsed, {
			dismissFn: (fingerprint: string): DismissSuggestionOnMainResult => {
				receivedFingerprint = fingerprint;
				return { ok: true, fingerprint, sha: 'ghi9012' };
			},
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(0);
		expect(receivedFingerprint).toBe(SAMPLE_ENTRY.fingerprint);
		expect(stdoutLines.join('')).toContain('CAM_SUGGESTIONS_DISMISSED=abc123def456');
	});

	test('dismiss: failure returns non-zero without printing a CAM_SUGGESTIONS_DISMISSED line', () => {
		const stdoutLines: string[] = [];
		const parsed = parseSuggestionsArgs(['dismiss', 'deadbeef0000']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchSuggestions(parsed, {
			dismissFn: (): DismissSuggestionOnMainResult => ({ ok: false, reason: 'not-found' }),
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(1);
		expect(stdoutLines.join('')).not.toContain('CAM_SUGGESTIONS_DISMISSED');
	});
});

// ---------------------------------------------------------------------------
// index.ts registration: `suggestions list` is exercised via `cam suggestions --help`
// ---------------------------------------------------------------------------

test('index.ts registers `suggestions list` in SUGGESTIONS_HELP', async () => {
	const { readFileSync } = await import('node:fs');
	const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
	expect(source).toContain("case 'suggestions':");
	expect(source).toContain('SUGGESTIONS_HELP');
});
