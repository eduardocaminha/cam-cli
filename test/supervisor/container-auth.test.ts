// test/supervisor/container-auth.test.ts
//
// Unit tests for src/supervisor/container-auth.ts.
//
// Coverage:
//   AC1 - buildAuthCheckExecArgv returns the correct 6-element non-interactive argv
//   AC2 - applyContainerAuthCheck returns {ok:true} when loggedIn===true on exit 0,
//         and {ok:false, exitCode, stderrTail} otherwise (non-zero exit,
//         unparsable JSON, or loggedIn!==true). Never throws.
//   General - ContainerAuthError is an Error subclass with stderrTail property

import { describe, expect, test } from 'bun:test';
import {
	buildAuthCheckExecArgv,
	applyContainerAuthCheck,
	ContainerAuthError,
	type AuthCheckSpawnFn,
	type ApplyAuthCheckResult,
} from '../../src/supervisor/container-auth.ts';

function loggedInPayload(subscriptionType?: string): string {
	return JSON.stringify({
		loggedIn: true,
		authMethod: 'oauth',
		apiProvider: 'anthropic',
		email: 'operator@example.com',
		orgId: 'org_1',
		orgName: 'Example Org',
		...(subscriptionType !== undefined ? { subscriptionType } : {}),
	});
}

// ---------------------------------------------------------------------------
// AC1: buildAuthCheckExecArgv
// ---------------------------------------------------------------------------

describe('buildAuthCheckExecArgv', () => {
	test('returns exactly the required 6-element non-interactive argv for cam-worker', () => {
		const argv = buildAuthCheckExecArgv('cam-worker');
		expect(argv).toEqual(['exec', 'cam-worker', 'claude', 'auth', 'status', '--json']);
	});

	test('uses the provided containerName in the second position', () => {
		const argv = buildAuthCheckExecArgv('my-container');
		expect(argv[1]).toBe('my-container');
	});

	test('contains no -it flag (non-interactive)', () => {
		const argv = buildAuthCheckExecArgv('cam-worker');
		expect(argv).not.toContain('-it');
	});

	test('contains no sudo (no privilege escalation)', () => {
		const argv = buildAuthCheckExecArgv('cam-worker');
		expect(argv).not.toContain('sudo');
	});

	test('returns exactly 6 elements', () => {
		const argv = buildAuthCheckExecArgv('cam-worker');
		expect(argv).toHaveLength(6);
	});

	test('first element is exec (docker exec subcommand)', () => {
		const argv = buildAuthCheckExecArgv('cam-worker');
		expect(argv[0]).toBe('exec');
	});
});

// ---------------------------------------------------------------------------
// AC2: applyContainerAuthCheck — {ok:true} when logged in on exit 0
// ---------------------------------------------------------------------------

