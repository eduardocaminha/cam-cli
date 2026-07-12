// test/issue-list.test.ts
//
// Tests for runIssueList() in src/commands/issue-list.ts (`cam issue list`).
//
// Coverage (US-002 acceptance criteria):
//   AC1: issue_system read (missing file/key defaults to 'local'); 'local'
//        reads the backlog via readBacklogFromMain and renders through the
//        src/logging print helpers with the injectable writer seam.
//   AC2: row shape -- priority (blank when unranked), id, [blocked: ...]
//        marker, title truncation; stage headings in lifecycle order.
//   AC3: --all includes the shipped group; default excludes shipped+abandoned.
//   AC4: 'linear'/'github' issue_system prints a native-UI hint and returns 0.
//   AC5: determinism -- the injected recording spawn proves the ONLY
//        subprocess calls are the git ls-tree/cat-file pair (never tmux,
//        never claude).
//
// Coverage (US-002, CAM-222 acceptance criteria -- `cam issue list --json`):
//   AC1: 'local' + --json writes pure JSON (JSON.parse-able, no emitTitle/
//        heading decoration) with exactly { counts, plannable, byStage }.
//   AC2: status:'abandoned' entries (including the specified+abandoned
//        zombie fixture) never appear in the JSON output.
//   AC4: --json with 'linear'/'github' keeps the existing hint behavior and
//        exits 0 (the JSON contract is 'local'-only).
//   AC5 (reuse): --json still routes through readBacklogFromMain, never a
//        raw working-tree read (same recording-spawn fixture proves it).
//
// All I/O is faked: project.toml is written to a real mkdtemp'd tmp dir
// (mirrors test/config/models.test.ts), and readBacklogFromMain's git calls
// are answered by an in-memory recording BacklogSpawnFn (mirrors
// test/issue-file.test.ts's makeRecordingSpawn pattern). No real git binary
// or tmux/claude process is ever invoked.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runIssueList } from '../src/commands/issue-list.ts';
import type { BacklogSpawnFn } from '../src/issues/backlog.ts';
import type { IssueEntry } from '../src/issues/types.ts';
import { stripAnsi } from '../src/logging/color.ts';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam-issue-list-test-'));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function writeProjectToml(content: string): string {
	const path = join(tmpDir, 'project.toml');
	writeFileSync(path, content, 'utf8');
	return path;
}

function makeIssue(overrides: Partial<IssueEntry> & { id: string }): IssueEntry {
	return {
		title: 'Test issue',
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		...overrides,
	};
}

/** cat-file --batch framing: `<oid> blob <size>\n<content>\n`. */
function frameBlobOutput(content: string): string {
	return `abc123 blob ${content.length}\n${content}\n`;
}

function okResult(stdout = ''): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
}

interface SpawnCall {
	cmd: string;
	args: string[];
}

/**
 * Builds a recording BacklogSpawnFn that answers `git ls-tree` with one
 * placeholder path per entry and `git cat-file --batch` with the framed JSON
 * blobs, in the same order as `entries`. Every call (cmd + args) is recorded
 * so tests can assert the ONLY subprocess usage is this git ls-tree/cat-file
 * pair (US-002 AC5).
 */
function makeRecordingBacklogSpawn(entries: IssueEntry[]): {
	spawnFn: BacklogSpawnFn;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const paths = entries.map((_e, i) => `scripts/cam/issues/CAM-${String(i + 1).padStart(4, '0')}.json`);
	const lsTreeOutput = paths.length > 0 ? `${paths.join('\n')}\n` : '';
	const catFileOutput = entries.map((e) => frameBlobOutput(`${JSON.stringify(e)}\n`)).join('');

	const spawnFn: BacklogSpawnFn = (cmd, args) => {
		calls.push({ cmd, args });
		if (args.includes('ls-tree')) return okResult(lsTreeOutput);
		if (args.includes('cat-file')) return okResult(catFileOutput);
		return okResult('');
	};

	return { spawnFn, calls };
}

/** Captures every chunk written through the injected writer seam as one string. */
function makeCapture(): { writer: (s: string) => void; plain: () => string } {
	let buf = '';
	return {
		writer: (s: string) => {
			buf += s;
		},
		plain: () => stripAnsi(buf),
	};
}

function lineWith(plain: string, needle: string): string {
	const line = plain.split('\n').find((l) => l.includes(needle));
	if (line === undefined) {
		throw new Error(`expected a line containing "${needle}" in:\n${plain}`);
	}
	return line;
}

// ---------------------------------------------------------------------------
// AC1: issue_system read + 'local' backend render path
// ---------------------------------------------------------------------------

