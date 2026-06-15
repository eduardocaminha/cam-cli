// test/plan.test.ts
//
// Unit tests for `cam plan` (US-006: thin-proxy to orchestrator).
//
// What we cover:
//   - parsePlanArgs: positional integer, leading-# tolerance, bare (no arg),
//     and standardized error on any present-but-non-integer token.
//   - runPlan (hit path): orchestrator alive → send-keys /cam-plan [N] and return 0.
//   - runPlan (miss path): bootstraps cam run, waits for marker, then send-keys.
//   - runPlan: bootstrap failure returns 1.
//   - runPlan: marker timeout returns 1.
//   - runPlan: missing orch pane returns 1.
//   - send-keys is atomic (-l flag, text + Enter in same call).

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { runPlan } from '../src/commands/plan.ts';
import { parsePlanArgs } from '../index.ts';
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
 *
 * @param sessionExists  Whether has-session returns 0 (session exists).
 * @param orchAlive      Whether pane index 0 is running 'claude'.
 * @param orchPaneId     Pane ID returned by list-panes for index 0.
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
		// With -L cam prefix: args[0]='-L', args[1]='cam', args[2]=subcommand.
		const subcommand = args[0] === '-L' ? args[2] : args[0];

		if (subcommand === 'has-session') {
			return { ...base, status: sessionExists ? 0 : 1 };
		}

		if (subcommand === 'list-panes') {
			if (!sessionExists) return { ...base, status: 1 };
			const fIdx = args.indexOf('-F');
			const fmt = fIdx !== -1 ? (args[fIdx + 1] ?? '') : '';
			if (fmt === '#{pane_index}\t#{pane_current_command}') {
				// For orchestratorAlive: return pane 0 running claude (or not).
				return {
					...base,
					stdout: Buffer.from(orchAlive ? `0\tclaude\n` : `0\tsh\n`),
				};
			}
			if (fmt === '#{pane_index}\t#{pane_id}') {
				// For getOrchPaneId: return pane 0 with orchPaneId.
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

// --- parsePlanArgs (strict, number-only CLI contract) ----------------------

describe('parsePlanArgs', () => {
	test('parses a positional integer issue number', () => {
		expect(parsePlanArgs(['21'])).toEqual({ issue: 21, help: false });
	});

	test('tolerates a leading `#` on the number', () => {
		expect(parsePlanArgs(['#21'])).toEqual({ issue: 21, help: false });
	});

	test('bare (no argument) leaves issue undefined', () => {
		expect(parsePlanArgs([])).toEqual({ help: false });
	});

	test('--help / -h set the help flag', () => {
		expect(parsePlanArgs(['--help'])).toEqual({ help: true });
		expect(parsePlanArgs(['-h'])).toEqual({ help: true });
	});

	test('rejects a present-but-non-integer token (returns null)', () => {
		expect(parsePlanArgs(['abc'])).toBeNull();
		expect(parsePlanArgs(['1.5'])).toBeNull();
		expect(parsePlanArgs(['21abc'])).toBeNull();
		expect(parsePlanArgs(['#abc'])).toBeNull();
		expect(parsePlanArgs([''])).toBeNull();
	});

	test('rejects zero and negatives', () => {
		expect(parsePlanArgs(['0'])).toBeNull();
		expect(parsePlanArgs(['-5'])).toBeNull();
	});

	test('rejects the removed --issue flag and any unknown option', () => {
		expect(parsePlanArgs(['--issue', '21'])).toBeNull();
		expect(parsePlanArgs(['--issue=21'])).toBeNull();
		expect(parsePlanArgs(['--bogus'])).toBeNull();
	});

	test('rejects more than one positional argument', () => {
		expect(parsePlanArgs(['21', '22'])).toBeNull();
	});
});

// --- runPlan (thin-proxy): hit path ----------------------------------------

describe('runPlan (thin-proxy, hit path)', () => {
	test('sends /cam-plan to orchestrator pane and returns 0', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-hit-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%2' });

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
		});

		expect(code).toBe(0);

		// Verify send-keys was called with /cam-plan.
		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeDefined();
		expect(sendKeys?.args).toContain('-l');
		expect(sendKeys?.args).toContain('/cam-plan');
		expect(sendKeys?.args).toContain('Enter');
		expect(sendKeys?.args).toContain('%2');
	});

	test('sends /cam-plan N when issue is provided', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-hit-issue-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%3' });

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			issue: 42,
		});

		expect(code).toBe(0);
		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys?.args).toContain('/cam-plan 42');
		expect(sendKeys?.args).toContain('-l');
		expect(sendKeys?.args).toContain('Enter');
	});

	test('send-keys is atomic: text and Enter are in the same send-keys call', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-atomic-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

		await runPlan({ cwd: tmpDir, tmuxSpawnFn: spawnFn });

		// One send-keys call with both the text and 'Enter' as separate args.
		const sendKeys = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toHaveLength(1);
		const call = sendKeys[0];
		// 'Enter' must be a discrete argument (not concatenated with the text).
		const enterIdx = call?.args.lastIndexOf('Enter') ?? -1;
		const textIdx = call?.args.findIndex((a) => a.startsWith('/cam-plan')) ?? -1;
		expect(enterIdx).toBeGreaterThan(textIdx);
	});

	test('uses -l flag for literal send-keys (metachar safety)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-literal-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

		await runPlan({ cwd: tmpDir, tmuxSpawnFn: spawnFn });

		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys?.args).toContain('-l');
	});

	test('skips bootstrap when orchestrator is already alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-no-bootstrap-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		let bootstrapCalled = false;

		await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => { bootstrapCalled = true; return true; },
		});

		expect(bootstrapCalled).toBe(false);
	});
});

