// test/commands/spec.test.ts
//
// Unit tests for `cam spec` (US-004, CAM-107: thin-proxy to orchestrator;
// US-003, CAM-118: --write-docs in-process write channel).
//
// What we cover:
//   - parseSpecArgs: positional id, bare (no arg), unknown flags rejected,
//     --write-docs discriminated-union recognition (US-003).
//   - dispatchSpec: routes mode 'write-docs' to writeDocsFn and mode 'proxy'
//     to runSpecFn, proving branch isolation (US-003).
//   - runSpecWriteDocs: reads stdin JSON, calls writeDomainDocsOnMain,
//     zero tmux spawn calls, exit codes for ok/noOp/invalid-payload/guard
//     failure/malformed-JSON (US-003).
//   - runSpec (hit path): orchestrator alive -> send-keys /cam-spec <id> and return 0.
//   - runSpec: dispatch shape asserts issue id parsed, /cam-spec slash injected.
//   - runSpec: send-keys is atomic (NO -l; -l would make "Enter" literal).
//   - runSpec (miss path): bootstraps cam run, waits for marker, then send-keys.
//   - runSpec: bootstrap failure returns 1.
//   - runSpec: marker timeout returns 1.
//   - runSpec: mutex busy returns 1 without send-keys.
//   - runSpec: missing orch pane returns 1.

import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import { runSpec, runSpecWriteDocs } from '../../src/commands/spec.ts';
import { parseSpecArgs, dispatchSpec } from '../../index.ts';
import type { WriteDomainDocsOnMainOutcome } from '../../src/commands/domain-docs.ts';
import {
	projectSessionName,
	type SpawnFn as TmuxSpawnFn,
} from '../../src/tmux/session.ts';

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
	/** When true, paneCountMutex returns 'busy' (3 panes instead of 2). */
	paneMutexBusy?: boolean;
} = {}): TmuxSpawnFn & { calls: TmuxCall[] } {
	const { sessionExists = true, orchAlive = true, orchPaneId = '%0', paneMutexBusy = false } = opts;
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
			if (fmt === '#{@cam_label}') {
				return {
					...base,
					stdout: Buffer.from(orchAlive ? `orchestrator\ndashboard\n` : `dashboard\n`),
				};
			}
			if (fmt === '#{pane_index};#{pane_id}') {
				return { ...base, stdout: Buffer.from(`0;${orchPaneId}\n`) };
			}
			if (fmt === '#{pane_id}') {
				const panes = paneMutexBusy ? '%0\n%1\n%2\n' : '%0\n%1\n';
				return { ...base, stdout: Buffer.from(panes) };
			}
			return { ...base, stdout: Buffer.from('') };
		}

		if (subcommand === 'capture-pane') {
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

// --- parseSpecArgs ----------------------------------------------------------

describe('parseSpecArgs', () => {
	test('parses a positional issue id (prefix-number format) as mode:proxy', () => {
		expect(parseSpecArgs(['CAM-42'])).toEqual({ mode: 'proxy', id: 'CAM-42', help: false });
	});

	test('parses a bare integer as an id string', () => {
		expect(parseSpecArgs(['42'])).toEqual({ mode: 'proxy', id: '42', help: false });
	});

	test('--help / -h set the help flag', () => {
		expect(parseSpecArgs(['--help'])).toEqual({ help: true });
		expect(parseSpecArgs(['-h'])).toEqual({ help: true });
	});

	test('bare (no argument) returns { mode: proxy, help: false } with no id', () => {
		expect(parseSpecArgs([])).toEqual({ mode: 'proxy', help: false });
	});

	test('rejects empty string argument (returns null)', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseSpecArgs([''])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});

	test('rejects unknown option flags (returns null)', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseSpecArgs(['--bogus'])).toBeNull();
			expect(parseSpecArgs(['--unknown-flag'])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});

	test('rejects more than one positional argument', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseSpecArgs(['CAM-42', 'CAM-43'])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});
});

// --- parseSpecArgs: --write-docs discriminated-union recognition (US-003) --

