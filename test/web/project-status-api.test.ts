import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import { openProjectRegistry } from '../../src/runtime/project-registry.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function readyProject(root: string): void {
	execFileSync('git', ['init', '-b', 'main'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'operator@example.com'], { cwd: root });
	mkdirSync(join(root, '.gateship', 'issues'), { recursive: true });
	writeFileSync(join(root, '.gateship', 'issues', 'GSHIP-0001.json'), JSON.stringify({
		id: 'GSHIP-1',
		title: 'First issue',
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-08-22T09:00:00.000Z',
		updatedAt: '2026-08-22T09:00:00.000Z',
	}));
	execFileSync('git', ['add', '.gateship/issues/GSHIP-0001.json'], { cwd: root });
	execFileSync('git', ['commit', '-m', 'seed backlog'], { cwd: root });
	execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
}

describe('GET /api/project', () => {
	test('reports an otherwise empty service directory as an onboarding target', async () => {
		const cwd = createTestTmpdir('gship-project-api-');
		const handle = startWebServer({ port: 0, cwd });
		try {
			const response = await fetch(`http://${handle.hostname}:${handle.port}/api/project`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				project: {
					state: 'empty',
					detail: 'This folder does not contain a Git project yet.',
				},
			});
		} finally {
			handle.stop();
		}
	});
});

describe('GET /api/projects', () => {
	test('lists the durable current-project registration with a stable identity', async () => {
		const cwd = createTestTmpdir('gship-project-list-api-');
		const gateshipHome = createTestTmpdir('gship-project-list-home-');
		const read = async () => {
			const handle = startWebServer({ port: 0, cwd, gateshipHome });
			try {
				const response = await fetch(`http://${handle.hostname}:${handle.port}/api/projects`);
				expect(response.status).toBe(200);
				return await response.json() as { projects: Array<Record<string, unknown>> };
			} finally {
				await handle.stop();
			}
		};

		const first = await read();
		const second = await read();
		expect(first.projects).toEqual([{
			id: expect.any(String),
			name: cwd.split('/').at(-1),
			root: cwd,
			stateDir: `${cwd}/.gship`,
			readiness: 'empty',
			current: true,
		}]);
		expect(second.projects[0]?.id).toBe(first.projects[0]?.id);
	});

	test('marks only the project served by this instance as current', async () => {
		const gateshipHome = createTestTmpdir('gship-project-list-shared-home-');
		const firstRoot = createTestTmpdir('gship-project-list-first-');
		const secondRoot = createTestTmpdir('gship-project-list-second-');
		const first = startWebServer({ port: 0, cwd: firstRoot, gateshipHome });
		await first.stop();
		const second = startWebServer({ port: 0, cwd: secondRoot, gateshipHome });
		try {
			const body = await fetch(`http://${second.hostname}:${second.port}/api/projects`)
				.then((response) => response.json()) as { projects: Array<{ root: string; current: boolean }> };
			expect(body.projects).toHaveLength(2);
			expect(body.projects.find((project) => project.root === firstRoot)?.current).toBe(false);
			expect(body.projects.find((project) => project.root === secondRoot)?.current).toBe(true);
		} finally {
			await second.stop();
		}
	});
});

/** A checkout the operator already has: GitHub origin and a local origin/main. */
function readyCheckout(root: string, remoteUrl = 'git@github.com:acme/product.git'): void {
	execFileSync('git', ['init', '-b', 'main'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'operator@example.com'], { cwd: root });
	writeFileSync(join(root, 'README.md'), '# product\n');
	execFileSync('git', ['add', 'README.md'], { cwd: root });
	execFileSync('git', ['commit', '-m', 'seed'], { cwd: root });
	execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: root });
	execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
}

