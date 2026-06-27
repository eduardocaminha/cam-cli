// test/commands/issue-specify.test.ts
//
// Tests for src/commands/issue-specify.ts (specifyIssueOnMain).
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
import type { IssueEntry, IssuesLocalJson, WsjfScore } from '../../src/issues/types.ts';
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

function makeBacklog(overrides?: Partial<IssueEntry>): IssuesLocalJson {
	const entry: IssueEntry = {
		id: 'CAM-1',
		title: 'My idea',
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
	return { next_id: 2, issues: [entry] };
}

// ---------------------------------------------------------------------------
// Fake SpawnFn builder
// ---------------------------------------------------------------------------

interface FakeSpawnOpts {
	/** Simulated current branch (default: 'feat/test'). */
	branch?: string;
	/** Local main sha (default: 'abc123def456abc1'). */
	localMainSha?: string;
	/** If true, origin/main returns the same sha (up-to-date). */
	originMainUpToDate?: boolean;
	/** Backlog JSON to return from `git show main:scripts/cam/issues.local.json`. */
	backlog: IssuesLocalJson;
}

function makeFakeSpawnFn(opts: FakeSpawnOpts): { spawnFn: SpawnFn; calls: string[][] } {
	const branch = opts.branch ?? 'feat/test';
	const localMainSha = opts.localMainSha ?? 'abc123def456abc1';
	const calls: string[][] = [];

	const spawnFn: SpawnFn = (cmd, args, _options) => {
		calls.push([cmd, ...args]);

		const sub = args.join(' ');

		// rev-parse --abbrev-ref HEAD -> branch
		if (sub.includes('rev-parse --abbrev-ref HEAD')) {
			return { stdout: `${branch}\n`, stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}

		// rev-parse main (local)
		if (sub.match(/rev-parse main$/) || sub.endsWith('rev-parse main')) {
			return { stdout: `${localMainSha}\n`, stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}

		// fetch origin main (best-effort, always succeeds)
		if (sub.includes('fetch origin main')) {
			return { stdout: '', stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}

		// rev-parse origin/main
		if (sub.includes('rev-parse origin/main')) {
			if (opts.originMainUpToDate) {
				return { stdout: `${localMainSha}\n`, stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
			}
			// No remote -- skip diverge check
			return { stdout: '', stderr: '', status: 1, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}

		// git show main:scripts/cam/issues.local.json
		if (sub.includes('show') && sub.includes('issues.local.json')) {
			const json = JSON.stringify(opts.backlog, null, 2) + '\n';
			return { stdout: json, stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}

		// read-tree, hash-object, update-index, write-tree, commit-tree, update-ref
		if (sub.includes('read-tree')) {
			return { stdout: '', stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}
		if (sub.includes('hash-object')) {
			return { stdout: 'blobsha111\n', stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}
		if (sub.includes('update-index')) {
			return { stdout: '', stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}
		if (sub.includes('write-tree')) {
			return { stdout: 'treesha222\n', stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}
		if (sub.includes('commit-tree')) {
			return { stdout: 'newcommitsha333\n', stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}
		if (sub.includes('update-ref')) {
			return { stdout: '', stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}

		// push origin main (best-effort, simulate no remote -> non-zero)
		if (sub.includes('push origin main')) {
			return { stdout: '', stderr: 'no remote configured', status: 1, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}

		// add + commit + rev-parse --short HEAD (on-main path)
		if (sub.includes('add scripts/cam/issues.local.json')) {
			return { stdout: '', stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}
		if (sub.match(/commit -m /)) {
			return { stdout: '', stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}
		if (sub.includes('rev-parse --short HEAD')) {
			return { stdout: 'abc1234\n', stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
		}

		// fallback
		return { stdout: '', stderr: '', status: 0, pid: 0, signal: null, output: [] } as SpawnSyncReturns<string>;
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
		// The production-wiring test explicitly omits this to exercise the default file sink.
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
	const { spawnFn, calls } = makeFakeSpawnFn({ backlog: makeBacklog() });
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
	// No git show call should have been made (validation before backlog read)
	const showCall = calls.find((c) => c.join(' ').includes('show') && c.join(' ').includes('issues.local.json'));
	expect(showCall).toBeUndefined();
});

test('returns invalid-spec when spec is missing scope', () => {
	const { spawnFn } = makeFakeSpawnFn({ backlog: makeBacklog() });
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
	const { spawnFn, calls } = makeFakeSpawnFn({ backlog: makeBacklog() });
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
	// No git show call
	const showCall = calls.find((c) => c.join(' ').includes('show') && c.join(' ').includes('issues.local.json'));
	expect(showCall).toBeUndefined();
});

// ---------------------------------------------------------------------------
// AC3: not-found when id absent
// ---------------------------------------------------------------------------

test('returns not-found when id does not exist in backlog', () => {
	const { spawnFn } = makeFakeSpawnFn({ backlog: makeBacklog() });
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
	const backlog = makeBacklog({ stage: 'specified' });
	const { spawnFn } = makeFakeSpawnFn({ backlog });
	const result = specifyIssueOnMain(makeOpts({ spawnFn }));
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe('wrong-stage');
	}
});

test('returns wrong-stage when issue is planned', () => {
	const backlog = makeBacklog({ stage: 'planned' });
	const { spawnFn } = makeFakeSpawnFn({ backlog });
	const result = specifyIssueOnMain(makeOpts({ spawnFn }));
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.reason).toBe('wrong-stage');
	}
});

test('returns wrong-stage when issue is shipped', () => {
	const backlog = makeBacklog({ stage: 'shipped' });
	const { spawnFn } = makeFakeSpawnFn({ backlog });
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
	const backlog = makeBacklog({ status: 'abandoned' });
	const { spawnFn } = makeFakeSpawnFn({ backlog });
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
	const backlog = makeBacklog();
	const { spawnFn } = makeFakeSpawnFn({ backlog });
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
	const backlog = makeBacklog();
	const { spawnFn } = makeFakeSpawnFn({ backlog });
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
	const backlog = makeBacklog();
	const { spawnFn, calls } = makeFakeSpawnFn({ backlog });

	const result = specifyIssueOnMain(makeOpts({ spawnFn }));

	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.id).toBe('CAM-1');
		expect(result.committedTo).toBe('main');
		expect(result.branchWasMain).toBe(false);
		// sha is first 7 chars of newcommitsha333
		expect(result.sha).toBe('newcomm');
	}

	// Verify commit-tree plumbing calls were made
	const allArgs = calls.map((c) => c.join(' '));
	expect(allArgs.some((a) => a.includes('read-tree'))).toBe(true);
	expect(allArgs.some((a) => a.includes('hash-object'))).toBe(true);
	expect(allArgs.some((a) => a.includes('update-index'))).toBe(true);
	expect(allArgs.some((a) => a.includes('write-tree'))).toBe(true);
	expect(allArgs.some((a) => a.includes('commit-tree'))).toBe(true);
	expect(allArgs.some((a) => a.includes('update-ref'))).toBe(true);

	// Never called git checkout
	expect(allArgs.some((a) => a.includes('checkout'))).toBe(false);

	// Used git show to read the backlog
	expect(allArgs.some((a) => a.includes('show') && a.includes('issues.local.json'))).toBe(true);
});

test('success path: commit-tree call includes correct parent sha', () => {
	const backlog = makeBacklog();
	const { spawnFn, calls } = makeFakeSpawnFn({ backlog, localMainSha: 'mymainsha000' });

	specifyIssueOnMain(makeOpts({ spawnFn }));

	const commitTreeCall = calls.find((c) => c.join(' ').includes('commit-tree'));
	expect(commitTreeCall).toBeDefined();
	// The parent sha must appear in the commit-tree argv
	expect(commitTreeCall?.join(' ')).toContain('mymainsha000');
});

test('success path: commit message is chore(cam): specify <id>', () => {
	const backlog = makeBacklog();
	const { spawnFn, calls } = makeFakeSpawnFn({ backlog });

	specifyIssueOnMain(makeOpts({ spawnFn, id: 'CAM-1' }));

	const commitTreeCall = calls.find((c) => c.join(' ').includes('commit-tree'));
	expect(commitTreeCall?.join(' ')).toContain('chore(cam): specify CAM-1');
});

test('success path: serialized JSON sets stage to specified and includes spec+wsjf+blockedBy', () => {
	const backlog = makeBacklog();
	let capturedJson = '';
	const { spawnFn } = makeFakeSpawnFn({ backlog });

	// Intercept the hash-object call to capture the serialized JSON
	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJson = opts.input;
		}
		return spawnFn(cmd, args, opts);
	};

	specifyIssueOnMain(makeOpts({ spawnFn: recordingSpawnFn, blockedBy: [] }));

	const parsed = JSON.parse(capturedJson) as IssuesLocalJson;
	const entry = parsed.issues[0];
	expect(entry?.stage).toBe('specified');
	expect(entry?.spec).toEqual(VALID_SPEC);
	expect(entry?.wsjf).toEqual(VALID_WSJF);
	expect(entry?.blockedBy).toEqual([]);
});

test('success path (on-main): direct commit, writeFile called', () => {
	const backlog = makeBacklog();
	const writtenFiles: Array<{ path: string; content: string }> = [];
	const { spawnFn } = makeFakeSpawnFn({ backlog, branch: 'main' });

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
	expect(writtenFiles).toHaveLength(1);
	expect(writtenFiles[0]?.path).toContain('issues.local.json');
	const parsed = JSON.parse(writtenFiles[0]?.content ?? '{}') as IssuesLocalJson;
	expect(parsed.issues[0]?.stage).toBe('specified');
});

// ---------------------------------------------------------------------------
// AC3: No mutation on guard failures (verify git show not called for spec/wsjf errors)
// ---------------------------------------------------------------------------

test('no backlog read occurs when spec is invalid (fail fast)', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ backlog: makeBacklog() });
	specifyIssueOnMain(
		makeOpts({
			spawnFn,
			spec: { acceptanceCriteria: [], scope: 'x', gotchas: [], domainTerms: [] },
		}),
	);
	const showCalled = calls.some(
		(c) => c.join(' ').includes('show') && c.join(' ').includes('issues.local.json'),
	);
	expect(showCalled).toBe(false);
});

test('no backlog read occurs when wsjf is invalid (fail fast)', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ backlog: makeBacklog() });
	specifyIssueOnMain(
		makeOpts({
			spawnFn,
			// @ts-expect-error: intentionally broken wsjf
			wsjf: { value: 'not-a-number' },
		}),
	);
	const showCalled = calls.some(
		(c) => c.join(' ').includes('show') && c.join(' ').includes('issues.local.json'),
	);
	expect(showCalled).toBe(false);
});

// ---------------------------------------------------------------------------
// AC1: Never runs git checkout (verified by all paths above; explicit guard)
// ---------------------------------------------------------------------------

test('never calls git checkout on any code path', () => {
	// Try several code paths and verify no checkout call
	const scenarios: Array<Partial<SpecifyIssueOnMainOptions>> = [
		{ id: 'CAM-999' },  // not-found
		{ spec: { acceptanceCriteria: [], scope: '', gotchas: [], domainTerms: [] } }, // invalid-spec
		{},  // success
	];

	for (const overrides of scenarios) {
		const { spawnFn, calls } = makeFakeSpawnFn({ backlog: makeBacklog() });
		specifyIssueOnMain(makeOpts({ spawnFn, ...overrides }));
		const checkoutCalled = calls.some((c) => c.includes('checkout'));
		expect(checkoutCalled).toBe(false);
	}
});

// ===========================================================================
// US-007: stage-promoted observability events
// ===========================================================================

test('emits stage-promoted event on successful commit (injected sink)', () => {
	const backlog = makeBacklog();
	const { spawnFn } = makeFakeSpawnFn({ backlog });

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
	const backlog = makeBacklog();
	const { spawnFn } = makeFakeSpawnFn({ backlog });

	const emittedEvents: WorkerEvent[] = [];
	const fakeEventSink: WorkerEventLogger = (e) => emittedEvents.push(e);

	specifyIssueOnMain(makeOpts({ spawnFn, id: 'CAM-999', eventSink: fakeEventSink }));

	expect(emittedEvents).toHaveLength(0);
});

test('does not emit event when spec is invalid', () => {
	const backlog = makeBacklog();
	const { spawnFn } = makeFakeSpawnFn({ backlog });

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
	// If the sink is left unwired, readFileSync below throws and the test fails.
	const tmpCwd = mkdtempSync(join(tmpdir(), 'cam-specify-wiring-'));
	dirsToCleanup.push(tmpCwd);

	const backlog = makeBacklog();
	const { spawnFn } = makeFakeSpawnFn({ backlog });

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
	mkdirSync(camDir, { recursive: true });

	const entry: IssueEntry = {
		id: 'CAM-1',
		title: 'My idea',
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		...initialIssue,
	};
	const issuesJson = JSON.stringify({ next_id: 2, issues: [entry] }, null, 2) + '\n';
	writeFileSync(join(camDir, 'issues.local.json'), issuesJson);

	run(['add', '-A']);
	run(['commit', '-m', 'chore: initial harness state']);

	return { dir, run, camDir };
}

// Case A: off-main path

test.skipIf(!gitAvailable)(
	'Real-git Case A (off-main): entry on main gains specified stage; work branch untouched',
	() => {
		const { dir, run, camDir } = makeTmpRepo();

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
			eventSink: () => {}, // no-op: keep tmpdir working tree clean
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

		// main has the updated entry
		const showResult = run(['show', 'main:scripts/cam/issues.local.json']);
		const mainData = JSON.parse(showResult.stdout as string) as IssuesLocalJson;
		const entry = mainData.issues[0];
		expect(entry?.stage).toBe('specified');
		expect(entry?.spec).toEqual(VALID_SPEC);
		expect(entry?.wsjf).toEqual(VALID_WSJF);
		expect(entry?.blockedBy).toEqual([]);

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
		const wtContent = readFileSync(join(camDir, 'issues.local.json'), 'utf8');
		const wtData = JSON.parse(wtContent) as IssuesLocalJson;
		expect(wtData.issues[0]?.stage).toBe('idea');
	},
);

// Case B: on-main path

test.skipIf(!gitAvailable)(
	'Real-git Case B (on-main): direct commit; working-tree file gains specified stage',
	() => {
		const { dir, run, camDir } = makeTmpRepo();

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
			eventSink: () => {}, // no-op: keep tmpdir working tree clean
		});

		if (!result.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);
		}

		expect(result.branchWasMain).toBe(true);
		expect(result.committedTo).toBe('main');

		// main advanced
		const mainSha1 = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// commit message
		const logResult = run(['log', '-1', '--format=%s']);
		expect((logResult.stdout as string).trim()).toBe('chore(cam): specify CAM-1');

		// working-tree file updated
		const wtContent = readFileSync(join(camDir, 'issues.local.json'), 'utf8');
		const wtData = JSON.parse(wtContent) as IssuesLocalJson;
		expect(wtData.issues[0]?.stage).toBe('specified');
		expect(wtData.issues[0]?.spec).toEqual(VALID_SPEC);
		expect(wtData.issues[0]?.wsjf).toEqual(VALID_WSJF);

		// working tree clean
		const status = run(['status', '--porcelain']);
		expect((status.stdout as string).trim()).toBe('');
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
	const { spawnFn } = makeFakeSpawnFn({ backlog: makeBacklog() });
	const result = abandonIssueOnMain(makeAbandonOpts({ spawnFn, id: 'CAM-999' }));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe('not-found');
});

test('abandon: returns already-abandoned when status is already abandoned', () => {
	const backlog = makeBacklog({ status: 'abandoned' });
	const { spawnFn } = makeFakeSpawnFn({ backlog });
	const result = abandonIssueOnMain(makeAbandonOpts({ spawnFn }));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe('already-abandoned');
});

test('abandon: success path (off-main) sets status to abandoned', () => {
	const backlog = makeBacklog();
	let capturedJson = '';
	const { spawnFn } = makeFakeSpawnFn({ backlog });

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

	const parsed = JSON.parse(capturedJson) as IssuesLocalJson;
	expect(parsed.issues[0]?.status).toBe('abandoned');
	// stage is unchanged
	expect(parsed.issues[0]?.stage).toBe('idea');
});

test('abandon: success path (on-main) writeFile called', () => {
	const backlog = makeBacklog();
	const writtenFiles: Array<{ path: string; content: string }> = [];
	const { spawnFn } = makeFakeSpawnFn({ backlog, branch: 'main' });

	const result = abandonIssueOnMain(
		makeAbandonOpts({
			spawnFn,
			writeFile: (path, content) => writtenFiles.push({ path, content }),
		}),
	);

	expect(result.ok).toBe(true);
	if (result.ok) expect(result.branchWasMain).toBe(true);
	expect(writtenFiles).toHaveLength(1);
	const parsed = JSON.parse(writtenFiles[0]?.content ?? '{}') as IssuesLocalJson;
	expect(parsed.issues[0]?.status).toBe('abandoned');
});

test('abandon: commit message is chore(cam): abandon <id>', () => {
	const backlog = makeBacklog();
	const { spawnFn, calls } = makeFakeSpawnFn({ backlog });
	abandonIssueOnMain(makeAbandonOpts({ spawnFn, id: 'CAM-1' }));
	const commitTreeCall = calls.find((c) => c.join(' ').includes('commit-tree'));
	expect(commitTreeCall?.join(' ')).toContain('chore(cam): abandon CAM-1');
});

test('abandon: never calls git checkout', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ backlog: makeBacklog() });
	abandonIssueOnMain(makeAbandonOpts({ spawnFn }));
	expect(calls.some((c) => c.includes('checkout'))).toBe(false);
});

