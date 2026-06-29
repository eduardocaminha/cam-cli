// test/commands/issue-specify.test.ts
//
// Tests for src/commands/issue-specify.ts (specifyIssueOnMain, abandonIssueOnMain,
// mergeIssueOnMain).
//
// US-004 cutover: backlog is read via readBacklogFromMain (ls-tree + cat-file --batch).
// Only the target CAM-NNNN.json is written; issues.local.json is never touched.
//
// Two sections:
//   1. Unit tests -- fake SpawnFn records calls and returns canned results.
//      Covers all guard paths (invalid-spec, invalid-wsjf, not-found,
//      wrong-stage, not-open, integrity-error) and the success path.
//   2. Real-git integration tests -- actual git in a tmpdir, skip when git absent.
//      Covers Case A (off-main commit-tree) and Case B (on-main direct commit).

import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	specifyIssueOnMain,
	abandonIssueOnMain,
	mergeIssueOnMain,
	type SpawnFn,
	type SpecifyIssueOnMainOptions,
	type AbandonIssueOnMainOptions,
	type MergeIssueOnMainOptions,
} from '../../src/commands/issue-specify.ts';
import type { Spec } from '../../src/issues/spec.ts';
import type { IssueEntry, WsjfScore } from '../../src/issues/types.ts';
import type {
	WorkerEvent,
	WorkerEventLogger,
	StagePromotedEventDetail,
} from '../../src/supervisor/events.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_SPEC: Spec = {
	acceptanceCriteria: ['It works'],
	scope: 'Limited to the foo module',
	gotchas: [],
	domainTerms: [],
};

const VALID_WSJF: WsjfScore = {
	value: 8,
	timeCriticality: 5,
	riskReduction: 3,
	jobSize: 2,
};

/** Serialise a single IssueEntry to its on-disk per-file JSON format. */
function toJson(entry: IssueEntry): string {
	return JSON.stringify(entry, null, 2) + '\n';
}

/** Build ls-tree + cat-file --batch responses for a list of IssueEntries. */
function buildIssueFixtures(entries: IssueEntry[]): { lsTreeOutput: string; catFileOutput: string } {
	const lines: string[] = [];
	const blobs: string[] = [];
	for (const entry of entries) {
		const n = parseInt(entry.id.split('-')[1] ?? '0', 10);
		const padded = `CAM-${String(n).padStart(4, '0')}.json`;
		lines.push(`scripts/cam/issues/${padded}`);
		const content = toJson(entry);
		blobs.push(`oid${entry.id} blob ${content.length}\n${content}\n`);
	}
	return {
		lsTreeOutput: lines.join('\n') + (lines.length > 0 ? '\n' : ''),
		catFileOutput: blobs.join(''),
	};
}

/** Minimal SpawnSyncReturns<string> for a successful git call. */
function okResult(stdout = ''): SpawnSyncReturns<string> {
	return { pid: 0, output: [], stdout, stderr: '', status: 0, signal: null };
}

/** Minimal SpawnSyncReturns<string> for a failing git call. */
function failResult(stdout = '', stderr = ''): SpawnSyncReturns<string> {
	return { pid: 0, output: [], stdout, stderr, status: 1, signal: null };
}

function makeEntry(overrides?: Partial<IssueEntry>): IssueEntry {
	return {
		id: 'CAM-1',
		title: 'My idea',
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Fake SpawnFn builder
// ---------------------------------------------------------------------------

interface FakeSpawnOpts {
	/** Simulated current branch (default: 'feat/test'). */
	branch?: string;
	/** Local main sha (default: 'abc123def456abc1'). */
	localMainSha?: string;
	/** If true, origin/main returns the same sha (up-to-date). Default: false (no remote). */
	originMainUpToDate?: boolean;
	/** Backlog entries returned by ls-tree + cat-file. */
	entries: IssueEntry[];
}

function makeFakeSpawnFn(opts: FakeSpawnOpts): { spawnFn: SpawnFn; calls: string[][] } {
	const branch = opts.branch ?? 'feat/test';
	const localMainSha = opts.localMainSha ?? 'abc123def456abc1';
	const calls: string[][] = [];
	const { lsTreeOutput, catFileOutput } = buildIssueFixtures(opts.entries);

	const spawnFn: SpawnFn = (cmd, args, _options) => {
		calls.push([cmd, ...args]);
		const sub = args.join(' ');

		// rev-parse --abbrev-ref HEAD -> branch
		if (sub.includes('rev-parse --abbrev-ref HEAD')) {
			return okResult(`${branch}\n`);
		}

		// rev-parse origin/main
		if (sub.includes('rev-parse origin/main')) {
			if (opts.originMainUpToDate) {
				return okResult(`${localMainSha}\n`);
			}
			return failResult();
		}

		// rev-parse main (local)
		if (sub.match(/rev-parse main$/) || (sub.includes('rev-parse') && sub.endsWith('main'))) {
			return okResult(`${localMainSha}\n`);
		}

		// fetch origin main
		if (sub.includes('fetch origin main')) {
			return okResult();
		}

		// ls-tree -> file listing (readBacklogFromMain)
		if (sub.includes('ls-tree') && sub.includes('scripts/cam/issues')) {
			return okResult(lsTreeOutput);
		}

		// cat-file --batch -> blob content (readBacklogFromMain)
		if (sub.includes('cat-file') && sub.includes('--batch')) {
			return okResult(catFileOutput);
		}

		// CAS plumbing
		if (sub.includes('read-tree')) return okResult();
		if (sub.includes('hash-object')) return okResult('blobsha111\n');
		if (sub.includes('update-index')) return okResult();
		if (sub.includes('write-tree')) return okResult('treesha222\n');
		if (sub.includes('commit-tree')) return okResult('newcommitsha333\n');
		if (sub.includes('update-ref')) return okResult();

		// on-main path
		if (sub.includes('add scripts/cam/issues')) return okResult();
		if (sub.match(/commit -m /)) return okResult();
		if (sub.includes('rev-parse --short HEAD')) return okResult('abc1234\n');

		// push origin main (best-effort, no remote)
		if (sub.includes('push origin main')) {
			return failResult('', 'no remote configured');
		}

		return okResult();
	};

	return { spawnFn, calls };
}

function makeOpts(
	overrides: Partial<SpecifyIssueOnMainOptions> & { spawnFn: SpawnFn },
): SpecifyIssueOnMainOptions {
	const { spawnFn, ...rest } = overrides;
	return {
		cwd: '/fake/cwd',
		id: 'CAM-1',
		spec: VALID_SPEC,
		wsjf: VALID_WSJF,
		clock: () => '2026-06-27T00:00:00.000Z',
		// Default no-op eventSink so unit tests do not touch the filesystem.
		eventSink: () => {},
		...rest,
		spawnFn,
	};
}

// ===========================================================================
// 1. Unit tests
// ===========================================================================

// ---------------------------------------------------------------------------
// AC2: Invalid spec -> error without commit
// ---------------------------------------------------------------------------

test('returns invalid-spec when spec has empty acceptanceCriteria', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: [makeEntry()] });
	const result = specifyIssueOnMain(
		makeOpts({
			spawnFn,
			spec: { acceptanceCriteria: [], scope: 'some scope', gotchas: [], domainTerms: [] },
		}),
	);
	expect(result.ok).toBe(false);
	if (!result.ok && 'errors' in result) {
		expect(result.reason).toBe('invalid-spec');
		expect(result.errors.length).toBeGreaterThan(0);
	}
	// No ls-tree or cat-file call before spec validation
	const backlogRead = calls.find((c) => c.join(' ').includes('ls-tree'));
	expect(backlogRead).toBeUndefined();
});

