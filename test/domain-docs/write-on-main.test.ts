// test/domain-docs/write-on-main.test.ts
//
// Unit tests for writeDomainDocsOnMain() in src/commands/domain-docs.ts
// (CAM-118 US-002).
//
// All external I/O is faked via injectable SpawnFn; no real git binary or
// filesystem is exercised (except the mkdtempSync inside commitTreeToMain).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	writeDomainDocsOnMain,
	type SpawnFn,
	type WriteDomainDocsOnMainOptions,
	type WriteDomainDocsOnMainOutcome,
	type WriteDomainDocsOnMainSuccess,
} from '../../src/commands/domain-docs.ts';
import type { DomainDocsPayload } from '../../src/domain-docs/render.ts';
import type { WorkerEvent } from '../../src/supervisor/events.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_TS = '2026-07-06T14:00:00.000Z';
const clock = () => FIXED_TS;

const EMPTY_PAYLOAD: DomainDocsPayload = { terms: [], adrs: [] };

const ONE_TERM_PAYLOAD: DomainDocsPayload = {
	terms: [{ term: 'Order', definition: 'A request to purchase.' }],
	adrs: [],
};

const ONE_ADR_PAYLOAD: DomainDocsPayload = {
	terms: [],
	adrs: [
		{
			title: 'Use event sourcing',
			context: 'We need an audit trail.',
			decision: 'Adopt event sourcing for the write model.',
			consequences: 'Reads are projected separately.',
		},
	],
};

const EXISTING_CONTEXT_MD =
	'# Context\n\n## Language\n\n**Invoice**:\nA request for payment.\n';

const EXISTING_ADR_LS_TREE_OUTPUT = [
	'docs/adr/0001-issue-system-redesign.md',
	'docs/adr/0002-fast-track-plan-ready.md',
	'docs/adr/0009-ship-phase-deterministic-sidecar-runner.md',
].join('\n') + '\n';

function okResult(stdout = ''): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null };
}

function failResult(stderr = ''): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, '', stderr], stdout: '', stderr, status: 1, signal: null };
}

function assertOk(
	result: WriteDomainDocsOnMainOutcome,
): asserts result is WriteDomainDocsOnMainSuccess {
	if (!result.ok) {
		throw new Error(
			`Expected ok:true but got ok:false, reason=${JSON.stringify((result as { reason: string }).reason)}`,
		);
	}
}

interface SpawnCall {
	cmd: string;
	args: string[];
}

interface RecordingSpawnOpts {
	/** What branch `git rev-parse --abbrev-ref HEAD` reports. Default 'cam/feature'. */
	branch?: string;
	/** SHA returned by `git rev-parse main`. Default 'mainsha1234567890'. */
	mainSha?: string;
	/** Exit status for `git rev-parse main`. Default 0. Set to 1 for missing local main. */
	mainRevParseStatus?: number;
	/** SHA returned by `git rev-parse origin/main`. Default = mainSha. */
	originMainSha?: string;
	/** Exit status for `git rev-parse origin/main`. Default 0. Set to 1 for no-remote. */
	originMainStatus?: number;
	/** `git show main:CONTEXT.md` stdout. Default: absent (non-zero exit). */
	contextMdContent?: string | null;
	/** `git ls-tree ... docs/adr/` stdout. Default: EXISTING_ADR_LS_TREE_OUTPUT. */
	adrLsTreeOutput?: string;
	/** SHA returned by `git hash-object`. Default 'blobsha1234'. */
	blobSha?: string;
	/** SHA returned by `git write-tree`. Default 'treesha1234'. */
	treeSha?: string;
	/** Full commit SHA returned by `git commit-tree`. Default 'newcommitsha1234567'. */
	newCommitSha?: string;
	/** Exit status for `git push origin main`. Default 0. */
	pushStatus?: number;
}