// ===========================================================================
// 4. mergeIssueOnMain -- unit tests
// ===========================================================================

function makeBacklogTwo(
	overrides1?: Partial<IssueEntry>,
	overrides2?: Partial<IssueEntry>,
): IssuesLocalJson {
	const e1: IssueEntry = {
		id: 'CAM-1',
		title: 'Source idea',
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides1,
	};
	const e2: IssueEntry = {
		id: 'CAM-2',
		title: 'Target idea',
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-02T00:00:00.000Z',
		...overrides2,
	};
	return { next_id: 3, issues: [e1, e2] };
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
	const { spawnFn } = makeFakeSpawnFn({ backlog: makeBacklogTwo() });
	const result = mergeIssueOnMain(makeMergeOpts({ spawnFn, id: 'CAM-1', intoId: 'CAM-1' }));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe('self-merge');
});

test('merge-into: returns source-not-found when source id absent', () => {
	const { spawnFn } = makeFakeSpawnFn({ backlog: makeBacklogTwo() });
	const result = mergeIssueOnMain(makeMergeOpts({ spawnFn, id: 'CAM-999', intoId: 'CAM-2' }));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe('source-not-found');
});

test('merge-into: returns target-not-found when target id absent', () => {
	const { spawnFn } = makeFakeSpawnFn({ backlog: makeBacklogTwo() });
	const result = mergeIssueOnMain(makeMergeOpts({ spawnFn, id: 'CAM-1', intoId: 'CAM-999' }));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe('target-not-found');
});

