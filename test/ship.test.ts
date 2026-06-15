// test/ship.test.ts
//
// Unit tests for `cam ship` (US-007: thin-proxy to orchestrator).
//
// What we cover:
//   - parseShipArgs: --help/-h, unknown flag rejection.
//   - runShip (hit path): orchestrator alive -> send-keys /cam-ship and return 0.
//   - runShip (miss path): bootstraps cam run, waits for marker, then send-keys.
//   - runShip: bootstrap failure returns 1.
//   - runShip: marker timeout returns 1.
//   - runShip: missing orch pane returns 1.
//   - send-keys is atomic (-l flag, text + Enter in same call).

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { runShip } from '../src/commands/ship.ts';
import { parseShipArgs } from '../index.ts';
import {
	projectSessionName,
	type SpawnFn as TmuxSpawnFn,
} from '../src/tmux/session.ts';

// --- Fake tmux spawn --------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

/**
 * Build a fake TmuxSpawnFn that simulates a session with an orchestrator pane.
 */
function makeFakeTmuxSpawn(opts: {
	sessionExists?: boolean;
	orchAlive?: boolean;
	orchPaneId?: string;
} = {}): TmuxSpawnFn & { calls: TmuxCall[] } {
	const { sessionExists = true, orchAlive = true, orchPaneId = '%0' } = opts;
	const calls: TmuxCall[] = [];

	const fn = ((cmd: string, args: string[]) => {
		calls.push({ cmd, args: [...args] });
		const base: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};
		const subcommand = args[0] === '-L' ? args[2] : args[0];

		if (subcommand === 'has-session') {
			return { ...base, status: sessionExists ? 0 : 1 };
		}

		if (subcommand === 'list-panes') {
			if (!sessionExists) return { ...base, status: 1 };
			const fIdx = args.indexOf('-F');
			const fmt = fIdx !== -1 ? (args[fIdx + 1] ?? '') : '';
			if (fmt === '#{pane_index}\t#{pane_current_command}') {
				return {
					...base,
					stdout: Buffer.from(orchAlive ? `0\tclaude\n` : `0\tsh\n`),
				};
			}
			if (fmt === '#{pane_index}\t#{pane_id}') {
				return { ...base, stdout: Buffer.from(`0\t${orchPaneId}\n`) };
			}
			return { ...base, stdout: Buffer.from('') };
		}

		if (subcommand === 'capture-pane') {
			// Return idle pane content so the idle-check (US-008) passes immediately.
			return { ...base, stdout: Buffer.from('> ') };
		}

		if (subcommand === 'send-keys') {
			return base;
		}

		return base;
	}) as TmuxSpawnFn & { calls: TmuxCall[] };
	fn.calls = calls;
	return fn;
}

// --- parseShipArgs ---------------------------------------------------------

describe('parseShipArgs', () => {
	test('bare (no args) returns help: false', () => {
		expect(parseShipArgs([])).toEqual({ help: false });
	});

	test('--help sets help: true', () => {
		expect(parseShipArgs(['--help'])).toEqual({ help: true });
	});

	test('-h sets help: true', () => {
		expect(parseShipArgs(['-h'])).toEqual({ help: true });
	});

	test('unknown flag returns null', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseShipArgs(['--bogus'])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});

	test('does not accept --permission-mode (returns null)', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseShipArgs(['--permission-mode', 'acceptEdits'])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});
});

// --- runShip (thin-proxy): hit path ------------------------------------------

describe('runShip (thin-proxy, hit path)', () => {
	test('sends /cam-ship to orchestrator pane and returns 0', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-ship-hit-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%3' });

		const code = await runShip({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
		});

		expect(code).toBe(0);

		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeDefined();
		expect(sendKeys?.args).toContain('-l');
		expect(sendKeys?.args).toContain('/cam-ship');
		expect(sendKeys?.args).toContain('Enter');
		expect(sendKeys?.args).toContain('%3');
	});

	test('send-keys is atomic: text and Enter are in the same send-keys call', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-ship-atomic-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

		await runShip({ cwd: tmpDir, tmuxSpawnFn: spawnFn });

		const sendKeys = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toHaveLength(1);
		const call = sendKeys[0];
		const enterIdx = call?.args.lastIndexOf('Enter') ?? -1;
		const textIdx = call?.args.findIndex((a) => a === '/cam-ship') ?? -1;
		expect(enterIdx).toBeGreaterThan(textIdx);
	});

	test('uses -l flag for literal send-keys (metachar safety)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-ship-literal-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

		await runShip({ cwd: tmpDir, tmuxSpawnFn: spawnFn });

		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys?.args).toContain('-l');
	});

	test('skips bootstrap when orchestrator is already alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-ship-no-bootstrap-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		let bootstrapCalled = false;

		await runShip({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => { bootstrapCalled = true; return true; },
		});

		expect(bootstrapCalled).toBe(false);
	});
});

