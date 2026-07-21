// test/supervisor/sidecar-self-pid.test.ts
//
// Tests for US-001 (CAM-387): runSidecar self-registers its own pid at boot
// via the writeSidecarPidFn DI seam, so that a standalone `nohup cam sidecar
// ...` process (which never goes through run.ts) is reported as alive by
// `sidecarAlive` -- the liveness gate read by `cam plan`/`next`/`ship`.
//
// Coverage:
//   AC1: booting runSidecar (real writeSidecarPidFn default, injected
//        immediately-resolving runSidecarLoopFn, cwd = fresh temp dir) makes
//        sidecarAlive(join(tmpCwd, '.claude')) true afterward.
//   AC2/AC3 are covered by file-assert oracles against src/commands/sidecar.ts.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runSidecar, type SidecarOptions } from '../../src/commands/sidecar.ts';
import { sidecarAlive } from '../../src/supervisor/sidecar-pid.ts';
import type { RunSidecarLoopOptions } from '../../src/supervisor/loop.ts';

function makeProjectDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-sidecar-self-pid-'));
	mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });
	mkdirSync(join(dir, '.claude'), { recursive: true });
	return dir;
}

function makeMinimalOptions(cwd: string, overrides: Partial<SidecarOptions> = {}): SidecarOptions {
	return {
		cwd,
		sleepFn: () => {},
		readActiveFn: () => false,
		hasPendingStoriesFn: () => false,
		hasSessionFn: () => false,
		...overrides,
	};
}

describe('runSidecar: self-registers its own pid at boot (US-001, CAM-387)', () => {
	test('sidecarAlive is true after boot, via the default writeSidecarPidFn', async () => {
		const cwd = makeProjectDir();
		try {
			const loopFn = async (_opts: RunSidecarLoopOptions): Promise<void> => {
				// Immediately-resolving loop: the pid write must already have
				// happened before this is even called.
			};

			await runSidecar({
				...makeMinimalOptions(cwd),
				runSidecarLoopFn: loopFn,
			});

			expect(sidecarAlive(join(cwd, '.claude'))).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('writeSidecarPidFn is called exactly once, before the injected loop runs', async () => {
		const cwd = makeProjectDir();
		try {
			let writeCalls = 0;
			let loopSawWrite = false;

			await runSidecar({
				...makeMinimalOptions(cwd),
				writeSidecarPidFn: (_dir, _pid) => {
					writeCalls++;
				},
				runSidecarLoopFn: async (_opts: RunSidecarLoopOptions): Promise<void> => {
					loopSawWrite = writeCalls === 1;
				},
			});

			expect(writeCalls).toBe(1);
			expect(loopSawWrite).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