test('merge-into: returns already-abandoned when source is abandoned', () => {
	const backlog = makeBacklogTwo({ status: 'abandoned' });
	const { spawnFn } = makeFakeSpawnFn({ backlog });
	const result = mergeIssueOnMain(makeMergeOpts({ spawnFn }));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe('already-abandoned');
});

test('merge-into: success sets source status to abandoned and records target in description', () => {
	const backlog = makeBacklogTwo();
	let capturedJson = '';
	const { spawnFn } = makeFakeSpawnFn({ backlog });

	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJson = opts.input;
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

	const parsed = JSON.parse(capturedJson) as IssuesLocalJson;
	const source = parsed.issues.find((e) => e.id === 'CAM-1');
	expect(source?.status).toBe('abandoned');
	expect(source?.description).toContain('Merged into CAM-2.');
	// target untouched
	const target = parsed.issues.find((e) => e.id === 'CAM-2');
	expect(target?.status).toBe('open');
});

test('merge-into: appends to existing description', () => {
	const backlog = makeBacklogTwo({ description: 'Original desc' });
	let capturedJson = '';
	const { spawnFn } = makeFakeSpawnFn({ backlog });

	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJson = opts.input;
		}
		return spawnFn(cmd, args, opts);
	};

	mergeIssueOnMain(makeMergeOpts({ spawnFn: recordingSpawnFn }));

	const parsed = JSON.parse(capturedJson) as IssuesLocalJson;
	const source = parsed.issues.find((e) => e.id === 'CAM-1');
	expect(source?.description).toBe('Original desc\n\nMerged into CAM-2.');
});

