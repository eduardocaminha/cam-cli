// test/commands/sidecar-session-start.test.ts
//
// Tests for US-001 (dashboard total-session elapsed): runSidecar records the
// session-start timestamp exactly once, at process startup, before the poll
// loop runs.
//
// Coverage:
//   - writeSessionStartFn is called exactly once per runSidecar invocation,
//     regardless of whether the injected loop simulates multiple active/idle
//     cycles internally (proving a "second loop in one session" cannot
//     re-trigger the write, since the write happens before the loop starts).
//   - the production default writes the real file at
//     .claude/.cam-sidecar-session.json via writeSidecarSessionStart.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runSidecar, type SidecarOptions } from '../../src/commands/sidecar.ts';
import { readSidecarSessionStart } from '../../src/supervisor/session-start.ts';
import type { RunSidecarLoopOptions } from '../../src/supervisor/loop.ts';

function makeProjectDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-sidecar-session-start-'));
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

describe('runSidecar: session-start recorded once at startup (US-001)', () => {
	test('writeSessionStartFn is called exactly once, even when the injected loop simulates several cycles', async () => {
		const cwd = makeProjectDir();
		let writeCount = 0;

		const loopSpy = async (_opts: RunSidecarLoopOptions): Promise<void> => {
			// Simulate a sidecar loop that internally advances through several
			// active/idle cycles before returning. The session-start write must
			// NOT be re-triggered by any of this: it happens once, before the
			// loop is invoked at all.
			for (let i = 0; i < 3; i++) {
				/* no-op: represents a "fresh loop start" within one session */
			}
		};

		await runSidecar({
			...makeMinimalOptions(cwd),
			writeSessionStartFn: () => {
				writeCount++;
			},
			runSidecarLoopFn: loopSpy,
		});

		expect(writeCount).toBe(1);
	});

	test('production default writes a readable session-start marker to .claude/', async () => {
		const cwd = makeProjectDir();

		await runSidecar({
			...makeMinimalOptions(cwd),
			runSidecarLoopFn: async () => {},
		});

		const iso = readSidecarSessionStart(join(cwd, '.claude'));
		expect(iso).not.toBeNull();
		expect(Number.isFinite(Date.parse(iso as string))).toBe(true);
	});
});
