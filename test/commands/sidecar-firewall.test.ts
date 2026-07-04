// test/commands/sidecar-firewall.test.ts
//
// Tests for US-001 (CAM-176): firewall fail-closed wiring in runSidecar.
//
// Coverage:
//   AC5 - when ensureContainerFn throws FirewallError, runSidecar catches it,
//         logs an operator-facing message, and returns WITHOUT invoking
//         runSidecarLoop.  Proven by injecting a throwing ensureContainerFn
//         and a runSidecarLoopFn spy and asserting the spy is never called.
//   AC6 - host mode (worker_isolation absent): zero docker calls and zero
//         firewall calls (ensureContainerFn is never invoked).

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runSidecar, type SidecarOptions } from '../../src/commands/sidecar.ts';
import { FirewallError } from '../../src/supervisor/container-firewall.ts';
import type { RunSidecarLoopOptions } from '../../src/supervisor/loop.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal temp project directory with project.toml configured
 * for the given worker_isolation value.
 */
function makeProjectDir(
	isolation: 'container' | 'host' | 'none',
): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-firewall-test-'));
	mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });
	mkdirSync(join(dir, '.claude'), { recursive: true });

	if (isolation === 'container') {
		writeFileSync(
			join(dir, 'scripts', 'cam', 'project.toml'),
			'[loop]\nworker_isolation = "container"\n',
		);
	} else {
		// host mode: either absent toml or explicit host value
		if (isolation === 'host') {
			writeFileSync(
				join(dir, 'scripts', 'cam', 'project.toml'),
				'[loop]\nworker_isolation = "host"\n',
			);
		}
		// 'none': no project.toml → readWorkerIsolation falls back to 'host'
	}

	return dir;
}

/**
 * Build the minimal SidecarOptions to drive runSidecar without a real
 * sidecar loop.  The runSidecarLoopFn spy is used to assert the loop was
 * (or was not) invoked.
 */
function makeMinimalOptions(
	cwd: string,
	overrides: Partial<SidecarOptions> = {},
): SidecarOptions {
	return {
		cwd,
		// Inject a no-op loop fn that records calls
		sleepFn: () => {},
		// Prevent the loop from running by making clearActive / readActive
		// immediately terminate the outer loop via the absence of pending stories
		readActiveFn: () => false,
		hasPendingStoriesFn: () => false,
		// Self-exit immediately (no session)
		hasSessionFn: () => false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// AC5: fail-closed — FirewallError aborts before runSidecarLoop
// ---------------------------------------------------------------------------

describe('runSidecar: FirewallError aborts before runSidecarLoop (AC5)', () => {
	test('runSidecarLoopFn spy is NEVER called when ensureContainerFn throws FirewallError', async () => {
		const cwd = makeProjectDir('container');
		let loopCallCount = 0;
		const loopSpy = async (_opts: RunSidecarLoopOptions): Promise<void> => {
			loopCallCount++;
		};

		await runSidecar({
			...makeMinimalOptions(cwd),
			ensureContainerFn: () => {
				throw new FirewallError('iptables: Permission denied');
			},
			runSidecarLoopFn: loopSpy,
		});

		expect(loopCallCount).toBe(0);
	});

	test('runSidecar returns (does not throw) when FirewallError is caught', async () => {
		const cwd = makeProjectDir('container');

		// Should resolve without throwing
		await expect(
			runSidecar({
				...makeMinimalOptions(cwd),
				ensureContainerFn: () => {
					throw new FirewallError('ipset error');
				},
				runSidecarLoopFn: async () => {},
			}),
		).resolves.toBeUndefined();
	});

	test('non-FirewallError exceptions from ensureContainerFn are rethrown', async () => {
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
				// success — no throw
			},
			runSidecarLoopFn: loopSpy,
		});

		expect(loopCallCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC6: host mode — zero docker calls, zero firewall calls
// ---------------------------------------------------------------------------

describe('runSidecar: host mode is a complete no-op for container/firewall (AC6)', () => {
	test('ensureContainerFn is NOT called in host mode (absent project.toml)', async () => {
		const cwd = makeProjectDir('none'); // no project.toml → defaults to host
		let ensureCallCount = 0;
		let loopCallCount = 0;

		await runSidecar({
			...makeMinimalOptions(cwd),
			ensureContainerFn: () => {
				ensureCallCount++;
			},
			runSidecarLoopFn: async () => {
				loopCallCount++;
			},
		});

		expect(ensureCallCount).toBe(0);
		// Loop still runs (host mode is not a sidecar abort)
		expect(loopCallCount).toBe(1);
	});

	test('ensureContainerFn is NOT called when worker_isolation = host', async () => {
		const cwd = makeProjectDir('host');
		let ensureCallCount = 0;

		await runSidecar({
			...makeMinimalOptions(cwd),
			ensureContainerFn: () => {
				ensureCallCount++;
			},
			runSidecarLoopFn: async () => {},
		});

		expect(ensureCallCount).toBe(0);
	});

	test('runSidecarLoopFn is called in host mode (host mode does not abort the loop)', async () => {
		const cwd = makeProjectDir('host');
		let loopCallCount = 0;

		await runSidecar({
			...makeMinimalOptions(cwd),
			ensureContainerFn: () => {
				throw new Error('should not be called in host mode');
			},
			runSidecarLoopFn: async () => {
				loopCallCount++;
			},
		});

		// The ensureContainerFn was never called (host mode), so no throw.
		// The loop runs normally.
		expect(loopCallCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// File-assert oracle: FirewallError is imported and caught in sidecar.ts
// ---------------------------------------------------------------------------

describe('file-assert: FirewallError is caught in sidecar.ts (AC4 oracle)', () => {
	test('sidecar.ts imports FirewallError from container-firewall', () => {
		const src = require('node:fs').readFileSync(
			join(import.meta.dir, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		expect(src).toContain("FirewallError");
	});

	test('sidecar.ts contains instanceof FirewallError check', () => {
		const src = require('node:fs').readFileSync(
			join(import.meta.dir, '../../src/commands/sidecar.ts'),
			'utf8',
		);
		expect(src).toContain('instanceof FirewallError');
	});
});