test('merge-into: foldBlockedBy folds source blockedBy into target', () => {
	// source blocks on CAM-3; after merge, target should also block on CAM-3
	const backlog: IssuesLocalJson = {
		next_id: 4,
		issues: [
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
		],
	};
	let capturedJson = '';
	const { spawnFn } = makeFakeSpawnFn({ backlog });

	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJson = opts.input;
		}
		return spawnFn(cmd, args, opts);
	};

	mergeIssueOnMain(makeMergeOpts({ spawnFn: recordingSpawnFn, foldBlockedBy: true }));

	const parsed = JSON.parse(capturedJson) as IssuesLocalJson;
	const target = parsed.issues.find((e) => e.id === 'CAM-2');
	expect(target?.blockedBy).toContain('CAM-3');
});

test('merge-into: foldBlockedBy does not fold when false (default)', () => {
	const backlog: IssuesLocalJson = {
		next_id: 4,
		issues: [
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
		],
	};
	let capturedJson = '';
	const { spawnFn } = makeFakeSpawnFn({ backlog });

	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJson = opts.input;
		}
		return spawnFn(cmd, args, opts);
	};

	mergeIssueOnMain(makeMergeOpts({ spawnFn: recordingSpawnFn, foldBlockedBy: false }));

	const parsed = JSON.parse(capturedJson) as IssuesLocalJson;
	const target = parsed.issues.find((e) => e.id === 'CAM-2');
	expect(target?.blockedBy).toEqual([]);
});

