// test/commands/orch-recycle-pid-fns.test.ts
//
// Direct unit tests for readWrapperPid and resolveChildViaPgrep.
//
// These functions were previously bypassed entirely by the OrchRecycleWatchOptions
// injection layer (reviewer finding US-R1-001): every test injected resolvePidFn
// at the options level, so readWrapperPid / resolveChildViaPgrep / makeResolvePidFn
// had zero direct coverage, and their parsing guards (empty file, non-finite pid,
// non-zero pgrep exit, empty/multi-line stdout, pid<=0) could regress silently.
//
// Fix: export readWrapperPid and resolveChildViaPgrep (the latter with an
// injectable PgrepSpawnFn seam) so this file can exercise each guard branch
// with real temp files (readWrapperPid) or fake spawn output (resolveChildViaPgrep).
//
// Test matrix:
//   readWrapperPid:
//     RW-1  file absent -> null
//     RW-2  empty file -> null
//     RW-3  whitespace-only -> null
//     RW-4  non-finite string ("abc") -> null
//     RW-5  pid = 0 -> null
//     RW-6  pid < 0 -> null
//     RW-7  valid pid (no whitespace) -> number
//     RW-8  valid pid with surrounding whitespace -> number (trimmed)
//
//   resolveChildViaPgrep:
//     RC-1  non-zero exit status -> null
//     RC-2  null status (signal-killed pgrep) -> null
//     RC-3  zero exit, empty stdout -> null
//     RC-4  zero exit, whitespace-only stdout -> null
//     RC-5  zero exit, single valid pid -> number
//     RC-6  zero exit, multi-line stdout -> first pid returned
//     RC-7  zero exit, non-numeric first line -> null
//     RC-8  zero exit, pid = 0 in stdout -> null

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	readWrapperPid,
	resolveChildViaPgrep,
	type PgrepSpawnFn,
} from '../../src/commands/orch-recycle-watch.ts';

// ---------------------------------------------------------------------------
// Temp-dir helpers for readWrapperPid tests
// ---------------------------------------------------------------------------

let tmpDir: string | undefined;

function ensureTmpDir(): string {
	if (!tmpDir) {
		tmpDir = mkdtempSync(join(tmpdir(), 'cam-pid-fns-test-'));
	}
	return tmpDir;
}

afterEach(() => {
	// Clean up temp dir after each test group has run; created lazily.
	if (tmpDir) {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Best-effort.
		}
		tmpDir = undefined;
	}
});

// ---------------------------------------------------------------------------
// Helper: write a temp pid file and return its path
// ---------------------------------------------------------------------------

function writePidFile(name: string, content: string): string {
	const dir = ensureTmpDir();
	const p = join(dir, name);
	writeFileSync(p, content, 'utf8');
	return p;
}

// ---------------------------------------------------------------------------
// readWrapperPid
// ---------------------------------------------------------------------------

describe('readWrapperPid', () => {
	test('RW-1: file absent -> null', () => {
		const absent = join(ensureTmpDir(), 'does-not-exist.pid');
		expect(readWrapperPid(absent)).toBeNull();
	});

	test('RW-2: empty file -> null', () => {
		const p = writePidFile('rw2.pid', '');
		expect(readWrapperPid(p)).toBeNull();
	});

	test('RW-3: whitespace-only file -> null', () => {
		const p = writePidFile('rw3.pid', '   \n  ');
		expect(readWrapperPid(p)).toBeNull();
	});

	test('RW-4: non-finite string ("abc") -> null', () => {
		const p = writePidFile('rw4.pid', 'abc');
		expect(readWrapperPid(p)).toBeNull();
	});

	test('RW-5: pid = 0 -> null', () => {
		const p = writePidFile('rw5.pid', '0');
		expect(readWrapperPid(p)).toBeNull();
	});

	test('RW-6: pid < 0 -> null', () => {
		const p = writePidFile('rw6.pid', '-42');
		expect(readWrapperPid(p)).toBeNull();
	});

	test('RW-7: valid pid (no surrounding whitespace) -> number', () => {
		const p = writePidFile('rw7.pid', '12345');
		expect(readWrapperPid(p)).toBe(12345);
	});

	test('RW-8: valid pid with surrounding whitespace/newline -> number (trimmed)', () => {
		const p = writePidFile('rw8.pid', '  67890\n');
		expect(readWrapperPid(p)).toBe(67890);
	});
});

// ---------------------------------------------------------------------------
// resolveChildViaPgrep (injected PgrepSpawnFn — no real process spawn)
// ---------------------------------------------------------------------------

describe('resolveChildViaPgrep', () => {
	test('RC-1: non-zero exit status -> null', () => {
		const fake: PgrepSpawnFn = () => ({ status: 1, stdout: '5678\n' });
		expect(resolveChildViaPgrep(1234, fake)).toBeNull();
	});

	test('RC-2: null status (signal-killed pgrep) -> null', () => {
		const fake: PgrepSpawnFn = () => ({ status: null, stdout: '5678\n' });
		expect(resolveChildViaPgrep(1234, fake)).toBeNull();
	});

	test('RC-3: zero exit, empty stdout -> null', () => {
		const fake: PgrepSpawnFn = () => ({ status: 0, stdout: '' });
		expect(resolveChildViaPgrep(1234, fake)).toBeNull();
	});

	test('RC-4: zero exit, whitespace-only stdout -> null', () => {
		const fake: PgrepSpawnFn = () => ({ status: 0, stdout: '   \n' });
		expect(resolveChildViaPgrep(1234, fake)).toBeNull();
	});

	test('RC-5: zero exit, single valid pid -> returns number', () => {
		const fake: PgrepSpawnFn = () => ({ status: 0, stdout: '5678\n' });
		expect(resolveChildViaPgrep(1234, fake)).toBe(5678);
	});

	test('RC-6: zero exit, multi-line stdout -> first pid returned', () => {
		const fake: PgrepSpawnFn = () => ({ status: 0, stdout: '5678\n9012\n' });
		expect(resolveChildViaPgrep(1234, fake)).toBe(5678);
	});

	test('RC-7: zero exit, non-numeric first line -> null', () => {
		const fake: PgrepSpawnFn = () => ({ status: 0, stdout: 'not-a-number\n' });
		expect(resolveChildViaPgrep(1234, fake)).toBeNull();
	});

	test('RC-8: zero exit, pid = 0 in stdout -> null', () => {
		const fake: PgrepSpawnFn = () => ({ status: 0, stdout: '0\n' });
		expect(resolveChildViaPgrep(1234, fake)).toBeNull();
	});

	test('RC-extra: wrapperPid is passed through to spawnFn', () => {
		let receivedPid: number | undefined;
		const fake: PgrepSpawnFn = (pid) => {
			receivedPid = pid;
			return { status: 0, stdout: '9999\n' };
		};
		resolveChildViaPgrep(42, fake);
		expect(receivedPid).toBe(42);
	});
});