// --- runShip (thin-proxy): miss path ------------------------------------------

describe('runShip (thin-proxy, miss path)', () => {
	test('bootstraps + waits for marker + sends keys when orch not alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-ship-miss-'));

		let bootstrapCalled = false;
		let markerPresent = false;
		let orchReady = false;

		const calls: TmuxCall[] = [];
		const statefulSpawnFn: TmuxSpawnFn & { calls: TmuxCall[] } = Object.assign(
			(cmd: string, args: string[]) => {
				calls.push({ cmd, args: [...args] });
				const base: SpawnSyncReturns<Buffer> = {
					pid: 1,
					output: [null, Buffer.from(''), Buffer.from('')],
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
					status: 0,
					signal: null,
				};
				const subcommand = args[0] === '-L' ? args[2] : args[0];
				if (subcommand === 'has-session') {
					return { ...base, status: orchReady ? 0 : 1 };
				}
				if (subcommand === 'list-panes') {
					if (!orchReady) return { ...base, status: 1 };
					const fIdx = args.indexOf('-F');
					const fmt = fIdx !== -1 ? (args[fIdx + 1] ?? '') : '';
					if (fmt === '#{pane_index}\t#{pane_current_command}') {
						return { ...base, stdout: Buffer.from('0\tclaude\n') };
					}
					if (fmt === '#{pane_index}\t#{pane_id}') {
						return { ...base, stdout: Buffer.from('0\t%0\n') };
					}
				}
				if (subcommand === 'capture-pane') {
					// Return idle pane content so the idle-check (US-008) passes immediately.
					return { ...base, stdout: Buffer.from('> ') };
				}
				return base;
			},
			{ calls },
		);

		const bootstrapFn = async () => {
			bootstrapCalled = true;
			orchReady = true;
			markerPresent = true;
			return true;
		};

		const code = await runShip({
			cwd: tmpDir,
			tmuxSpawnFn: statefulSpawnFn,
			bootstrapFn,
			statFn: () => markerPresent,
			sleepFn: () => {},
			waitTimeoutMs: 5_000,
		});

		expect(code).toBe(0);
		expect(bootstrapCalled).toBe(true);

		const sendKeys = statefulSpawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeDefined();
		expect(sendKeys?.args).toContain('/cam-ship');
	});

	test('returns 1 when bootstrap fails', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-ship-boot-fail-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		const code = await runShip({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => false,
		});

		expect(code).toBe(1);
	});

	test('returns 1 when marker never appears (timeout)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-ship-timeout-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		const code = await runShip({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => true,
			statFn: () => false,
			sleepFn: () => {},
			waitTimeoutMs: 5,
		});

		expect(code).toBe(1);
	});
});

// --- runShip (thin-proxy): pane-not-found path --------------------------------

describe('runShip (thin-proxy, pane lookup)', () => {
	test('returns 1 when getOrchPaneId returns null (list-panes fails)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-ship-nopane-'));
		const spawnFn: TmuxSpawnFn & { calls: TmuxCall[] } = (() => {
			const calls: TmuxCall[] = [];
			const fn = ((cmd: string, args: string[]) => {
				calls.push({ cmd, args: [...args] });
				const base: SpawnSyncReturns<Buffer> = {
					pid: 1,
					output: [null, Buffer.from(''), Buffer.from('')],
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
					status: 0,
					signal: null,
				};
				const subcommand = args[0] === '-L' ? args[2] : args[0];
				if (subcommand === 'has-session') return base;
				if (subcommand === 'list-panes') {
					const fIdx = args.indexOf('-F');
					const fmt = fIdx !== -1 ? (args[fIdx + 1] ?? '') : '';
					if (fmt === '#{pane_index}\t#{pane_current_command}') {
						return { ...base, stdout: Buffer.from('0\tclaude\n') };
					}
					return { ...base, stdout: Buffer.from('') };
				}
				return base;
			}) as TmuxSpawnFn & { calls: TmuxCall[] };
			fn.calls = calls;
			return fn;
		})();

		const code = await runShip({ cwd: tmpDir, tmuxSpawnFn: spawnFn });
		expect(code).toBe(1);
	});
});

// --- runShip: session name used in all tmux calls ----------------------------

describe('runShip: session name', () => {
	test('all tmux calls include the project session name', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-ship-sessname-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });
		const sessionName = projectSessionName(tmpDir);

		await runShip({ cwd: tmpDir, tmuxSpawnFn: spawnFn });

		const callsWithSession = spawnFn.calls.filter((c) => c.args.includes(sessionName));
		expect(callsWithSession.length).toBeGreaterThan(0);
	});
});