test('merge-into: foldBlockedBy deduplicates existing entries', () => {
	const backlog: IssuesLocalJson = {
		next_id: 4,
		issues: [
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
		],
	};
	let capturedJson = '';
	const { spawnFn } = makeFakeSpawnFn({ backlog });

	const recordingSpawnFn: SpawnFn = (cmd, args, opts) => {
		if (args.join(' ').includes('hash-object') && opts.input !== undefined) {
			capturedJson = opts.input;
		}
		return spawnFn(cmd, args, opts);
	};

	mergeIssueOnMain(makeMergeOpts({ spawnFn: recordingSpawnFn, foldBlockedBy: true }));

	const parsed = JSON.parse(capturedJson) as IssuesLocalJson;
	const target = parsed.issues.find((e) => e.id === 'CAM-2');
	// CAM-3 should appear only once (no duplication)
	expect(target?.blockedBy.filter((d) => d === 'CAM-3')).toHaveLength(1);
});

test('merge-into: commit message is chore(cam): merge <id> into <intoId>', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ backlog: makeBacklogTwo() });
	mergeIssueOnMain(makeMergeOpts({ spawnFn }));
	const commitTreeCall = calls.find((c) => c.join(' ').includes('commit-tree'));
	expect(commitTreeCall?.join(' ')).toContain('chore(cam): merge CAM-1 into CAM-2');
});

