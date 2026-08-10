// test/commands/next-headless-flag.test.ts
//
// US-004 (CAM-516): `--headless` is a pure per-invocation flag threaded from
// the CLI surface through the existing state-file transport into
// RunSupervisorOptions, never sticky and never sourced from persisted
// config.
//
// Coverage:
//   1. parseNextArgs(['--headless']) returns the flag set; NEXT_HELP
//      documents it in the Options section; an unrelated unknown flag still
//      rejects (the reject path is preserved, not widened). Test named
//      'parseNextArgs'.
//   2. State-file round trip (AC3): renderStateFile writes headless into the
//      real vendored template, parseStateFile reads it back into LoopState,
//      and buildSupervisorOptions (host.ts) lifts it into
//      RunSupervisorOptions.headless.
//   3. non-sticky (AC4): a `cam next` invocation without --headless resets
//      headless:false on disk even when the prior state file held
//      headless:true. Test named 'non-sticky'.
//   4. Mid-cycle preservation: makeClearActive and makeSetPhaseFn
//      (sidecar.ts) preserve headless across their own read-modify-write, so
//      the flag survives the clearActive-then-buildOpts ordering and phase
//      transitions within one cycle (see the doc comments at each site).

import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { createTestTmpdir } from '../helpers/test-tmpdir';
import { NEXT_HELP, parseNextArgs } from '../../index.ts';
import { renderStateFile, runNext, writeStateFile } from '../../src/commands/next.ts';
import { parseStateFile } from '../../src/commands/status.ts';
import { buildSupervisorOptions } from '../../src/supervisor/host.ts';
import { makeClearActive, makeReadHeadless, makeSetPhaseFn } from '../../src/commands/sidecar.ts';
import type { SpawnFn as TmuxSpawnFn } from '../../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Fake tmux spawn (mirrors test/commands/next-preflight.test.ts's
// makeFakeTmuxSpawn: orchestrator alive, single free pane, pane %0).
// ---------------------------------------------------------------------------

function makeFakeTmuxSpawn(): TmuxSpawnFn {
	return ((_cmd: string, args: string[]) => {
		const base: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};
		const subcommand = args[0] === '-L' ? args[2] : args[0];

		if (subcommand === 'has-session') return { ...base, status: 0 };
		if (subcommand === 'list-panes') {
			const fIdx = args.indexOf('-F');
			const fmt = fIdx !== -1 ? (args[fIdx + 1] ?? '') : '';
			if (fmt === '#{@cam_label}') return { ...base, stdout: Buffer.from('orchestrator\ndashboard\n') };
			if (fmt === '#{pane_index};#{pane_id}') return { ...base, stdout: Buffer.from('0;%0\n') };
			if (fmt === '#{pane_id}') return { ...base, stdout: Buffer.from('%0\n%1\n') };
			return { ...base, stdout: Buffer.from('') };
		}
		if (subcommand === 'capture-pane') return { ...base, stdout: Buffer.from('> ') };
		return base;
	}) as TmuxSpawnFn;
}

// ---------------------------------------------------------------------------
// 1. parseNextArgs / NEXT_HELP / reject-path preservation
// ---------------------------------------------------------------------------

