// test/commands/spec.test.ts
//
// Unit tests for the deterministic internal `gship spec` write channels.
//
// What we cover:
//   - parseSpecArgs: operator-facing invocations move to `gship web`, unknown
//     flags are rejected, and both internal modes are recognized.
//   - dispatchSpec: routes mode 'write-docs' to writeDocsFn, mode 'persist'
//     to persistFn, proving branch isolation.
//   - runSpecWriteDocs: reads stdin JSON, calls writeDomainDocsOnMain,
//     zero tmux spawn calls, exit codes for ok/noOp/invalid-payload/guard
//     failure/malformed-JSON (US-003).
//   - runSpecPersist: reads stdin JSON, calls specifyIssueOnMain, zero tmux
//     spawn calls, exit codes for ok / each reason / malformed-JSON (US-001,
//     CAM-213).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { runSpecWriteDocs, runSpecPersist } from '../../src/commands/spec.ts';
import { parseSpecArgs, dispatchSpec } from '../../index.ts';
import type { SpecifyIssueOnMainOutcome } from '../../src/commands/issue-specify.ts';

// --- parseSpecArgs ----------------------------------------------------------

describe('parseSpecArgs', () => {
	test('--help / -h set the help flag', () => {
		expect(parseSpecArgs(['--help'])).toEqual({ help: true });
		expect(parseSpecArgs(['-h'])).toEqual({ help: true });
	});

	test('operator-facing id and bare invocations move to gship web', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseSpecArgs(['CAM-42'])).toBeNull();
			expect(parseSpecArgs(['42'])).toBeNull();
			expect(parseSpecArgs([])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
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

	test('mode is write-docs', () => {
		expect(parseSpecArgs(['--write-docs', 'CAM-1'])?.mode).toBe('write-docs');
	});

	test('--help still wins over --write-docs', () => {
		expect(parseSpecArgs(['--write-docs', '--help'])).toEqual({ help: true });
	});
});

// --- parseSpecArgs: --persist discriminated-union recognition (US-001, CAM-213) --

describe('parseSpecArgs: --persist', () => {
	test('--persist <id> returns { mode: persist, id, help: false }', () => {
		expect(parseSpecArgs(['--persist', 'CAM-213'])).toEqual({
			mode: 'persist',
			id: 'CAM-213',
			help: false,
		});
	});

	test('id may precede the --persist flag', () => {
		expect(parseSpecArgs(['CAM-213', '--persist'])).toEqual({
			mode: 'persist',
			id: 'CAM-213',
			help: false,
		});
	});

	test('--persist without an id returns null', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseSpecArgs(['--persist'])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});

	test('mode discriminates persist from write-docs', () => {
		const persist = parseSpecArgs(['--persist', 'CAM-1']);
		const writeDocs = parseSpecArgs(['--write-docs', 'CAM-1']);
		expect(persist?.mode).toBe('persist');
		expect(writeDocs?.mode).toBe('write-docs');
	});

	test('--help still wins over --persist', () => {
		expect(parseSpecArgs(['--persist', '--help'])).toEqual({ help: true });
	});
});

// --- dispatchSpec: deterministic branch isolation --------------------------