test('merge-into: never calls git checkout', () => {
	const { spawnFn, calls } = makeFakeSpawnFn({ backlog: makeBacklogTwo() });
	mergeIssueOnMain(makeMergeOpts({ spawnFn }));
	expect(calls.some((c) => c.includes('checkout'))).toBe(false);
});

// ===========================================================================
// 5. Real-git integration tests: abandon and merge-into
// ===========================================================================

function makeTmpRepoTwo(): RepoHandles & { camDir2?: string } {
	const dir = mkdtempSync(join(tmpdir(), 'cam-abandon-merge-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	const camDir = join(dir, 'scripts', 'cam');
	mkdirSync(camDir, { recursive: true });

	const issues: IssuesLocalJson = {
		next_id: 3,
		issues: [
			{
				id: 'CAM-1',
				title: 'Source idea',
				stage: 'idea',
				status: 'open',
				blockedBy: [],
				createdAt: '2026-01-01T00:00:00.000Z',
			},
			{
				id: 'CAM-2',
				title: 'Target idea',
				stage: 'idea',
				status: 'open',
				blockedBy: [],
				createdAt: '2026-01-02T00:00:00.000Z',
			},
		],
	};
	writeFileSync(join(camDir, 'issues.local.json'), JSON.stringify(issues, null, 2) + '\n');

	run(['add', '-A']);
	run(['commit', '-m', 'chore: initial harness state']);

	return { dir, run, camDir };
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

		// entry is abandoned on main
		const showResult = run(['show', 'main:scripts/cam/issues.local.json']);
		const data = JSON.parse(showResult.stdout as string) as IssuesLocalJson;
		const entry = data.issues.find((e) => e.id === 'CAM-1');
		expect(entry?.status).toBe('abandoned');

		// feature branch HEAD unchanged
		const featureSha1 = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		expect(featureSha1).toBe(featureSha0);

		// working tree clean
		expect((run(['status', '--porcelain']).stdout as string).trim()).toBe('');
	},
);

test.skipIf(!gitAvailable)(
	'Real-git abandon (on-main): direct commit; file updated in working tree',
	() => {
		const { dir, run, camDir } = makeTmpRepoTwo();

		const result = abandonIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			spawnFn: realSpawnFn,
			clock: () => '2026-06-27T00:00:00.000Z',
		});

		if (!result.ok) throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);
		expect(result.branchWasMain).toBe(true);

		const wtContent = readFileSync(join(camDir, 'issues.local.json'), 'utf8');
		const data = JSON.parse(wtContent) as IssuesLocalJson;
		const entry = data.issues.find((e) => e.id === 'CAM-1');
		expect(entry?.status).toBe('abandoned');

		const logResult = run(['log', '-1', '--format=%s']);
		expect((logResult.stdout as string).trim()).toBe('chore(cam): abandon CAM-1');

		expect((run(['status', '--porcelain']).stdout as string).trim()).toBe('');
	},
);

