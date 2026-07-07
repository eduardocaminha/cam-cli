// test/commands/sidecar-toolchain.test.ts
//
// Tests for US-007 (CAM-192/CAM-201): container-toolchain fail-closed wiring
// in runSidecar's boot-time ensure-container call.
//
// Coverage:
//   AC2 - when ensureContainerFn throws ToolchainMismatchError, runSidecar
//         catches it, logs an operator-facing message, and returns WITHOUT
//         invoking runSidecarLoop. Proven by injecting a throwing
//         ensureContainerFn and a runSidecarLoopFn spy and asserting the spy
//         is never called.
//   AC2 - non-matching errors (TypeError) from ensureContainerFn propagate
//         out of runSidecar (mirrors the Firewall/ContainerConfig precedent).
//   AC2 - file-assert that sidecar.ts contains `ToolchainMismatchError` (the
//         literal oracle string from the story) and an `instanceof` check.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runSidecar, type SidecarOptions } from '../../src/commands/sidecar.ts';
import { ToolchainMismatchError } from '../../src/supervisor/toolchain-assert.ts';
import type { RunSidecarLoopOptions } from '../../src/supervisor/loop.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal temp project directory with project.toml configured
 * for container isolation.
 */
function makeProjectDir(isolation: 'container' | 'host' | 'none'): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-toolchain-test-'));
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
// AC2: fail-closed — ToolchainMismatchError aborts before runSidecarLoop
// ---------------------------------------------------------------------------

describe('runSidecar: ToolchainMismatchError aborts before runSidecarLoop (AC2)', () => {
	test('runSidecarLoopFn spy is NEVER called when ensureContainerFn throws ToolchainMismatchError', async () => {
		const cwd = makeProjectDir('container');
		let loopCallCount = 0;
		const loopSpy = async (_opts: RunSidecarLoopOptions): Promise<void> => {
			loopCallCount++;
		};

		await runSidecar({
			...makeMinimalOptions(cwd),
			ensureContainerFn: () => {
				throw new ToolchainMismatchError(
					[{ tool: 'bun', expected: '1.3.13', actual: '1.2.23' }],
					'still-mismatched',
				);
			},
			runSidecarLoopFn: loopSpy,
		});

		expect(loopCallCount).toBe(0);
	});

	test('runSidecar returns (does not throw) when ToolchainMismatchError is caught', async () => {
		const cwd = makeProjectDir('container');

		await expect(
			runSidecar({
				...makeMinimalOptions(cwd),
				ensureContainerFn: () => {
					throw new ToolchainMismatchError(
						[{ tool: 'node', expected: '22.23.1', actual: null }],
						'rebuild-failed',
					);
				},
				runSidecarLoopFn: async () => {},
			}),
		).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// AC2: non-matching errors are still rethrown
// ---------------------------------------------------------------------------

describe('runSidecar: non-ToolchainMismatchError exceptions rethrown', () => {
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

	test('host mode never invokes ensureContainerFn (isolation !== container)', async () => {
		const cwd = makeProjectDir('host');
		let called = false;

		await runSidecar({
			...makeMinimalOptions(cwd),
			ensureContainerFn: () => {
				called = true;
			},
			runSidecarLoopFn: async () => {},
		});

		expect(called).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC2: file-assert oracle — ToolchainMismatchError is caught in sidecar.ts
// ---------------------------------------------------------------------------

describe('file-assert: ToolchainMismatchError is caught in sidecar.ts (AC2 oracle)', () => {
	test('sidecar.ts imports ToolchainMismatchError from toolchain-assert', () => {
		const src = readFileSync(join(import.meta.dir, '../../src/commands/sidecar.ts'), 'utf8');
		expect(src).toContain('ToolchainMismatchError');
	});

	test('sidecar.ts contains instanceof ToolchainMismatchError check', () => {
		const src = readFileSync(join(import.meta.dir, '../../src/commands/sidecar.ts'), 'utf8');
		expect(src).toContain('instanceof ToolchainMismatchError');
	});
});
