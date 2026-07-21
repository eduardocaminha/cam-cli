// test/commands/pause.test.ts
//
// Unit tests for `cam pause` — the operator graceful brake, backed by a
// dedicated pause marker (.claude/.cam-pause) distinct from the loop-state
// `active`/`phase` field.
//
// Covers: the pause-marker module helpers (injected fs seams, never real
// fs), `parsePauseArgs`, `runPause` (injectable seams, no real fs), that
// `cam pause` does NOT modify `.claude/cam-loop.local.md` (real tmpdir), and
// that `cam resume` clears the pause marker as part of its flow (real
// tmpdir).

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import {
	PAUSE_MARKER,
	setPause,
	clearPause,
	isPauseSet,
} from '../../src/supervisor/pause-marker.ts';
import { parsePauseArgs, runPause } from '../../src/commands/pause.ts';
import { runResume, type SpawnSyncFn } from '../../src/commands/resume.ts';

// ---------------------------------------------------------------------------
// PAUSE_MARKER constant
// ---------------------------------------------------------------------------

describe('PAUSE_MARKER', () => {
	test('value is .cam-pause', () => {
		expect(PAUSE_MARKER).toBe('.cam-pause');
	});
});

// ---------------------------------------------------------------------------
// pause-marker module helpers (injectable seams, no real fs)
// ---------------------------------------------------------------------------

describe('setPause', () => {
	test('calls injected writeFn with correct path', () => {
		const written: Array<{ path: string; data: string }> = [];
		setPause('/fake/.claude', (path, data) => written.push({ path, data }));
		expect(written).toHaveLength(1);
		expect(written[0]?.path).toBe(join('/fake/.claude', PAUSE_MARKER));
		expect(written[0]?.data).toBe('');
	});

	test('is idempotent: calling twice calls writeFn twice (file presence is OS concern)', () => {
		const called: number[] = [];
		const writeFn = () => called.push(1);
		setPause('/fake/.claude', writeFn);
		setPause('/fake/.claude', writeFn);
		expect(called).toHaveLength(2);
	});

	test('swallows write errors (never throws)', () => {
		expect(() =>
			setPause('/fake/.claude', () => {
				throw new Error('disk full');
			}),
		).not.toThrow();
	});
});

describe('clearPause', () => {
	test('calls injected removeFn with correct path', () => {
		const removed: string[] = [];
		clearPause('/fake/.claude', (path) => removed.push(path));
		expect(removed).toHaveLength(1);
		expect(removed[0]).toBe(join('/fake/.claude', PAUSE_MARKER));
	});

	test('is idempotent: missing file (ENOENT) does not throw', () => {
		expect(() =>
			clearPause('/fake/.claude', () => {
				const err: NodeJS.ErrnoException = new Error('not found');
				err.code = 'ENOENT';
				throw err;
			}),
		).not.toThrow();
	});
});

describe('isPauseSet', () => {
	test('returns true when existsFn reports present', () => {
		expect(isPauseSet('/fake/.claude', () => true)).toBe(true);
	});

	test('returns false when existsFn reports absent', () => {
		expect(isPauseSet('/fake/.claude', () => false)).toBe(false);
	});

	test('calls existsFn with correct path', () => {
		const checked: string[] = [];
		isPauseSet('/fake/.claude', (p) => {
			checked.push(p);
			return false;
		});
		expect(checked[0]).toBe(join('/fake/.claude', PAUSE_MARKER));
	});

	test('returns false when existsFn throws (never throws)', () => {
		expect(
			isPauseSet('/fake/.claude', () => {
				throw new Error('unexpected');
			}),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// parsePauseArgs
// ---------------------------------------------------------------------------

describe('parsePauseArgs', () => {
	test('empty args -> not help', () => {
		expect(parsePauseArgs([])).toEqual({ help: false });
	});

	test('--help -> help mode', () => {
		expect(parsePauseArgs(['--help'])).toEqual({ help: true });
	});

	test('-h -> help mode', () => {
		expect(parsePauseArgs(['-h'])).toEqual({ help: true });
	});

	test('unknown arg -> null (caller should print error)', () => {
		expect(parsePauseArgs(['--unknown'])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// runPause — injectable seams, no real fs
// ---------------------------------------------------------------------------

describe('runPause', () => {
	test('calls writeFn and returns 0', () => {
		const written: string[] = [];
		const exitCode = runPause({
			cwd: '/fake/project',
			writeFn: (path) => written.push(path),
		});
		expect(exitCode).toBe(0);
		expect(written).toHaveLength(1);
		expect(written[0]).toContain(PAUSE_MARKER);
	});
});

// ---------------------------------------------------------------------------
// AC4: `cam pause` does NOT modify .claude/cam-loop.local.md (real tmpdir)
// ---------------------------------------------------------------------------

describe('runPause — does not touch loop state file', () => {
	test('cam-loop.local.md is byte-unchanged after cam pause runs', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-pause-state-untouched-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			const statePath = join(dir, '.claude', 'cam-loop.local.md');
			const stateContents = '---\nactive: true\npid: 123\n---\n\n/cam-next\n';
			writeFileSync(statePath, stateContents);

			const exitCode = runPause({ cwd: dir });

			expect(exitCode).toBe(0);
			expect(readFileSync(statePath, 'utf8')).toBe(stateContents);
			expect(existsSync(join(dir, '.claude', PAUSE_MARKER))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// AC5: `cam resume` clears the pause marker as part of its flow (real tmpdir)
// ---------------------------------------------------------------------------

const fakeSpawn: SpawnSyncFn = () =>
	({
		pid: 0,
		output: [],
		stdout: '',
		stderr: '',
		status: 1,
		signal: null,
	}) as SpawnSyncReturns<string>;

describe('runResume — clears the pause marker (US-001, CAM-360)', () => {
	test('idle mode (no state file): pause marker present before, absent after', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-clears-pause-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			setPause(join(dir, '.claude'));
			expect(isPauseSet(join(dir, '.claude'))).toBe(true);

			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (() => true) as typeof process.stdout.write;
			try {
				const code = await runResume({
					cwd: dir,
					spawnFn: fakeSpawn,
					retryMonitorFn: () => false,
				});
				expect(code).toBe(0);
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(isPauseSet(join(dir, '.claude'))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('--dry-run does NOT clear the pause marker', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resume-dryrun-keeps-pause-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			setPause(join(dir, '.claude'));

			const originalWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (() => true) as typeof process.stdout.write;
			try {
				const code = await runResume({
					cwd: dir,
					spawnFn: fakeSpawn,
					retryMonitorFn: () => false,
					dryRun: true,
				});
				expect(code).toBe(0);
			} finally {
				process.stdout.write = originalWrite;
			}

			expect(isPauseSet(join(dir, '.claude'))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
