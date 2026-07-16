// test/git/on-main-spawn-forward.test.ts
//
// Behavioral regression test for realOnMainSpawnFn (src/git/on-main.ts,
// US-001 CAM-311): proves maxBuffer passed in `opts` actually reaches the
// underlying spawnSync call via `{ ...opts, stdio: 'pipe' }`, rather than
// being silently dropped (the CAM-307 bug this helper exists to prevent).
//
// Real subprocess, no mocking: `sh -c "head -c <n> /dev/zero"` produces
// exactly <n> bytes of stdout deterministically on macOS and Linux.
// Node's default spawnSync maxBuffer is 1 MiB (1024 * 1024 bytes), so a
// 2 MiB request without an explicit maxBuffer must fail with ENOBUFS; the
// same request WITH a larger maxBuffer forwarded through realOnMainSpawnFn
// must succeed and return the full payload. This is behavioral proof of
// forwarding, not a bare mock-call assertion.

import { describe, test, expect } from 'bun:test';
import { realOnMainSpawnFn } from '../../src/git/on-main.ts';

const TWO_MIB = 2 * 1024 * 1024;

describe('realOnMainSpawnFn', () => {
	test('drops output past Node default 1 MiB maxBuffer when maxBuffer is omitted', () => {
		const result = realOnMainSpawnFn('sh', ['-c', `head -c ${TWO_MIB} /dev/zero`], {
			encoding: 'utf8',
		});

		expect(result.error).toBeDefined();
		expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOBUFS');
	});

	test('forwards a large maxBuffer through to spawnSync so >1 MiB stdout is not truncated', () => {
		const result = realOnMainSpawnFn('sh', ['-c', `head -c ${TWO_MIB} /dev/zero`], {
			encoding: 'utf8',
			maxBuffer: 4 * 1024 * 1024,
		});

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect((result.stdout ?? '').length).toBe(TWO_MIB);
	});
});
