// test/web/project-scoped-run-api.test.ts
//
// Work, made operational per selected project (GSHIP-712). The surface reuses
// the scoped routes the service already exposes, so what is asserted here is
// the seam between them and the boot runtime: an issue filed, specified,
// approved or abandoned for a named project lands in that project's own
// backlog, a start reaches that project's own runtime, and none of the five
// ever falls back to the collaborators the boot project was started with.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import { readBacklogFromMain } from '../../src/issues/backlog.ts';
import { RUNTIME_SOURCE_REF } from '../../src/runtime/source-ref.ts';
import { openProjectRegistry } from '../../src/runtime/project-registry.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
	const stdout = new TextDecoder().decode(result.stdout).trim();
	const stderr = new TextDecoder().decode(result.stderr).trim();
	if (result.exitCode !== 0) throw new Error(stderr || stdout);
	return stdout;
}

function identify(cwd: string): void {
	git(cwd, ['config', 'user.name', 'Gateship Test']);
	git(cwd, ['config', 'user.email', 'test@example.invalid']);
}

function writeIssue(cwd: string, number: number, stage: 'idea' | 'specified'): void {
	const directory = join(cwd, '.gateship', 'issues');
	const id = `GSHIP-${number}`;
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, `GSHIP-${String(number).padStart(4, '0')}.json`),
		`${JSON.stringify({
			id,
			title: `fixture ${id}`,
			stage,
			status: 'open',
			blockedBy: [],
			createdAt: '2026-08-22T00:00:00.000Z',
			updatedAt: '2026-08-22T00:00:00.000Z',
			...(stage === 'specified'
				? { description: 'fixture', specSource: 'operator', spec: { scope: 'fixture', verify: ['works'] } }
				: {}),
		}, null, 2)}\n`,
	);
}

/**
 * A project with a real remote, so the intake path this API delegates to can
 * publish for it exactly as it does for the boot project.
 */
function publishableProject(prefix: string, issues: Array<[number, 'idea' | 'specified']>): {
	root: string;
	remote: string;
	local: string;
} {
	const root = createTestTmpdir(prefix);
	const seed = join(root, 'seed');
	mkdirSync(seed, { recursive: true });
	git(seed, ['init', '-q', '-b', 'main']);
	identify(seed);
	for (const [number, stage] of issues) writeIssue(seed, number, stage);
	writeFileSync(join(seed, 'README.md'), '# fixture\n');
	git(seed, ['add', '.']);
	git(seed, ['commit', '-q', '-m', 'seed']);

	const remote = join(root, 'remote.git');
	git(root, ['clone', '-q', '--bare', seed, remote]);
	const local = join(root, 'local');
	git(root, ['clone', '-q', remote, local]);
	identify(local);
	return { root, remote, local };
}

/** The boot runtime, instrumented so any fallback to it is a recorded fact. */
function bootRuntimeThatMustNotStart(cwd: string): { runtime: RunRuntime; starts: () => number } {
	const runtime = new RunRuntime({ cwd, store: new RunStore(':memory:') });
	let starts = 0;
	runtime.startRun = () => {
		starts += 1;
		throw new Error('the boot runtime must not be started by a scoped command');
	};
	return { runtime, starts: () => starts };
}

