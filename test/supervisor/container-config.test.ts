// test/supervisor/container-config.test.ts
//
// Unit tests for src/supervisor/container-config.ts.
//
// Coverage:
//   AC1 - buildChownExecArgv returns the correct root-escalated chown argv
//   AC2 - buildConfigAssertArgv argv contains node invocation and all 5 key
//         names; script performs a merge (not a whole-file overwrite)
//   AC3 - applyContainerConfig: ok case, fail case (exitCode+stderrTail),
//         not-throw assertion
//   AC4 - ContainerConfigError: instanceof Error, name, stderrTail

import { describe, expect, test } from 'bun:test';
import {
	buildChownExecArgv,
	buildConfigAssertArgv,
	applyContainerConfig,
	ContainerConfigError,
	type ConfigSpawnFn,
	type ApplyConfigResult,
} from '../../src/supervisor/container-config.ts';

// ---------------------------------------------------------------------------
// AC1: buildChownExecArgv
// ---------------------------------------------------------------------------

describe('buildChownExecArgv', () => {
	test('first element is exec (docker exec subcommand)', () => {
		const argv = buildChownExecArgv('cam-worker');
		expect(argv[0]).toBe('exec');
	});

	test('includes the containerName in the argv', () => {
		const argv = buildChownExecArgv('cam-worker');
		expect(argv).toContain('cam-worker');
	});

	test('uses the provided containerName (not hardcoded)', () => {
		const argv = buildChownExecArgv('my-container');
		expect(argv).toContain('my-container');
		expect(argv).not.toContain('cam-worker');
	});

	test('includes chown command', () => {
		const argv = buildChownExecArgv('cam-worker');
		expect(argv).toContain('chown');
	});

	test('uses -R flag for recursive chown', () => {
		const argv = buildChownExecArgv('cam-worker');
		expect(argv).toContain('-R');
	});

	test('targets /home/bun/.claude', () => {
		const argv = buildChownExecArgv('cam-worker');
		expect(argv).toContain('/home/bun/.claude');
	});

	test('uses bun:bun ownership', () => {
		const argv = buildChownExecArgv('cam-worker');
		expect(argv).toContain('bun:bun');
	});

	test('uses a root-escalated form (runs as root to repair root-owned volumes)', () => {
		const argv = buildChownExecArgv('cam-worker');
		// Either -u root flag or sudo in the argv
		const hasRootFlag = argv.includes('-u') && argv.includes('root');
		const hasSudo = argv.includes('sudo');
		expect(hasRootFlag || hasSudo).toBe(true);
	});

	test('full argv shape matches expected form', () => {
		const argv = buildChownExecArgv('cam-worker');
		expect(argv).toEqual([
			'exec',
			'-u',
			'root',
			'cam-worker',
			'chown',
			'-R',
			'bun:bun',
			'/home/bun/.claude',
		]);
	});
});

// ---------------------------------------------------------------------------
// AC2: buildConfigAssertArgv — node invocation, 5 keys, merge not overwrite
// ---------------------------------------------------------------------------