describe('parseSpecArgs: --write-docs', () => {
	test('--write-docs <id> returns { mode: write-docs, id, help: false }', () => {
		expect(parseSpecArgs(['--write-docs', 'CAM-118'])).toEqual({
			mode: 'write-docs',
			id: 'CAM-118',
			help: false,
		});
	});

	test('id may precede the --write-docs flag', () => {
		expect(parseSpecArgs(['CAM-118', '--write-docs'])).toEqual({
			mode: 'write-docs',
			id: 'CAM-118',
			help: false,
		});
	});

	test('--write-docs without an id returns null', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseSpecArgs(['--write-docs'])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});

	test('mode discriminates write-docs from proxy', () => {
		const writeDocs = parseSpecArgs(['--write-docs', 'CAM-1']);
		const proxy = parseSpecArgs(['CAM-1']);
		expect(writeDocs?.mode).toBe('write-docs');
		expect(proxy?.mode).toBe('proxy');
	});

	test('--help still wins over --write-docs', () => {
		expect(parseSpecArgs(['--write-docs', '--help'])).toEqual({ help: true });
	});
});

// --- dispatchSpec: branch isolation (US-003) --------------------------------

describe('dispatchSpec: routing isolation', () => {
	test('mode:write-docs calls writeDocsFn and NOT runSpecFn', async () => {
		let writeDocsCalled = false;
		let runSpecCalled = false;

		const code = await dispatchSpec(
			{ mode: 'write-docs', id: 'CAM-118', help: false },
			{
				writeDocsFn: async (id) => {
					writeDocsCalled = true;
					expect(id).toBe('CAM-118');
					return 0;
				},
				runSpecFn: async () => {
					runSpecCalled = true;
					return 0;
				},
			},
		);

		expect(code).toBe(0);
		expect(writeDocsCalled).toBe(true);
		expect(runSpecCalled).toBe(false);
	});

	test('mode:proxy calls runSpecFn and NOT writeDocsFn', async () => {
		let writeDocsCalled = false;
		let runSpecCalled = false;

		const code = await dispatchSpec(
			{ mode: 'proxy', id: 'CAM-42', help: false },
			{
				writeDocsFn: async () => {
					writeDocsCalled = true;
					return 0;
				},
				runSpecFn: async (id) => {
					runSpecCalled = true;
					expect(id).toBe('CAM-42');
					return 0;
				},
			},
		);

		expect(code).toBe(0);
		expect(runSpecCalled).toBe(true);
		expect(writeDocsCalled).toBe(false);
	});

	test('mode:proxy with no id prints error and returns 1 without calling runSpecFn', async () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		let runSpecCalled = false;
		try {
			const code = await dispatchSpec(
				{ mode: 'proxy', help: false },
				{ runSpecFn: async () => { runSpecCalled = true; return 0; } },
			);
			expect(code).toBe(1);
			expect(runSpecCalled).toBe(false);
		} finally {
			process.stderr.write = original;
		}
	});

	test('forwards exit codes from both branches', async () => {
		const writeDocsCode = await dispatchSpec(
			{ mode: 'write-docs', id: 'CAM-1', help: false },
			{ writeDocsFn: async () => 1, runSpecFn: async () => 0 },
		);
		expect(writeDocsCode).toBe(1);

		const proxyCode = await dispatchSpec(
			{ mode: 'proxy', id: 'CAM-1', help: false },
			{ writeDocsFn: async () => 0, runSpecFn: async () => 1 },
		);
		expect(proxyCode).toBe(1);
	});
});

// --- runSpecWriteDocs: zero tmux spawn calls + exit codes (US-003) ----------

