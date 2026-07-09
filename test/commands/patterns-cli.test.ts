// test/commands/patterns-cli.test.ts
//
// Unit tests for the `cam patterns` CLI wiring in index.ts:
// parsePatternsArgs, dispatchPatterns, PATTERNS_HELP registration.
//
// CAM-231 US-002 (cam patterns archive CLI wiring + help + sentinel).
//
// Mirrors the injectable-deps test pattern of test/commands/journal-append.ts
// (dispatchJournal section): all external I/O (archiveFn, writeStdout) is
// faked, no real git or stdout is exercised.

import { test, expect, describe } from 'bun:test';
import type { ArchivePatternsOnMainResult } from '../../src/commands/patterns-archive.ts';
import { dispatchPatterns, parsePatternsArgs } from '../../index.ts';

// ---------------------------------------------------------------------------
// parsePatternsArgs
// ---------------------------------------------------------------------------

describe('parsePatternsArgs', () => {
	test('--help returns { help: true }', () => {
		expect(parsePatternsArgs(['--help'])).toEqual({ help: true });
	});

	test('-h returns { help: true }', () => {
		expect(parsePatternsArgs(['-h'])).toEqual({ help: true });
	});

	test('no args returns { help: true } (bare `cam patterns` shows usage, does not error)', () => {
		expect(parsePatternsArgs([])).toEqual({ help: true });
	});

	test('archive returns { mode: "archive", help: false }', () => {
		expect(parsePatternsArgs(['archive'])).toEqual({ mode: 'archive', help: false });
	});

	test('archive takes no --threshold flag: extra args after archive are ignored, still mode:archive', () => {
		expect(parsePatternsArgs(['archive', '--threshold', '10'])).toEqual({
			mode: 'archive',
			help: false,
		});
	});

	test('unknown subcommand returns null (triggers printFatalHint)', () => {
		const stdoutLines: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			if (typeof chunk === 'string') stdoutLines.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			expect(parsePatternsArgs(['unknown'])).toBeNull();
			expect(stdoutLines.join('')).toContain('cam patterns archive');
		} finally {
			process.stdout.write = originalWrite;
		}
	});
});

// ---------------------------------------------------------------------------
// dispatchPatterns
// ---------------------------------------------------------------------------

describe('dispatchPatterns', () => {
	test('help mode: prints PATTERNS_HELP and returns 0 without touching archiveFn', () => {
		let archiveCalled = false;
		const parsed = parsePatternsArgs(['--help']);
		expect(parsed).not.toBeNull();
		if (!parsed) return;

		const code = dispatchPatterns(parsed, {
			archiveFn: (): ArchivePatternsOnMainResult => {
				archiveCalled = true;
				return { ok: true, archived: 0, sha: '' };
			},
		});

		expect(code).toBe(0);
		expect(archiveCalled).toBe(false);
	});

	test('successful archive with marked bullets: prints CAM_PATTERNS_ARCHIVED=<n> sha=<sha> and returns 0', () => {
		const stdoutLines: string[] = [];
		const parsed = parsePatternsArgs(['archive']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchPatterns(parsed, {
			archiveFn: (): ArchivePatternsOnMainResult => ({ ok: true, archived: 3, sha: 'abc1234' }),
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(0);
		expect(stdoutLines).toHaveLength(1);
		expect(stdoutLines[0]).toBe('CAM_PATTERNS_ARCHIVED=3 sha=abc1234\n');
	});

	test('no-op (no marked bullets): prints CAM_PATTERNS_ARCHIVE=noop and returns 0', () => {
		const stdoutLines: string[] = [];
		const parsed = parsePatternsArgs(['archive']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchPatterns(parsed, {
			archiveFn: (): ArchivePatternsOnMainResult => ({ ok: true, archived: 0, sha: '' }),
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(0);
		expect(stdoutLines).toHaveLength(1);
		expect(stdoutLines[0]).toBe('CAM_PATTERNS_ARCHIVE=noop\n');
	});

	test('archiveFn returns ok:false: returns 1 and emits no sentinel', () => {
		const stdoutLines: string[] = [];
		const parsed = parsePatternsArgs(['archive']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchPatterns(parsed, {
			archiveFn: (): ArchivePatternsOnMainResult => ({ ok: false, reason: 'diverged' }),
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(1);
		expect(stdoutLines).toHaveLength(0);
	});

	test('archiveFn returns ok:false reason patterns-missing: returns 1', () => {
		const parsed = parsePatternsArgs(['archive']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchPatterns(parsed, {
			archiveFn: (): ArchivePatternsOnMainResult => ({ ok: false, reason: 'patterns-missing' }),
			writeStdout: () => {},
		});

		expect(code).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// index.ts registration: `patterns archive` is listed in top-level help
// ---------------------------------------------------------------------------

test('index.ts registers `patterns archive` in the top-level help entries', async () => {
	const { readFileSync } = await import('node:fs');
	const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
	expect(source).toContain('patterns archive');
});