describe('runIssueList — issue_system read (AC1)', () => {
	test('missing project.toml defaults to local and renders the backlog', () => {
		const entries = [makeIssue({ id: 'CAM-1', stage: 'idea' })];
		const { spawnFn, calls } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		const code = runIssueList({
			cwd: tmpDir,
			configPath: join(tmpDir, 'does-not-exist.toml'),
			spawnFn,
			writer,
		});

		expect(code).toBe(0);
		expect(plain()).toContain('CAM-1');
		expect(calls.length).toBeGreaterThan(0);
	});

	test('project.toml present without an issue_system key also defaults to local', () => {
		writeProjectToml('issue_prefix = "CAM"\n');
		const entries = [makeIssue({ id: 'CAM-1', stage: 'idea' })];
		const { spawnFn } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		const code = runIssueList({ cwd: tmpDir, spawnFn, writer });

		expect(code).toBe(0);
		expect(plain()).toContain('CAM-1');
	});
});

// ---------------------------------------------------------------------------
// AC2: row shape + stage heading order
// ---------------------------------------------------------------------------

describe('runIssueList — row rendering (AC2)', () => {
	test('ranked entry shows its rank; unranked entry shows a blank priority column', () => {
		const entries = [
			makeIssue({ id: 'CAM-1', stage: 'idea', rank: 1 }),
			makeIssue({ id: 'CAM-2', stage: 'idea' }),
		];
		const { spawnFn } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		runIssueList({ cwd: tmpDir, configPath: join(tmpDir, 'missing.toml'), spawnFn, writer });

		const rankedLine = lineWith(plain(), 'CAM-1').trim();
		expect(rankedLine.startsWith('1')).toBe(true);

		const unrankedLine = lineWith(plain(), 'CAM-2').trim();
		expect(unrankedLine.startsWith('CAM-2')).toBe(true);
	});

	test('an entry with an unmet blocker shows the [blocked: <ids>] marker', () => {
		const entries = [
			makeIssue({ id: 'CAM-1', stage: 'specified' }),
			makeIssue({ id: 'CAM-2', stage: 'specified', blockedBy: ['CAM-1'] }),
		];
		const { spawnFn } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		runIssueList({ cwd: tmpDir, configPath: join(tmpDir, 'missing.toml'), spawnFn, writer });

		const line = lineWith(plain(), 'CAM-2');
		expect(line).toContain('[blocked: CAM-1]');
	});

	test('an entry with no unmet blockers shows no marker', () => {
		const entries = [makeIssue({ id: 'CAM-1', stage: 'idea' })];
		const { spawnFn } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		runIssueList({ cwd: tmpDir, configPath: join(tmpDir, 'missing.toml'), spawnFn, writer });

		expect(lineWith(plain(), 'CAM-1')).not.toContain('[blocked:');
	});

	test('a long title is truncated to the column budget with an ellipsis', () => {
		const longTitle = 'A'.repeat(80);
		const entries = [makeIssue({ id: 'CAM-1', stage: 'idea', title: longTitle })];
		const { spawnFn } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		runIssueList({ cwd: tmpDir, configPath: join(tmpDir, 'missing.toml'), spawnFn, writer });

		const line = lineWith(plain(), 'CAM-1');
		expect(line).not.toContain(longTitle);
		expect(line).toContain('…');
	});

	test('a short title renders unmodified (no truncation)', () => {
		const entries = [makeIssue({ id: 'CAM-1', stage: 'idea', title: 'Short title' })];
		const { spawnFn } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		runIssueList({ cwd: tmpDir, configPath: join(tmpDir, 'missing.toml'), spawnFn, writer });

		expect(lineWith(plain(), 'CAM-1')).toContain('Short title');
	});

	test('stage groups render as headings in lifecycle order', () => {
		const entries = [
			makeIssue({ id: 'CAM-1', stage: 'planned' }),
			makeIssue({ id: 'CAM-2', stage: 'idea' }),
			makeIssue({ id: 'CAM-3', stage: 'specified' }),
		];
		const { spawnFn } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		runIssueList({ cwd: tmpDir, configPath: join(tmpDir, 'missing.toml'), spawnFn, writer });

		const text = plain();
		const ideaIdx = text.indexOf('Idea');
		const specifiedIdx = text.indexOf('Specified');
		const plannedIdx = text.indexOf('Planned');
		expect(ideaIdx).toBeGreaterThan(-1);
		expect(specifiedIdx).toBeGreaterThan(ideaIdx);
		expect(plannedIdx).toBeGreaterThan(specifiedIdx);
	});
});

// ---------------------------------------------------------------------------
// AC3: --all option
// ---------------------------------------------------------------------------