describe('buildConfigAssertArgv', () => {
	test('first element is exec', () => {
		const argv = buildConfigAssertArgv('cam-worker');
		expect(argv[0]).toBe('exec');
	});

	test('includes the containerName in the argv', () => {
		const argv = buildConfigAssertArgv('cam-worker');
		expect(argv).toContain('cam-worker');
	});

	test('argv contains node invocation', () => {
		const argv = buildConfigAssertArgv('cam-worker');
		expect(argv).toContain('node');
	});

	test('argv contains -e flag (inline script execution)', () => {
		const argv = buildConfigAssertArgv('cam-worker');
		expect(argv).toContain('-e');
	});

	test('script contains hasCompletedOnboarding', () => {
		const argv = buildConfigAssertArgv('cam-worker');
		const script = argv.find((a) => a.includes('hasCompletedOnboarding')) ?? '';
		expect(script).toContain('hasCompletedOnboarding');
	});

	test('script contains theme', () => {
		const argv = buildConfigAssertArgv('cam-worker');
		const script = argv.find((a) => a.includes('theme')) ?? '';
		expect(script).toContain('theme');
	});

	test('script contains bypassPermissionsModeAccepted', () => {
		const argv = buildConfigAssertArgv('cam-worker');
		const script = argv.find((a) => a.includes('bypassPermissionsModeAccepted')) ?? '';
		expect(script).toContain('bypassPermissionsModeAccepted');
	});

	test('script contains hasTrustDialogAccepted', () => {
		const argv = buildConfigAssertArgv('cam-worker');
		const script = argv.find((a) => a.includes('hasTrustDialogAccepted')) ?? '';
		expect(script).toContain('hasTrustDialogAccepted');
	});

	test('script contains hasCompletedProjectOnboarding', () => {
		const argv = buildConfigAssertArgv('cam-worker');
		const script = argv.find((a) => a.includes('hasCompletedProjectOnboarding')) ?? '';
		expect(script).toContain('hasCompletedProjectOnboarding');
	});

	test('script is a merge (reads existing file before writing — not a whole-file overwrite)', () => {
		// The script must contain a readFileSync call to prove it reads first.
		const argv = buildConfigAssertArgv('cam-worker');
		const script = argv.join(' ');
		expect(script).toContain('readFileSync');
		expect(script).toContain('writeFileSync');
	});

	test('script targets /home/bun/.claude.json', () => {
		const argv = buildConfigAssertArgv('cam-worker');
		const script = argv.join(' ');
		expect(script).toContain('/home/bun/.claude.json');
	});

	test('script uses the /workspace project key', () => {
		const argv = buildConfigAssertArgv('cam-worker');
		const script = argv.join(' ');
		expect(script).toContain('/workspace');
	});
});

// ---------------------------------------------------------------------------
// AC3: applyContainerConfig — ok case, fail cases, not-throw assertion
// ---------------------------------------------------------------------------

describe('applyContainerConfig: success path (both steps exit 0)', () => {
	function makeSuccessSpawn(): { fn: ConfigSpawnFn; calls: { cmd: string; args: string[] }[] } {
		const calls: { cmd: string; args: string[] }[] = [];
		const fn: ConfigSpawnFn = (cmd, args) => {
			calls.push({ cmd, args });
			return { stdout: 'ok', stderr: '', exitCode: 0 };
		};
		return { fn, calls };
	}

	test('returns {ok:true} when both steps exit 0', () => {
		const { fn } = makeSuccessSpawn();
		const result = applyContainerConfig('cam-worker', fn);
		expect(result.ok).toBe(true);
	});

	test('calls docker twice (chown step then config-assert step)', () => {
		const { fn, calls } = makeSuccessSpawn();
		applyContainerConfig('cam-worker', fn);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.cmd).toBe('docker');
		expect(calls[1]?.cmd).toBe('docker');
	});

	test('first call is the chown argv', () => {
		const { fn, calls } = makeSuccessSpawn();
		applyContainerConfig('cam-worker', fn);
		const first = calls[0]?.args ?? [];
		expect(first).toContain('chown');
		expect(first).toContain('/home/bun/.claude');
	});

	test('second call is the node config-assert argv', () => {
		const { fn, calls } = makeSuccessSpawn();
		applyContainerConfig('cam-worker', fn);
		const second = calls[1]?.args ?? [];
		expect(second).toContain('node');
		expect(second).toContain('-e');
	});

	test('result satisfies ApplyConfigResult type on success', () => {
		const { fn } = makeSuccessSpawn();
		const result: ApplyConfigResult = applyContainerConfig('cam-worker', fn);
		expect(result.ok).toBe(true);
	});
});