// --- runPlan (thin-proxy): miss path ----------------------------------------

describe('runPlan (thin-proxy, miss path)', () => {
	test('bootstraps + waits for marker + sends keys when orch not alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-miss-'));

		let bootstrapCalled = false;
		let markerPresent = false;
		let orchReady = false; // transitions to true when bootstrapFn fires

		// Stateful spawn fn: session/orch not alive until bootstrapFn sets orchReady.
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

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: statefulSpawnFn,
			bootstrapFn,
			statFn: () => markerPresent,
			sleepFn: () => {},
			waitTimeoutMs: 5_000,
		});

		expect(code).toBe(0);
		expect(bootstrapCalled).toBe(true);

		// send-keys should have fired.
		const sendKeys = statefulSpawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeDefined();
		expect(sendKeys?.args).toContain('/cam-plan');
	});

	test('returns 1 when bootstrap fails', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-boot-fail-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => false, // bootstrap fails
		});

		expect(code).toBe(1);
	});

	test('returns 1 when marker never appears (timeout)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-timeout-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		const code = await runPlan({
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => true, // bootstrap succeeds
			statFn: () => false, // marker never appears
			sleepFn: () => {},
			waitTimeoutMs: 5, // tiny budget
		});

		expect(code).toBe(1);
	});
});

// --- runPlan (thin-proxy): pane-not-found path ------------------------------

describe('runPlan (thin-proxy, pane lookup)', () => {
	test('returns 1 when getOrchPaneId returns null (list-panes fails)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-nopane-'));
		// Session exists, orch alive, but list-panes returns empty for pane-id lookup.
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
				if (subcommand === 'has-session') return base; // session exists (status 0)
				if (subcommand === 'list-panes') {
					const fIdx = args.indexOf('-F');
					const fmt = fIdx !== -1 ? (args[fIdx + 1] ?? '') : '';
					if (fmt === '#{pane_index}\t#{pane_current_command}') {
						// orchestratorAlive: pane 0 running claude
						return { ...base, stdout: Buffer.from('0\tclaude\n') };
					}
					// getOrchPaneId: return empty (no pane found)
					return { ...base, stdout: Buffer.from('') };
				}
				return base;
			}) as TmuxSpawnFn & { calls: TmuxCall[] };
			fn.calls = calls;
			return fn;
		})();

		const code = await runPlan({ cwd: tmpDir, tmuxSpawnFn: spawnFn });
		expect(code).toBe(1);
	});
});

// --- runPlan: session name used in all tmux calls ---------------------------

describe('runPlan: session name', () => {
	test('all tmux calls include the project session name', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-sessname-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });
		const sessionName = projectSessionName(tmpDir);

		await runPlan({ cwd: tmpDir, tmuxSpawnFn: spawnFn });

		const callsWithSession = spawnFn.calls.filter((c) => c.args.includes(sessionName));
		expect(callsWithSession.length).toBeGreaterThan(0);
	});
});