test('returns invalid-spec when spec is missing scope', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry()] });
	const result = specifyIssueOnMain(
		makeOpts({
			spawnFn,
			spec: { acceptanceCriteria: ['ac1'], scope: '', gotchas: [], domainTerms: [] },
		}),
	);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe('invalid-spec');
	}
});

// ---------------------------------------------------------------------------
// AC2: Invalid wsjf -> error without commit
// ---------------------------------------------------------------------------

test('returns invalid-wsjf when wsjf is missing a field', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: [makeEntry()] });
	const result = specifyIssueOnMain(
		makeOpts({
			spawnFn,
			// @ts-expect-error: intentionally omitting jobSize for the test
			wsjf: { value: 1, timeCriticality: 2, riskReduction: 3 },
		}),
	);
	expect(result.ok).toBe(false);
	if (!result.ok && 'errors' in result) {
		expect(result.reason).toBe('invalid-wsjf');
		expect(result.errors.length).toBeGreaterThan(0);
	}
	// No backlog read
	const backlogRead = calls.find((c) => c.join(' ').includes('ls-tree'));
	expect(backlogRead).toBeUndefined();
});

// ---------------------------------------------------------------------------
// AC3: not-found when id absent
// ---------------------------------------------------------------------------

test('returns not-found when id does not exist in backlog', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry()] });
	const result = specifyIssueOnMain(makeOpts({ spawnFn, id: 'CAM-999' }));
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe('not-found');
	}
});

// ---------------------------------------------------------------------------
// AC3: wrong-stage when issue is not 'idea'
// ---------------------------------------------------------------------------

test('returns wrong-stage when issue is already specified', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry({ stage: 'specified' })] });
	const result = specifyIssueOnMain(makeOpts({ spawnFn }));
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe('wrong-stage');
	}
});

test('returns wrong-stage when issue is planned', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry({ stage: 'planned' })] });
	const result = specifyIssueOnMain(makeOpts({ spawnFn }));
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe('wrong-stage');
	}
});

test('returns wrong-stage when issue is shipped', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry({ stage: 'shipped' })] });
	const result = specifyIssueOnMain(makeOpts({ spawnFn }));
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe('wrong-stage');
	}
});

// ---------------------------------------------------------------------------
// AC3: not-open when issue is abandoned
// ---------------------------------------------------------------------------

test('returns not-open when issue status is abandoned', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry({ status: 'abandoned' })] });
	const result = specifyIssueOnMain(makeOpts({ spawnFn }));
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe('not-open');
	}
});

// ---------------------------------------------------------------------------
// AC4: integrity-error when blockedBy references unknown id
// ---------------------------------------------------------------------------

test('returns integrity-error when blockedBy references unknown id', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry()] });
	const result = specifyIssueOnMain(
		makeOpts({ spawnFn, blockedBy: ['CAM-999'] }),
	);
	expect(result.ok).toBe(false);
	if (!result.ok && 'errors' in result) {
		expect(result.reason).toBe('integrity-error');
		expect(result.errors.length).toBeGreaterThan(0);
	}
});

test('returns integrity-error when blockedBy is self-referential', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry()] });
	const result = specifyIssueOnMain(
		makeOpts({ spawnFn, blockedBy: ['CAM-1'] }),
	);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe('integrity-error');
	}
});

// ---------------------------------------------------------------------------
// AC5: Success path (off-main) -- commit-tree plumbing
// ---------------------------------------------------------------------------

