// test/stop-markers.test.ts
//
// Unit tests for US-002: performStop removes the full per-session marker set,
// idempotently.
//
// Markers covered:
//   - .claude/cam-loop.local.md     (STATE_FILE_PATH, already existed)
//   - .claude/.cam-supervisor.lock  (SUPERVISOR_LOCK_FILE)
//   - .claude/.cam-orch-session     (ORCH_SESSION_MARKER)
//   - .claude/.cam-worker-pane      (WORKER_PANE_MARKER)
//   - .claude/.cam-orch-ready       (ORCH_READY_MARKER)
//   - .claude/.cam-orch-recycle     (ORCH_RECYCLE_MARKER)
//   - scripts/cam/worker-report.json (WORKER_REPORT_FILENAME)
//
// Oracle: bun test test/stop-markers.test.ts

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { performStop, type SpawnSyncFn } from '../src/commands/stop.ts';
import { WORKER_PANE_MARKER, ORCH_SESSION_MARKER, ORCH_RECYCLE_MARKER } from '../src/tmux/session.ts';
import { ORCH_READY_MARKER } from '../src/tmux/bootstrap-wait.ts';
import { SUPERVISOR_LOCK_FILE } from '../src/supervisor/lock.ts';
import { WORKER_REPORT_FILENAME } from '../src/supervisor/worker-report.ts';

// --- Helpers ---------------------------------------------------------------

/** Fake spawnSync: reports tmux as unavailable so the session-kill path is skipped. */
function noOpSpawn(_cmd: string, _args: string[], _opts: { encoding: 'utf8' }): SpawnSyncReturns<string> {
	return { pid: 1, output: ['', '', ''], stdout: '', stderr: '', status: 1, signal: null };
}

// Cast once so call sites stay readable.
const fakeSpawn = noOpSpawn as unknown as SpawnSyncFn;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('performStop — per-session marker cleanup (US-002)', () => {
	test('removes all six markers when all are present', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-markers-all-'));
		try {
			const claudeDir = join(dir, '.claude');
			mkdirSync(claudeDir, { recursive: true });
			mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });

			// Write all six markers.
			const stateFile = join(claudeDir, 'cam-loop.local.md');
			writeFileSync(stateFile, 'active: true\n');
			writeFileSync(join(claudeDir, SUPERVISOR_LOCK_FILE), '{"pid":1}');
			writeFileSync(join(claudeDir, ORCH_SESSION_MARKER), 'uuid-abc');
			writeFileSync(join(claudeDir, WORKER_PANE_MARKER), '%5');
			writeFileSync(join(claudeDir, ORCH_READY_MARKER), '');
			writeFileSync(join(dir, WORKER_REPORT_FILENAME), '{"outcome":"DONE","story":"US-001","gates":{"typecheck":"ok","tests":"1 pass / 0 fail"},"notes":"none"}');

			performStop({ cwd: dir, spawnSyncFn: fakeSpawn });

			// All six must be gone.
			expect(existsSync(stateFile)).toBe(false);
			expect(existsSync(join(claudeDir, SUPERVISOR_LOCK_FILE))).toBe(false);
			expect(existsSync(join(claudeDir, ORCH_SESSION_MARKER))).toBe(false);
			expect(existsSync(join(claudeDir, WORKER_PANE_MARKER))).toBe(false);
			expect(existsSync(join(claudeDir, ORCH_READY_MARKER))).toBe(false);
			expect(existsSync(join(dir, WORKER_REPORT_FILENAME))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('tolerates all absent markers without throwing (existsSyncFn always false)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-markers-absent-'));
		try {
			const unlinked: string[] = [];
			// existsSyncFn always returns false: no marker is present.
			expect(() =>
				performStop({
					cwd: dir,
					spawnSyncFn: fakeSpawn,
					existsSyncFn: () => false,
					unlinkSyncFn: (p: string) => {
						unlinked.push(p);
					},
				}),
			).not.toThrow();
			// With existsSyncFn always false, unlinkSyncFn must never be called.
			expect(unlinked).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('calls unlinkSyncFn for every marker when existsSyncFn always returns true', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-markers-inject-'));
		try {
			const claudeDir = join(dir, '.claude');
			const unlinked: string[] = [];

			performStop({
				cwd: dir,
				spawnSyncFn: fakeSpawn,
				existsSyncFn: () => true,
				unlinkSyncFn: (p: string) => {
					unlinked.push(p);
				},
			});

			// Expect exactly 7 unlink calls — one per marker.
			expect(unlinked).toContain(join(dir, '.claude', 'cam-loop.local.md'));
			expect(unlinked).toContain(join(claudeDir, SUPERVISOR_LOCK_FILE));
			expect(unlinked).toContain(join(claudeDir, ORCH_SESSION_MARKER));
			expect(unlinked).toContain(join(claudeDir, WORKER_PANE_MARKER));
			expect(unlinked).toContain(join(claudeDir, ORCH_READY_MARKER));
			expect(unlinked).toContain(join(claudeDir, ORCH_RECYCLE_MARKER));
			expect(unlinked).toContain(join(dir, WORKER_REPORT_FILENAME));
			expect(unlinked).toHaveLength(7);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('second call is a no-op (idempotent): markers already absent do not throw', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-stop-markers-idempotent-'));
		try {
			const claudeDir = join(dir, '.claude');
			mkdirSync(claudeDir, { recursive: true });
			mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });

			// Write all seven markers, then call performStop twice.
			writeFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'active: true\n');
			writeFileSync(join(claudeDir, SUPERVISOR_LOCK_FILE), '{"pid":1}');
			writeFileSync(join(claudeDir, ORCH_SESSION_MARKER), 'uuid-abc');
			writeFileSync(join(claudeDir, WORKER_PANE_MARKER), '%5');
			writeFileSync(join(claudeDir, ORCH_READY_MARKER), '');
			writeFileSync(join(claudeDir, ORCH_RECYCLE_MARKER), '');
			writeFileSync(join(dir, WORKER_REPORT_FILENAME), '{"outcome":"DONE"}');

			performStop({ cwd: dir, spawnSyncFn: fakeSpawn });

			// Second call: all markers are already gone; must not throw.
			expect(() =>
				performStop({ cwd: dir, spawnSyncFn: fakeSpawn }),
			).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
