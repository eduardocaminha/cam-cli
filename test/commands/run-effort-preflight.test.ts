// test/commands/run-effort-preflight.test.ts
//
// Unit tests for checkClaudeEffortSupport (US-R1-002, CAM-425 review round 1
// fix, addressing the WARNING left in handoff.json after US-002: the
// production probe's four documented fail-closed branches -- spawnFn throws,
// result.error set on ENOENT, non-zero exit status, string-vs-Buffer stdout
// -- were never exercised in isolation; the only prior coverage
// (test/commands/run-effort-argv.test.ts) only asserted that the probe was
// called, with the fake spawn always returning status 0 and empty stdout.
//
// All tests inject a fake SpawnFn so no real `claude` process is spawned.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { checkClaudeEffortSupport } from '../../src/commands/run-effort-preflight.ts';
import type { SpawnFn } from '../../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Fake SpawnFn builder
// ---------------------------------------------------------------------------

interface FakeSpawnOpts {
	/** Exit status (default: 0). */
	status?: number | null;
	/** stdout to return: string, Buffer, or undefined (default: ''). */
	stdout?: string | Buffer;
	/** If set, result.error is populated (simulates spawnSync ENOENT). */
	spawnError?: Error;
}

function makeFakeEffortSpawn(opts: FakeSpawnOpts = {}): SpawnFn {
	const { status = 0, stdout = '', spawnError } = opts;
	return (
		_cmd: string,
		_args: string[],
		_options?: { stdio?: 'ignore' | 'inherit' | 'pipe' },
	): SpawnSyncReturns<Buffer | string> => ({
		pid: 1234,
		output: [null, stdout, ''],
		stdout,
		stderr: '',
		status,
		signal: null,
		...(spawnError !== undefined ? { error: spawnError } : {}),
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkClaudeEffortSupport (US-R1-002)', () => {
	// AC: fail-closed branch 1 -- spawnFn throws synchronously.
	test('returns false when spawnFn throws', () => {
		const throwingSpawn: SpawnFn = () => {
			throw new Error('spawnSync claude ENOENT');
		};
		expect(checkClaudeEffortSupport(throwingSpawn)).toBe(false);
	});

	// AC: fail-closed branch 2 -- spawnSync sets result.error on ENOENT
	// without throwing (claude not on PATH).
	test('returns false when result.error is set (ENOENT path)', () => {
		const spawn = makeFakeEffortSpawn({
			status: null,
			stdout: '',
			spawnError: new Error('ENOENT: no such file or directory'),
		});
		expect(checkClaudeEffortSupport(spawn)).toBe(false);
	});

	// AC: fail-closed branch 3 -- non-zero exit status.
	test('returns false on non-zero exit status', () => {
		const spawn = makeFakeEffortSpawn({ status: 1, stdout: '--effort is supported' });
		expect(checkClaudeEffortSupport(spawn)).toBe(false);
	});

	// AC: fail-closed branch 3b -- null exit status (signal-killed).
	test('returns false on null exit status (signal)', () => {
		const spawn = makeFakeEffortSpawn({ status: null, stdout: '--effort is supported' });
		expect(checkClaudeEffortSupport(spawn)).toBe(false);
	});

	// AC: fail-closed branch 4 -- stdout missing the substring.
	test('returns false when stdout does not mention --effort', () => {
		const spawn = makeFakeEffortSpawn({ status: 0, stdout: 'Usage: claude [options]' });
		expect(checkClaudeEffortSupport(spawn)).toBe(false);
	});

	// AC: empty stdout -> false (fail-closed, this is the only path the
	// pre-existing argv test exercised).
	test('returns false on empty stdout', () => {
		const spawn = makeFakeEffortSpawn({ status: 0, stdout: '' });
		expect(checkClaudeEffortSupport(spawn)).toBe(false);
	});

	// AC: string stdout containing the substring -> true (supported path).
	test('returns true when string stdout contains --effort', () => {
		const spawn = makeFakeEffortSpawn({
			status: 0,
			stdout: 'Options:\n  --effort <level>  Set model effort level',
		});
		expect(checkClaudeEffortSupport(spawn)).toBe(true);
	});

	// AC: Buffer stdout containing the substring -> true (real spawnSync
	// without an explicit encoding returns Buffer, not string).
	test('returns true when Buffer stdout contains --effort', () => {
		const spawn = makeFakeEffortSpawn({
			status: 0,
			stdout: Buffer.from('Options:\n  --effort <level>  Set model effort level', 'utf8'),
		});
		expect(checkClaudeEffortSupport(spawn)).toBe(true);
	});

	// AC: Buffer stdout NOT containing the substring -> false.
	test('returns false when Buffer stdout does not contain --effort', () => {
		const spawn = makeFakeEffortSpawn({
			status: 0,
			stdout: Buffer.from('Usage: claude [options]', 'utf8'),
		});
		expect(checkClaudeEffortSupport(spawn)).toBe(false);
	});

	// AC: asserts the probe calls `claude --help` (the documented production
	// command), so the fake wiring in other tests is verifiably correct.
	test('calls claude with --help', () => {
		let capturedCmd = '';
		let capturedArgs: string[] = [];
		const capturingSpawn: SpawnFn = (cmd, args, _opts?) => {
			capturedCmd = cmd;
			capturedArgs = [...args];
			return {
				pid: 1,
				output: [null, '--effort', ''],
				stdout: '--effort',
				stderr: '',
				status: 0,
				signal: null,
			};
		};
		checkClaudeEffortSupport(capturingSpawn);
		expect(capturedCmd).toBe('claude');
		expect(capturedArgs).toContain('--help');
	});
});