test('success path (off-main): returns ok:true with expected fields', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: [makeEntry()] });

	const result = specifyIssueOnMain(makeOpts({ spawnFn }));

	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.id).toBe('CAM-1');
		expect(result.committedTo).toBe('main');
		expect(result.branchWasMain).toBe(false);
		// sha is first 7 chars of 'newcommitsha333'
		expect(result.sha).toBe('newcomm');
	}

	// Verify CAS plumbing calls
	const allArgs = calls.map((c) => c.join(' '));
	expect(allArgs.some((a) => a.includes('ls-tree') && a.includes('scripts/cam/issues'))).toBe(true);
	expect(allArgs.some((a) => a.includes('cat-file') && a.includes('--batch'))).toBe(true);
	expect(allArgs.some((a) => a.includes('read-tree'))).toBe(true);
	expect(allArgs.some((a) => a.includes('hash-object'))).toBe(true);
	expect(allArgs.some((a) => a.includes('update-index'))).toBe(true);
	expect(allArgs.some((a) => a.includes('write-tree'))).toBe(true);
	expect(allArgs.some((a) => a.includes('commit-tree'))).toBe(true);
	expect(allArgs.some((a) => a.includes('update-ref'))).toBe(true);

	// Never called git checkout
	expect(allArgs.some((a) => a.includes('checkout'))).toBe(false);

	// Never referenced issues.local.json (US-004 AC)
	for (const call of calls) {
		expect(call.join(' ')).not.toContain('issues.local.json');
	}
});

test('success path: commit-tree call includes correct parent sha', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: [makeEntry()], localMainSha: 'mymainsha000' });

	specifyIssueOnMain(makeOpts({ spawnFn }));

	const commitTreeCall = calls.find((c) => c.join(' ').includes('commit-tree'));
	expect(commitTreeCall).toBeDefined();
	// The parent sha must appear in the commit-tree argv
	expect(commitTreeCall?.join(' ')).toContain('mymainsha000');
});

test('success path: commit message is chore(cam): specify <id>', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: [makeEntry()] });

	specifyIssueOnMain(makeOpts({ spawnFn, id: 'CAM-1' }));

	const commitTreeCall = calls.find((c) => c.join(' ').includes('commit-tree'));
	expect(commitTreeCall?.join(' ')).toContain('chore(cam): specify CAM-1');
});

test('success path: serialized JSON sets stage to specified and includes spec+wsjf+blockedBy', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry()] });
	let capturedJson = '';

	// Intercept the hash-object call to capture the serialized JSON
	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJson = opts.input;
		}
		return spawnFn(cmd, args, opts);
	};

	specifyIssueOnMain(makeOpts({ spawnFn: recordingSpawnFn, blockedBy: [] }));

	// US-004: hash-object input is a single IssueEntry (not the whole backlog)
	const parsed = JSON.parse(capturedJson) as IssueEntry;
	expect(parsed.id).toBe('CAM-1');
	expect(parsed.stage).toBe('specified');
	expect(parsed.spec).toEqual(VALID_SPEC);
	expect(parsed.wsjf).toEqual(VALID_WSJF);
	expect(parsed.blockedBy).toEqual([]);
});

test('success path (on-main): ref-only commit via commitTreeToMain; writeFile never called', () => {
	// CAM-133: even when branchWasMain===true, the commit path is now always
	// commitTreeToMain (ref-only). writeFile must never be called.
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: [makeEntry()], branch: 'main' });
	const writtenFiles: Array<{ path: string; content: string }> = [];

	const result = specifyIssueOnMain(
		makeOpts({
			spawnFn,
			writeFile: (path, content) => writtenFiles.push({ path, content }),
		}),
	);

	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.branchWasMain).toBe(true);
	}
	// ref-only invariant: writeFile is never invoked (working tree untouched)
	expect(writtenFiles).toHaveLength(0);
	// commit-tree plumbing is always used (even on-main after the fix)
	const commitTreeCall = calls.find((c) => c.join(' ').includes('commit-tree'));
	expect(commitTreeCall).toBeDefined();
});

// ---------------------------------------------------------------------------
// AC3: No mutation on guard failures (verify backlog not read for spec/wsjf errors)
// ---------------------------------------------------------------------------

test('no backlog read occurs when spec is invalid (fail fast)', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: [makeEntry()] });
	specifyIssueOnMain(
		makeOpts({
			spawnFn,
			spec: { acceptanceCriteria: [], scope: 'x', gotchas: [], domainTerms: [] },
		}),
	);
	const lsTreeCalled = calls.some((c) => c.join(' ').includes('ls-tree'));
	expect(lsTreeCalled).toBe(false);
});

test('no backlog read occurs when wsjf is invalid (fail fast)', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: [makeEntry()] });
	specifyIssueOnMain(
		makeOpts({
			spawnFn,
			// @ts-expect-error: intentionally broken wsjf
			wsjf: { value: 'not-a-number' },
		}),
	);
	const lsTreeCalled = calls.some((c) => c.join(' ').includes('ls-tree'));
	expect(lsTreeCalled).toBe(false);
});

// ---------------------------------------------------------------------------
// AC1: Never runs git checkout
// ---------------------------------------------------------------------------

test('never calls git checkout on any code path', () => {
	const scenarios: Array<Partial<SpecifyIssueOnMainOptions>> = [
		{ id: 'CAM-999' }, // not-found
		{ spec: { acceptanceCriteria: [], scope: '', gotchas: [], domainTerms: [] } }, // invalid-spec
		{}, // success
	];

	for (const overrides of scenarios) {
		const { spawnFn, calls } = makeFakeSpawnFn({ entries: [makeEntry()] });
		specifyIssueOnMain(makeOpts({ spawnFn, ...overrides }));
		const checkoutCalled = calls.some((c) => c.includes('checkout'));
		expect(checkoutCalled).toBe(false);
	}
});