describe('runIssueList — --all option (AC3)', () => {
	test('default view excludes shipped and abandoned entries', () => {
		const entries = [
			makeIssue({ id: 'CAM-1', stage: 'shipped' }),
			makeIssue({ id: 'CAM-2', stage: 'idea', status: 'abandoned' }),
			makeIssue({ id: 'CAM-3', stage: 'idea' }),
		];
		const { spawnFn } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		runIssueList({ cwd: tmpDir, configPath: join(tmpDir, 'missing.toml'), spawnFn, writer });

		const text = plain();
		expect(text).not.toContain('CAM-1');
		expect(text).not.toContain('CAM-2');
		expect(text).toContain('CAM-3');
		expect(text).not.toContain('Shipped');
	});

	test('--all (all:true) includes the shipped group but still excludes abandoned', () => {
		const entries = [
			makeIssue({ id: 'CAM-1', stage: 'shipped' }),
			makeIssue({ id: 'CAM-2', stage: 'shipped', status: 'abandoned' }),
			makeIssue({ id: 'CAM-3', stage: 'idea' }),
		];
		const { spawnFn } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		runIssueList({ cwd: tmpDir, configPath: join(tmpDir, 'missing.toml'), spawnFn, writer, all: true });

		const text = plain();
		expect(text).toContain('Shipped');
		expect(text).toContain('CAM-1');
		expect(text).not.toContain('CAM-2');
	});
});

// ---------------------------------------------------------------------------
// AC4: 'linear' / 'github' issue_system backends
// ---------------------------------------------------------------------------

