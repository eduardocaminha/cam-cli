// test/commands/run-auth-preflight.test.ts
//
// Unit tests for checkClaudeAuth (US-001, CAM-82).
//
// All tests inject a fake SpawnFn so no real `claude` process is spawned.
// Covers: ok path, subscriptionType surfacing, loggedIn:false, non-zero exit,
// empty stdout, unparseable JSON, and spawn error (ENOENT).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { checkClaudeAuth } from '../../src/commands/run.ts';
import type { SpawnFn } from '../../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Fake SpawnFn builder
// ---------------------------------------------------------------------------

interface FakeSpawnOpts {
	/** Exit status (default: 0). */
	status?: number | null;
	/** JSON string or raw string to return as stdout (default: ''). */
	stdout?: string;
	/** If set, result.error is populated (simulates spawn failure). */
	spawnError?: Error;
}

function makeFakeAuthSpawn(opts: FakeSpawnOpts = {}): SpawnFn {
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

/** Helper: valid logged-in JSON payload. */
function loggedInPayload(subscriptionType?: string): string {
	const obj: Record<string, unknown> = {
		loggedIn: true,
		authMethod: 'claude_ai',
		apiProvider: 'claude_ai',
		email: 'test@example.com',
		orgId: 'org_abc',
		orgName: 'Test Org',
	};
	if (subscriptionType !== undefined) {
		obj['subscriptionType'] = subscriptionType;
	}
	return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkClaudeAuth (US-001)', () => {
	// AC: logged-in JSON with loggedIn:true -> ok result
	test('returns ok when loggedIn is true', () => {
		const spawn = makeFakeAuthSpawn({ stdout: loggedInPayload('claude_pro') });
		const result = checkClaudeAuth(spawn);
		expect(result.ok).toBe(true);
	});

	// AC: subscriptionType is surfaced in the ok result (informational only)
	test('surfaces subscriptionType in the ok result', () => {
		const spawn = makeFakeAuthSpawn({ stdout: loggedInPayload('claude_pro') });
		const result = checkClaudeAuth(spawn);
		if (!result.ok) throw new Error('expected ok');
		expect(result.subscriptionType).toBe('claude_pro');
	});

	// AC: any subscriptionType with loggedIn:true passes (not a gate)
	test('passes regardless of subscriptionType value', () => {
		for (const subType of ['claude_pro', 'claude_free', 'team', 'enterprise', 'custom_value']) {
			const spawn = makeFakeAuthSpawn({ stdout: loggedInPayload(subType) });
			const result = checkClaudeAuth(spawn);
			expect(result.ok).toBe(true);
		}
	});

	// AC: subscriptionType absent still passes
	test('passes when subscriptionType is absent from payload', () => {
		const spawn = makeFakeAuthSpawn({ stdout: loggedInPayload() });
		const result = checkClaudeAuth(spawn);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('expected ok');
		expect(result.subscriptionType).toBeUndefined();
	});

	// AC: loggedIn:false -> fail with mention of `claude auth login`
	test('fails when loggedIn is false', () => {
		const payload = JSON.stringify({ loggedIn: false, subscriptionType: null });
		const spawn = makeFakeAuthSpawn({ stdout: payload });
		const result = checkClaudeAuth(spawn);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('claude auth login');
	});

	// AC: loggedIn missing -> fail
	test('fails when loggedIn field is absent', () => {
		const spawn = makeFakeAuthSpawn({ stdout: JSON.stringify({ subscriptionType: 'claude_pro' }) });
		const result = checkClaudeAuth(spawn);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('claude auth login');
	});

	// AC: non-zero exit -> fail with clear message
	test('fails on non-zero exit status', () => {
		const spawn = makeFakeAuthSpawn({ status: 1, stdout: '' });
		const result = checkClaudeAuth(spawn);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('claude auth login');
	});

	// AC: null exit status (signal-killed) -> fail
	test('fails on null exit status (signal)', () => {
		const spawn = makeFakeAuthSpawn({ status: null, stdout: '' });
		const result = checkClaudeAuth(spawn);
		expect(result.ok).toBe(false);
	});

	// AC: empty stdout -> fail (fail-closed)
	test('fails on empty stdout', () => {
		const spawn = makeFakeAuthSpawn({ status: 0, stdout: '' });
		const result = checkClaudeAuth(spawn);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('claude auth login');
	});

	// AC: whitespace-only stdout -> fail (fail-closed)
	test('fails on whitespace-only stdout', () => {
		const spawn = makeFakeAuthSpawn({ status: 0, stdout: '   \n  ' });
		const result = checkClaudeAuth(spawn);
		expect(result.ok).toBe(false);
	});

	// AC: unparseable stdout -> fail (fail-closed)
	test('fails on non-JSON stdout', () => {
		const spawn = makeFakeAuthSpawn({ status: 0, stdout: 'not json at all' });
		const result = checkClaudeAuth(spawn);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('claude auth login');
	});

	// AC: JSON array (unexpected shape) -> fail (fail-closed)
	test('fails when stdout is a JSON array', () => {
		const spawn = makeFakeAuthSpawn({ status: 0, stdout: '[{"loggedIn":true}]' });
		const result = checkClaudeAuth(spawn);
		expect(result.ok).toBe(false);
	});

	// AC: spawn error (claude not on PATH) -> fail with clear message
	test('fails when spawn throws (claude not on PATH)', () => {
		// Throwing spawn: simulate what spawnSync does when the binary is missing
		// on some environments (it can throw ENOENT).
		const throwingSpawn: SpawnFn = () => {
			throw new Error('spawnSync claude ENOENT');
		};
		const result = checkClaudeAuth(throwingSpawn);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('claude auth login');
	});

	// AC: spawn error via result.error (the usual spawnSync ENOENT path) -> fail
	test('fails when result.error is set (ENOENT path)', () => {
		const spawn = makeFakeAuthSpawn({
			status: null,
			stdout: '',
			spawnError: new Error('ENOENT: no such file or directory'),
		});
		const result = checkClaudeAuth(spawn);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('claude auth login');
	});

	// AC: asserts the function calls claude auth status --json
	test('calls claude with auth status --json args', () => {
		let capturedCmd = '';
		let capturedArgs: string[] = [];
		const capturingSpawn: SpawnFn = (cmd, args, _opts?) => {
			capturedCmd = cmd;
			capturedArgs = [...args];
			return {
				pid: 1,
				output: [null, loggedInPayload('claude_pro'), ''],
				stdout: loggedInPayload('claude_pro'),
				stderr: '',
				status: 0,
				signal: null,
			};
		};
		checkClaudeAuth(capturingSpawn);
		expect(capturedCmd).toBe('claude');
		expect(capturedArgs).toContain('auth');
		expect(capturedArgs).toContain('status');
		expect(capturedArgs).toContain('--json');
	});
});