// ===========================================================================
// US-007: stage-promoted observability events
// ===========================================================================

test('emits stage-promoted event on successful commit (injected sink)', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry()] });

	const emittedEvents: WorkerEvent[] = [];
	const fakeEventSink: WorkerEventLogger = (e) => emittedEvents.push(e);

	specifyIssueOnMain(makeOpts({ spawnFn, eventSink: fakeEventSink }));

	expect(emittedEvents).toHaveLength(1);
	const ev = emittedEvents[0];
	expect(ev?.kind).toBe('stage-promoted');
	const detail = ev?.detail as StagePromotedEventDetail;
	expect(detail.id).toBe('CAM-1');
	expect(detail.fromStage).toBe('idea');
	expect(detail.toStage).toBe('specified');
	expect(ev?.storyId).toBe('CAM-1');
});

test('does not emit event when guard fails (not-found)', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry()] });

	const emittedEvents: WorkerEvent[] = [];
	const fakeEventSink: WorkerEventLogger = (e) => emittedEvents.push(e);

	specifyIssueOnMain(makeOpts({ spawnFn, id: 'CAM-999', eventSink: fakeEventSink }));

	expect(emittedEvents).toHaveLength(0);
});

test('does not emit event when spec is invalid', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry()] });

	const emittedEvents: WorkerEvent[] = [];
	const fakeEventSink: WorkerEventLogger = (e) => emittedEvents.push(e);

	specifyIssueOnMain(
		makeOpts({
			spawnFn,
			spec: { acceptanceCriteria: [], scope: '', gotchas: [], domainTerms: [] },
			eventSink: fakeEventSink,
		}),
	);

	expect(emittedEvents).toHaveLength(0);
});

test('production-wiring: default sink writes stage-promoted event to cam-worker-events.jsonl', () => {
	// This test does NOT inject eventSink. specifyIssueOnMain must call
	// makeFileEventLogger(<cwd>/.claude/cam-worker-events.jsonl) by default.
	const tmpCwd = mkdtempSync(join(tmpdir(), 'cam-specify-wiring-'));
	dirsToCleanup.push(tmpCwd);

	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry()] });

	specifyIssueOnMain({
		cwd: tmpCwd,
		id: 'CAM-1',
		spec: VALID_SPEC,
		wsjf: VALID_WSJF,
		clock: () => '2026-06-27T00:00:00.000Z',
		spawnFn,
		// eventSink intentionally omitted: must use the default file sink
	});

	const eventsPath = join(tmpCwd, '.claude', 'cam-worker-events.jsonl');
	const raw = readFileSync(eventsPath, 'utf8').trim();
	const event = JSON.parse(raw) as WorkerEvent;
	expect(event.kind).toBe('stage-promoted');
	const detail = event.detail as StagePromotedEventDetail;
	expect(detail.id).toBe('CAM-1');
	expect(detail.fromStage).toBe('idea');
	expect(detail.toStage).toBe('specified');
});

// ===========================================================================
// 2. Real-git integration tests
// ===========================================================================

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0;

const dirsToCleanup: string[] = [];

afterEach(() => {
	for (const d of dirsToCleanup) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
	dirsToCleanup.length = 0;
});

const realSpawnFn: SpawnFn = (cmd, args, opts) =>
	spawnSync(cmd, args, {
		encoding: opts.encoding,
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.input !== undefined ? { input: opts.input } : {}),
		stdio: 'pipe',
	}) as SpawnSyncReturns<string>;

interface RepoHandles {
	dir: string;
	run: (args: string[]) => ReturnType<typeof spawnSync>;
	camDir: string;
	issuesDir: string;
}

function makeTmpRepo(initialIssue?: Partial<IssueEntry>): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-specify-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	const camDir = join(dir, 'scripts', 'cam');
	const issuesDir = join(camDir, 'issues');
	mkdirSync(issuesDir, { recursive: true });

	// US-004: create per-file CAM-0001.json (not issues.local.json)
	const entry: IssueEntry = {
		id: 'CAM-1',
		title: 'My idea',
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		...initialIssue,
	};
	writeFileSync(join(issuesDir, 'CAM-0001.json'), toJson(entry));

	run(['add', '-A']);
	run(['commit', '-m', 'chore: initial harness state']);

	return { dir, run, camDir, issuesDir };
}

// Case A: off-main path

test.skipIf(!gitAvailable)(
	'Real-git Case A (off-main): entry on main gains specified stage; work branch untouched',
	() => {
		const { dir, run, issuesDir } = makeTmpRepo();

		const mainSha0 = (run(['rev-parse', 'main']).stdout as string).trim();

		run(['checkout', '-b', 'feat/spec-test']);
		const featureSha0 = (run(['rev-parse', 'HEAD']).stdout as string).trim();

		const result = specifyIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			spec: VALID_SPEC,
			wsjf: VALID_WSJF,
			spawnFn: realSpawnFn,
			clock: () => '2026-06-27T00:00:00.000Z',
			eventSink: () => {},
		});

		if (!result.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);
		}

		// result shape
		expect(result.id).toBe('CAM-1');
		expect(result.committedTo).toBe('main');
		expect(result.branchWasMain).toBe(false);

		// main advanced by one commit
		const mainSha1 = (run(['rev-parse', 'main']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// US-004: main has the updated per-file entry
		const showResult = run(['show', 'main:scripts/cam/issues/CAM-0001.json']);
		const entry = JSON.parse(showResult.stdout as string) as IssueEntry;
		expect(entry.stage).toBe('specified');
		expect(entry.spec).toEqual(VALID_SPEC);
		expect(entry.wsjf).toEqual(VALID_WSJF);
		expect(entry.blockedBy).toEqual([]);

		// commit message
		const logResult = run(['log', 'main', '-1', '--format=%s']);
		expect((logResult.stdout as string).trim()).toBe('chore(cam): specify CAM-1');

		// feature-branch HEAD unchanged
		const featureSha1 = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		expect(featureSha1).toBe(featureSha0);

		// working tree clean
		const status = run(['status', '--porcelain']);
		expect((status.stdout as string).trim()).toBe('');

		// working-tree file NOT modified (off-main path)
		const wtContent = readFileSync(join(issuesDir, 'CAM-0001.json'), 'utf8');
		const wtEntry = JSON.parse(wtContent) as IssueEntry;
		expect(wtEntry.stage).toBe('idea');
	},
);

