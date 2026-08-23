import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createProjectFromOperator, startWebServer } from '../../src/commands/web.ts';
import type { ProjectCreateCommandRunner } from '../../src/runtime/project-create.ts';
import type { GitCloneRunner } from '../../src/runtime/project-import.ts';
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

/**
 * Stands in for a real `git clone` without touching the network: it leaves
 * behind exactly what a successful `git clone --branch main` of `input.url`
 * would -- a local checkout with `origin` set to that URL and a local
 * `origin/main` ref -- at the staging path the runtime already computed.
 */
const cloneLocally: GitCloneRunner = async (input) => {
	mkdirSync(input.destination, { recursive: true });
	readyCheckout(input.destination, input.url);
	return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
};

// GSHIP-718: the other onboarding write is a GitHub repository, never a path.
describe('POST /api/projects/import', () => {
	test('clones a new repository into a Gateship-managed checkout and registers it', async () => {
		const cwd = createTestTmpdir('gship-import-api-current-');
		const gateshipHome = createTestTmpdir('gship-import-api-home-');
		const handle = startWebServer({ port: 0, cwd, gateshipHome, projectImportClone: cloneLocally });
		try {
			const origin = `http://${handle.hostname}:${handle.port}`;
			const imported = await fetch(`${origin}/api/projects/import`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin },
				body: JSON.stringify({ repository: 'acme/product' }),
			});
			expect(imported.status).toBe(200);
			const body = await imported.json() as { ok: boolean; project: Record<string, unknown> };
			const destination = join(gateshipHome, 'projects', 'acme', 'product');
			expect(body).toMatchObject({
				ok: true,
				project: {
					name: 'product',
					root: destination,
					stateDir: join(destination, '.gship'),
					readiness: 'ready',
					repository: 'acme/product',
					current: false,
				},
			});
			expect(existsSync(destination)).toBe(true);

			// Idempotent: the same repository, already a ready checkout, is only
			// registered/returned -- the injected clone would throw if it ran again.
			const repeated = await fetch(`${origin}/api/projects/import`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin },
				body: JSON.stringify({ repository: 'https://github.com/acme/product' }),
			});
			expect(repeated.status).toBe(200);
			expect((await repeated.json() as { project: { id: string } }).project.id)
				.toBe(body.project.id as string);
		} finally {
			await handle.stop();
		}
	});

	test('refuses invalid input, an untrusted origin and a clone failure without registering anything', async () => {
		const cwd = createTestTmpdir('gship-import-api-refusal-current-');
		const gateshipHome = createTestTmpdir('gship-import-api-refusal-home-');
		const failingClone: GitCloneRunner = async () => ({
			exitCode: 128,
			stdout: '',
			stderr: 'fatal: repository not found',
			timedOut: false,
		});
		const handle = startWebServer({ port: 0, cwd, gateshipHome, projectImportClone: failingClone });
		try {
			const origin = `http://${handle.hostname}:${handle.port}`;
			const doImport = (body: unknown, headers: Record<string, string> = { origin }) =>
				fetch(`${origin}/api/projects/import`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', ...headers },
					body: JSON.stringify(body),
				});

			const invalid = await doImport({ repository: 'https://gitlab.com/acme/product' });
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toMatchObject({ ok: false, code: 'invalid-request' });

			const untrusted = await doImport({ repository: 'acme/product' }, { origin: 'http://evil.example' });
			expect(untrusted.status).toBe(403);
			expect(await untrusted.json()).toMatchObject({ ok: false, code: 'forbidden-origin' });

			const failed = await doImport({ repository: 'acme/product' });
			expect(failed.status).toBe(502);
			expect(await failed.json()).toMatchObject({
				ok: false,
				code: 'clone-failed',
				message: expect.stringContaining('repository not found'),
			});

			// Only the boot project the service started in is registered.
			const listed = await fetch(`${origin}/api/projects`)
				.then((response) => response.json()) as { projects: Array<{ current: boolean }> };
			expect(listed.projects).toHaveLength(1);
			expect(listed.projects[0]?.current).toBe(true);
			expect(existsSync(join(gateshipHome, 'projects', 'acme', 'product'))).toBe(false);
		} finally {
			await handle.stop();
		}
	});
});

