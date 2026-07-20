// test/supervisor/plan/plan-preflight-spawn.test.ts
//
// Real-subprocess boundary tests for makePreflightSpawnFn (US-002, CAM-368).
//
// This is the sole production PlanPreflightSpawnFn implementation, extracted
// out of the sidecar's makeProductionPlanPhaseFn closure. Every unit test
// elsewhere injects a fake spawnFn (test/supervisor/plan/plan-preflight.test.ts),
// so this file is the ONLY place the real Bun.spawnSync wiring is exercised:
// it must actually execute a subprocess in every case, never a fake or a
// hand-copied equivalent closure (see scripts/cam/patterns.md "Real-git
// integration test pattern").
//
// Coverage:
//   1. stderr-only command -> stderr contains the literal, stdout.trim() === ''.
//   2. stdout-only command -> stdout contains the literal, stderr.trim() === ''.
//   3. both-streams command -> both decoded and non-empty.
//   4. non-zero exit -> exitCode matches.
//   5. cwd is honored: a real temp dir's realpath matches decoded `pwd` output,
//      and a different cwd would yield a different result (non-vacuous).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePreflightSpawnFn } from '../../../src/supervisor/plan-preflight-spawn.ts';

describe('makePreflightSpawnFn (real subprocess boundary)', () => {
	test('stderr-only: stderr contains the literal, stdout is empty', () => {
		const spawnFn = makePreflightSpawnFn(process.cwd());
		const r = spawnFn('sh', ['-c', "echo STDERR_LITERAL_ABC 1>&2"]);
		expect(r.stderr).toContain('STDERR_LITERAL_ABC');
		expect(r.stdout.trim()).toBe('');
	});

	test('stdout-only: stdout contains the literal, stderr is empty', () => {
		const spawnFn = makePreflightSpawnFn(process.cwd());
		const r = spawnFn('sh', ['-c', 'echo STDOUT_LITERAL_XYZ']);
		expect(r.stdout).toContain('STDOUT_LITERAL_XYZ');
		expect(r.stderr.trim()).toBe('');
	});

	test('both streams: both decoded and non-empty', () => {
		const spawnFn = makePreflightSpawnFn(process.cwd());
		const r = spawnFn('sh', ['-c', 'echo OUT_BOTH; echo ERR_BOTH 1>&2']);
		expect(r.stdout).toContain('OUT_BOTH');
		expect(r.stderr).toContain('ERR_BOTH');
		expect(r.stdout.trim().length).toBeGreaterThan(0);
		expect(r.stderr.trim().length).toBeGreaterThan(0);
	});

	test('non-zero exit: exitCode matches the process exit code', () => {
		const spawnFn = makePreflightSpawnFn(process.cwd());
		const r = spawnFn('sh', ['-c', 'exit 7']);
		expect(r.exitCode).toBe(7);
	});

	describe('cwd is honored', () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), 'cam-preflight-spawn-'));
		});

		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		test('a real temp dir is threaded through to the spawned process', () => {
			const spawnFn = makePreflightSpawnFn(tmpDir);
			const r = spawnFn('pwd', []);
			// macOS commonly symlinks /var -> /private/var; resolve both sides
			// through realpathSync before comparing, or a raw string compare
			// would false-fail (see story notes, AC10 non-vacuity).
			expect(realpathSync(r.stdout.trim())).toBe(realpathSync(tmpDir));
		});

		test('a different cwd yields a different decoded pwd (non-vacuous)', () => {
			const other = mkdtempSync(join(tmpdir(), 'cam-preflight-spawn-other-'));
			try {
				const spawnFn = makePreflightSpawnFn(tmpDir);
				const r = spawnFn('pwd', []);
				expect(realpathSync(r.stdout.trim())).not.toBe(realpathSync(other));
			} finally {
				rmSync(other, { recursive: true, force: true });
			}
		});
	});
});