describe('runIssueList — issue_system backend branch (AC4)', () => {
	test('linear prints a hint pointing at the Linear app and returns 0', () => {
		const configPath = writeProjectToml('issue_system = "linear"\n');
		const { spawnFn, calls } = makeRecordingBacklogSpawn([]);
		const { writer, plain } = makeCapture();

		const code = runIssueList({ cwd: tmpDir, configPath, spawnFn, writer });

		expect(code).toBe(0);
		expect(plain()).toContain('Linear');
		expect(calls.length).toBe(0);
	});

	test('github prints a hint pointing at gh issue list and returns 0', () => {
		const configPath = writeProjectToml('issue_system = "github"\n');
		const { spawnFn, calls } = makeRecordingBacklogSpawn([]);
		const { writer, plain } = makeCapture();

		const code = runIssueList({ cwd: tmpDir, configPath, spawnFn, writer });

		expect(code).toBe(0);
		expect(plain()).toContain('gh issue list');
		expect(calls.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC5: determinism -- the only subprocess seam is git ls-tree/cat-file
// ---------------------------------------------------------------------------

describe('runIssueList — deterministic subprocess seam (AC5)', () => {
	test('the only spawn calls are git ls-tree and git cat-file --batch; never tmux/claude', () => {
		const entries = [
			makeIssue({ id: 'CAM-1', stage: 'idea' }),
			makeIssue({ id: 'CAM-2', stage: 'planned', rank: 1 }),
		];
		const { spawnFn, calls } = makeRecordingBacklogSpawn(entries);
		const { writer } = makeCapture();

		runIssueList({ cwd: tmpDir, configPath: join(tmpDir, 'missing.toml'), spawnFn, writer });

		expect(calls.length).toBe(2);
		for (const call of calls) {
			expect(call.cmd).toBe('git');
			expect(call.args).not.toContain('send-keys');
			expect(call.args).not.toContain('list-panes');
			expect(call.args.join(' ')).not.toContain('tmux');
			expect(call.args.join(' ')).not.toContain('claude');
		}
		expect(calls.some((c) => c.args.includes('ls-tree'))).toBe(true);
		expect(calls.some((c) => c.args.includes('cat-file'))).toBe(true);
	});

	test('an empty backlog prints a hint and still returns 0 (no crash on zero entries)', () => {
		const { spawnFn } = makeRecordingBacklogSpawn([]);
		const { writer, plain } = makeCapture();

		const code = runIssueList({ cwd: tmpDir, configPath: join(tmpDir, 'missing.toml'), spawnFn, writer });

		expect(code).toBe(0);
		expect(plain()).toContain('No actionable backlog items.');
	});
});

// ---------------------------------------------------------------------------
// --json machine mode (US-002, CAM-222)
// ---------------------------------------------------------------------------

describe('runIssueList — --json machine mode', () => {
	test('writes pure JSON with exactly { counts, plannable, byStage }; no title/heading decoration', () => {
		const entries = [
			makeIssue({ id: 'CAM-1', stage: 'specified' }),
			makeIssue({ id: 'CAM-2', stage: 'idea' }),
		];
		const { spawnFn } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		const code = runIssueList({
			cwd: tmpDir,
			configPath: join(tmpDir, 'missing.toml'),
			spawnFn,
			writer,
			json: true,
		});

		expect(code).toBe(0);
		const parsed = JSON.parse(plain());
		expect(Object.keys(parsed).sort()).toEqual(['byStage', 'counts', 'plannable']);
		expect(parsed).toEqual({
			counts: { idea: 1, specified: 1, planned: 0 },
			plannable: [
				{
					id: 'CAM-1',
					title: 'Test issue',
					rank: null,
					createdAt: '2026-01-01T00:00:00Z',
					updatedAt: '2026-01-01T00:00:00Z',
				},
			],
			byStage: {
				idea: [
					{
						id: 'CAM-2',
						title: 'Test issue',
						rank: null,
						createdAt: '2026-01-01T00:00:00Z',
						updatedAt: '2026-01-01T00:00:00Z',
					},
				],
				specified: [
					{
						id: 'CAM-1',
						title: 'Test issue',
						rank: null,
						createdAt: '2026-01-01T00:00:00Z',
						updatedAt: '2026-01-01T00:00:00Z',
					},
				],
				planned: [],
			},
		});
	});

	test('a stage:specified + status:abandoned zombie fixture appears NOWHERE in the JSON output', () => {
		const entries = [
			makeIssue({ id: 'CAM-99', stage: 'specified', status: 'abandoned' }),
			makeIssue({ id: 'CAM-1', stage: 'specified' }),
		];
		const { spawnFn } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		runIssueList({
			cwd: tmpDir,
			configPath: join(tmpDir, 'missing.toml'),
			spawnFn,
			writer,
			json: true,
			all: true,
		});

		expect(plain().includes('CAM-99')).toBe(false);
	});

	test('--all adds shipped to counts and byStage in JSON mode', () => {
		const entries = [
			makeIssue({ id: 'CAM-1', stage: 'shipped' }),
			makeIssue({ id: 'CAM-2', stage: 'idea' }),
		];
		const { spawnFn } = makeRecordingBacklogSpawn(entries);
		const { writer, plain } = makeCapture();

		runIssueList({
			cwd: tmpDir,
			configPath: join(tmpDir, 'missing.toml'),
			spawnFn,
			writer,
			json: true,
			all: true,
		});

		const parsed = JSON.parse(plain());
		expect(parsed.counts.shipped).toBe(1);
		expect(parsed.byStage.shipped).toEqual([
			{
				id: 'CAM-1',
				title: 'Test issue',
				rank: null,
				createdAt: '2026-01-01T00:00:00Z',
				updatedAt: '2026-01-01T00:00:00Z',
			},
		]);
	});

	test('--json with issue_system linear still prints the Linear hint (JSON contract is local-only), exits 0', () => {
		const configPath = writeProjectToml('issue_system = "linear"\n');
		const { spawnFn, calls } = makeRecordingBacklogSpawn([]);
		const { writer, plain } = makeCapture();

		const code = runIssueList({ cwd: tmpDir, configPath, spawnFn, writer, json: true });

		expect(code).toBe(0);
		expect(plain()).toContain('Linear');
		expect(calls.length).toBe(0);
	});

	test('--json with issue_system github still prints the gh hint, exits 0', () => {
		const configPath = writeProjectToml('issue_system = "github"\n');
		const { spawnFn, calls } = makeRecordingBacklogSpawn([]);
		const { writer, plain } = makeCapture();

		const code = runIssueList({ cwd: tmpDir, configPath, spawnFn, writer, json: true });

		expect(code).toBe(0);
		expect(plain()).toContain('gh issue list');
		expect(calls.length).toBe(0);
	});

	test('--json still reads the backlog via readBacklogFromMain (git ls-tree/cat-file), never a raw fs read', () => {
		const entries = [makeIssue({ id: 'CAM-1', stage: 'idea' })];
		const { spawnFn, calls } = makeRecordingBacklogSpawn(entries);
		const { writer } = makeCapture();

		runIssueList({ cwd: tmpDir, configPath: join(tmpDir, 'missing.toml'), spawnFn, writer, json: true });

		expect(calls.length).toBe(2);
		expect(calls.some((c) => c.args.includes('ls-tree'))).toBe(true);
		expect(calls.some((c) => c.args.includes('cat-file'))).toBe(true);
	});

	test('empty backlog produces empty JSON groups (no crash on zero entries)', () => {
		const { spawnFn } = makeRecordingBacklogSpawn([]);
		const { writer, plain } = makeCapture();

		const code = runIssueList({
			cwd: tmpDir,
			configPath: join(tmpDir, 'missing.toml'),
			spawnFn,
			writer,
			json: true,
		});

		expect(code).toBe(0);
		expect(JSON.parse(plain())).toEqual({
			counts: { idea: 0, specified: 0, planned: 0 },
			plannable: [],
			byStage: { idea: [], specified: [], planned: [] },
		});
	});
});