test('parseNextArgs', () => {
	const result = parseNextArgs(['--headless']);
	expect(result).not.toBeNull();
	expect(result?.headless).toBe(true);
	expect(result?.help).toBe(false);

	// Absent by default.
	expect(parseNextArgs([])?.headless).toBeUndefined();

	// NEXT_HELP documents the flag inside the Options section (not just
	// anywhere in the string).
	const optionsIdx = NEXT_HELP.indexOf('Options');
	const behaviourIdx = NEXT_HELP.indexOf('Behaviour');
	expect(optionsIdx).toBeGreaterThan(-1);
	expect(behaviourIdx).toBeGreaterThan(optionsIdx);
	expect(NEXT_HELP.slice(optionsIdx, behaviourIdx)).toContain('--headless');

	// An unrelated unknown flag STILL produces the unknown-option error and a
	// null return: the reject path at the end of the parse loop is preserved,
	// not widened.
	const original = process.stderr.write.bind(process.stderr);
	const captured: string[] = [];
	process.stderr.write = ((chunk: string | Uint8Array) => {
		captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const rejected = parseNextArgs(['--totally-unknown-flag']);
		expect(rejected).toBeNull();
	} finally {
		process.stderr.write = original;
	}
	expect(captured.join('')).toMatch(/unknown next option.*--totally-unknown-flag/i);
});

// ---------------------------------------------------------------------------
// 2. State-file transport round trip (AC3)
// ---------------------------------------------------------------------------

describe('state-file transport round trip', () => {
	test('renderStateFile writes headless, parseStateFile reads it back, buildSupervisorOptions lifts it into RunSupervisorOptions', () => {
		const dir = createTestTmpdir('cam-headless-roundtrip-');
		try {
			const body = renderStateFile({
				maxIterations: 30,
				completionPromise: 'COMPLETE',
				startedAt: new Date().toISOString(),
				pid: 1234,
				active: true,
				headless: true,
			});
			writeStateFile(dir, body, { force: true });

			const raw = readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8');
			const parsed = parseStateFile(raw);
			expect(parsed?.headless).toBe(true);

			const { opts } = buildSupervisorOptions(dir);
			expect(opts.headless).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('headless defaults to false when omitted from renderStateFile input', () => {
		const dir = createTestTmpdir('cam-headless-default-');
		try {
			const body = renderStateFile({
				maxIterations: 30,
				completionPromise: 'COMPLETE',
				startedAt: new Date().toISOString(),
				pid: 1234,
				active: true,
			});
			writeStateFile(dir, body, { force: true });

			const raw = readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8');
			const parsed = parseStateFile(raw);
			expect(parsed?.headless).toBe(false);

			const { opts } = buildSupervisorOptions(dir);
			expect(opts.headless).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 3. non-sticky (AC4)
// ---------------------------------------------------------------------------

test('non-sticky', async () => {
	const dir = createTestTmpdir('cam-headless-nonsticky-');
	try {
		const spawnFn = makeFakeTmuxSpawn();

		// A previous cycle wrote headless:true.
		const priorBody = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: new Date().toISOString(),
			pid: 1234,
			active: false,
			headless: true,
		});
		writeStateFile(dir, priorBody, { force: true });
		const before = parseStateFile(readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8'));
		expect(before?.headless).toBe(true);

		// A fresh `cam next` invocation WITHOUT --headless.
		const code = await runNext({
			cwd: dir,
			tmuxSpawnFn: spawnFn,
			sidecarAliveFn: () => true,
			preflightFn: () => ({ ok: true }),
			// headless intentionally omitted -- must NOT inherit the on-disk true.
		});

		expect(code).toBe(0);
		const after = parseStateFile(readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8'));
		expect(after?.headless).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('an invocation WITH --headless writes headless:true', async () => {
	const dir = createTestTmpdir('cam-headless-on-');
	try {
		const spawnFn = makeFakeTmuxSpawn();

		const code = await runNext({
			cwd: dir,
			tmuxSpawnFn: spawnFn,
			sidecarAliveFn: () => true,
			preflightFn: () => ({ ok: true }),
			headless: true,
		});

		expect(code).toBe(0);
		const after = parseStateFile(readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8'));
		expect(after?.headless).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 4. Mid-cycle preservation (sidecar.ts)
// ---------------------------------------------------------------------------

describe('mid-cycle preservation (sidecar.ts)', () => {
	test('makeClearActive preserves headless across its own read-modify-write', () => {
		const dir = createTestTmpdir('cam-headless-clearactive-');
		try {
			const claudeDir = join(dir, '.claude');
			const body = renderStateFile({
				maxIterations: 30,
				completionPromise: 'COMPLETE',
				startedAt: new Date().toISOString(),
				pid: 1,
				active: true,
				headless: true,
			});
			writeStateFile(dir, body, { force: true });

			makeClearActive(claudeDir, dir)();

			expect(makeReadHeadless(claudeDir)()).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('makeSetPhaseFn preserves headless across a phase transition', () => {
		const dir = createTestTmpdir('cam-headless-setphase-');
		try {
			const claudeDir = join(dir, '.claude');
			const body = renderStateFile({
				maxIterations: 30,
				completionPromise: 'COMPLETE',
				startedAt: new Date().toISOString(),
				pid: 1,
				active: true,
				headless: true,
			});
			writeStateFile(dir, body, { force: true });

			makeSetPhaseFn(claudeDir, dir)('shipping');

			expect(makeReadHeadless(claudeDir)()).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
