// test/commands/orch-recycle-pid-fns.test.ts
//
// Direct unit tests for readWrapperPid and resolveChildViaPs.
//
// These functions are exported with injectable seams so every parsing guard
// branch can be exercised without touching real fs/processes.
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
//   resolveChildViaPs (injected PsSpawnFn -- no real process spawn):
//     PS-1  non-zero exit status -> null
//     PS-2  null status (signal-killed ps) -> null
//     PS-3  zero exit, empty stdout -> null
//     PS-4  zero exit, no line with matching ppid -> null
//     PS-5  zero exit, one match, space-padded columns -> returns pid
//     PS-6  zero exit, multiple matching lines -> highest pid selected + ambiguity event
//     PS-7  zero exit, non-numeric ppid column -> line skipped (no match -> null)
//     PS-8  zero exit, matching ppid but non-numeric pid column -> null
//     PS-extra  spawnFn is invoked when injected

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	readWrapperPid,
	resolveChildViaPs,
	type PsSpawnFn,
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
// resolveChildViaPs (injected PsSpawnFn -- no real process spawn)
//
// The ps output format is `ps -ax -o pid=,ppid=`: space-padded two-column
// lines "  PID  PPID" with no header row (the `=` suppresses the header).
// ---------------------------------------------------------------------------

describe('resolveChildViaPs', () => {
	test('PS-1: non-zero exit status -> null', () => {
		const fake: PsSpawnFn = () => ({ status: 1, stdout: '   5678   1234\n' });
		expect(resolveChildViaPs(1234, fake)).toBeNull();
	});

	test('PS-2: null status (signal-killed ps) -> null', () => {
		const fake: PsSpawnFn = () => ({ status: null, stdout: '   5678   1234\n' });
		expect(resolveChildViaPs(1234, fake)).toBeNull();
	});

	test('PS-3: zero exit, empty stdout -> null', () => {
		const fake: PsSpawnFn = () => ({ status: 0, stdout: '' });
		expect(resolveChildViaPs(1234, fake)).toBeNull();
	});

	test('PS-4: zero exit, no line with matching ppid -> null', () => {
		// Line has ppid=9999, not 1234.
		const fake: PsSpawnFn = () => ({ status: 0, stdout: '   5678   9999\n' });
		expect(resolveChildViaPs(1234, fake)).toBeNull();
	});

	test('PS-5: zero exit, one match, space-padded columns -> returns pid', () => {
		// Two lines; only the second matches ppid==1234.
		const fake: PsSpawnFn = () => ({
			status: 0,
			stdout: '   9999   9000\n   5678   1234\n',
		});
		expect(resolveChildViaPs(1234, fake)).toBe(5678);
	});

	test('PS-6: zero exit, multiple matching lines -> highest pid selected + ambiguity event emitted', () => {
		// Both lines match ppid==1234; highest pid is 9012.
		const fake: PsSpawnFn = () => ({
			status: 0,
			stdout: '   5678   1234\n   9012   1234\n',
		});
		const events: string[] = [];
		const result = resolveChildViaPs(1234, fake, (e) => events.push(e));
		expect(result).toBe(9012);
		expect(events.length).toBe(1);
		const parsed = JSON.parse(events[0] ?? '{}') as {
			event: string;
			selectedPid: number;
			childPids: number[];
		};
		expect(parsed.event).toBe('ambiguous-children');
		expect(parsed.selectedPid).toBe(9012);
		expect(parsed.childPids).toContain(5678);
		expect(parsed.childPids).toContain(9012);
	});

	test('PS-7: zero exit, non-numeric ppid column -> line skipped (no match -> null)', () => {
		// ppid column is "abc" -- parseInt returns NaN, line is skipped.
		const fake: PsSpawnFn = () => ({ status: 0, stdout: '   5678   abc\n' });
		expect(resolveChildViaPs(1234, fake)).toBeNull();
	});

	test('PS-8: zero exit, matching ppid but non-numeric pid column -> null', () => {
		// pid column is "abc" -- parseInt returns NaN, line produces no match.
		const fake: PsSpawnFn = () => ({ status: 0, stdout: '   abc   1234\n' });
		expect(resolveChildViaPs(1234, fake)).toBeNull();
	});

	test('PS-extra: spawnFn is invoked when injected', () => {
		let called = false;
		const fake: PsSpawnFn = () => {
			called = true;
			return { status: 0, stdout: '' };
		};
		resolveChildViaPs(1234, fake);
		expect(called).toBe(true);
	});
});