describe('dispatchSpec: routing isolation', () => {
	test('mode:write-docs calls only writeDocsFn and forwards its exit code', async () => {
		let persistCalled = false;
		const code = await dispatchSpec(
			{ mode: 'write-docs', id: 'CAM-118', help: false },
			{
				writeDocsFn: async (id) => {
					expect(id).toBe('CAM-118');
					return 1;
				},
				persistFn: async () => {
					persistCalled = true;
					return 0;
				},
			},
		);

		expect(code).toBe(1);
		expect(persistCalled).toBe(false);
	});

	test('mode:persist calls only persistFn and forwards its exit code', async () => {
		let writeDocsCalled = false;
		const code = await dispatchSpec(
			{ mode: 'persist', id: 'CAM-213', help: false },
			{
				persistFn: async (id) => {
					expect(id).toBe('CAM-213');
					return 1;
				},
				writeDocsFn: async () => {
					writeDocsCalled = true;
					return 0;
				},
			},
		);

		expect(code).toBe(1);
		expect(writeDocsCalled).toBe(false);
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

// --- runSpecPersist: zero tmux spawn calls + exit codes (US-001, CAM-213) ---

const VALID_PERSIST_STDIN = JSON.stringify({
	spec: {
		acceptanceCriteria: ['a'],
		scope: 'in-scope description',
		gotchas: [],
		domainTerms: [],
	},
	wsjf: { value: 5, timeCriticality: 5, riskReduction: 5, jobSize: 5 },
});

describe('runSpecPersist', () => {
	test('real specifyIssueOnMain path: injected spawnFn is only ever called with cmd=git, never tmux', async () => {
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

		const code = await runSpecPersist({
			id: 'CAM-213',
			readStdin: async () => VALID_PERSIST_STDIN,
			spawnFn: fakeSpawnFn,
		});

		// A non-existent backlog entry short-circuits as not-found, but the
		// up-to-date guard + backlog read still exercise real git spawnFn calls.
		expect(code).toBe(1);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => c.cmd === 'git')).toBe(true);
		expect(calls.some((c) => c.cmd === 'tmux')).toBe(false);
	});

	test('top-level JSON null on the real specifyIssueOnMain path returns 1 with reason=invalid-spec and never spawns git', async () => {
		const calls: { cmd: string; args: string[] }[] = [];
		const fakeSpawnFn = (cmd: string, args: string[]) => {
			calls.push({ cmd, args: [...args] });
			return { pid: 1, output: [null, '', ''], stdout: '', stderr: '', status: 0, signal: null } as SpawnSyncReturns<string>;
		};
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		const written: string[] = [];
		try {
			const code = await runSpecPersist({
				id: 'CAM-999',
				readStdin: async () => 'null',
				spawnFn: fakeSpawnFn,
				writeStdout: (line) => written.push(line),
			});
			expect(code).toBe(1);
			expect(calls.length).toBe(0);
			expect(written.join('')).toContain('CAM_SPEC_RESULT=ERROR reason=invalid-spec');
		} finally {
			process.stderr.write = original;
		}
	});

	test('malformed stdin JSON returns 1 with reason=invalid-json; specifyIssueOnMain never called', async () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		let persistCalled = false;
		const written: string[] = [];
		try {
			const code = await runSpecPersist({
				id: 'CAM-213',
				readStdin: async () => 'not json{{{',
				persistFn: () => { persistCalled = true; return { ok: false, reason: 'not-found' }; },
				writeStdout: (line) => written.push(line),
			});
			expect(code).toBe(1);
			expect(persistCalled).toBe(false);
			expect(written.join('')).toContain('CAM_SPEC_RESULT=ERROR reason=invalid-json');
		} finally {
			process.stderr.write = original;
		}
	});

	test('top-level JSON null returns 1 with reason=invalid-spec; specifyIssueOnMain never called', async () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		let persistCalled = false;
		const written: string[] = [];
		try {
			const code = await runSpecPersist({
				id: 'CAM-213',
				readStdin: async () => 'null',
				persistFn: () => { persistCalled = true; return { ok: false, reason: 'not-found' }; },
				writeStdout: (line) => written.push(line),
			});
			expect(code).toBe(1);
			expect(persistCalled).toBe(false);
			expect(written.join('')).toContain('CAM_SPEC_RESULT=ERROR reason=invalid-spec');
		} finally {
			process.stderr.write = original;
		}
	});

	test('ok:true returns 0 and writes CAM_SPEC_RESULT=<id> sha=<sha>', async () => {
		const written: string[] = [];
		const code = await runSpecPersist({
			id: 'CAM-213',
			readStdin: async () => VALID_PERSIST_STDIN,
			persistFn: () => ({ ok: true, id: 'CAM-213', committedTo: 'main', sha: 'abc1234', branchWasMain: false }),
			writeStdout: (line) => written.push(line),
		});
		expect(code).toBe(0);
		expect(written.join('')).toContain('CAM_SPEC_RESULT=CAM-213 sha=abc1234');
	});

	const reasonCases: { name: string; outcome: SpecifyIssueOnMainOutcome }[] = [
		{ name: 'invalid-spec', outcome: { ok: false, reason: 'invalid-spec', errors: ['spec.problem required'] } },
		{ name: 'invalid-wsjf', outcome: { ok: false, reason: 'invalid-wsjf', errors: ['wsjf.value required'] } },
		{ name: 'not-found', outcome: { ok: false, reason: 'not-found' } },
		{ name: 'wrong-stage', outcome: { ok: false, reason: 'wrong-stage' } },
		{ name: 'not-open', outcome: { ok: false, reason: 'not-open' } },
		{ name: 'integrity-error', outcome: { ok: false, reason: 'integrity-error', errors: ['dangling blockedBy ref'] } },
		{ name: 'diverged', outcome: { ok: false, reason: 'diverged' } },
		{ name: 'detached-head', outcome: { ok: false, reason: 'detached-head' } },
		{ name: 'missing-main', outcome: { ok: false, reason: 'missing-main' } },
	];

	for (const { name, outcome } of reasonCases) {
		test(`reason=${name} returns 1 and writes CAM_SPEC_RESULT=ERROR reason=${name}`, async () => {
			const original = process.stderr.write.bind(process.stderr);
			process.stderr.write = (() => true) as typeof process.stderr.write;
			const written: string[] = [];
			try {
				const code = await runSpecPersist({
					id: 'CAM-213',
					readStdin: async () => VALID_PERSIST_STDIN,
					persistFn: () => outcome,
					writeStdout: (line) => written.push(line),
				});
				expect(code).toBe(1);
				expect(written.join('')).toContain(`CAM_SPEC_RESULT=ERROR reason=${name}`);
			} finally {
				process.stderr.write = original;
			}
		});
	}
});