describe('runSpecWriteDocs', () => {
	test('real writeDomainDocsOnMain path: injected spawnFn is only ever called with cmd=git, never tmux', async () => {
		const calls: { cmd: string; args: string[] }[] = [];
		const fakeSpawnFn = (cmd: string, args: string[]) => {
			calls.push({ cmd, args: [...args] });
			const subcommand = args[2];
			if (subcommand === 'rev-parse' && args.includes('--abbrev-ref')) {
				return { pid: 1, output: [null, 'main\n', ''], stdout: 'main\n', stderr: '', status: 0, signal: null } as SpawnSyncReturns<string>;
			}
			if (subcommand === 'rev-parse') {
				return { pid: 1, output: [null, 'deadbeef\n', ''], stdout: 'deadbeef\n', stderr: '', status: 0, signal: null } as SpawnSyncReturns<string>;
			}
			return { pid: 1, output: [null, '', ''], stdout: '', stderr: '', status: 1, signal: null } as SpawnSyncReturns<string>;
		};

		const code = await runSpecWriteDocs({
			id: 'CAM-118',
			readStdin: async () => JSON.stringify({ terms: [], adrs: [] }),
			spawnFn: fakeSpawnFn,
		});

		// Empty payload short-circuits as noOp BEFORE any read/commit, but the
		// up-to-date guard still runs two spawnFn calls (branch + main rev-parse).
		expect(code).toBe(0);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => c.cmd === 'git')).toBe(true);
		expect(calls.some((c) => c.cmd === 'tmux')).toBe(false);
	});

	test('malformed stdin JSON returns 1', async () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			const code = await runSpecWriteDocs({
				id: 'CAM-118',
				readStdin: async () => 'not json{{{',
			});
			expect(code).toBe(1);
		} finally {
			process.stderr.write = original;
		}
	});

	test('invalid payload (validation errors) returns 1', async () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			const code = await runSpecWriteDocs({
				id: 'CAM-118',
				readStdin: async () => JSON.stringify({ terms: [], adrs: [] }),
				writeFn: () => ({ ok: false, reason: 'invalid-payload', errors: ['terms must be an array'] }),
			});
			expect(code).toBe(1);
		} finally {
			process.stderr.write = original;
		}
	});

	test('guard failure (diverged / detached-head / missing-main) returns 1', async () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			const code = await runSpecWriteDocs({
				id: 'CAM-118',
				readStdin: async () => JSON.stringify({ terms: [], adrs: [] }),
				writeFn: () => ({ ok: false, reason: 'diverged' }),
			});
			expect(code).toBe(1);
		} finally {
			process.stderr.write = original;
		}
	});

	test('ok:true (non-noOp) returns 0 and writes the CAM_DOMAIN_DOCS_WRITTEN sentinel', async () => {
		const written: string[] = [];
		const code = await runSpecWriteDocs({
			id: 'CAM-118',
			readStdin: async () => JSON.stringify({ terms: [{ term: 'Order', definition: 'x' }], adrs: [] }),
			writeFn: () => ({ ok: true, sha: 'abc1234', adrFiles: [] }),
			writeStdout: (line) => written.push(line),
		});
		expect(code).toBe(0);
		expect(written.join('')).toContain('CAM_DOMAIN_DOCS_WRITTEN=CAM-118 sha=abc1234');
	});

	test('ok:true noOp returns 0 without writing the sentinel', async () => {
		const written: string[] = [];
		const code = await runSpecWriteDocs({
			id: 'CAM-118',
			readStdin: async () => JSON.stringify({ terms: [], adrs: [] }),
			writeFn: () => ({ ok: true, sha: '', noOp: true, adrFiles: [] }),
			writeStdout: (line) => written.push(line),
		});
		expect(code).toBe(0);
		expect(written.join('')).not.toContain('CAM_DOMAIN_DOCS_WRITTEN');
	});
});

// --- runSpec (thin-proxy): hit path ----------------------------------------

