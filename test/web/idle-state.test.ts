// test/web/idle-state.test.ts
//
// Real-server coverage for the between-cycle snapshot extension. The fixture
// publishes main to a real remote and tracks it, so the route exercises the
// sanctioned backlog reader over the runtime source ref (CAM-580), rather than
// deriving issue state from working-tree files.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import { GSHIP_VERSION } from '../../src/version.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function git(cwd: string, args: string[]): void {
	const result = Bun.spawnSync(['git', ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr));
	}
}

function issue(overrides: Partial<IssueEntry> & Pick<IssueEntry, 'id' | 'title'>): IssueEntry {
	return {
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-08-01T00:00:00Z',
		updatedAt: '2026-08-02T00:00:00Z',
		...overrides,
	};
}

function seedIdleRepo(): string {
	const root = createTestTmpdir('gship-web-idle-');
	const cwd = join(root, 'repo');
	mkdirSync(cwd, { recursive: true });
	git(cwd, ['init', '-q', '--initial-branch=main']);
	git(cwd, ['config', 'user.email', 'gship-test@example.com']);
	git(cwd, ['config', 'user.name', 'Gateship Test']);

	const issues = [
		issue({ id: 'GSHIP-1', title: 'first idea' }),
		issue({
			id: 'GSHIP-2',
			title: 'ready',
			stage: 'specified',
			spec: { acceptanceCriteria: ['works'], scope: 'test', gotchas: [], domainTerms: [] },
		}),
		issue({ id: 'GSHIP-3', title: 'blocked', stage: 'specified', blockedBy: ['GSHIP-1'] }),
	];
	const issueDir = join(cwd, '.gateship', 'issues');
	mkdirSync(issueDir, { recursive: true });
	for (const entry of issues) {
		writeFileSync(join(issueDir, `${entry.id}.json`), JSON.stringify(entry));
	}
	git(cwd, ['add', '.']);
	git(cwd, ['commit', '-q', '-m', 'seed backlog']);

	// The snapshot derives the backlog from the runtime source ref, so the
	// fixture publishes main to a remote and tracks it.
	const remote = join(root, 'remote.git');
	git(cwd, ['clone', '-q', '--bare', cwd, remote]);
	git(cwd, ['remote', 'add', 'origin', remote]);
	git(cwd, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);

	return cwd;
}

async function getSnapshot(cwd: string): Promise<Record<string, unknown>> {
	const handle = startWebServer({ port: 0, cwd });
	try {
		const response = await fetch(`http://${handle.hostname}:${handle.port}/api/snapshot`);
		expect(response.status).toBe(200);
		return (await response.json()) as Record<string, unknown>;
	} finally {
		await handle.stop();
	}
}

describe('GET /api/snapshot idle state', () => {
	test('returns the source-ref-backed backlog', async () => {
		const cwd = seedIdleRepo();
		const payload = await getSnapshot(cwd);
		const idleState = payload['idleState'] as Record<string, unknown>;

		expect(Object.keys(payload)).toEqual(['idleState', 'version']);
		expect(payload['version']).toBe(GSHIP_VERSION);
		expect(idleState).toBeDefined();
		expect(Object.keys(idleState)).toEqual(['backlog']);
		expect(idleState['backlog']).toEqual({
			counts: { idea: 1, specified: 2, planned: 0 },
			plannable: [
				{
					id: 'GSHIP-2',
					title: 'ready',
					createdAt: '2026-08-01T00:00:00Z',
					updatedAt: '2026-08-02T00:00:00Z',
				},
			],
			byStage: {
				idea: [
					{
						id: 'GSHIP-1',
						title: 'first idea',
						createdAt: '2026-08-01T00:00:00Z',
						updatedAt: '2026-08-02T00:00:00Z',
					},
				],
				specified: [
					{
						id: 'GSHIP-2',
						title: 'ready',
						createdAt: '2026-08-01T00:00:00Z',
						updatedAt: '2026-08-02T00:00:00Z',
					},
					{
						id: 'GSHIP-3',
						title: 'blocked',
						createdAt: '2026-08-01T00:00:00Z',
						updatedAt: '2026-08-02T00:00:00Z',
					},
				],
				planned: [],
			},
		});
	});
});
