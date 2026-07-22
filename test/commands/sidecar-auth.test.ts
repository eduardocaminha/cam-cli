// test/commands/sidecar-auth.test.ts
//
// Tests for US-004 (CAM-396): ContainerAuthError fail-closed wiring in
// runContainerEnsureGuard / runSidecar.
//
// Coverage:
//   AC1/AC3 - when ensureContainerFn throws ContainerAuthError, runSidecar
//             catches it, writes the durable stall marker (reason
//             'container-auth-unavailable', detail from stderrTail), and
//             returns WITHOUT invoking runSidecarLoop. Proven by injecting a
//             throwing ensureContainerFn and a runSidecarLoopFn spy.
//   AC2      - the auth branch mirrors the FirewallError branch (writes a
//              marker), unlike ContainerConfigError/ToolchainMismatchError
//              (which write no marker).

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runSidecar, type SidecarOptions } from '../../src/commands/sidecar.ts';
import { ContainerAuthError } from '../../src/supervisor/container-auth.ts';
import { ContainerConfigError } from '../../src/supervisor/container-config.ts';
import { ToolchainMismatchError } from '../../src/supervisor/toolchain-assert.ts';
import type { RunSidecarLoopOptions } from '../../src/supervisor/loop.ts';
import {
	SIDECAR_STALLED_FILENAME,
	readSidecarStalledMarker,
} from '../../src/supervisor/sidecar-stalled.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal temp project directory with project.toml configured
 * for the given worker_isolation value.
 */
function makeProjectDir(isolation: 'container' | 'host' | 'none'): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-auth-test-'));
	mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });
	mkdirSync(join(dir, '.claude'), { recursive: true });

	if (isolation === 'container') {
		writeFileSync(
			join(dir, 'scripts', 'cam', 'project.toml'),
			'[loop]\nworker_isolation = "container"\n',
		);
	} else if (isolation === 'host') {
		writeFileSync(
			join(dir, 'scripts', 'cam', 'project.toml'),
			'[loop]\nworker_isolation = "host"\n',
		);
	}
	// 'none': no project.toml → readWorkerIsolation falls back to 'host'

	return dir;
}

/**
 * Build the minimal SidecarOptions to drive runSidecar without a real
 * sidecar loop.
 */
function makeMinimalOptions(
	cwd: string,
	overrides: Partial<SidecarOptions> = {},
): SidecarOptions {
	return {
		cwd,
		sleepFn: () => {},
		readActiveFn: () => false,
		hasPendingStoriesFn: () => false,
		hasSessionFn: () => false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// AC1/AC3: fail-closed — ContainerAuthError aborts before runSidecarLoop and
// writes the durable stall marker.
// ---------------------------------------------------------------------------

describe('runSidecar: ContainerAuthError aborts before runSidecarLoop (AC1/AC3)', () => {
	test('runSidecarLoopFn spy is NEVER called when ensureContainerFn throws ContainerAuthError', async () => {
		const cwd = makeProjectDir('container');
		let loopCallCount = 0;
		const loopSpy = async (_opts: RunSidecarLoopOptions): Promise<void> => {
			loopCallCount++;
		};

		await runSidecar({
			...makeMinimalOptions(cwd),
			ensureContainerFn: () => {
				throw new ContainerAuthError('claude auth status: not logged in');
			},
			runSidecarLoopFn: loopSpy,
		});

		expect(loopCallCount).toBe(0);
	});

	test('runSidecar returns (does not throw) when ContainerAuthError is caught', async () => {
		const cwd = makeProjectDir('container');

		await expect(
			runSidecar({
				...makeMinimalOptions(cwd),
				ensureContainerFn: () => {
					throw new ContainerAuthError('auth probe exited 1');
				},
				runSidecarLoopFn: async () => {},
			}),
		).resolves.toBeUndefined();
	});

	test('writes the marker with reason container-auth-unavailable and the stderrTail as detail', async () => {
		const cwd = makeProjectDir('container');
		const markerPath = join(cwd, '.claude', SIDECAR_STALLED_FILENAME);

		await runSidecar({
			...makeMinimalOptions(cwd),
			ensureContainerFn: () => {
				throw new ContainerAuthError('claude auth status: not logged in');
			},
			runSidecarLoopFn: async () => {},
		});

		const marker = readSidecarStalledMarker(markerPath);
		expect(marker).not.toBeNull();
		expect(marker?.reason).toBe('container-auth-unavailable');
		expect(marker?.detail).toBe('claude auth status: not logged in');
		expect(typeof marker?.writtenAt).toBe('string');
	});
});

// ---------------------------------------------------------------------------
// AC2: the auth branch mirrors FirewallError (writes a marker), NOT
// ContainerConfigError/ToolchainMismatchError (which write no marker).
// ---------------------------------------------------------------------------

describe('runSidecar: ContainerConfigError/ToolchainMismatchError still write no marker (AC2)', () => {
	test('ContainerConfigError aborts the loop but writes no stall marker', async () => {
		const cwd = makeProjectDir('container');
		const markerPath = join(cwd, '.claude', SIDECAR_STALLED_FILENAME);
		let loopCallCount = 0;

		await runSidecar({
			...makeMinimalOptions(cwd),
			ensureContainerFn: () => {
				throw new ContainerConfigError('config repair failed');
			},
			runSidecarLoopFn: async () => {
				loopCallCount++;
			},
		});

		expect(loopCallCount).toBe(0);
		expect(readSidecarStalledMarker(markerPath)).toBeNull();
	});

	test('ToolchainMismatchError aborts the loop but writes no stall marker', async () => {
		const cwd = makeProjectDir('container');
		const markerPath = join(cwd, '.claude', SIDECAR_STALLED_FILENAME);
		let loopCallCount = 0;

		await runSidecar({
			...makeMinimalOptions(cwd),
			ensureContainerFn: () => {
				throw new ToolchainMismatchError(
					[{ tool: 'bun', expected: '1.3.13', actual: '1.2.23' }],
					'still-mismatched',
				);
			},
			runSidecarLoopFn: async () => {
				loopCallCount++;
			},
		});

		expect(loopCallCount).toBe(0);
		expect(readSidecarStalledMarker(markerPath)).toBeNull();
	});
});
