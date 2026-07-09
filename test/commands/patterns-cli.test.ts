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
import type { ArchiveJournalOnMainResult } from '../../src/commands/journal-archive.ts';
import type { JournalCycleEntry } from '../../src/commands/journal.ts';
import { dispatchPatterns, parsePatternsArgs, dispatchJournal, parseJournalArgs } from '../../index.ts';

// ---------------------------------------------------------------------------
// Fixtures (mirrors test/commands/journal-append.test.ts SAMPLE_ENTRY)
// ---------------------------------------------------------------------------

const SAMPLE_ENTRY: JournalCycleEntry = {
	cycleId: 'cam/CAM-226-patterns-cycle-close',
	title: 'patterns archive on cycle-close',
	started: '2026-07-09',
	closed: '2026-07-09',
	branch: 'cam/issue-226',
	issue: 'CAM-226',
	outcome: 'shipped',
	summary: 'Auto-invoke patterns archive best-effort at cycle close.',
};

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
// dispatchJournal --cycle-close: auto-invoked patterns archive (US-003, CAM-226)
// ---------------------------------------------------------------------------

describe('dispatchJournal --cycle-close auto-invokes patternsArchiveFn (US-003)', () => {
	test('call-order oracle: patternsArchiveFn runs after the journal archiveFn check and before armMarker + CAM_ORCH_HANDOFF_DUE', async () => {
		const order: string[] = [];
		const parsed = parseJournalArgs(['append', '--cycle-close']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = await dispatchJournal(parsed, {
			readStdin: async () => JSON.stringify(SAMPLE_ENTRY),
			appendFn: () => ({ ok: true, cycleId: SAMPLE_ENTRY.cycleId, sha: 'sha1234' }),
			writeStdout: (line) => {
				if (line.startsWith('CAM_JOURNAL_APPENDED')) order.push('appended');
				if (line.startsWith('CAM_ORCH_HANDOFF_DUE')) order.push('handoff-due');
			},
			recordCycleTokensFn: () => { order.push('record-tokens'); },
			handoffExistsFn: () => true,
			watcherAliveFn: () => true,
			archiveFn: (): ArchiveJournalOnMainResult => {
				order.push('journal-archive-check');
				return { ok: true, archived: 0, entries: 0, sha: '' };
			},
			patternsArchiveFn: (): ArchivePatternsOnMainResult => {
				order.push('patterns-archive-check');
				return { ok: true, archived: 0, sha: '' };
			},
			armRecycleMarkerFn: () => { order.push('arm-marker'); },
		});

		expect(code).toBe(0);
		expect(order).toEqual([
			'appended',
			'record-tokens',
			'journal-archive-check',
			'patterns-archive-check',
			'arm-marker',
			'handoff-due',
		]);
	});

	test('patternsArchiveFn returns ok:false: logs a warning, exit code unchanged, marker still armed, handoff still emitted', async () => {
		const stdoutLines: string[] = [];
		let markerArmed = false;
		let sawWarning = false;
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			if (typeof chunk === 'string' && /patterns archive check failed/.test(chunk)) sawWarning = true;
			return true;
		}) as typeof process.stdout.write;

		try {
			const parsed = parseJournalArgs(['append', '--cycle-close']);
			expect(parsed).not.toBeNull();
			if (!parsed || parsed.help) return;

			const code = await dispatchJournal(parsed, {
				readStdin: async () => JSON.stringify(SAMPLE_ENTRY),
				appendFn: () => ({ ok: true, cycleId: SAMPLE_ENTRY.cycleId, sha: 'sha1234' }),
				writeStdout: (line) => stdoutLines.push(line),
				recordCycleTokensFn: () => {},
				handoffExistsFn: () => true,
				watcherAliveFn: () => true,
				archiveFn: (): ArchiveJournalOnMainResult => ({ ok: true, archived: 0, entries: 0, sha: '' }),
				patternsArchiveFn: (): ArchivePatternsOnMainResult => ({ ok: false, reason: 'diverged' }),
				armRecycleMarkerFn: () => { markerArmed = true; },
			});

			expect(code).toBe(0);
			expect(markerArmed).toBe(true);
			expect(stdoutLines).toHaveLength(2);
			expect(stdoutLines[1]).toBe('CAM_ORCH_HANDOFF_DUE=true\n');
			expect(sawWarning).toBe(true);
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test('patternsArchiveFn throws: logs a warning, exit code unchanged, marker still armed, handoff still emitted', async () => {
		const stdoutLines: string[] = [];
		let markerArmed = false;
		let sawWarning = false;
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			if (typeof chunk === 'string' && /patterns archive check threw/.test(chunk)) sawWarning = true;
			return true;
		}) as typeof process.stdout.write;

		try {
			const parsed = parseJournalArgs(['append', '--cycle-close']);
			expect(parsed).not.toBeNull();
			if (!parsed || parsed.help) return;

			const code = await dispatchJournal(parsed, {
				readStdin: async () => JSON.stringify(SAMPLE_ENTRY),
				appendFn: () => ({ ok: true, cycleId: SAMPLE_ENTRY.cycleId, sha: 'sha1234' }),
				writeStdout: (line) => stdoutLines.push(line),
				recordCycleTokensFn: () => {},
				handoffExistsFn: () => true,
				watcherAliveFn: () => true,
				archiveFn: (): ArchiveJournalOnMainResult => ({ ok: true, archived: 0, entries: 0, sha: '' }),
				patternsArchiveFn: (): ArchivePatternsOnMainResult => { throw new Error('boom'); },
				armRecycleMarkerFn: () => { markerArmed = true; },
			});

			expect(code).toBe(0);
			expect(markerArmed).toBe(true);
			expect(stdoutLines).toHaveLength(2);
			expect(stdoutLines[1]).toBe('CAM_ORCH_HANDOFF_DUE=true\n');
			expect(sawWarning).toBe(true);
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	test('plain append (no --cycle-close) never calls patternsArchiveFn', async () => {
		let patternsArchiveCalled = false;
		const parsed = parseJournalArgs(['append']);
		expect(parsed).not.toBeNull();
		if (!parsed || parsed.help) return;

		const code = await dispatchJournal(parsed, {
			readStdin: async () => JSON.stringify(SAMPLE_ENTRY),
			appendFn: () => ({ ok: true, cycleId: SAMPLE_ENTRY.cycleId, sha: 'abc' }),
			writeStdout: () => {},
			recordCycleTokensFn: () => {},
			patternsArchiveFn: (): ArchivePatternsOnMainResult => {
				patternsArchiveCalled = true;
				return { ok: true, archived: 0, sha: '' };
			},
		});

		expect(code).toBe(0);
		expect(patternsArchiveCalled).toBe(false);
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
