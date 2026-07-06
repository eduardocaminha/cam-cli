// test/integration/domain-docs-on-main.test.ts
//
// CAM-133 regression shape (mirrors test/integration/issue-specify-ref-only.test.ts):
// a prior ref-only issue write leaves the working tree stale; writeDomainDocsOnMain
// on main must then (a) preserve the prior file in main's tree, (b) make the new
// CONTEXT.md/ADR content visible via `git show main:...`, and (c) be idempotent on
// a second run with the same payload (no duplicate glossary entries, no second
// ADR file for the same decision title).
//
// CAM-118 US-002.

import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIssueFile } from '../../src/issues/alloc.ts';
import { writeDomainDocsOnMain, type SpawnFn } from '../../src/commands/domain-docs.ts';
import type { DomainDocsPayload } from '../../src/domain-docs/render.ts';

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0;

// ---------------------------------------------------------------------------
// Tmp-dir lifecycle
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// realSpawnFn: forwards env (GIT_INDEX_FILE) and input (hash-object --stdin)
// ---------------------------------------------------------------------------

const realSpawnFn: SpawnFn = (cmd, args, opts) =>
	spawnSync(cmd, args, {
		encoding: opts.encoding,
		...(opts.env !== undefined ? { env: opts.env } : {}),
		...(opts.input !== undefined ? { input: opts.input } : {}),
		stdio: 'pipe',
	}) as SpawnSyncReturns<string>;

// ---------------------------------------------------------------------------
// Repo scaffold
// ---------------------------------------------------------------------------

function makeTmpRepo(): { dir: string; run: (args: string[]) => ReturnType<typeof spawnSync> } {
	const dir = mkdtempSync(join(tmpdir(), 'cam-domain-docs-refonly-'));
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	// Minimal initial commit so main exists (git tracks no empty dirs).
	writeFileSync(join(dir, 'README.md'), '# test repo\n');
	run(['add', 'README.md']);
	run(['commit', '-m', 'chore: initial']);

	return { dir, run };
}

const PAYLOAD: DomainDocsPayload = {
	terms: [{ term: 'Order', definition: 'A request to purchase.' }],
	adrs: [
		{
			title: 'Use event sourcing',
			context: 'We need an audit trail.',
			decision: 'Adopt event sourcing for the write model.',
			consequences: 'Reads are projected separately.',
		},
	],
};

// ---------------------------------------------------------------------------
// Regression test: chained ref-only write -> writeDomainDocsOnMain
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'a prior ref-only issue write survives writeDomainDocsOnMain; new content is visible on main; a second run is idempotent',
	() => {
		const { dir, run } = makeTmpRepo();

		// Step 1: write CAM-1 ref-only (no working-tree mutation, CAM-133 style).
		const r1 = writeIssueFile({ cwd: dir, title: 'Idea 1', spawnFn: realSpawnFn });
		expect(r1.id).toBe('CAM-1');
		expect(existsSync(join(dir, 'scripts', 'cam', 'issues', 'CAM-0001.json'))).toBe(true);

		// Step 2: writeDomainDocsOnMain while checked out on main.
		const result1 = writeDomainDocsOnMain({
			cwd: dir,
			id: 'CAM-118',
			payload: PAYLOAD,
			spawnFn: realSpawnFn,
			clock: () => '2026-07-06T00:00:00.000Z',
			eventSink: () => {},
		});
		if (!result1.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(result1)}`);
		}
		expect(result1.noOp).toBeUndefined();
		expect(result1.adrFiles).toEqual(['0001-use-event-sourcing.md']);

		// Oracle (a): the prior ref-only issue file survives on main.
		const lsIssues = run(['ls-tree', '-r', '--name-only', 'main', 'scripts/cam/issues/']);
		const issueFiles = (lsIssues.stdout as string).trim().split('\n').filter(Boolean);
		expect(issueFiles).toContain('scripts/cam/issues/CAM-0001.json');

		// Oracle (b): new CONTEXT.md and ADR content is visible via `git show main:...`.
		const contextShow = run(['show', 'main:CONTEXT.md']);
		expect(contextShow.status).toBe(0);
		expect(contextShow.stdout as string).toContain('**Order**:');
		expect(contextShow.stdout as string).toContain('A request to purchase.');

		const adrShow = run(['show', 'main:docs/adr/0001-use-event-sourcing.md']);
		expect(adrShow.status).toBe(0);
		expect(adrShow.stdout as string).toContain('# ADR 0001: Use event sourcing');

		// Step 3: a second run with the SAME payload is idempotent.
		const result2 = writeDomainDocsOnMain({
			cwd: dir,
			id: 'CAM-118',
			payload: PAYLOAD,
			spawnFn: realSpawnFn,
			clock: () => '2026-07-06T00:05:00.000Z',
			eventSink: () => {},
		});
		if (!result2.ok) {
			throw new Error(`Expected ok:true but got: ${JSON.stringify(result2)}`);
		}

		// No new ADR file for the same decision title.
		expect(result2.adrFiles).toEqual([]);
		const lsAdrAfter = run(['ls-tree', '-r', '--name-only', 'main', 'docs/adr/']);
		const adrFilesAfter = (lsAdrAfter.stdout as string).trim().split('\n').filter(Boolean);
		expect(adrFilesAfter).toHaveLength(1);

		// No duplicate glossary entry: CONTEXT.md still has exactly one "**Order**:" block.
		const contextShowAfter = run(['show', 'main:CONTEXT.md']);
		const orderOccurrences = (contextShowAfter.stdout as string).split('**Order**:').length - 1;
		expect(orderOccurrences).toBe(1);

		// The prior ref-only issue file still survives after the second domain-docs commit.
		const lsIssuesAfter = run(['ls-tree', '-r', '--name-only', 'main', 'scripts/cam/issues/']);
		const issueFilesAfter = (lsIssuesAfter.stdout as string).trim().split('\n').filter(Boolean);
		expect(issueFilesAfter).toContain('scripts/cam/issues/CAM-0001.json');
	},
);