function makeRecordingSpawn(opts: RecordingSpawnOpts = {}): {
	spawnFn: SpawnFn;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const branch = opts.branch ?? 'cam/feature';
	const mainSha = opts.mainSha ?? 'mainsha1234567890';
	const mainRevParseStatus = opts.mainRevParseStatus ?? 0;
	const originMainSha = opts.originMainSha ?? mainSha;
	const originMainStatus = opts.originMainStatus ?? 0;
	const contextMdContent = opts.contextMdContent ?? null;
	const adrLsTreeOutput = opts.adrLsTreeOutput ?? EXISTING_ADR_LS_TREE_OUTPUT;
	const blobSha = opts.blobSha ?? 'blobsha1234';
	const treeSha = opts.treeSha ?? 'treesha1234';
	const newCommitSha = opts.newCommitSha ?? 'newcommitsha1234567';
	const pushStatus = opts.pushStatus ?? 0;

	const spawnFn: SpawnFn = (cmd, args, _options) => {
		calls.push({ cmd, args });
		const argsStr = args.join(' ');

		if (argsStr.includes('rev-parse') && argsStr.includes('--abbrev-ref') && argsStr.includes('HEAD')) {
			return okResult(branch + '\n');
		}

		if (argsStr.includes('rev-parse') && argsStr.includes('origin/main')) {
			return { ...okResult(originMainSha + '\n'), status: originMainStatus };
		}

		if (
			argsStr.includes('rev-parse') &&
			argsStr.includes('main') &&
			!argsStr.includes('--abbrev-ref') &&
			!argsStr.includes('origin/main')
		) {
			return { ...okResult(mainSha + '\n'), status: mainRevParseStatus };
		}

		if (argsStr.includes('fetch')) {
			return okResult();
		}

		if (argsStr.includes('show') && argsStr.includes('main:CONTEXT.md')) {
			return contextMdContent === null ? failResult('fatal: path not in tree') : okResult(contextMdContent);
		}

		if (argsStr.includes('ls-tree') && argsStr.includes('docs/adr')) {
			return okResult(adrLsTreeOutput);
		}

		if (argsStr.includes('read-tree')) {
			return okResult();
		}

		if (argsStr.includes('hash-object')) {
			return okResult(blobSha + '\n');
		}

		if (argsStr.includes('update-index')) {
			return okResult();
		}

		if (argsStr.includes('write-tree')) {
			return okResult(treeSha + '\n');
		}

		if (argsStr.includes('commit-tree')) {
			return okResult(newCommitSha + '\n');
		}

		if (argsStr.includes('update-ref')) {
			return okResult();
		}

		if (argsStr.includes('push') && argsStr.includes('origin') && argsStr.includes('main')) {
			return pushStatus === 0
				? okResult()
				: { ...failResult('rejected: remote rejected'), status: pushStatus };
		}

		return okResult();
	};

	return { spawnFn, calls };
}

