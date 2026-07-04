// test/commands/sidecar-config.test.ts
//
// Tests for US-003 (CAM-185): container-config fail-closed wiring in runSidecar.
//
// Coverage:
//   AC4 - when ensureContainerFn throws ContainerConfigError, runSidecar
//         catches it, logs an operator-facing message, and returns WITHOUT
//         invoking runSidecarLoop.  Proven by injecting a throwing
//         ensureContainerFn and a runSidecarLoopFn spy and asserting the spy
//         is never called.
//   AC5 - non-matching errors (TypeError) from ensureContainerFn propagate
//         out of runSidecar.
//   AC6 - file-assert that sidecar.ts contains `instanceof ContainerConfigError`.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runSidecar, type SidecarOptions } from '../../src/commands/sidecar.ts';
import { ContainerConfigError } from '../../src/supervisor/container-config.ts';
import type { RunSidecarLoopOptions } from '../../src/supervisor/loop.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal temp project directory with project.toml configured
 * for container isolation.
 */
function makeProjectDir(isolation: 'container' | 'host' | 'none'): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-config-test-'));
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
	// 'none': no project.toml -> readWorkerIsolation falls back to 'host'

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
// AC4: fail-closed — ContainerConfigError aborts before runSidecarLoop
// ---------------------------------------------------------------------------

describe('runSidecar: ContainerConfigError aborts before runSidecarLoop (AC4)', () => {
	test('runSidecarLoopFn spy is NEVER called when ensureContainerFn throws ContainerConfigError', async () => {
		const cwd = makeProjectDir('container');
		let loopCallCount = 0;
		const loopSpy = async (_opts: RunSidecarLoopOptions): Promise<void> => {
			loopCallCount++;
		};

		await runSidecar({
			...makeMinimalOptions(cwd),
			ensureContainerFn: () => {
				throw new ContainerConfigError('chown: Operation not permitted');
			},
			runSidecarLoopFn: loopSpy,
		});

		expect(loopCallCount).toBe(0);
	});

	test('runSidecar returns (does not throw) when ContainerConfigError is caught', async () => {
		const cwd = makeProjectDir('container');

		await expect(
			runSidecar({
				...makeMinimalOptions(cwd),
				ensureContainerFn: () => {
					throw new ContainerConfigError('node merge script failed');
				},
				runSidecarLoopFn: async () => {},
			}),
		).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// AC5: non-matching errors are still rethrown
// ---------------------------------------------------------------------------

describe('runSidecar: non-ContainerConfigError exceptions rethrown (AC5)', () => {
	test('TypeError thrown by ensureContainerFn propagates out of runSidecar', async () => {
		const cwd = makeProjectDir('container');

		await expect(
			runSidecar({
				...makeMinimalOptions(cwd),
				ensureContainerFn: () => {
					throw new TypeError('unexpected crash');
				},
				runSidecarLoopFn: async () => {},
			}),
		).rejects.toThrow(TypeError);
	});

	test('runSidecarLoopFn IS called when ensureContainerFn succeeds', async () => {
		const cwd = makeProjectDir('container');
		let loopCallCount = 0;
		const loopSpy = async (_opts: RunSidecarLoopOptions): Promise<void> => {
			loopCallCount++;
		};

		await runSidecar({
			...makeMinimalOptions(cwd),
			ensureContainerFn: () => {
				// success
			},
			runSidecarLoopFn: loopSpy,
		});

		expect(loopCallCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC6: file-assert — ContainerConfigError is imported and caught in sidecar.ts
// ---------------------------------------------------------------------------

describe('file-assert: ContainerConfigError is caught in sidecar.ts (AC6)', () => {
	test('sidecar.ts imports ContainerConfigError from container-config', () => {
		const src = require('node:fs').readFileSync(
			join(import.meta.dir, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		expect(src).toContain('ContainerConfigError');
	});

	test('sidecar.ts contains instanceof ContainerConfigError check', () => {
		const src = require('node:fs').readFileSync(
			join(import.meta.dir, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		expect(src).toContain('instanceof ContainerConfigError');
	});
});