// Case B: on-main path

test.skipIf(!gitAvailable)(
	'Real-git Case B (on-main): ref-only commit via commitTreeToMain; working-tree file synced to HEAD',
	() => {
		// CAM-133: on-main path uses commitTreeToMain. After a successful commit,
		// syncWorktreeIfOnMain syncs the working-tree file to HEAD (coherence invariant).
		const { dir, run, issuesDir } = makeTmpRepo();

		const branchBefore = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout as string).trim();
		expect(branchBefore).toBe('main');

		const mainSha0 = (run(['rev-parse', 'HEAD']).stdout as string).trim();

		const result = specifyIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			spec: VALID_SPEC,
			wsjf: VALID_WSJF,
			spawnFn: realSpawnFn,
			clock: () => '2026-06-27T00:00:00.000Z',
			eventSink: () => {},
		});

		if (!result.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);
		}

		expect(result.branchWasMain).toBe(true);
		expect(result.committedTo).toBe('main');

		// main ref advanced (via git update-ref, not a working-tree commit)
		const mainSha1 = (run(['rev-parse', 'main']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// commit message
		const logResult = run(['log', 'main', '-1', '--format=%s']);
		expect((logResult.stdout as string).trim()).toBe('chore(cam): specify CAM-1');

		// main ref has the updated entry (confirmed via git show)
		const showResult = run(['show', 'main:scripts/cam/issues/CAM-0001.json']);
		const mainEntry = JSON.parse(showResult.stdout as string) as IssueEntry;
		expect(mainEntry.stage).toBe('specified');
		expect(mainEntry.spec).toEqual(VALID_SPEC);
		expect(mainEntry.wsjf).toEqual(VALID_WSJF);

		// working-tree file is synced to HEAD (syncWorktreeIfOnMain coherence invariant)
		const wtContent = readFileSync(join(issuesDir, 'CAM-0001.json'), 'utf8');
		const wtEntry = JSON.parse(wtContent) as IssueEntry;
		expect(wtEntry.stage).toBe('specified');
	},
);

// Real-git guard tests

test.skipIf(!gitAvailable)(
	'Real-git: returns wrong-stage for non-idea issue in real git',
	() => {
		const { dir } = makeTmpRepo({ stage: 'specified' });

		const result = specifyIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			spec: VALID_SPEC,
			wsjf: VALID_WSJF,
			spawnFn: realSpawnFn,
			clock: () => '2026-06-27T00:00:00.000Z',
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('wrong-stage');
		}
	},
);

test.skipIf(!gitAvailable)(
	'Real-git: returns not-found for missing id in real git',
	() => {
		const { dir } = makeTmpRepo();

		const result = specifyIssueOnMain({
			cwd: dir,
			id: 'CAM-999',
			spec: VALID_SPEC,
			wsjf: VALID_WSJF,
			spawnFn: realSpawnFn,
			clock: () => '2026-06-27T00:00:00.000Z',
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('not-found');
		}
	},
);

// ===========================================================================
// 3. abandonIssueOnMain -- unit tests
// ===========================================================================

function makeAbandonOpts(
	overrides: Partial<AbandonIssueOnMainOptions> & { spawnFn: SpawnFn },
): AbandonIssueOnMainOptions {
	const { spawnFn, ...rest } = overrides;
	return {
		cwd: '/fake/cwd',
		id: 'CAM-1',
		clock: () => '2026-06-27T00:00:00.000Z',
		...rest,
		spawnFn,
	};
}

test('abandon: returns not-found when id absent', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry()] });
	const result = abandonIssueOnMain(makeAbandonOpts({ spawnFn, id: 'CAM-999' }));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe('not-found');
});

test('abandon: returns already-abandoned when status is already abandoned', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry({ status: 'abandoned' })] });
	const result = abandonIssueOnMain(makeAbandonOpts({ spawnFn }));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe('already-abandoned');
});

test('abandon: success path (off-main) sets status to abandoned', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: [makeEntry()] });
	let capturedJson = '';

	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJson = opts.input;
		}
		return spawnFn(cmd, args, opts);
	};

	const result = abandonIssueOnMain(makeAbandonOpts({ spawnFn: recordingSpawnFn }));
	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.id).toBe('CAM-1');
		expect(result.committedTo).toBe('main');
		expect(result.branchWasMain).toBe(false);
	}

	// US-004: capturedJson is a single IssueEntry (not the whole backlog)
	const parsed = JSON.parse(capturedJson) as IssueEntry;
	expect(parsed.status).toBe('abandoned');
	// stage is unchanged
	expect(parsed.stage).toBe('idea');
});

