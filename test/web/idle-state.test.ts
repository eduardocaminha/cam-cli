// test/web/idle-state.test.ts
//
// Real-server coverage for the between-cycle snapshot extension. The fixture
// uses a real main ref so the route exercises the sanctioned backlog reader,
// rather than deriving issue state from working-tree files.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import type { CycleMetricsRow } from '../../src/stats/cycles.ts';
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

function cycle(index: number, shipped = false): CycleMetricsRow {
	return {
		cycleId: `cam/cycle-${index}`,
		issueNumber: String(index),
		closedAt: `2026-08-${String(index).padStart(2, '0')}T12:00:00Z`,
		workerRounds: index,
		reviewRounds: 1,
		orchTokens: index * 10,
		workerTokens: index * 20,
		total: index * 30,
		...(shipped ? { prNumber: 500 + index, mergeMode: 'ci-gated' as const } : {}),
	};
}

function seedIdleRepo(): { cwd: string; cycles: CycleMetricsRow[] } {
	const cwd = createTestTmpdir('cam-web-idle-');
	git(cwd, ['init', '-q', '--initial-branch=main']);
	git(cwd, ['config', 'user.email', 'cam-test@example.com']);
	git(cwd, ['config', 'user.name', 'Cam Test']);

	const issues = [
		issue({ id: 'CAM-1', title: 'first idea', rank: 4 }),
		issue({
			id: 'CAM-2',
			title: 'ready',
			stage: 'specified',
			rank: 1,
			spec: { acceptanceCriteria: ['works'], scope: 'test', gotchas: [], domainTerms: [] },
		}),
		issue({ id: 'CAM-3', title: 'blocked', stage: 'specified', rank: 2, blockedBy: ['CAM-1'] }),
	];
	const issueDir = join(cwd, 'scripts', 'cam', 'issues');
	mkdirSync(issueDir, { recursive: true });
	for (const entry of issues) {
		writeFileSync(join(issueDir, `${entry.id}.json`), JSON.stringify(entry));
	}
	git(cwd, ['add', '.']);
	git(cwd, ['commit', '-q', '-m', 'seed backlog']);

	const cycles = Array.from({ length: 7 }, (_, index) => cycle(index + 1, index === 5));
	writeFileSync(
		join(cwd, 'scripts', 'cam', 'cycle-metrics.jsonl'),
		`${[
			JSON.stringify({ schemaVersion: 1, unattributedLeadingEvents: 9 }),
			...cycles.map((row) => JSON.stringify(row)),
		].join('\n')}\n`,
	);
	return { cwd, cycles };
}

async function getSnapshot(cwd: string): Promise<Record<string, unknown>> {
	const handle = startWebServer({ port: 0, cwd, claudeDir: join(cwd, 'claude-home') });
	try {
		const response = await fetch(`http://${handle.hostname}:${handle.port}/api/snapshot`);
		expect(response.status).toBe(200);
		return (await response.json()) as Record<string, unknown>;
	} finally {
		await handle.stop();
	}
}

describe('GET /api/snapshot idle state', () => {
	test('adds the five newest cycles and the main-backed derived backlog when no PRD exists', async () => {
		const { cwd, cycles } = seedIdleRepo();
		const payload = await getSnapshot(cwd);
		const idleState = payload['idleState'] as Record<string, unknown>;

		expect(idleState).toBeDefined();
		expect(idleState['recentCycles']).toEqual(cycles.slice(-5).reverse());
		const recentCycles = idleState['recentCycles'] as Record<string, unknown>[];
		expect(Object.hasOwn(recentCycles[0] ?? {}, 'prNumber')).toBe(false);
		expect(Object.hasOwn(recentCycles[0] ?? {}, 'mergeMode')).toBe(false);
		expect(recentCycles[1]?.['prNumber']).toBe(506);
		expect(recentCycles[1]?.['mergeMode']).toBe('ci-gated');

		expect(idleState['backlog']).toEqual({
			counts: { idea: 1, specified: 2, planned: 0 },
			plannable: [
				{
					id: 'CAM-2',
					title: 'ready',
					rank: 1,
					createdAt: '2026-08-01T00:00:00Z',
					updatedAt: '2026-08-02T00:00:00Z',
				},
			],
			byStage: {
				idea: [
					{
						id: 'CAM-1',
						title: 'first idea',
						rank: 4,
						createdAt: '2026-08-01T00:00:00Z',
						updatedAt: '2026-08-02T00:00:00Z',
					},
				],
				specified: [
					{
						id: 'CAM-2',
						title: 'ready',
						rank: 1,
						createdAt: '2026-08-01T00:00:00Z',
						updatedAt: '2026-08-02T00:00:00Z',
					},
					{
						id: 'CAM-3',
						title: 'blocked',
						rank: 2,
						createdAt: '2026-08-01T00:00:00Z',
						updatedAt: '2026-08-02T00:00:00Z',
					},
				],
				planned: [],
			},
		});
	});

	test('omits the idle state key when a PRD is present', async () => {
		const { cwd } = seedIdleRepo();
		writeFileSync(
			join(cwd, 'scripts', 'cam', 'prd.json'),
			JSON.stringify({ branchName: 'cam/active', userStories: [] }),
		);

		const payload = await getSnapshot(cwd);
		expect(Object.hasOwn(payload, 'idleState')).toBe(false);
	});

	test('missing cycle metrics is best-effort and still returns an empty recent list', async () => {
		const cwd = createTestTmpdir('cam-web-idle-empty-');
		const payload = await getSnapshot(cwd);
		const idleState = payload['idleState'] as Record<string, unknown>;
		expect(idleState['recentCycles']).toEqual([]);
	});
});
