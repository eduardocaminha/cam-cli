// test/tmux/dispatch-timeouts.test.ts
//
// Unit tests for the NARRATION_IDLE_TIMEOUT_MS / IDLE_WAIT_DEADLINE_MS split
// (US-001, CAM-361): the sidecar's best-effort narration push must wait at
// most a short dedicated idle-timeout before sending anyway to a busy
// orchestrator pane, without lowering the shared 30s deadline the one-shot
// CLI thin-proxies (`cam issue`/`cam review`/`cam spec`) and the
// `orch-recycle-watch` backstop process still rely on.
//
// Coverage:
//   1. NARRATION_IDLE_TIMEOUT_MS === 2_000, strictly less than IDLE_WAIT_DEADLINE_MS.
//   2. IDLE_WAIT_DEADLINE_MS stays 30_000 (unchanged).
//   3. File-assert: src/supervisor/host.ts imports NARRATION_IDLE_TIMEOUT_MS
//      and wires it into its sendKeysVerified options object.
//   4. File-assert: none of the four one-shot CLI thin-proxy / watch call
//      sites (issue.ts, review.ts, spec.ts, orch-recycle-watch.ts) reference
//      NARRATION_IDLE_TIMEOUT_MS -- they keep their own pre-existing
//      options.idleTimeoutMs passthrough (or no override at all), which
//      falls back to the full IDLE_WAIT_DEADLINE_MS in production.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NARRATION_IDLE_TIMEOUT_MS, IDLE_WAIT_DEADLINE_MS } from '../../src/tmux/dispatch.ts';

describe('NARRATION_IDLE_TIMEOUT_MS / IDLE_WAIT_DEADLINE_MS split (US-001, CAM-361)', () => {
	test('NARRATION_IDLE_TIMEOUT_MS is 2_000 and strictly less than IDLE_WAIT_DEADLINE_MS', () => {
		expect(NARRATION_IDLE_TIMEOUT_MS).toBe(2_000);
		expect(NARRATION_IDLE_TIMEOUT_MS).toBeLessThan(IDLE_WAIT_DEADLINE_MS);
	});

	test('IDLE_WAIT_DEADLINE_MS stays 30_000 (unchanged by this story)', () => {
		expect(IDLE_WAIT_DEADLINE_MS).toBe(30_000);
	});

	test('host.ts imports NARRATION_IDLE_TIMEOUT_MS and wires it into its sendKeysVerified call', () => {
		const src = readFileSync(join(import.meta.dir, '../../src/supervisor/host.ts'), 'utf8');
		expect(src).toMatch(/import\s*\{[^}]*NARRATION_IDLE_TIMEOUT_MS[^}]*\}\s*from\s*['"]\.\.\/tmux\/dispatch\.ts['"]/);
		expect(src).toMatch(/idleTimeoutMs:\s*NARRATION_IDLE_TIMEOUT_MS/);
	});

	test('no other of the five sendKeysVerified call sites references NARRATION_IDLE_TIMEOUT_MS', () => {
		const callSitePaths = [
			'../../src/commands/issue.ts',
			'../../src/commands/review.ts',
			'../../src/commands/spec.ts',
			'../../src/commands/orch-recycle-watch.ts',
		];
		for (const relPath of callSitePaths) {
			const src = readFileSync(join(import.meta.dir, relPath), 'utf8');
			expect(src).not.toMatch(/NARRATION_IDLE_TIMEOUT_MS/);
		}
	});
});