describe('applyContainerConfig: failure path — chown step fails', () => {
	function makeChownFailSpawn(exitCode: number, stderr: string): ConfigSpawnFn {
		let called = 0;
		return (_cmd, _args) => {
			called++;
			if (called === 1) return { stdout: '', stderr, exitCode };
			return { stdout: 'ok', stderr: '', exitCode: 0 };
		};
	}

	test('returns {ok:false} when chown step exits non-zero', () => {
		const fn = makeChownFailSpawn(1, 'chown: permission denied\n');
		const result = applyContainerConfig('cam-worker', fn);
		expect(result.ok).toBe(false);
	});

	test('carries the exitCode from the failed chown step', () => {
		const fn = makeChownFailSpawn(2, 'some error');
		const result = applyContainerConfig('cam-worker', fn);
		if (result.ok) throw new Error('Expected failure result');
		expect(result.exitCode).toBe(2);
	});

	test('carries stderrTail from the failed chown step', () => {
		const fn = makeChownFailSpawn(1, 'chown: permission denied\n');
		const result = applyContainerConfig('cam-worker', fn);
		if (result.ok) throw new Error('Expected failure result');
		expect(result.stderrTail).toContain('chown');
	});

	test('stops after chown failure (config-assert step not called)', () => {
		const calls: string[] = [];
		const fn: ConfigSpawnFn = (_cmd, args) => {
			calls.push(args.join(' '));
			// Fail on first call (chown), succeed on second
			return { stdout: '', stderr: 'fail', exitCode: calls.length === 1 ? 1 : 0 };
		};
		applyContainerConfig('cam-worker', fn);
		expect(calls).toHaveLength(1);
	});
});

describe('applyContainerConfig: failure path — config-assert step fails', () => {
	function makeConfigFailSpawn(exitCode: number, stderr: string): ConfigSpawnFn {
		let called = 0;
		return (_cmd, _args) => {
			called++;
			if (called === 2) return { stdout: '', stderr, exitCode };
			return { stdout: 'ok', stderr: '', exitCode: 0 };
		};
	}

	test('returns {ok:false} when config-assert step exits non-zero', () => {
		const fn = makeConfigFailSpawn(1, 'node: SyntaxError\n');
		const result = applyContainerConfig('cam-worker', fn);
		expect(result.ok).toBe(false);
	});

	test('carries the exitCode from the failed config-assert step', () => {
		const fn = makeConfigFailSpawn(3, 'node: error');
		const result = applyContainerConfig('cam-worker', fn);
		if (result.ok) throw new Error('Expected failure result');
		expect(result.exitCode).toBe(3);
	});

	test('carries stderrTail from the failed config-assert step', () => {
		const fn = makeConfigFailSpawn(1, 'node: SyntaxError in script\n');
		const result = applyContainerConfig('cam-worker', fn);
		if (result.ok) throw new Error('Expected failure result');
		expect(result.stderrTail).toContain('node');
	});
});

describe('applyContainerConfig: not-throw assertion', () => {
	test('does not throw when spawnFn returns non-zero exit (failure is a return value)', () => {
		const failFn: ConfigSpawnFn = () => ({ stdout: '', stderr: 'err', exitCode: 1 });
		expect(() => applyContainerConfig('cam-worker', failFn)).not.toThrow();
	});

	test('stderrTail is at most 5 lines', () => {
		const stderr = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
		const fn: ConfigSpawnFn = () => ({ stdout: '', stderr, exitCode: 1 });
		const result = applyContainerConfig('cam-worker', fn);
		if (result.ok) throw new Error('Expected failure result');
		const lineCount = result.stderrTail.split('\n').length;
		expect(lineCount).toBeLessThanOrEqual(5);
	});
});

// ---------------------------------------------------------------------------
// AC4: ContainerConfigError — typed Error subclass
// ---------------------------------------------------------------------------

describe('ContainerConfigError', () => {
	test('is an instance of Error', () => {
		const err = new ContainerConfigError('some detail');
		expect(err).toBeInstanceOf(Error);
	});

	test('has name ContainerConfigError (stable name)', () => {
		const err = new ContainerConfigError('some detail');
		expect(err.name).toBe('ContainerConfigError');
	});

	test('carries stderrTail field', () => {
		const tail = 'chown: permission denied\nnode: SyntaxError';
		const err = new ContainerConfigError(tail);
		expect(err.stderrTail).toBe(tail);
	});

	test('message includes the stderrTail', () => {
		const tail = 'chown: permission denied';
		const err = new ContainerConfigError(tail);
		expect(err.message).toContain(tail);
	});

	test('instanceof ContainerConfigError check works for typed catch', () => {
		const err = new ContainerConfigError('detail');
		expect(err instanceof ContainerConfigError).toBe(true);
	});
});
