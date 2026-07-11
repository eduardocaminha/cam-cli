// test/stop-container-teardown.test.ts
//
// Unit tests for US-004 (CAM-207): `cam stop` tears down the cam-worker
// container at session exit, gated to container mode, through an injectable
// spawn seam, best-effort (never throws).
//
// Acceptance criteria covered:
//   AC1 — container mode: `docker rm -f <DEFAULT_CONTAINER_NAME>` is invoked
//         through the injectable spawn seam; a non-zero exit (container
//         absent) is tolerated, never thrown.
//   AC4 — host mode (worker_isolation != 'container'): a no-op. `docker rm -f`
//         is never called and `containerTornDown` stays false.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncFn } from '../src/commands/stop.ts';
import { performStop } from '../src/commands/stop.ts';
import { DEFAULT_CONTAINER_NAME } from '../src/supervisor/worker-container.ts';

/** Fake SpawnSyncFn: tmux calls fail (unavailable), docker calls succeed. */
function makeSpawnFn(dockerStatus: number): { spawnFn: SpawnSyncFn; calls: Array<{ cmd: string; args: string[] }> } {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	const spawnFn: SpawnSyncFn = (cmd, args) => {
		calls.push({ cmd, args });
		const status = cmd === 'docker' ? dockerStatus : 1; // tmux unavailable
		return {
			pid: 1,
			output: ['', '', ''] as (string | null)[],
			stdout: '',
			stderr: '',
			status,
			signal: null,
		};
	};
	return { spawnFn, calls };
}

describe('performStop — container teardown (US-004, CAM-207)', () => {
	test('container mode + docker rm -f succeeds: containerTornDown=true, correct argv', () => {
		const { spawnFn, calls } = makeSpawnFn(0);

		const report = performStop({
			cwd: '/fake/cwd',
			spawnSyncFn: spawnFn,
			existsSyncFn: () => false,
			unlinkSyncFn: () => {},
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			killFn: () => {},
			workerIsolationReader: () => 'container',
		});

		expect(report.containerTornDown).toBe(true);
		const dockerCall = calls.find((c) => c.cmd === 'docker');
		expect(dockerCall).toBeDefined();
		expect(dockerCall!.args).toEqual(['rm', '-f', DEFAULT_CONTAINER_NAME]);
	});

	test('container mode + docker rm -f fails (container absent): containerTornDown=false, no throw', () => {
		const { spawnFn } = makeSpawnFn(1);

		expect(() =>
			performStop({
				cwd: '/fake/cwd',
				spawnSyncFn: spawnFn,
				existsSyncFn: () => false,
				unlinkSyncFn: () => {},
				sidecarPidReader: () => null,
				sidecarPidAliveFn: () => false,
				sidecarPidRemover: () => {},
				killFn: () => {},
				workerIsolationReader: () => 'container',
			}),
		).not.toThrow();

		const report = performStop({
			cwd: '/fake/cwd',
			spawnSyncFn: spawnFn,
			existsSyncFn: () => false,
			unlinkSyncFn: () => {},
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			killFn: () => {},
			workerIsolationReader: () => 'container',
		});
		expect(report.containerTornDown).toBe(false);
	});

	test('container mode: a spawnFn that throws never propagates out of performStop', () => {
		const throwingSpawn: SpawnSyncFn = (cmd) => {
			if (cmd === 'docker') throw new Error('docker binary absent');
			return { pid: 1, output: ['', '', ''] as (string | null)[], stdout: '', stderr: '', status: 1, signal: null };
		};

		expect(() =>
			performStop({
				cwd: '/fake/cwd',
				spawnSyncFn: throwingSpawn,
				existsSyncFn: () => false,
				unlinkSyncFn: () => {},
				sidecarPidReader: () => null,
				sidecarPidAliveFn: () => false,
				sidecarPidRemover: () => {},
				killFn: () => {},
				workerIsolationReader: () => 'container',
			}),
		).not.toThrow();
	});

	test('custom containerName option is forwarded to docker rm -f', () => {
		const { spawnFn, calls } = makeSpawnFn(0);

		performStop({
			cwd: '/fake/cwd',
			spawnSyncFn: spawnFn,
			existsSyncFn: () => false,
			unlinkSyncFn: () => {},
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			killFn: () => {},
			workerIsolationReader: () => 'container',
			containerName: 'my-custom-container',
		});

		const dockerCall = calls.find((c) => c.cmd === 'docker');
		expect(dockerCall!.args).toEqual(['rm', '-f', 'my-custom-container']);
	});

	// -------------------------------------------------------------------------
	// AC4 — host mode is a no-op (this repo's mode; also the fail-closed default
	// when workerIsolationReader is not injected and no project.toml exists).
	// -------------------------------------------------------------------------

	test('host mode (explicit): docker is never invoked, containerTornDown stays false', () => {
		const { spawnFn, calls } = makeSpawnFn(0);

		const report = performStop({
			cwd: '/fake/cwd',
			spawnSyncFn: spawnFn,
			existsSyncFn: () => false,
			unlinkSyncFn: () => {},
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			killFn: () => {},
			workerIsolationReader: () => 'host',
		});

		expect(report.containerTornDown).toBe(false);
		expect(calls.find((c) => c.cmd === 'docker')).toBeUndefined();
	});

	test('default worker-isolation reader (no injection, no project.toml on disk): fail-closed to host, docker never invoked', () => {
		const { spawnFn, calls } = makeSpawnFn(0);

		const report = performStop({
			cwd: '/fake/cwd/does-not-exist',
			spawnSyncFn: spawnFn,
			existsSyncFn: () => false,
			unlinkSyncFn: () => {},
			sidecarPidReader: () => null,
			sidecarPidAliveFn: () => false,
			sidecarPidRemover: () => {},
			killFn: () => {},
		});

		expect(report.containerTornDown).toBe(false);
		expect(calls.find((c) => c.cmd === 'docker')).toBeUndefined();
	});
});