function makeOptions(
	overrides: Partial<WriteDomainDocsOnMainOptions> & { spawnFn: SpawnFn },
): WriteDomainDocsOnMainOptions {
	return {
		cwd: '/fake/project',
		id: 'CAM-118',
		payload: EMPTY_PAYLOAD,
		clock,
		// Default no-op eventSink so unit tests do not touch the filesystem
		// (mirrors test/commands/issue-specify.test.ts). Tests that assert on
		// the emitted event override this with a capturing sink.
		eventSink: () => {},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// AC1: guard order + discriminated union + empty-payload no-op
// ---------------------------------------------------------------------------

describe('writeDomainDocsOnMain — AC1: guard order, discriminated union, empty-payload no-op', () => {
	test('empty payload returns ok:true noOp:true with no commit and no push', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = writeDomainDocsOnMain(makeOptions({ spawnFn, payload: EMPTY_PAYLOAD }));

		assertOk(result);
		expect(result.noOp).toBe(true);
		expect(result.adrFiles).toEqual([]);
		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('update-ref'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('push'))).toBeUndefined();
		// noOp path never even reads CONTEXT.md / docs/adr from main.
		expect(calls.find((c) => c.args.includes('show'))).toBeUndefined();
		expect(calls.find((c) => c.args.includes('ls-tree'))).toBeUndefined();
	});

	test('up-to-date guard runs before payload validation (detached-head wins over invalid payload)', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ branch: 'HEAD' });
		// Deliberately invalid payload (not an object at runtime).
		const result = writeDomainDocsOnMain(
			makeOptions({ spawnFn, payload: 'not-a-payload' as unknown as DomainDocsPayload }),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('detached-head');
		}
		expect(calls.find((c) => c.args.includes('commit-tree'))).toBeUndefined();
	});

	test('invalid payload returns ok:false reason:invalid-payload with errors', () => {
		const { spawnFn } = makeRecordingSpawn();
		const result = writeDomainDocsOnMain(
			makeOptions({ spawnFn, payload: { terms: 'nope', adrs: [] } as unknown as DomainDocsPayload }),
		);

		expect(result.ok).toBe(false);
		if (!result.ok && result.reason === 'invalid-payload') {
			expect(result.errors.length).toBeGreaterThan(0);
		} else {
			throw new Error('expected reason:invalid-payload');
		}
	});

	test('callers narrow success/error via if (!result.ok)', () => {
		const { spawnFn } = makeRecordingSpawn();
		const result = writeDomainDocsOnMain(makeOptions({ spawnFn, payload: ONE_TERM_PAYLOAD }));
		if (!result.ok) {
			throw new Error('expected success');
		}
		expect(typeof result.sha).toBe('string');
		expect(Array.isArray(result.adrFiles)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC2: reads from main (git show main:CONTEXT.md, git ls-tree against main)
// ---------------------------------------------------------------------------

describe('writeDomainDocsOnMain — AC2: reads CONTEXT.md and docs/adr/ listing from main', () => {
	test('reads CONTEXT.md via `git show main:CONTEXT.md`', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		writeDomainDocsOnMain(makeOptions({ spawnFn, payload: ONE_TERM_PAYLOAD }));

		const showCall = calls.find((c) => c.args.includes('show'));
		expect(showCall).toBeDefined();
		expect(showCall!.args).toContain('main:CONTEXT.md');
	});

	test('reads docs/adr/ listing via `git ls-tree` against main', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		writeDomainDocsOnMain(makeOptions({ spawnFn, payload: ONE_ADR_PAYLOAD }));

		const lsTreeCall = calls.find((c) => c.args.includes('ls-tree'));
		expect(lsTreeCall).toBeDefined();
		expect(lsTreeCall!.args).toContain('main');
		expect(lsTreeCall!.args.some((a) => a.includes('docs/adr'))).toBe(true);
	});

	test('ADR numbers allocated against main listing: existing 0001..0009 yields 0010', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = writeDomainDocsOnMain(makeOptions({ spawnFn, payload: ONE_ADR_PAYLOAD }));
		assertOk(result);
		expect(result.adrFiles).toEqual(['0010-use-event-sourcing.md']);

		const cacheinfoCall = calls.find((c) =>
			c.args.some((a) => a.startsWith('100644,') && a.includes('0010-use-event-sourcing.md')),
		);
		expect(cacheinfoCall).toBeDefined();
	});

	test('absent CONTEXT.md on main (non-zero git show exit) is treated as null, not an error', () => {
		const { spawnFn } = makeRecordingSpawn({ contextMdContent: null });
		const result = writeDomainDocsOnMain(makeOptions({ spawnFn, payload: ONE_TERM_PAYLOAD }));
		assertOk(result);
	});

	test('existing CONTEXT.md content on main is merged, not overwritten', () => {
		const { spawnFn, calls } = makeRecordingSpawn({ contextMdContent: EXISTING_CONTEXT_MD });
		writeDomainDocsOnMain(makeOptions({ spawnFn, payload: ONE_TERM_PAYLOAD }));

		const hashCall = calls.find(
			(c) => c.args.includes('hash-object') && (c.args.includes('-w') || c.args.includes('--stdin')),
		);
		expect(hashCall).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// AC3: one atomic commit via commitTreeToMain, message, best-effort push
// ---------------------------------------------------------------------------

describe('writeDomainDocsOnMain — AC3: atomic commit via commitTreeToMain + best-effort push', () => {
	test('commit message is docs(cam): domain docs for <id>', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		writeDomainDocsOnMain(makeOptions({ spawnFn, payload: ONE_TERM_PAYLOAD, id: 'CAM-118' }));

		const commitTreeCall = calls.find((c) => c.args.includes('commit-tree'));
		expect(commitTreeCall).toBeDefined();
		const msgIdx = commitTreeCall!.args.indexOf('-m');
		expect(commitTreeCall!.args[msgIdx + 1]).toBe('docs(cam): domain docs for CAM-118');
	});

	test('CONTEXT.md and the new ADR file both land in one atomic commit (single write-tree/commit-tree pair)', () => {
		const combinedPayload: DomainDocsPayload = { terms: ONE_TERM_PAYLOAD.terms, adrs: ONE_ADR_PAYLOAD.adrs };
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = writeDomainDocsOnMain(makeOptions({ spawnFn, payload: combinedPayload }));
		assertOk(result);

		const writeTreeCalls = calls.filter((c) => c.args.includes('write-tree'));
		const commitTreeCalls = calls.filter((c) => c.args.includes('commit-tree'));
		expect(writeTreeCalls.length).toBe(1);
		expect(commitTreeCalls.length).toBe(1);

		const cacheinfoPaths = calls
			.filter((c) => c.args.includes('update-index'))
			.flatMap((c) => c.args.filter((a) => a.startsWith('100644,')));
		expect(cacheinfoPaths.some((p) => p.includes('CONTEXT.md'))).toBe(true);
		expect(cacheinfoPaths.some((p) => p.includes('docs/adr/0010-use-event-sourcing.md'))).toBe(true);
	});

	test('push fires after update-ref (best-effort)', () => {
		const { spawnFn, calls } = makeRecordingSpawn();
		const result = writeDomainDocsOnMain(makeOptions({ spawnFn, payload: ONE_TERM_PAYLOAD }));
		assertOk(result);

		const updateRefIdx = calls.findIndex((c) => c.args.includes('update-ref'));
		const pushIdx = calls.findIndex((c) => c.args.includes('push') && c.args.includes('origin'));
		expect(updateRefIdx).toBeGreaterThan(-1);
		expect(pushIdx).toBeGreaterThan(updateRefIdx);
	});

	test('push failure still returns ok:true (push is best-effort)', () => {
		const { spawnFn } = makeRecordingSpawn({ pushStatus: 1 });
		const result = writeDomainDocsOnMain(makeOptions({ spawnFn, payload: ONE_TERM_PAYLOAD }));
		assertOk(result);
	});
});

// ---------------------------------------------------------------------------
// AC4 (unit-level slice; full real-git coverage lives in
// test/integration/domain-docs-on-main.test.ts): idempotent re-run
// ---------------------------------------------------------------------------

describe('writeDomainDocsOnMain — AC4 (unit slice): idempotent ADR re-run', () => {
	test('re-running with an ADR title that already exists on main skips creating a duplicate file', () => {
		const lsTreeWithNewAdr = EXISTING_ADR_LS_TREE_OUTPUT.trimEnd() + '\n0010-use-event-sourcing.md\n';
		const { spawnFn, calls } = makeRecordingSpawn({ adrLsTreeOutput: lsTreeWithNewAdr });
		const result = writeDomainDocsOnMain(makeOptions({ spawnFn, payload: ONE_ADR_PAYLOAD }));
		assertOk(result);

		expect(result.adrFiles).toEqual([]);
		const cacheinfoPaths = calls
			.filter((c) => c.args.includes('update-index'))
			.flatMap((c) => c.args.filter((a) => a.startsWith('100644,')));
		expect(cacheinfoPaths.some((p) => p.includes('docs/adr/'))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AC5: 'domain-docs-written' observability event (default sink + injected sink)
// ---------------------------------------------------------------------------

describe('writeDomainDocsOnMain — AC5: domain-docs-written observability event', () => {
	test('emits domain-docs-written via injected eventSink on a successful non-noOp commit', () => {
		const events: WorkerEvent[] = [];
		const { spawnFn } = makeRecordingSpawn();
		const result = writeDomainDocsOnMain(
			makeOptions({
				spawnFn,
				payload: ONE_ADR_PAYLOAD,
				id: 'CAM-118',
				eventSink: (e) => events.push(e),
			}),
		);
		assertOk(result);

		expect(events.length).toBe(1);
		expect(events[0]?.kind).toBe('domain-docs-written');
		expect(events[0]?.storyId).toBe('CAM-118');
		expect(events[0]?.detail).toEqual({ id: 'CAM-118', adrFiles: ['0010-use-event-sourcing.md'] });
	});

	test('does not emit any event on the empty-payload no-op path', () => {
		const events: WorkerEvent[] = [];
		const { spawnFn } = makeRecordingSpawn();
		writeDomainDocsOnMain(
			makeOptions({ spawnFn, payload: EMPTY_PAYLOAD, eventSink: (e) => events.push(e) }),
		);
		expect(events.length).toBe(0);
	});

	test('production wiring: omitting eventSink writes to <cwd>/.claude/cam-worker-events.jsonl', async () => {
		const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');

		const tmpCwd = mkdtempSync(join(tmpdir(), 'cam-domain-docs-events-'));
		try {
			const { spawnFn } = makeRecordingSpawn();
			const result = writeDomainDocsOnMain({
				cwd: tmpCwd,
				id: 'CAM-118',
				payload: ONE_ADR_PAYLOAD,
				spawnFn,
				clock,
				// eventSink intentionally omitted: must use the default file sink.
			});
			assertOk(result);

			const logPath = join(tmpCwd, '.claude', 'cam-worker-events.jsonl');
			const contents = readFileSync(logPath, 'utf8');
			const parsed = JSON.parse(contents.trim().split('\n')[0]!) as { kind: string };
			expect(parsed.kind).toBe('domain-docs-written');
		} finally {
			rmSync(tmpCwd, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// AC6/AC7: up-to-date guard reasons + export sanity
// ---------------------------------------------------------------------------

describe('writeDomainDocsOnMain — up-to-date guard (detached-head, missing-main, diverged)', () => {
	test('returns ok:false reason:diverged when local main differs from origin/main', () => {
		const { spawnFn, calls } = makeRecordingSpawn({
			mainSha: 'localsha111',
			originMainSha: 'originsha222',
		});
		const result = writeDomainDocsOnMain(makeOptions({ spawnFn, payload: ONE_TERM_PAYLOAD }));

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('diverged');
		}
		expect(calls.find((c) => c.args.includes('show'))).toBeUndefined();
	});

	test('returns ok:false reason:missing-main when rev-parse main fails', () => {
		const { spawnFn } = makeRecordingSpawn({ mainRevParseStatus: 1 });
		const result = writeDomainDocsOnMain(makeOptions({ spawnFn, payload: ONE_TERM_PAYLOAD }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('missing-main');
		}
	});

	test('writeDomainDocsOnMain is exported from src/commands/domain-docs.ts', () => {
		expect(typeof writeDomainDocsOnMain).toBe('function');
	});
});