test('abandon: success path (on-main) ref-only commit; writeFile never called', () => {
	// CAM-133: even when branchWasMain===true, the commit path is now always
	// commitTreeToMain (ref-only). writeFile must never be called.
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: [makeEntry()], branch: 'main' });
	const writtenFiles: Array<{ path: string; content: string }> = [];

	const result = abandonIssueOnMain(
		makeAbandonOpts({
			spawnFn,
			writeFile: (path, content) => writtenFiles.push({ path, content }),
		}),
	);

	expect(result.ok).toBe(true);
	if (result.ok) expect(result.branchWasMain).toBe(true);
	// ref-only invariant: writeFile is never invoked (working tree untouched)
	expect(writtenFiles).toHaveLength(0);
	// commit-tree plumbing is always used (even on-main after the fix)
	const commitTreeCall = calls.find((c) => c.join(' ').includes('commit-tree'));
	expect(commitTreeCall).toBeDefined();
});

test('abandon: commit message is chore(cam): abandon <id>', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: [makeEntry()] });
	abandonIssueOnMain(makeAbandonOpts({ spawnFn, id: 'CAM-1' }));
	const commitTreeCall = calls.find((c) => c.join(' ').includes('commit-tree'));
	expect(commitTreeCall?.join(' ')).toContain('chore(cam): abandon CAM-1');
});

test('abandon: never calls git checkout', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: [makeEntry()] });
	abandonIssueOnMain(makeAbandonOpts({ spawnFn }));
	expect(calls.some((c) => c.includes('checkout'))).toBe(false);
});

// ===========================================================================
// 4. mergeIssueOnMain -- unit tests
// ===========================================================================

function makeTwoEntries(
	overrides1?: Partial<IssueEntry>,
	overrides2?: Partial<IssueEntry>,
): IssueEntry[] {
	return [
		{
			id: 'CAM-1',
			title: 'Source idea',
			stage: 'idea',
			status: 'open',
			blockedBy: [],
			createdAt: '2026-01-01T00:00:00.000Z',
			...overrides1,
		},
		{
			id: 'CAM-2',
			title: 'Target idea',
			stage: 'idea',
			status: 'open',
			blockedBy: [],
			createdAt: '2026-01-02T00:00:00.000Z',
			...overrides2,
		},
	];
}

function makeMergeOpts(
	overrides: Partial<MergeIssueOnMainOptions> & { spawnFn: SpawnFn },
): MergeIssueOnMainOptions {
	const { spawnFn, ...rest } = overrides;
	return {
		cwd: '/fake/cwd',
		id: 'CAM-1',
		intoId: 'CAM-2',
		clock: () => '2026-06-27T00:00:00.000Z',
		...rest,
		spawnFn,
	};
}

test('merge-into: returns self-merge when id === intoId', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: makeTwoEntries() });
	const result = mergeIssueOnMain(makeMergeOpts({ spawnFn, id: 'CAM-1', intoId: 'CAM-1' }));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe('self-merge');
});

test('merge-into: returns source-not-found when source id absent', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: makeTwoEntries() });
	const result = mergeIssueOnMain(makeMergeOpts({ spawnFn, id: 'CAM-999', intoId: 'CAM-2' }));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe('source-not-found');
});

test('merge-into: returns target-not-found when target id absent', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: makeTwoEntries() });
	const result = mergeIssueOnMain(makeMergeOpts({ spawnFn, id: 'CAM-1', intoId: 'CAM-999' }));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe('target-not-found');
});

test('merge-into: returns already-abandoned when source is abandoned', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: makeTwoEntries({ status: 'abandoned' }) });
	const result = mergeIssueOnMain(makeMergeOpts({ spawnFn }));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe('already-abandoned');
});

test('merge-into: success sets source status to abandoned and records target in description', () => {
	const { spawnFn } = makeFakeSpawnFn({ entries: makeTwoEntries() });
	const capturedJsons: string[] = [];

	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJsons.push(opts.input);
		}
		return spawnFn(cmd, args, opts);
	};

	const result = mergeIssueOnMain(makeMergeOpts({ spawnFn: recordingSpawnFn }));
	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.id).toBe('CAM-1');
		expect(result.intoId).toBe('CAM-2');
		expect(result.committedTo).toBe('main');
	}

	// US-004: each hash-object input is a single IssueEntry
	const allParsed = capturedJsons.map((j) => JSON.parse(j) as IssueEntry);
	const source = allParsed.find((e) => e.id === 'CAM-1');
	expect(source?.status).toBe('abandoned');
	expect(source?.description).toContain('Merged into CAM-2.');
});

test('merge-into: appends to existing description', () => {
	const { spawnFn } = makeFakeSpawnFn({
		entries: makeTwoEntries({ description: 'Original desc' }),
	});
	const capturedJsons: string[] = [];

	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJsons.push(opts.input);
		}
		return spawnFn(cmd, args, opts);
	};

	mergeIssueOnMain(makeMergeOpts({ spawnFn: recordingSpawnFn }));

	const allParsed = capturedJsons.map((j) => JSON.parse(j) as IssueEntry);
	const source = allParsed.find((e) => e.id === 'CAM-1');
	expect(source?.description).toBe('Original desc\n\nMerged into CAM-2.');
});

test('merge-into: foldBlockedBy folds source blockedBy into target', () => {
	// source blocks on CAM-3; after merge, target should also block on CAM-3
	const threeEntries: IssueEntry[] = [
		{
			id: 'CAM-1',
			title: 'Source',
			stage: 'idea',
			status: 'open',
			blockedBy: ['CAM-3'],
			createdAt: '2026-01-01T00:00:00.000Z',
		},
		{
			id: 'CAM-2',
			title: 'Target',
			stage: 'idea',
			status: 'open',
			blockedBy: [],
			createdAt: '2026-01-02T00:00:00.000Z',
		},
		{
			id: 'CAM-3',
			title: 'Blocker',
			stage: 'idea',
			status: 'open',
			blockedBy: [],
			createdAt: '2026-01-03T00:00:00.000Z',
		},
	];
	const capturedJsons: string[] = [];
	const { spawnFn } = makeFakeSpawnFn({ entries: threeEntries });

	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJsons.push(opts.input);
		}
		return spawnFn(cmd, args, opts);
	};

	mergeIssueOnMain(makeMergeOpts({ spawnFn: recordingSpawnFn, foldBlockedBy: true }));

	const allParsed = capturedJsons.map((j) => JSON.parse(j) as IssueEntry);
	const target = allParsed.find((e) => e.id === 'CAM-2');
	expect(target?.blockedBy).toContain('CAM-3');
});

