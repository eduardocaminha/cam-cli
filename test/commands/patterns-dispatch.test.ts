// test/commands/patterns-dispatch.test.ts
//
// Unit tests for the `cam patterns` CLI dispatch wiring in index.ts, covering
// the US-004 addition of the `prune` subcommand alongside the pre-existing
// `archive` one: parsePatternsArgs and dispatchPatterns both route on
// `mode`, and `cam patterns archive` keeps working unchanged.
//
// Mirrors the injectable-deps test pattern of test/commands/patterns-cli.test.ts
// (dispatchPatterns section): all external I/O (archiveFn, pruneFn,
// writeStdout) is faked, no real git or stdout is exercised.
//
// US-004, CAM-64 "mulch model" port (`cam patterns prune`).

import { describe, expect, test } from 'bun:test';
import type { ArchivePatternsOnMainResult } from '../../src/commands/patterns-archive.ts';
import type { PrunePatternRecordsOnMainResult } from '../../src/commands/patterns-prune.ts';
import { dispatchPatterns, parsePatternsArgs } from '../../index.ts';

// ---------------------------------------------------------------------------
// AC1: parsePatternsArgs accepts `prune` as a new subcommand; `archive` still works
// ---------------------------------------------------------------------------

describe('parsePatternsArgs — AC1: archive|prune namespace', () => {
	test('archive returns { mode: "archive", help: false } (unchanged)', () => {
		expect(parsePatternsArgs(['archive'])).toEqual({ mode: 'archive', help: false });
	});

	test('prune returns { mode: "prune", help: false }', () => {
		expect(parsePatternsArgs(['prune'])).toEqual({ mode: 'prune', help: false });
	});

	test('--help returns { help: true }', () => {
		expect(parsePatternsArgs(['--help'])).toEqual({ help: true });
	});

	test('no args returns { help: true } (bare `cam patterns` shows usage)', () => {
		expect(parsePatternsArgs([])).toEqual({ help: true });
	});

	test('unknown subcommand returns null and hints both archive and prune', () => {
		const stdoutLines: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			if (typeof chunk === 'string') stdoutLines.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			expect(parsePatternsArgs(['bogus'])).toBeNull();
			expect(stdoutLines.join('')).toContain('cam patterns archive|prune');
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test('`cam prune` is NOT this namespace -- prune only resolves as a subcommand of `patterns`', () => {
		// parsePatternsArgs only ever sees the tail after `cam patterns`; a bare
		// top-level `cam prune` is routed by a completely different dispatcher
		// (.claude/commands/cam-prune.md, branch cleanup) that never calls this
		// function. This test documents the boundary: the string 'prune' is only
		// meaningful here as args[0] under the `patterns` namespace.
		expect(parsePatternsArgs(['prune'])).toEqual({ mode: 'prune', help: false });
	});
});

// ---------------------------------------------------------------------------
// AC5: dispatchPatterns prune routing, sentinel emission, on-main writer only
// ---------------------------------------------------------------------------

describe('dispatchPatterns — AC5: prune routing + deterministic sentinel', () => {
	test('help mode: prints PATTERNS_HELP, touches neither archiveFn nor pruneFn', () => {
		let archiveCalled = false;
		let pruneCalled = false;
		const parsed = parsePatternsArgs(['--help']);
		expect(parsed).not.toBeNull();
		if (!parsed) return;

		const code = dispatchPatterns(parsed, {
			archiveFn: (): ArchivePatternsOnMainResult => {
				archiveCalled = true;
				return { ok: true, archived: 0, sha: '' };
			},
			pruneFn: (): PrunePatternRecordsOnMainResult => {
				pruneCalled = true;
				return { ok: true, pruned: 0, demoted: 0, archived: 0, sha: '' };
			},
		});

		expect(code).toBe(0);
		expect(archiveCalled).toBe(false);
		expect(pruneCalled).toBe(false);
	});

	test('prune mode calls ONLY pruneFn, never archiveFn', () => {
		let archiveCalled = false;
		const parsed = parsePatternsArgs(['prune']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchPatterns(parsed, {
			archiveFn: (): ArchivePatternsOnMainResult => {
				archiveCalled = true;
				return { ok: true, archived: 0, sha: '' };
			},
			pruneFn: (): PrunePatternRecordsOnMainResult => ({ ok: true, pruned: 0, demoted: 0, archived: 0, sha: '' }),
			writeStdout: () => {},
		});

		expect(code).toBe(0);
		expect(archiveCalled).toBe(false);
	});

	test('successful prune with mutations: prints CAM_PATTERNS_PRUNED=<n> sha=<sha> and returns 0', () => {
		const stdoutLines: string[] = [];
		const parsed = parsePatternsArgs(['prune']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchPatterns(parsed, {
			pruneFn: (): PrunePatternRecordsOnMainResult => ({
				ok: true,
				pruned: 2,
				demoted: 1,
				archived: 1,
				sha: 'cafe123',
			}),
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(0);
		expect(stdoutLines).toHaveLength(1);
		expect(stdoutLines[0]).toBe('CAM_PATTERNS_PRUNED=2 sha=cafe123\n');
	});

	test('prune no-op (nothing to prune): prints CAM_PATTERNS_PRUNED=noop and returns 0', () => {
		const stdoutLines: string[] = [];
		const parsed = parsePatternsArgs(['prune']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchPatterns(parsed, {
			pruneFn: (): PrunePatternRecordsOnMainResult => ({ ok: true, pruned: 0, demoted: 0, archived: 0, sha: '' }),
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(0);
		expect(stdoutLines).toHaveLength(1);
		expect(stdoutLines[0]).toBe('CAM_PATTERNS_PRUNED=noop\n');
	});

	test('pruneFn returns ok:false: returns 1 and emits no sentinel', () => {
		const stdoutLines: string[] = [];
		const parsed = parsePatternsArgs(['prune']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchPatterns(parsed, {
			pruneFn: (): PrunePatternRecordsOnMainResult => ({ ok: false, reason: 'diverged' }),
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(1);
		expect(stdoutLines).toHaveLength(0);
	});

	test('`cam patterns archive` still works unchanged after adding prune', () => {
		const stdoutLines: string[] = [];
		const parsed = parsePatternsArgs(['archive']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchPatterns(parsed, {
			archiveFn: (): ArchivePatternsOnMainResult => ({ ok: true, archived: 4, sha: 'beef456' }),
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(0);
		expect(stdoutLines).toHaveLength(1);
		expect(stdoutLines[0]).toBe('CAM_PATTERNS_ARCHIVED=4 sha=beef456\n');
	});

	test('archive no-op still prints CAM_PATTERNS_ARCHIVE=noop, never the prune sentinel', () => {
		const stdoutLines: string[] = [];
		const parsed = parsePatternsArgs(['archive']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = dispatchPatterns(parsed, {
			archiveFn: (): ArchivePatternsOnMainResult => ({ ok: true, archived: 0, sha: '' }),
			writeStdout: (line) => stdoutLines.push(line),
		});

		expect(code).toBe(0);
		expect(stdoutLines[0]).toBe('CAM_PATTERNS_ARCHIVE=noop\n');
	});
});
