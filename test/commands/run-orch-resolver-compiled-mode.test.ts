// test/commands/run-orch-resolver-compiled-mode.test.ts
//
// Regression test for US-R1-001 (CAM-425 review round 1): the per-respawn
// resolver command built at src/commands/run.ts's setupPanes call site was
// invalid on the compiled distribution cam actually ships (bun build
// --compile, scripts/build-release.sh). Verified empirically against a real
// compiled binary: process.argv[1] inside a `bun build --compile` executable
// is bun's internal virtual embedded-entry path (`/$bunfs/root/<outfile>` on
// bun 1.3.13), which the SAME binary's own `main()` command dispatch rejects
// as `unknown command: /$bunfs/root/<outfile>` when passed back as an argv
// token -- while invoking the binary directly as `<bin> orch-resolve` works.
//
// Updated for US-001 (CAM-426): the former second detection signal
// (`basename(execPath) !== 'bun'`) was a NEGATIVE heuristic that misclassified
// an interpreted run under a version-managed bun shim (e.g. `bun-1.3` rather
// than literally `bun`) as compiled, dropping the real script argv1. Detection
// is now keyed ONLY on the positive `/$bunfs/` argv1 signal, via the extracted
// resolveSelfInvokeArgv primitive (src/util/self-invoke.ts).
//
// Coverage:
//   AC1 (pure unit): resolveOrchResolverCmd renders the pre-existing
//       `<execPath> <argv1> orch-resolve` shape in interpreted mode (execPath
//       basename 'bun', a real argv1 script path).
//   AC2 (pure unit): resolveOrchResolverCmd collapses to `<execPath>
//       orch-resolve` (execPath alone, no second argv token) when argv1 looks
//       like bun's virtual embedded-entry path.
//   AC3 (pure unit, inverted per US-001): an interpreted run under a
//       version-managed interpreter shim (execPath basename e.g. 'bun-1.3')
//       with a real script argv1 renders the interpreted 3-token form, NOT
//       the collapsed compiled form -- basename is no longer a detection
//       signal at all.
//   AC4 (wiring, end-to-end via runRun): with process.execPath/argv[1]
//       monkeypatched to simulate a compiled-binary invocation, the resolver
//       command actually embedded in the dispatched orchestrator pane argv
//       (captured via the fake tmux spawn) matches the compiled-mode shape,
//       not the pre-fix `<execPath> <bunfs-path> orch-resolve` shape.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { runRun, resolveOrchResolverCmd, type SpawnSidecarFn, type SpawnWatcherFn } from '../../src/commands/run.ts';
import type { SpawnFn } from '../../src/tmux/session.ts';

const noopSidecar: SpawnSidecarFn = () => ({ pid: 0, kill: () => {} });
const noopWatcher: SpawnWatcherFn = () => ({ pid: 0, kill: () => {} });

describe('resolveOrchResolverCmd (US-R1-001, CAM-425)', () => {
	test('interpreted mode: bun execPath + a real argv1 script path renders <bun> <script> orch-resolve', () => {
		const cmd = resolveOrchResolverCmd('/opt/homebrew/bin/bun', '/repo/index.ts');
		expect(cmd).toBe(`'/opt/homebrew/bin/bun' '/repo/index.ts' orch-resolve`);
	});

	test('compiled mode (bunfs virtual argv1): collapses to <execPath> orch-resolve', () => {
		const cmd = resolveOrchResolverCmd('/usr/local/bin/cam', '/$bunfs/root/cam-branch');
		expect(cmd).toBe(`'/usr/local/bin/cam' orch-resolve`);
		expect(cmd).not.toContain('bunfs');
	});

	test('interpreted mode under a version-managed bun shim (execPath basename e.g. "bun-1.3"): renders the 3-token interpreted form, not the collapsed compiled form (US-001, CAM-426 -- basename is no longer a detection signal)', () => {
		const cmd = resolveOrchResolverCmd('/opt/homebrew/bin/bun-1.3', '/repo/index.ts');
		expect(cmd).toBe(`'/opt/homebrew/bin/bun-1.3' '/repo/index.ts' orch-resolve`);
	});

	test('interpreted mode with a missing argv1 falls back to the bare "cam" PATH lookup', () => {
		const cmd = resolveOrchResolverCmd('/opt/homebrew/bin/bun', undefined);
		expect(cmd).toBe(`'/opt/homebrew/bin/bun' 'cam' orch-resolve`);
	});
});

describe('setupPanes wiring: compiled-binary self-invoke (US-R1-001, CAM-425)', () => {
	interface SpawnRecord {
		cmd: string;
		args: string[];
	}

	function makeFakeSpawn(): SpawnFn & { calls: SpawnRecord[] } {
		const calls: SpawnRecord[] = [];
		let paneCounter = 0;

		const fn: SpawnFn = (cmd, args, options?) => {
			calls.push({ cmd, args: [...args] });

			const result: SpawnSyncReturns<Buffer> = {
				pid: 1,
				output: [null, Buffer.from(''), Buffer.from('')],
				stdout: Buffer.from(''),
				stderr: Buffer.from(''),
				status: 0,
				signal: null,
			};

			if (cmd === 'claude') {
				result.stdout = Buffer.from(JSON.stringify({ loggedIn: true }));
			}

			if (cmd === 'tmux') {
				const subcommand = args[0] === '-L' ? args[2] : args[0];
				if (subcommand === '-V') {
					result.status = 0;
				} else if (subcommand === 'has-session') {
					result.status = 1; // no existing session
				} else if (
					(subcommand === 'new-session' || subcommand === 'split-window') &&
					options?.stdio === 'pipe'
				) {
					paneCounter += 1;
					result.stdout = Buffer.from(`%${paneCounter}\n`);
				}
			}

			return result;
		};

		const decorated = fn as SpawnFn & { calls: SpawnRecord[] };
		decorated.calls = calls;
		return decorated;
	}

	function makeTmpProject(): string {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-run-resolver-compiled-'));
		const agentsDir = join(cwd, '.claude', 'agents');
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, 'subagent-orchestrator.md'), '# stub\n', 'utf8');
		return cwd;
	}

	function findOrchRespawn(calls: SpawnRecord[]): SpawnRecord | undefined {
		return calls.find((c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a === '%1'));
	}

	test('a compiled-binary process (bunfs argv1) produces a self-invoke resolverCmd with no second argv token', () => {
		const cwd = makeTmpProject();
		const originalExecPath = process.execPath;
		const originalArgv1 = process.argv[1];
		try {
			process.execPath = '/usr/local/bin/cam';
			process.argv[1] = '/$bunfs/root/cam-branch';

			const spawn = makeFakeSpawn();
			const code = runRun({
				cwd,
				noAttach: true,
				spawnFn: spawn,
				spawnSidecarFn: noopSidecar,
				spawnWatcherFn: noopWatcher,
				effortSupportCheckFn: () => true,
			});

			expect(code).toBe(0);
			const orchRespawn = findOrchRespawn(spawn.calls);
			expect(orchRespawn).toBeDefined();
			const dispatchedCmd = orchRespawn?.args[orchRespawn.args.length - 1] ?? '';
			expect(dispatchedCmd).toContain(`resolved=$('/usr/local/bin/cam' orch-resolve 2>/dev/null)`);
			expect(dispatchedCmd).not.toContain('bunfs');
		} finally {
			process.execPath = originalExecPath;
			if (originalArgv1 !== undefined) {
				process.argv[1] = originalArgv1;
			} else {
				process.argv.length = 1;
			}
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