test('merge-into: foldBlockedBy does not fold when false (default)', () => {
	const threeEntries: IssueEntry[] = [
		{
			id: 'CAM-1',
			title: 'Source',
			stage: 'idea',
			status: 'open',
			blockedBy: ['CAM-3'],
			createdAt: '2026-01-01T00:00:00.000Z',
		},
		{
			id: 'CAM-2',
			title: 'Target',
			stage: 'idea',
			status: 'open',
			blockedBy: [],
			createdAt: '2026-01-02T00:00:00.000Z',
		},
		{
			id: 'CAM-3',
			title: 'Blocker',
			stage: 'idea',
			status: 'open',
			blockedBy: [],
			createdAt: '2026-01-03T00:00:00.000Z',
		},
	];
	const capturedJsons: string[] = [];
	const { spawnFn } = makeFakeSpawnFn({ entries: threeEntries });

	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJsons.push(opts.input);
		}
		return spawnFn(cmd, args, opts);
	};

	mergeIssueOnMain(makeMergeOpts({ spawnFn: recordingSpawnFn, foldBlockedBy: false }));

	// No target file committed when foldBlockedBy=false
	const allParsed = capturedJsons.map((j) => JSON.parse(j) as IssueEntry);
	const target = allParsed.find((e) => e.id === 'CAM-2');
	// target not in commit when foldBlockedBy=false
	if (target !== undefined) {
		expect(target.blockedBy).toEqual([]);
	} else {
		// Target was not committed at all -- acceptable
		expect(target).toBeUndefined();
	}
});

test('merge-into: foldBlockedBy deduplicates existing entries', () => {
	const threeEntries: IssueEntry[] = [
		{
			id: 'CAM-1',
			title: 'Source',
			stage: 'idea',
			status: 'open',
			blockedBy: ['CAM-3'],
			createdAt: '2026-01-01T00:00:00.000Z',
		},
		{
			id: 'CAM-2',
			title: 'Target',
			stage: 'idea',
			status: 'open',
			blockedBy: ['CAM-3'],
			createdAt: '2026-01-02T00:00:00.000Z',
		},
		{
			id: 'CAM-3',
			title: 'Blocker',
			stage: 'idea',
			status: 'open',
			blockedBy: [],
			createdAt: '2026-01-03T00:00:00.000Z',
		},
	];
	const capturedJsons: string[] = [];
	const { spawnFn } = makeFakeSpawnFn({ entries: threeEntries });

	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJsons.push(opts.input);
		}
		return spawnFn(cmd, args, opts);
	};

	mergeIssueOnMain(makeMergeOpts({ spawnFn: recordingSpawnFn, foldBlockedBy: true }));

	const allParsed = capturedJsons.map((j) => JSON.parse(j) as IssueEntry);
	const target = allParsed.find((e) => e.id === 'CAM-2');
	// CAM-3 should appear only once (no duplication)
	expect(target?.blockedBy.filter((d) => d === 'CAM-3')).toHaveLength(1);
});

test('merge-into: commit message is chore(cam): merge <id> into <intoId>', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: makeTwoEntries() });
	mergeIssueOnMain(makeMergeOpts({ spawnFn }));
	const commitTreeCall = calls.find((c) => c.join(' ').includes('commit-tree'));
	expect(commitTreeCall?.join(' ')).toContain('chore(cam): merge CAM-1 into CAM-2');
});

test('merge-into: never calls git checkout', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ entries: makeTwoEntries() });
	mergeIssueOnMain(makeMergeOpts({ spawnFn }));
	expect(calls.some((c) => c.includes('checkout'))).toBe(false);
});

// ===========================================================================
// 5. Real-git integration tests: abandon and merge-into
// ===========================================================================