describe('applyContainerAuthCheck: success path (loggedIn===true, exit 0)', () => {
	function makeSuccessSpawn(): {
		fn: AuthCheckSpawnFn;
		calls: { cmd: string; args: string[] }[];
	} {
		const calls: { cmd: string; args: string[] }[] = [];
		const fn: AuthCheckSpawnFn = (cmd, args) => {
			calls.push({ cmd, args });
			return { stdout: loggedInPayload('claude_pro'), stderr: '', exitCode: 0 };
		};
		return { fn, calls };
	}

	test('returns {ok:true} when spawnFn exits 0 and loggedIn===true', () => {
		const { fn } = makeSuccessSpawn();
		const result = applyContainerAuthCheck('cam-worker', fn);
		expect(result.ok).toBe(true);
	});

	test('calls docker exec with the auth check argv', () => {
		const { fn, calls } = makeSuccessSpawn();
		applyContainerAuthCheck('cam-worker', fn);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toBe('docker');
		expect(calls[0]?.args).toEqual([
			'exec',
			'cam-worker',
			'claude',
			'auth',
			'status',
			'--json',
		]);
	});

	test('result satisfies ApplyAuthCheckResult type on success', () => {
		const { fn } = makeSuccessSpawn();
		const result: ApplyAuthCheckResult = applyContainerAuthCheck('cam-worker', fn);
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC2: applyContainerAuthCheck — {ok:false} paths
// ---------------------------------------------------------------------------

describe('applyContainerAuthCheck: failure path (non-zero exit)', () => {
	function makeFailSpawn(exitCode: number, stderr: string, stdout = ''): AuthCheckSpawnFn {
		return (_cmd, _args) => ({ stdout, stderr, exitCode });
	}

	test('returns {ok:false} when spawnFn exits non-zero', () => {
		const fn = makeFailSpawn(1, 'docker: container not running\n');
		const result = applyContainerAuthCheck('cam-worker', fn);
		expect(result.ok).toBe(false);
	});

	test('carries the exitCode on failure', () => {
		const fn = makeFailSpawn(2, 'some error');
		const result = applyContainerAuthCheck('cam-worker', fn);
		if (result.ok) throw new Error('Expected failure result');
		expect(result.exitCode).toBe(2);
	});

	test('stderrTail contains the last lines of stderr', () => {
		const stderr = 'line1\nline2\nline3\n';
		const fn = makeFailSpawn(1, stderr);
		const result = applyContainerAuthCheck('cam-worker', fn);
		if (result.ok) throw new Error('Expected failure result');
		expect(result.stderrTail).toContain('line3');
	});

	test('stderrTail is at most 5 lines', () => {
		const stderr = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
		const fn = makeFailSpawn(1, stderr);
		const result = applyContainerAuthCheck('cam-worker', fn);
		if (result.ok) throw new Error('Expected failure result');
		const lineCount = result.stderrTail.split('\n').length;
		expect(lineCount).toBeLessThanOrEqual(5);
	});

	test('applyContainerAuthCheck never throws on non-zero exit', () => {
		const fn = makeFailSpawn(1, 'err');
		expect(() => applyContainerAuthCheck('cam-worker', fn)).not.toThrow();
	});
});

describe('applyContainerAuthCheck: failure path (loggedIn!==true on exit 0)', () => {
	test('returns {ok:false} when loggedIn is false', () => {
		const fn: AuthCheckSpawnFn = () => ({
			stdout: JSON.stringify({ loggedIn: false }),
			stderr: '',
			exitCode: 0,
		});
		const result = applyContainerAuthCheck('cam-worker', fn);
		expect(result.ok).toBe(false);
	});

	test('returns {ok:false} when loggedIn is absent', () => {
		const fn: AuthCheckSpawnFn = () => ({
			stdout: JSON.stringify({ subscriptionType: 'claude_pro' }),
			stderr: '',
			exitCode: 0,
		});
		const result = applyContainerAuthCheck('cam-worker', fn);
		expect(result.ok).toBe(false);
	});
});

describe('applyContainerAuthCheck: failure path (unparsable JSON on exit 0)', () => {
	test('returns {ok:false} on empty stdout (fail-closed)', () => {
		const fn: AuthCheckSpawnFn = () => ({ stdout: '', stderr: '', exitCode: 0 });
		const result = applyContainerAuthCheck('cam-worker', fn);
		expect(result.ok).toBe(false);
	});

	test('returns {ok:false} on non-JSON stdout', () => {
		const fn: AuthCheckSpawnFn = () => ({
			stdout: 'not json at all',
			stderr: '',
			exitCode: 0,
		});
		const result = applyContainerAuthCheck('cam-worker', fn);
		expect(result.ok).toBe(false);
	});

	test('returns {ok:false} when JSON parses to a non-object (array)', () => {
		const fn: AuthCheckSpawnFn = () => ({
			stdout: '[{"loggedIn":true}]',
			stderr: '',
			exitCode: 0,
		});
		const result = applyContainerAuthCheck('cam-worker', fn);
		expect(result.ok).toBe(false);
	});

	test('applyContainerAuthCheck never throws on unparsable JSON', () => {
		const fn: AuthCheckSpawnFn = () => ({ stdout: 'garbage', stderr: '', exitCode: 0 });
		expect(() => applyContainerAuthCheck('cam-worker', fn)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// ContainerAuthError: typed Error subclass
// ---------------------------------------------------------------------------

describe('ContainerAuthError', () => {
	test('is an instance of Error', () => {
		const err = new ContainerAuthError('claude: command not found');
		expect(err).toBeInstanceOf(Error);
	});

	test('has name ContainerAuthError', () => {
		const err = new ContainerAuthError('some detail');
		expect(err.name).toBe('ContainerAuthError');
	});

	test('carries stderrTail property', () => {
		const tail = 'Error: not logged in\nrun `claude auth login`';
		const err = new ContainerAuthError(tail);
		expect(err.stderrTail).toBe(tail);
	});

	test('message includes the stderrTail', () => {
		const tail = 'Error: not logged in';
		const err = new ContainerAuthError(tail);
		expect(err.message).toContain(tail);
	});

	test('instanceof ContainerAuthError check works for typed catch', () => {
		const err = new ContainerAuthError('detail');
		expect(err instanceof ContainerAuthError).toBe(true);
	});
});