describe('POST /api/projects/create', () => {
	test('disables Bun\'s short HTTP timeout before reading the creation request', async () => {
		const home = createTestTmpdir('gship-create-timeout-home-');
		const currentRoot = createTestTmpdir('gship-create-timeout-current-');
		const registry = openProjectRegistry(home);
		const calls: Array<{ request: Request; seconds: number }> = [];
		const request = new Request('http://127.0.0.1:7777/api/projects/create', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:7777' },
			body: '{',
		});
		try {
			const response = await createProjectFromOperator(
				request,
				registry,
				currentRoot,
				home,
				undefined,
				undefined,
				{ timeout: (timedRequest, seconds) => calls.push({ request: timedRequest, seconds }) },
			);
			expect(response.status).toBe(400);
			expect(calls).toEqual([{ request, seconds: 0 }]);
		} finally {
			registry.close();
		}
	});

	test('creates through the managed service, requires trusted authorization and returns partial recovery', async () => {
		const cwd = createTestTmpdir('gship-create-api-current-');
		const gateshipHome = createTestTmpdir('gship-create-api-home-');
		let makeReady = true;
		const commands: string[][] = [];
		const runCommand: ProjectCreateCommandRunner = async (input) => {
			commands.push([...input.cmd]);
			if (input.cmd[0] === 'git') {
				const child = Bun.spawnSync(input.cmd, { cwd: input.cwd, stdout: 'pipe', stderr: 'pipe' });
				return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
			}
			if (input.cmd[2] === 'view') {
				return { exitCode: 1, stdout: '', stderr: 'Could not resolve to a Repository' };
			}
			if (makeReady) {
				execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/product.git'], { cwd: input.cwd });
				execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: input.cwd });
			}
			return { exitCode: makeReady ? 0 : 1, stdout: '', stderr: makeReady ? '' : 'push failed' };
		};
		const handle = startWebServer({
			port: 0,
			cwd,
			gateshipHome,
			projectCreateCommand: runCommand,
			projectCreateEnsureIdentity: () => ({ outcome: 'already-configured' }),
		});
		try {
			const origin = `http://${handle.hostname}:${handle.port}`;
			const post = (body: unknown, requestOrigin = origin) => fetch(`${origin}/api/projects/create`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: requestOrigin },
				body: JSON.stringify(body),
			});

			const untrusted = await post({
				repository: 'acme/product', visibility: 'private', authorization: 'Create acme/product as private.',
			}, 'http://evil.example');
			expect(untrusted.status).toBe(403);
			expect(commands).toEqual([]);

			const emptyAuthorization = await post({
				repository: 'acme/product', visibility: 'private', authorization: '',
			});
			expect(emptyAuthorization.status).toBe(400);
			expect(await emptyAuthorization.json()).toMatchObject({ code: 'invalid-authorization' });

			const created = await post({
				repository: 'acme/product',
				visibility: 'private',
				description: 'Product repository',
				authorization: 'Create acme/product as a private repository.',
			});
			expect(created.status).toBe(200);
			expect(await created.json()).toMatchObject({
				ok: true,
				project: { repository: 'acme/product', readiness: 'ready' },
			});
			expect(commands.find((argv) => argv[2] === 'create')).toContain('--private');
			expect(JSON.stringify(await fetch(`${origin}/api/projects`).then((response) => response.json())))
				.not.toContain('authorization');

			makeReady = false;
			const partial = await post({
				repository: 'acme/partial',
				visibility: 'public',
				authorization: 'Create acme/partial as a public repository.',
			});
			expect(partial.status).toBe(502);
			expect(await partial.json()).toMatchObject({
				ok: false,
				code: 'partial-create',
				repository: 'acme/partial',
				root: join(gateshipHome, 'projects', 'acme', 'partial'),
				readiness: { state: 'needs-attention', reason: 'origin-missing' },
			});
			expect(existsSync(join(gateshipHome, 'projects', 'acme', 'partial', 'README.md'))).toBe(true);
		} finally {
			await handle.stop();
		}
	});
});