function makeTmpRepoTwo(): RepoHandles {
	const dir = mkdtempSync(join(tmpdir(), 'cam-abandon-merge-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	const camDir = join(dir, 'scripts', 'cam');
	const issuesDir = join(camDir, 'issues');
	mkdirSync(issuesDir, { recursive: true });

	// US-004: create per-file CAM-0001.json and CAM-0002.json
	const e1: IssueEntry = {
		id: 'CAM-1',
		title: 'Source idea',
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-01T00:00:00.000Z',
	};
	const e2: IssueEntry = {
		id: 'CAM-2',
		title: 'Target idea',
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-02T00:00:00.000Z',
	};
	writeFileSync(join(issuesDir, 'CAM-0001.json'), toJson(e1));
	writeFileSync(join(issuesDir, 'CAM-0002.json'), toJson(e2));

	run(['add', '-A']);
	run(['commit', '-m', 'chore: initial harness state']);

	return { dir, run, camDir, issuesDir };
}

// Real-git abandon tests

test.skipIf(!gitAvailable)(
	'Real-git abandon (off-main): status set to abandoned; main advances; work branch untouched',
	() => {
		const { dir, run } = makeTmpRepoTwo();
		const mainSha0 = (run(['rev-parse', 'main']).stdout as string).trim();
		run(['checkout', '-b', 'feat/abandon-test']);
		const featureSha0 = (run(['rev-parse', 'HEAD']).stdout as string).trim();

		const result = abandonIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			spawnFn: realSpawnFn,
			clock: () => '2026-06-27T00:00:00.000Z',
		});

		if (!result.ok) throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);
		expect(result.id).toBe('CAM-1');
		expect(result.branchWasMain).toBe(false);

		// main advanced
		const mainSha1 = (run(['rev-parse', 'main']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// commit message
		const logResult = run(['log', 'main', '-1', '--format=%s']);
		expect((logResult.stdout as string).trim()).toBe('chore(cam): abandon CAM-1');

		// US-004: main has the updated per-file entry
		const showResult = run(['show', 'main:scripts/cam/issues/CAM-0001.json']);
		const entry = JSON.parse(showResult.stdout as string) as IssueEntry;
		expect(entry.status).toBe('abandoned');

		// feature branch HEAD unchanged
		const featureSha1 = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		expect(featureSha1).toBe(featureSha0);

		// working tree clean
		const status = run(['status', '--porcelain']);
		expect((status.stdout as string).trim()).toBe('');
	},
);

test.skipIf(!gitAvailable)(
	'Real-git abandon (on-main): ref-only commit via commitTreeToMain; working-tree file synced to HEAD',
	() => {
		// CAM-133: on-main path uses commitTreeToMain. After a successful commit,
		// syncWorktreeIfOnMain syncs the working-tree file to HEAD (coherence invariant).
		const { dir, run, issuesDir } = makeTmpRepoTwo();
		const mainSha0 = (run(['rev-parse', 'main']).stdout as string).trim();

		const result = abandonIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			spawnFn: realSpawnFn,
			clock: () => '2026-06-27T00:00:00.000Z',
		});

		if (!result.ok) throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);
		expect(result.branchWasMain).toBe(true);

		// main ref advanced (via git update-ref, not a working-tree commit)
		const mainSha1 = (run(['rev-parse', 'main']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// commit message on main
		const logResult = run(['log', 'main', '-1', '--format=%s']);
		expect((logResult.stdout as string).trim()).toBe('chore(cam): abandon CAM-1');

		// main ref has the updated entry (confirmed via git show)
		const showResult = run(['show', 'main:scripts/cam/issues/CAM-0001.json']);
		const mainEntry = JSON.parse(showResult.stdout as string) as IssueEntry;
		expect(mainEntry.status).toBe('abandoned');

		// working-tree file is synced to HEAD (syncWorktreeIfOnMain coherence invariant)
		const wtContent = readFileSync(join(issuesDir, 'CAM-0001.json'), 'utf8');
		const wtEntry = JSON.parse(wtContent) as IssueEntry;
		expect(wtEntry.status).toBe('abandoned');
	},
);

test.skipIf(!gitAvailable)(
	'Real-git abandon: already-abandoned guard fires in real git',
	() => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-abandon-aa-'));
		dirsToCleanup.push(dir);

		const run = (args: string[]) =>
			spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

		run(['init']);
		run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
		run(['config', 'user.email', 'test@example.com']);
		run(['config', 'user.name', 'Test User']);

		const camDir = join(dir, 'scripts', 'cam');
		const issuesDir = join(camDir, 'issues');
		mkdirSync(issuesDir, { recursive: true });

		const entry: IssueEntry = {
			id: 'CAM-1',
			title: 'Abandoned issue',
			stage: 'idea',
			status: 'abandoned',
			blockedBy: [],
			createdAt: '2026-01-01T00:00:00.000Z',
		};
		writeFileSync(join(issuesDir, 'CAM-0001.json'), toJson(entry));
		run(['add', '-A']);
		run(['commit', '-m', 'chore: initial']);

		const result = abandonIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			spawnFn: realSpawnFn,
			clock: () => '2026-06-27T00:00:00.000Z',
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('already-abandoned');
	},
);

// Real-git merge-into tests

test.skipIf(!gitAvailable)(
	'Real-git merge-into (off-main): source abandoned; description records target; main advances',
	() => {
		const { dir, run, issuesDir } = makeTmpRepoTwo();
		run(['checkout', '-b', 'feat/merge-test']);
		const mainSha0 = (run(['rev-parse', 'main']).stdout as string).trim();

		const result = mergeIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			intoId: 'CAM-2',
			spawnFn: realSpawnFn,
			clock: () => '2026-06-27T00:00:00.000Z',
		});

		if (!result.ok) throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);

		// main advanced
		const mainSha1 = (run(['rev-parse', 'main']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// source entry updated on main
		const showResult = run(['show', 'main:scripts/cam/issues/CAM-0001.json']);
		const source = JSON.parse(showResult.stdout as string) as IssueEntry;
		expect(source.status).toBe('abandoned');
		expect(source.description).toContain('Merged into CAM-2');

		// working tree clean
		const status = run(['status', '--porcelain']);
		expect((status.stdout as string).trim()).toBe('');

		// working-tree file NOT modified (off-main path)
		const wtContent = readFileSync(join(issuesDir, 'CAM-0001.json'), 'utf8');
		const wtEntry = JSON.parse(wtContent) as IssueEntry;
		expect(wtEntry.status).toBe('open');
	},
);

test.skipIf(!gitAvailable)(
	'Real-git merge-into: target-not-found guard fires in real git',
	() => {
		const { dir } = makeTmpRepoTwo();

		const result = mergeIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			intoId: 'CAM-999',
			spawnFn: realSpawnFn,
			clock: () => '2026-06-27T00:00:00.000Z',
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('target-not-found');
	},
);
