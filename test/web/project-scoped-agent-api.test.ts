import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import { openProjectRegistry } from '../../src/runtime/project-registry.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { type ProjectBrief, RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

interface ProjectList {
	projects: Array<{ id: string; current: boolean }>;
}

describe('project-scoped agent API', () => {
	test('delegates current-project routes to the existing runtime and collaborators', async () => {
		const cwd = createTestTmpdir('gship-project-agent-current-');
		const runtime = new RunRuntime({ cwd, store: new RunStore(':memory:') });
		let brief: ProjectBrief = {
			objective: 'Current objective',
			decisions: [],
			constraints: [],
			openItems: [],
		};
		const handle = startWebServer({
			port: 0,
			cwd,
			runRuntime: runtime,
			projectBrief: { get: () => brief, set: (next) => { brief = next; } },
			issueReader: (id) => id === 'GSHIP-698' ? {
				id,
				title: 'Scoped lifecycle',
				stage: 'idea',
				status: 'open',
				blockedBy: [],
				createdAt: '2026-08-22T12:00:00.000Z',
				updatedAt: '2026-08-22T12:00:00.000Z',
			} : null,
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const listed = await fetch(`${origin}/api/projects`).then((response) => response.json()) as ProjectList;
			const projectId = listed.projects.find((project) => project.current)!.id;
			const base = `${origin}/api/projects/${projectId}`;

			const snapshot = await fetch(`${base}/snapshot`);
			expect(snapshot.status).toBe(200);
			expect(await snapshot.json()).toHaveProperty('version');

			const issue = await fetch(`${base}/issues/GSHIP-698`);
			expect(issue.status).toBe(200);
			expect(await issue.json()).toMatchObject({ issue: { id: 'GSHIP-698' } });

			const readBrief = await fetch(`${base}/brief`);
			expect(readBrief.status).toBe(200);
			expect(await readBrief.json()).toMatchObject({ brief: { objective: 'Current objective' } });

			const updated = await fetch(`${base}/brief`, {
				method: 'PUT',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ ...brief, objective: 'Updated objective' }),
			});
			expect(updated.status).toBe(200);
			expect(brief.objective).toBe('Updated objective');
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('rejects every lifecycle route for a registered non-current project before work', async () => {
		const cwd = createTestTmpdir('gship-project-agent-owner-');
		const foreignRoot = createTestTmpdir('gship-project-agent-foreign-');
		const foreignState = createTestTmpdir('gship-project-agent-foreign-state-');
		const registry = openProjectRegistry(createTestTmpdir('gship-project-agent-home-'));
		const foreign = registry.reconcile({
			root: foreignRoot,
			stateDir: foreignState,
			readiness: { state: 'empty', name: 'foreign', detail: 'empty' },
		});
		const runtime = new RunRuntime({ cwd, store: new RunStore(':memory:') });
		let collaboratorCalls = 0;
		const handle = startWebServer({
			port: 0,
			cwd,
			projectRegistry: registry,
			runRuntime: runtime,
			issueIntake: () => {
				collaboratorCalls += 1;
				throw new Error('must not run');
			},
			projectBrief: {
				get: () => {
					collaboratorCalls += 1;
					throw new Error('must not run');
				},
				set: () => {
					collaboratorCalls += 1;
					throw new Error('must not run');
				},
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		const base = `${origin}/api/projects/${foreign.id}`;
		const requests: Array<[string, string]> = [
			['GET', '/snapshot'],
			['GET', '/backlog'],
			['GET', '/issues'],
			['GET', '/issues/GSHIP-698'],
			['POST', '/issues'],
			['POST', '/issues/GSHIP-698/spec'],
			['POST', '/issues/GSHIP-698/approve'],
			['POST', '/issues/GSHIP-698/abandon'],
			['GET', '/brief'],
			['PUT', '/brief'],
			['GET', '/runs'],
			['POST', '/runs'],
			['GET', '/runs/run-1'],
			['GET', '/runs/run-1/events'],
			['POST', '/runs/run-1/resume'],
			['POST', '/runs/run-1/cancel'],
			['POST', '/runs/run-1/abandon'],
			['POST', '/runs/run-1/ship'],
		];
		try {
			for (const [method, path] of requests) {
				const response = await fetch(`${base}${path}`, { method });
				expect(response.status).toBe(409);
				expect(await response.json()).toMatchObject({
					ok: false,
					code: 'project-runtime-unavailable',
				});
			}
			expect(collaboratorCalls).toBe(0);
			expect(runtime.listRuns()).toEqual([]);
			expect(existsSync(join(foreignState, 'runtime.sqlite'))).toBe(false);
		} finally {
			await handle.stop();
			runtime.close();
			registry.close();
		}
	});

	test('returns project-not-found for an unknown project identity', async () => {
		const handle = startWebServer({
			port: 0,
			cwd: createTestTmpdir('gship-project-agent-unknown-'),
		});
		try {
			const response = await fetch(
				`http://${handle.hostname}:${handle.port}/api/projects/unknown/runs`,
			);
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ ok: false, code: 'project-not-found' });
		} finally {
			await handle.stop();
		}
	});
});
