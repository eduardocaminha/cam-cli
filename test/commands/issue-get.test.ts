// test/commands/issue-get.test.ts
//
// Unit tests for getIssueOnMain (US-002, CAM-400) — deterministic, read-only
// `git show main:<path>` fetch of a single issue's JSON. All git calls are
// injected fakes; no real subprocess is ever spawned.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { getIssueOnMain } from '../../src/commands/issue-get.ts';
import type { BacklogSpawnFn } from '../../src/issues/backlog.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResult(stdout: string): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
}

function failResult(stderr = "fatal: path 'x' does not exist"): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, '', stderr], stdout: '', stderr, status: 128, signal: null };
}

interface SpawnCall {
	cmd: string;
	args: string[];
}

/** Build a recording spawnFn for `git show`. */
function makeShowSpawn(opts: { content?: string; missing?: boolean } = {}): {
	spawnFn: BacklogSpawnFn;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const spawnFn: BacklogSpawnFn = (cmd, args, _opts) => {
		calls.push({ cmd, args });
		if (opts.missing) return failResult();
		return okResult(opts.content ?? '{}\n');
	};
	return { spawnFn, calls };
}

// ---------------------------------------------------------------------------
// AC1 (US-002): resolves the zero-padded filename, reads via `git show
// main:<path>` through an injected spawnFn, returns content on success,
// { ok: false, reason: 'not-found' } when the id does not exist.
// ---------------------------------------------------------------------------

describe('getIssueOnMain', () => {
	test('resolves the zero-padded issue filename (CAM-42 -> CAM-0042.json)', () => {
		const { spawnFn, calls } = makeShowSpawn({ content: '{"id":"CAM-42"}\n' });
		getIssueOnMain('/fake/project', 'CAM-42', spawnFn);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual([
			'-C',
			'/fake/project',
			'show',
			'main:scripts/cam/issues/CAM-0042.json',
		]);
	});

	test('short numeric suffixes are zero-padded to 4 digits', () => {
		const { spawnFn, calls } = makeShowSpawn({ content: '{"id":"CAM-1"}\n' });
		getIssueOnMain('/fake/project', 'CAM-1', spawnFn);
		expect(calls[0]?.args).toContain('main:scripts/cam/issues/CAM-0001.json');
	});

	test('4+ digit ids are left unpadded further (CAM-1000 stays CAM-1000)', () => {
		const { spawnFn, calls } = makeShowSpawn({ content: '{"id":"CAM-1000"}\n' });
		getIssueOnMain('/fake/project', 'CAM-1000', spawnFn);
		expect(calls[0]?.args).toContain('main:scripts/cam/issues/CAM-1000.json');
	});

	test('success returns { ok: true, id, content } with the raw git show stdout', () => {
		const content = '{\n  "id": "CAM-42",\n  "title": "Example"\n}\n';
		const { spawnFn } = makeShowSpawn({ content });
		const result = getIssueOnMain('/fake/project', 'CAM-42', spawnFn);
		expect(result).toEqual({ ok: true, id: 'CAM-42', content });
	});

	test('reads from the `main` ref, never the working tree', () => {
		const { spawnFn, calls } = makeShowSpawn({ content: '{}\n' });
		getIssueOnMain('/fake/project', 'CAM-7', spawnFn);
		const showArg = calls[0]?.args.at(-1);
		expect(showArg?.startsWith('main:')).toBe(true);
	});

	test('non-existent id: git show exits nonzero, returns { ok: false, reason: not-found }', () => {
		const { spawnFn } = makeShowSpawn({ missing: true });
		const result = getIssueOnMain('/fake/project', 'CAM-999', spawnFn);
		expect(result).toEqual({ ok: false, reason: 'not-found' });
	});

	test('every git call is driven through the injected spawnFn (no real shell-out surface)', () => {
		const { spawnFn, calls } = makeShowSpawn({ content: '{}\n' });
		getIssueOnMain('/fake/project', 'CAM-42', spawnFn);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toBe('git');
	});

	test('defaults spawnFn to node:child_process.spawnSync when omitted (structural: does not throw on call shape)', () => {
		// Not exercised against a real repo here (that would be an integration
		// test); this only proves the parameter is optional per the injectable-
		// spawnSync convention (mirrors readBacklogFromMain).
		expect(getIssueOnMain.length).toBe(2);
	});
});