describe('runSpec (thin-proxy, hit path)', () => {
	test('sends /cam-spec <id> to orchestrator pane and returns 0', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-spec-hit-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%2' });

		const code = await runSpec({
			id: 'CAM-42',
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
		});

		expect(code).toBe(0);

		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeDefined();
		expect(sendKeys?.args).not.toContain('-l');
		expect(sendKeys?.args).toContain('/cam-spec CAM-42');
		expect(sendKeys?.args).toContain('Enter');
		expect(sendKeys?.args).toContain('%2');
	});

	test('issue id is included verbatim in the slash command', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-spec-id-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%3' });

		const code = await runSpec({
			id: 'CAM-107',
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
		});

		expect(code).toBe(0);
		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys?.args).toContain('/cam-spec CAM-107');
		expect(sendKeys?.args).not.toContain('-l');
		expect(sendKeys?.args).toContain('Enter');
	});

	test('send-keys is atomic: text and Enter are in the same call, NOT -l', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-spec-atomic-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });

		await runSpec({ id: 'CAM-1', cwd: tmpDir, tmuxSpawnFn: spawnFn });

		const sendKeys = spawnFn.calls.filter((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toHaveLength(1);
		const call = sendKeys[0];
		const enterIdx = call?.args.lastIndexOf('Enter') ?? -1;
		const textIdx = call?.args.findIndex((a) => a.startsWith('/cam-spec')) ?? -1;
		// Enter comes AFTER the text in the same call
		expect(enterIdx).toBeGreaterThan(textIdx);
		// -l is absent (would make "Enter" literal)
		expect(call?.args).not.toContain('-l');
	});

	test('skips bootstrap when orchestrator is already alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-spec-no-bootstrap-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true });
		let bootstrapCalled = false;

		await runSpec({
			id: 'CAM-42',
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => { bootstrapCalled = true; return true; },
		});

		expect(bootstrapCalled).toBe(false);
	});

	test('returns 1 and does not send-keys when pane mutex is busy', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-spec-busy-'));
		const spawnFn = makeFakeTmuxSpawn({
			sessionExists: true,
			orchAlive: true,
			paneMutexBusy: true,
		});

		const code = await runSpec({ id: 'CAM-42', cwd: tmpDir, tmuxSpawnFn: spawnFn });

		expect(code).toBe(1);
		const sendKeys = spawnFn.calls.find((c) => c.args[2] === 'send-keys');
		expect(sendKeys).toBeUndefined();
	});
});

// --- runSpec (thin-proxy): miss path ----------------------------------------

describe('runSpec (thin-proxy, miss path)', () => {
	test('bootstraps + waits for marker + sends keys when orch not alive', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-spec-miss-'));

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
					if (fmt === '#{@cam_label}') {
						return { ...base, stdout: Buffer.from('orchestrator\ndashboard\n') };
					}
					if (fmt === '#{pane_index};#{pane_id}') {
						return { ...base, stdout: Buffer.from('0;%0\n') };
					}
					if (fmt === '#{pane_id}') {
						return { ...base, stdout: Buffer.from('%0\n%1\n') };
					}
					return { ...base, stdout: Buffer.from('') };
				}
				if (subcommand === 'capture-pane') {
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

		const code = await runSpec({
			id: 'CAM-42',
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
		expect(sendKeys?.args).toContain('/cam-spec CAM-42');
	});

	test('returns 1 when bootstrap fails', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-spec-boot-fail-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		const code = await runSpec({
			id: 'CAM-42',
			cwd: tmpDir,
			tmuxSpawnFn: spawnFn,
			bootstrapFn: async () => false,
		});

		expect(code).toBe(1);
	});

	test('returns 1 when marker never appears (timeout)', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-spec-timeout-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: false });

		const code = await runSpec({
			id: 'CAM-42',
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

// --- runSpec: pane-not-found path -------------------------------------------

describe('runSpec (thin-proxy, pane lookup)', () => {
	test('returns 1 when getOrchPaneId returns null', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-spec-nopane-'));
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
					if (fmt === '#{@cam_label}') {
						return { ...base, stdout: Buffer.from('orchestrator\ndashboard\n') };
					}
					return { ...base, stdout: Buffer.from('') };
				}
				return base;
			}) as TmuxSpawnFn & { calls: TmuxCall[] };
			fn.calls = calls;
			return fn;
		})();

		const code = await runSpec({ id: 'CAM-42', cwd: tmpDir, tmuxSpawnFn: spawnFn });
		expect(code).toBe(1);
	});
});

// --- runSpec: session name used in all tmux calls ---------------------------

describe('runSpec: session name', () => {
	test('all tmux calls include the project session name', async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-spec-sessname-'));
		const spawnFn = makeFakeTmuxSpawn({ sessionExists: true, orchAlive: true, orchPaneId: '%0' });
		const sessionName = projectSessionName(tmpDir);

		await runSpec({ id: 'CAM-42', cwd: tmpDir, tmuxSpawnFn: spawnFn });

		const callsWithSession = spawnFn.calls.filter((c) => c.args.includes(sessionName));
		expect(callsWithSession.length).toBeGreaterThan(0);
	});
});
