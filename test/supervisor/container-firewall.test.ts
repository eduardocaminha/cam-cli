// test/supervisor/container-firewall.test.ts
//
// Unit tests for src/supervisor/container-firewall.ts.
//
// Coverage:
//   AC1 - buildFirewallExecArgv returns the correct 5-element argv
//   AC2 - applyContainerFirewall returns {ok:true} on exit 0, and
//         {ok:false, exitCode, stderrTail} on non-zero exit
//   General - FirewallError is an Error subclass with stderrTail property

import { describe, expect, test } from 'bun:test';
import {
	buildFirewallExecArgv,
	applyContainerFirewall,
	FirewallError,
	type FirewallSpawnFn,
	type ApplyFirewallResult,
} from '../../src/supervisor/container-firewall.ts';

// ---------------------------------------------------------------------------
// AC1: buildFirewallExecArgv
// ---------------------------------------------------------------------------

describe('buildFirewallExecArgv', () => {
	test('returns exactly the required 5-element argv for cam-worker', () => {
		// AC1: returns ['exec','cam-worker','sudo','bash','/workspace/.devcontainer/init-firewall.sh']
		const argv = buildFirewallExecArgv('cam-worker');
		expect(argv).toEqual([
			'exec',
			'cam-worker',
			'sudo',
			'bash',
			'/workspace/.devcontainer/init-firewall.sh',
		]);
	});

	test('uses the provided containerName in the second position', () => {
		const argv = buildFirewallExecArgv('my-container');
		expect(argv[1]).toBe('my-container');
	});

	test('uses absolute path /workspace/.devcontainer/init-firewall.sh (not relative)', () => {
		const argv = buildFirewallExecArgv('cam-worker');
		// Must be absolute path so the sudoers NOPASSWD grant matches
		expect(argv[4]).toBe('/workspace/.devcontainer/init-firewall.sh');
		expect(argv[4]?.startsWith('/')).toBe(true);
	});

	test('uses bash (not sh) so the sudoers NOPASSWD grant matches', () => {
		const argv = buildFirewallExecArgv('cam-worker');
		expect(argv[3]).toBe('bash');
	});

	test('returns exactly 5 elements', () => {
		const argv = buildFirewallExecArgv('cam-worker');
		expect(argv).toHaveLength(5);
	});

	test('first element is exec (docker exec subcommand)', () => {
		const argv = buildFirewallExecArgv('cam-worker');
		expect(argv[0]).toBe('exec');
	});

	test('third element is sudo (for NOPASSWD escalation)', () => {
		const argv = buildFirewallExecArgv('cam-worker');
		expect(argv[2]).toBe('sudo');
	});
});

// ---------------------------------------------------------------------------
// AC2: applyContainerFirewall — {ok:true} on exit 0
// ---------------------------------------------------------------------------

describe('applyContainerFirewall: success path (exit 0)', () => {
	function makeSuccessSpawn(): { fn: FirewallSpawnFn; calls: { cmd: string; args: string[] }[] } {
		const calls: { cmd: string; args: string[] }[] = [];
		const fn: FirewallSpawnFn = (cmd, args) => {
			calls.push({ cmd, args });
			return { stdout: 'OK', stderr: '', exitCode: 0 };
		};
		return { fn, calls };
	}

	test('returns {ok:true} when spawnFn exits 0', () => {
		const { fn } = makeSuccessSpawn();
		const result = applyContainerFirewall('cam-worker', fn);
		expect(result.ok).toBe(true);
	});

	test('calls docker exec with the firewall argv', () => {
		const { fn, calls } = makeSuccessSpawn();
		applyContainerFirewall('cam-worker', fn);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toBe('docker');
		expect(calls[0]?.args).toEqual([
			'exec',
			'cam-worker',
			'sudo',
			'bash',
			'/workspace/.devcontainer/init-firewall.sh',
		]);
	});

	test('result satisfies ApplyFirewallResult type on success', () => {
		const { fn } = makeSuccessSpawn();
		const result: ApplyFirewallResult = applyContainerFirewall('cam-worker', fn);
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC2: applyContainerFirewall — {ok:false} on non-zero exit
// ---------------------------------------------------------------------------

describe('applyContainerFirewall: failure path (non-zero exit)', () => {
	function makeFailSpawn(
		exitCode: number,
		stderr: string,
	): { fn: FirewallSpawnFn } {
		const fn: FirewallSpawnFn = (_cmd, _args) => ({
			stdout: '',
			stderr,
			exitCode,
		});
		return { fn };
	}

	test('returns {ok:false} when spawnFn exits non-zero', () => {
		const { fn } = makeFailSpawn(1, 'iptables error\n');
		const result = applyContainerFirewall('cam-worker', fn);
		expect(result.ok).toBe(false);
	});

	test('carries the exitCode on failure', () => {
		const { fn } = makeFailSpawn(2, 'some error');
		const result = applyContainerFirewall('cam-worker', fn);
		if (result.ok) throw new Error('Expected failure result');
		expect(result.exitCode).toBe(2);
	});

	test('stderrTail contains the last lines of stderr', () => {
		const stderr = 'line1\nline2\nline3\n';
		const { fn } = makeFailSpawn(1, stderr);
		const result = applyContainerFirewall('cam-worker', fn);
		if (result.ok) throw new Error('Expected failure result');
		expect(result.stderrTail).toContain('line3');
	});

	test('stderrTail is at most 5 lines', () => {
		const stderr = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
		const { fn } = makeFailSpawn(1, stderr);
		const result = applyContainerFirewall('cam-worker', fn);
		if (result.ok) throw new Error('Expected failure result');
		const lineCount = result.stderrTail.split('\n').length;
		expect(lineCount).toBeLessThanOrEqual(5);
	});

	test('applyContainerFirewall never throws (failure is a return value)', () => {
		// applyContainerFirewall itself should not swallow this (it propagates
		// unexpected throws); verify it doesn't wrap the result in a try/catch
		// by ensuring a well-behaved fn returns ok:false without throwing
		const failFn: FirewallSpawnFn = () => ({ stdout: '', stderr: 'err', exitCode: 1 });
		expect(() => applyContainerFirewall('cam-worker', failFn)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// FirewallError: typed Error subclass
// ---------------------------------------------------------------------------

describe('FirewallError', () => {
	test('is an instance of Error', () => {
		const err = new FirewallError('iptables -P OUTPUT DROP failed');
		expect(err).toBeInstanceOf(Error);
	});

	test('has name FirewallError', () => {
		const err = new FirewallError('some detail');
		expect(err.name).toBe('FirewallError');
	});

	test('carries stderrTail property', () => {
		const tail = 'iptables: Permission denied\nipset: Command failed';
		const err = new FirewallError(tail);
		expect(err.stderrTail).toBe(tail);
	});

	test('message includes the stderrTail', () => {
		const tail = 'iptables: Permission denied';
		const err = new FirewallError(tail);
		expect(err.message).toContain(tail);
	});

	test('instanceof FirewallError check works for typed catch', () => {
		const err = new FirewallError('detail');
		expect(err instanceof FirewallError).toBe(true);
	});
});