describe('POST /api/projects', () => {
	test('registers an existing checkout by absolute path and repeats without duplicating', async () => {
		const cwd = createTestTmpdir('gship-register-api-current-');
		const gateshipHome = createTestTmpdir('gship-register-api-home-');
		const target = realpathSync(createTestTmpdir('gship-register-api-target-'));
		readyCheckout(target);
		mkdirSync(join(target, 'packages', 'app'), { recursive: true });
		const handle = startWebServer({ port: 0, cwd, gateshipHome });
		try {
			const origin = `http://${handle.hostname}:${handle.port}`;
			const register = (root: string) => fetch(`${origin}/api/projects`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin },
				body: JSON.stringify({ root }),
			});

			const created = await register(join(target, 'packages', 'app'));
			expect(created.status).toBe(200);
			const body = await created.json() as { ok: boolean; project: { id: string } };
			const projectId = body.project.id;
			expect(typeof projectId).toBe('string');
			expect(body).toMatchObject({
				ok: true,
				project: {
					root: target,
					stateDir: join(target, '.gship'),
					readiness: 'ready',
					repository: 'acme/product',
					current: false,
				},
			});

			const repeated = await register(target).then((response) => response.json()) as {
				project: { id: string };
			};
			expect(repeated.project.id).toBe(projectId);
			const listed = await fetch(`${origin}/api/projects`)
				.then((response) => response.json()) as { projects: Array<{ id: string }> };
			expect(listed.projects).toHaveLength(2);
			expect(listed.projects.some((project) => project.id === projectId)).toBe(true);
		} finally {
			await handle.stop();
		}
	});

	test('refuses an unready or invisible path with its readiness detail and registers nothing', async () => {
		const cwd = createTestTmpdir('gship-register-api-refusal-current-');
		const gateshipHome = createTestTmpdir('gship-register-api-refusal-home-');
		const unfetched = realpathSync(createTestTmpdir('gship-register-api-refusal-target-'));
		readyCheckout(unfetched);
		execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: unfetched });
		const handle = startWebServer({ port: 0, cwd, gateshipHome });
		try {
			const origin = `http://${handle.hostname}:${handle.port}`;
			const register = (body: unknown, headers: Record<string, string> = { origin }) =>
				fetch(`${origin}/api/projects`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', ...headers },
					body: JSON.stringify(body),
				});

			const relative = await register({ root: 'relative/checkout' });
			expect(relative.status).toBe(400);
			expect(await relative.json()).toMatchObject({ ok: false, code: 'invalid-request' });

			const absent = await register({ root: join(unfetched, 'absent') });
			expect(absent.status).toBe(404);
			expect(await absent.json()).toMatchObject({ ok: false, code: 'root-not-found' });

			const notReady = await register({ root: unfetched });
			expect(notReady.status).toBe(409);
			expect(await notReady.json()).toMatchObject({
				ok: false,
				code: 'project-not-ready',
				message: expect.stringContaining('origin/main'),
				readiness: { state: 'needs-attention', reason: 'origin-main-missing' },
			});

			const untrusted = await register({ root: unfetched }, { origin: 'http://evil.example' });
			expect(untrusted.status).toBe(403);
			expect(await untrusted.json()).toMatchObject({ ok: false, code: 'forbidden-origin' });

			// Only the boot project the service started in is registered.
			const listed = await fetch(`${origin}/api/projects`)
				.then((response) => response.json()) as { projects: Array<{ current: boolean }> };
			expect(listed.projects).toHaveLength(1);
			expect(listed.projects[0]?.current).toBe(true);
		} finally {
			await handle.stop();
		}
	});
});

describe('GET /api/projects/:projectId/status', () => {
	test('reads a registered project backlog and bounded persisted run window', async () => {
		const currentRoot = createTestTmpdir('gship-project-status-current-');
		const targetRoot = createTestTmpdir('gship-project-status-target-');
		const targetState = createTestTmpdir('gship-project-status-state-');
		const home = createTestTmpdir('gship-project-status-home-');
		readyProject(targetRoot);
		const store = new RunStore(join(targetState, 'runtime.sqlite'));
		store.createRun({
			id: 'run-status',
			issueId: 'GSHIP-1',
			sessionId: 'session-status',
			workspacePath: '/managed/run-status',
			createdAt: '2026-08-22T10:00:00.000Z',
		});
		store.close();
		const registry = openProjectRegistry(home);
		const target = registry.reconcile({
			root: targetRoot,
			stateDir: targetState,
			readiness: {
				state: 'ready', name: 'target', repository: 'acme/target',
				remoteUrl: 'git@github.com:acme/target.git', sourceRef: 'origin/main',
			},
		});
		const handle = startWebServer({ port: 0, cwd: currentRoot, projectRegistry: registry });
		try {
			const response = await fetch(
				`http://${handle.hostname}:${handle.port}/api/projects/${target.id}/status`,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				project: { id: target.id, root: targetRoot, stateDir: targetState, readiness: 'ready', current: false },
				root: { state: 'available' },
				backlog: { state: 'available', counts: { idea: 1, specified: 0, planned: 0 } },
				database: {
					state: 'available',
					path: join(targetState, 'runtime.sqlite'),
					runs: [{
						id: 'run-status', issueId: 'GSHIP-1', state: 'queued',
						createdAt: '2026-08-22T10:00:00.000Z', updatedAt: '2026-08-22T10:00:00.000Z',
					}],
				},
			});
		} finally {
			await handle.stop();
			registry.close();
		}
	});

	test('returns typed unavailable state without deleting a stale registration', async () => {
		const currentRoot = createTestTmpdir('gship-project-status-unavailable-current-');
		const targetRoot = createTestTmpdir('gship-project-status-unavailable-target-');
		const targetState = createTestTmpdir('gship-project-status-unavailable-state-');
		const registry = openProjectRegistry(createTestTmpdir('gship-project-status-unavailable-home-'));
		const target = registry.reconcile({
			root: targetRoot,
			stateDir: targetState,
			readiness: { state: 'empty', name: 'target', detail: 'empty' },
		});
		rmSync(targetRoot, { recursive: true });
		const handle = startWebServer({ port: 0, cwd: currentRoot, projectRegistry: registry });
		try {
			const origin = `http://${handle.hostname}:${handle.port}`;
			const response = await fetch(`${origin}/api/projects/${target.id}/status`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				project: { id: target.id },
				root: { state: 'unavailable' },
				backlog: { state: 'unavailable' },
				database: { state: 'unavailable', path: join(targetState, 'runtime.sqlite') },
			});
			const listed = await fetch(`${origin}/api/projects`).then((listedResponse) => listedResponse.json()) as {
				projects: Array<{ id: string }>;
			};
			expect(listed.projects.some((project) => project.id === target.id)).toBe(true);
		} finally {
			await handle.stop();
			registry.close();
		}
	});

	test('returns 404 for an unknown registry identity', async () => {
		const handle = startWebServer({ port: 0, cwd: createTestTmpdir('gship-project-status-unknown-') });
		try {
			const response = await fetch(
				`http://${handle.hostname}:${handle.port}/api/projects/unknown/status`,
			);
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ ok: false, code: 'project-not-found' });
		} finally {
			await handle.stop();
		}
	});
});