test.skipIf(!gitAvailable)(
	'Real-git abandon: already-abandoned guard fires in real git',
	() => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-abandon-guard-'));
		dirsToCleanup.push(dir);

		const run = (args: string[]) =>
			spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
		run(['init']);
		run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
		run(['config', 'user.email', 'test@example.com']);
		run(['config', 'user.name', 'Test User']);
		const camDir = join(dir, 'scripts', 'cam');
		mkdirSync(camDir, { recursive: true });
		const issues: IssuesLocalJson = {
			next_id: 2,
			issues: [
				{
					id: 'CAM-1',
					title: 'Already done',
					stage: 'idea',
					status: 'abandoned',
					blockedBy: [],
					createdAt: '2026-01-01T00:00:00.000Z',
				},
			],
		};
		writeFileSync(join(camDir, 'issues.local.json'), JSON.stringify(issues, null, 2) + '\n');
		run(['add', '-A']);
		run(['commit', '-m', 'chore: init']);

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
		const { dir, run } = makeTmpRepoTwo();
		const mainSha0 = (run(['rev-parse', 'main']).stdout as string).trim();
		run(['checkout', '-b', 'feat/merge-test']);
		const featureSha0 = (run(['rev-parse', 'HEAD']).stdout as string).trim();

		const result = mergeIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			intoId: 'CAM-2',
			spawnFn: realSpawnFn,
			clock: () => '2026-06-27T00:00:00.000Z',
		});

		if (!result.ok) throw new Error(`Expected ok:true but got: ${JSON.stringify(result)}`);
		expect(result.id).toBe('CAM-1');
		expect(result.intoId).toBe('CAM-2');
		expect(result.branchWasMain).toBe(false);

		// main advanced
		const mainSha1 = (run(['rev-parse', 'main']).stdout as string).trim();
		expect(mainSha1).not.toBe(mainSha0);

		// commit message
		const logResult = run(['log', 'main', '-1', '--format=%s']);
		expect((logResult.stdout as string).trim()).toBe('chore(cam): merge CAM-1 into CAM-2');

		// source is abandoned on main; description records merge target
		const showResult = run(['show', 'main:scripts/cam/issues.local.json']);
		const data = JSON.parse(showResult.stdout as string) as IssuesLocalJson;
		const source = data.issues.find((e) => e.id === 'CAM-1');
		expect(source?.status).toBe('abandoned');
		expect(source?.description).toContain('Merged into CAM-2.');

		// target untouched
		const target = data.issues.find((e) => e.id === 'CAM-2');
		expect(target?.status).toBe('open');

		// feature branch HEAD unchanged
		const featureSha1 = (run(['rev-parse', 'HEAD']).stdout as string).trim();
		expect(featureSha1).toBe(featureSha0);

		// working tree clean
		expect((run(['status', '--porcelain']).stdout as string).trim()).toBe('');
	},
);

test.skipIf(!gitAvailable)(
	'Real-git merge-into: self-merge guard fires in real git',
	() => {
		const { dir } = makeTmpRepoTwo();
		const result = mergeIssueOnMain({
			cwd: dir,
			id: 'CAM-1',
			intoId: 'CAM-1',
			spawnFn: realSpawnFn,
			clock: () => '2026-06-27T00:00:00.000Z',
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('self-merge');
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