// GSHIP-717: the reverse route, and only a registry write. Its refusals are
// what the operator has to act on, so each one is typed and leaves the row.
describe('DELETE /api/projects/:projectId', () => {
	test('removes a registered non-current project and leaves its checkout on disk', async () => {
		const cwd = createTestTmpdir('gship-unregister-api-current-');
		const gateshipHome = createTestTmpdir('gship-unregister-api-home-');
		const target = realpathSync(createTestTmpdir('gship-unregister-api-target-'));
		readyCheckout(target);
		const handle = startWebServer({ port: 0, cwd, gateshipHome });
		try {
			const origin = `http://${handle.hostname}:${handle.port}`;
			const registered = await fetch(`${origin}/api/projects`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin },
				body: JSON.stringify({ root: target }),
			}).then((response) => response.json()) as { project: { id: string; name: string } };

			const removed = await fetch(`${origin}/api/projects/${registered.project.id}`, {
				method: 'DELETE',
				headers: { origin },
			});
			expect(removed.status).toBe(200);
			expect(await removed.json()).toEqual({
				ok: true,
				project: {
					id: registered.project.id,
					name: registered.project.name,
					root: target,
					stateDir: join(target, '.gship'),
					readiness: 'ready',
					repository: 'acme/product',
					current: false,
				},
			});

			// Only the boot project is left, and the checkout is untouched.
			const listed = await fetch(`${origin}/api/projects`)
				.then((response) => response.json()) as { projects: Array<{ current: boolean }> };
			expect(listed.projects).toHaveLength(1);
			expect(listed.projects[0]?.current).toBe(true);
			expect(existsSync(join(target, 'README.md'))).toBe(true);
			expect(existsSync(join(target, '.git'))).toBe(true);

			// The registration is gone for every project-scoped read too.
			const status = await fetch(`${origin}/api/projects/${registered.project.id}/status`);
			expect(status.status).toBe(404);
			expect(await status.json()).toMatchObject({ ok: false, code: 'project-not-found' });
		} finally {
			await handle.stop();
		}
	});

	test('refuses an untrusted origin, an unknown id and the checkout it serves', async () => {
		const cwd = realpathSync(createTestTmpdir('gship-unregister-api-refusal-current-'));
		const gateshipHome = createTestTmpdir('gship-unregister-api-refusal-home-');
		const handle = startWebServer({ port: 0, cwd, gateshipHome });
		try {
			const origin = `http://${handle.hostname}:${handle.port}`;
			const listed = await fetch(`${origin}/api/projects`)
				.then((response) => response.json()) as { projects: Array<{ id: string }> };
			const currentId = listed.projects[0]!.id;

			const untrusted = await fetch(`${origin}/api/projects/${currentId}`, {
				method: 'DELETE',
				headers: { origin: 'http://evil.example' },
			});
			expect(untrusted.status).toBe(403);
			expect(await untrusted.json()).toMatchObject({ ok: false, code: 'forbidden-origin' });

			const unknown = await fetch(`${origin}/api/projects/unknown`, {
				method: 'DELETE',
				headers: { origin },
			});
			expect(unknown.status).toBe(404);
			expect(await unknown.json()).toMatchObject({ ok: false, code: 'project-not-found' });

			const current = await fetch(`${origin}/api/projects/${currentId}`, {
				method: 'DELETE',
				headers: { origin },
			});
			expect(current.status).toBe(409);
			expect(await current.json()).toMatchObject({
				ok: false,
				code: 'project-is-current',
				message: expect.stringContaining('another checkout'),
			});

			const kept = await fetch(`${origin}/api/projects`)
				.then((response) => response.json()) as { projects: Array<{ id: string }> };
			expect(kept.projects.map((project) => project.id)).toEqual([currentId]);
		} finally {
			await handle.stop();
		}
	});

	test('refuses a project whose run has not finished and keeps the registration', async () => {
		const cwd = createTestTmpdir('gship-unregister-api-active-current-');
		const targetRoot = createTestTmpdir('gship-unregister-api-active-target-');
		const targetState = createTestTmpdir('gship-unregister-api-active-state-');
		const store = new RunStore(join(targetState, 'runtime.sqlite'));
		store.createRun({
			id: 'run-active',
			issueId: 'GSHIP-1',
			sessionId: 'session-active',
			workspacePath: '/managed/run-active',
			createdAt: '2026-08-23T10:00:00.000Z',
		});
		store.close();
		const registry = openProjectRegistry(createTestTmpdir('gship-unregister-api-active-home-'));
		const target = registry.reconcile({
			root: targetRoot,
			stateDir: targetState,
			readiness: {
				state: 'ready', name: 'target', repository: 'acme/target',
				remoteUrl: 'git@github.com:acme/target.git', sourceRef: 'origin/main',
			},
		});
		const handle = startWebServer({ port: 0, cwd, projectRegistry: registry });
		try {
			const origin = `http://${handle.hostname}:${handle.port}`;
			const refused = await fetch(`${origin}/api/projects/${target.id}`, {
				method: 'DELETE',
				headers: { origin },
			});
			expect(refused.status).toBe(409);
			expect(await refused.json()).toMatchObject({
				ok: false,
				code: 'project-has-active-run',
				message: expect.stringContaining('run-active'),
			});
			expect(registry.get(target.id)).not.toBeNull();
			expect(existsSync(join(targetState, 'runtime.sqlite'))).toBe(true);
		} finally {
			await handle.stop();
			registry.close();
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