describe('project-scoped work API', () => {
	test('intake, specification, approval and abandon write the named project backlog alone', async () => {
		const boot = publishableProject('gship-work-api-boot-', []);
		const foreign = publishableProject('gship-work-api-foreign-', [
			[1, 'idea'],
			[2, 'specified'],
			[3, 'specified'],
		]);
		const registry = openProjectRegistry(createTestTmpdir('gship-work-api-home-'));
		const registered = registry.reconcile({
			root: foreign.local,
			stateDir: createTestTmpdir('gship-work-api-foreign-state-'),
			readiness: {
				state: 'ready',
				name: 'foreign',
				repository: 'acme/foreign',
				remoteUrl: foreign.remote,
				sourceRef: 'origin/main',
			},
		});
		const bootCalls: string[] = [];
		const refuse = (what: string) => (): never => {
			bootCalls.push(what);
			throw new Error(`${what} must not run for another project`);
		};
		const handle = startWebServer({
			port: 0,
			cwd: boot.local,
			projectRegistry: registry,
			issueIntake: refuse('issueIntake'),
			issueSpecifier: refuse('issueSpecifier'),
			issueApprover: refuse('issueApprover'),
			issueAbandoner: refuse('issueAbandoner'),
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		const base = `${origin}/api/projects/${encodeURIComponent(registered.id)}`;
		const post = (path: string, body: unknown): Promise<Response> => fetch(`${base}${path}`, {
			method: 'POST',
			headers: { origin, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		try {
			const created = await post('/issues', {
				title: 'Intake escopado',
				scope: 'Cria a tarefa no projeto selecionado.',
				verificationCommand: 'bun test',
			});
			expect(created.status).toBe(201);
			const createdId = ((await created.json()) as { issue: { id: string } }).issue.id;

			const specified = await post('/issues/GSHIP-1/spec', {
				scope: 'Especifica a ideia do projeto selecionado.',
				verificationCommand: 'bun test focused',
			});
			expect(specified.status).toBe(200);

			const approved = await post('/issues/GSHIP-2/approve', {});
			expect(approved.status).toBe(200);

			const abandoned = await post('/issues/GSHIP-3/abandon', { reason: 'Sem sentido.' });
			expect(abandoned.status).toBe(200);

			// Every write landed in the selected project's own published backlog.
			const foreignBacklog = readBacklogFromMain(foreign.local, undefined, RUNTIME_SOURCE_REF);
			const byId = new Map(foreignBacklog.map((issue) => [issue.id, issue]));
			expect(byId.get(createdId)?.stage).toBe('specified');
			expect(byId.get('GSHIP-1')?.stage).toBe('specified');
			expect(byId.get('GSHIP-2')?.approval).toBeDefined();
			expect(byId.get('GSHIP-3')?.status).toBe('abandoned');

			// None of them reached the boot project: not its collaborators, and
			// not its backlog, which still has no issue at all.
			expect(bootCalls).toEqual([]);
			expect(readBacklogFromMain(boot.local, undefined, RUNTIME_SOURCE_REF)).toEqual([]);

			// The scoped read is the same separation: the selected project's
			// published issues, never the boot project's.
			const listed = await fetch(`${base}/issues`).then((response) => response.json()) as {
				issues: Array<{ id: string }>;
			};
			expect(listed.issues.map((issue) => issue.id)).toContain(createdId);
			const bootListed = await fetch(`${origin}/api/issues`).then((response) => response.json()) as {
				issues: Array<{ id: string }>;
			};
			expect(bootListed.issues).toEqual([]);
		} finally {
			await handle.stop();
			registry.close();
		}
	});

	test('a start for another project never reaches the boot runtime', async () => {
		const boot = publishableProject('gship-work-api-start-boot-', []);
		const foreign = publishableProject('gship-work-api-start-foreign-', [[1, 'idea']]);
		const registry = openProjectRegistry(createTestTmpdir('gship-work-api-start-home-'));
		const registered = registry.reconcile({
			root: foreign.local,
			stateDir: createTestTmpdir('gship-work-api-start-state-'),
			readiness: {
				state: 'ready',
				name: 'foreign',
				repository: 'acme/foreign',
				remoteUrl: foreign.remote,
				sourceRef: 'origin/main',
			},
		});
		const { runtime, starts } = bootRuntimeThatMustNotStart(boot.local);
		const handle = startWebServer({
			port: 0,
			cwd: boot.local,
			projectRegistry: registry,
			runRuntime: runtime,
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			// An idea is not admissible, so the selected project's own runtime
			// refuses it -- which is exactly the proof the start was addressed
			// there and never handed to the boot runtime instead.
			const started = await fetch(
				`${origin}/api/projects/${encodeURIComponent(registered.id)}/runs`,
				{
					method: 'POST',
					headers: { origin, 'content-type': 'application/json' },
					body: JSON.stringify({ issueId: 'GSHIP-1' }),
				},
			);
			expect(started.status).toBe(409);
			expect(await started.json()).toMatchObject({ ok: false, code: 'run-preflight-failed' });
			expect(starts()).toBe(0);
			expect(runtime.listRuns()).toEqual([]);
		} finally {
			await handle.stop();
			runtime.close();
			registry.close();
		}
	});

	test('the boot project keeps the collaborators and routes it was started with', async () => {
		const boot = publishableProject('gship-work-api-legacy-', [[1, 'idea']]);
		const received: Array<[string, unknown]> = [];
		const handle = startWebServer({
			port: 0,
			cwd: boot.local,
			issueIntake: (input) => {
				received.push(['issueIntake', input]);
				return { id: 'GSHIP-900', title: 'Intake boot', sha: 'abc1234' };
			},
			issueApprover: (id) => {
				received.push(['issueApprover', id]);
				return { id, title: 'Intake boot', sha: 'abc1234' };
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		const listed = await fetch(`${origin}/api/projects`).then((response) => response.json()) as {
			projects: Array<{ id: string; current: boolean }>;
		};
		const bootId = listed.projects.find((project) => project.current)!.id;
		try {
			for (const path of ['/api/issues', `/api/projects/${encodeURIComponent(bootId)}/issues`]) {
				received.length = 0;
				const created = await fetch(`${origin}${path}`, {
					method: 'POST',
					headers: { origin, 'content-type': 'application/json' },
					body: JSON.stringify({
						title: 'Intake boot',
						scope: 'Mantém o comportamento herdado.',
						verificationCommand: 'bun test',
					}),
				});
				expect(created.status).toBe(201);
				expect(await created.json()).toMatchObject({ ok: true, issue: { id: 'GSHIP-900' } });

				const approved = await fetch(`${origin}${path}/GSHIP-1/approve`, {
					method: 'POST',
					headers: { origin },
				});
				expect(approved.status).toBe(200);
				expect(received.map(([what]) => what)).toEqual(['issueIntake', 'issueApprover']);
			}
		} finally {
			await handle.stop();
		}
	});
});
