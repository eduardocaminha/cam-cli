import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import { fingerprintSpec } from '../../src/issues/spec.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import { openProjectRegistry } from '../../src/runtime/project-registry.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { type ProjectBrief, RunStore, type RunRecord } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

interface ProjectList {
	projects: Array<{ id: string; current: boolean }>;
}

function readyProject(root: string): void {
	execFileSync('git', ['init', '-b', 'main'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'operator@example.com'], { cwd: root });
	writeFileSync(join(root, 'README.md'), '# Test\n');
	execFileSync('git', ['add', 'README.md'], { cwd: root });
	execFileSync('git', ['commit', '-m', 'seed'], { cwd: root });
	execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/test.git'], { cwd: root });
	execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
}

const APPROVED_SPEC = { scope: 'Scoped approval', verify: ['bun test'] };

function approvedIssue(id: string, blockedBy: string[] = []): IssueEntry {
	return {
		id,
		title: id,
		stage: 'specified',
		status: 'open',
		blockedBy,
		createdAt: '2026-08-23T00:00:00.000Z',
		updatedAt: '2026-08-23T00:00:00.000Z',
		spec: APPROVED_SPEC,
		approval: {
			fingerprint: fingerprintSpec(APPROVED_SPEC),
			approvedAt: '2026-08-23T00:00:00.000Z',
		},
	};
}

async function approveProjectIssue(options: {
	backlog: IssueEntry[];
	chainRuns: boolean;
	activeRun?: RunRecord;
}): Promise<{ starts: string[]; approveAgain: () => Promise<Response>; cleanup: () => Promise<void> }> {
	const cwd = createTestTmpdir('gship-project-agent-approve-');
	readyProject(cwd);
	const store = new RunStore(':memory:');
	const runtime = new RunRuntime({ cwd, store, listBacklog: () => options.backlog });
	runtime.setChainRuns(options.chainRuns);
	if (options.activeRun !== undefined) {
		store.createRun({
			id: options.activeRun.id,
			issueId: options.activeRun.issueId,
			sessionId: options.activeRun.sessionId,
			workspacePath: options.activeRun.workspacePath,
			createdAt: options.activeRun.createdAt,
		});
	}
	const starts: string[] = [];
	runtime.startRun = async (issueId: string) => {
		starts.push(issueId);
		const created = store.createRun({
			id: `run-${starts.length}`,
			issueId,
			sessionId: `session-${starts.length}`,
			workspacePath: cwd,
			createdAt: '2026-08-23T00:00:01.000Z',
		});
		return created.run;
	};
	const issue = options.backlog[0]!;
	const nextApproval = options.backlog[1] ?? issue;
	const handle = startWebServer({
		port: 0,
		cwd,
		runRuntime: runtime,
		issueReader: (id) => options.backlog.find((entry) => entry.id === id) ?? null,
		issueApprover: (id) => ({ id, title: id, sha: 'approved-sha' }),
	});
	const listed = await fetch(`http://${handle.hostname}:${handle.port}/api/projects`)
		.then((response) => response.json()) as ProjectList;
	const projectId = listed.projects.find((project) => project.current)!.id;
	const origin = `http://${handle.hostname}:${handle.port}`;
	const approveAgain = () => fetch(`${origin}/api/projects/${projectId}/issues/${nextApproval.id}/approve`, {
		method: 'POST',
		headers: {
			origin,
			'content-type': 'application/json',
			'x-gateship-command-source': 'agent-cli',
		},
		body: JSON.stringify({
			fingerprint: fingerprintSpec(nextApproval.spec!),
			authorization: 'I approve this issue.',
		}),
	});
	const response = await approveAgain();
	expect(response.status).toBe(200);
	return {
		starts,
		approveAgain,
		cleanup: async () => {
			await handle.stop();
			runtime.close();
		},
	};
}

describe('project-scoped agent API', () => {
	test('opens and reopens external context without dirtying its checkout', async () => {
		const cwd = createTestTmpdir('gship-project-context-current-');
		const foreignRoot = createTestTmpdir('gship-project-context-foreign-');
		const registry = openProjectRegistry(createTestTmpdir('gship-project-context-home-'));
		readyProject(cwd);
		readyProject(foreignRoot);
		const foreign = registry.reconcile({
			root: foreignRoot,
			stateDir: join(foreignRoot, '.gship'),
			readiness: {
				state: 'ready',
				name: 'test',
				repository: 'acme/test',
				remoteUrl: 'git@github.com:acme/test.git',
				sourceRef: 'origin/main',
			},
		});
		const open = async (): Promise<void> => {
			const runtime = new RunRuntime({ cwd, store: new RunStore(':memory:') });
			const handle = startWebServer({ port: 0, cwd, projectRegistry: registry, runRuntime: runtime });
			try {
				const response = await fetch(
					`http://${handle.hostname}:${handle.port}/api/projects/${foreign.id}/snapshot`,
				);
				expect(response.status).toBe(200);
			} finally {
				await handle.stop();
				runtime.close();
			}
		};

		try {
			await open();
			await open();
			expect(existsSync(join(foreignRoot, '.gship', 'runtime.sqlite'))).toBe(true);
			expect(readFileSync(join(foreignRoot, '.gship', '.gitignore'), 'utf8')).toBe('*\n');
			expect(execFileSync('git', ['status', '--porcelain'], {
				cwd: foreignRoot,
				encoding: 'utf8',
			})).toBe('');
		} finally {
			registry.close();
		}
	});

	test('approval wakes the idle project chain through the project-scoped route', async () => {
		const result = await approveProjectIssue({ backlog: [approvedIssue('GSHIP-733')], chainRuns: true });
		try {
			expect(result.starts).toEqual(['GSHIP-733']);
		} finally {
			await result.cleanup();
		}
	});

	test('approval does not start when chain is disabled or the issue is blocked', async () => {
		const disabled = await approveProjectIssue({ backlog: [approvedIssue('GSHIP-734')], chainRuns: false });
		const blocked = await approveProjectIssue({
			backlog: [
				approvedIssue('GSHIP-735', ['GSHIP-1']),
				{ ...approvedIssue('GSHIP-1'), stage: 'planned' },
			],
			chainRuns: true,
		});
		try {
			expect(disabled.starts).toEqual([]);
			expect(blocked.starts).toEqual([]);
		} finally {
			await disabled.cleanup();
			await blocked.cleanup();
		}
	});

	test('approval does not start during an active project run and repeated approvals do not duplicate starts', async () => {
		const active = await approveProjectIssue({
			backlog: [approvedIssue('GSHIP-736')],
			chainRuns: true,
			activeRun: {
				id: 'run-active', issueId: 'GSHIP-700', sessionId: 'session-active', providerId: 'claude',
				state: 'queued', fixRounds: 0, createdAt: '2026-08-23T00:00:00.000Z',
				updatedAt: '2026-08-23T00:00:00.000Z', workspacePath: '/project', summary: null, error: null,
			},
		});
		try {
			expect(active.starts).toEqual([]);
		} finally {
			await active.cleanup();
		}

		const repeated = await approveProjectIssue({
			backlog: [approvedIssue('GSHIP-737'), approvedIssue('GSHIP-738')],
			chainRuns: true,
		});
		try {
			expect((await repeated.approveAgain()).status).toBe(200);
			expect(repeated.starts).toEqual(['GSHIP-737']);
		} finally {
			await repeated.cleanup();
		}
	});
	test('delegates current-project routes to the existing runtime and collaborators', async () => {
		const cwd = createTestTmpdir('gship-project-agent-current-');
		readyProject(cwd);
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

	test('composes and reuses an isolated runtime for a ready non-current project', async () => {
		const cwd = createTestTmpdir('gship-project-agent-owner-ready-');
		const foreignRoot = createTestTmpdir('gship-project-agent-ready-foreign-');
		const foreignState = createTestTmpdir('gship-project-agent-ready-state-');
		readyProject(foreignRoot);
		const registry = openProjectRegistry(createTestTmpdir('gship-project-agent-ready-home-'));
		const foreign = registry.reconcile({
			root: foreignRoot,
			stateDir: foreignState,
			readiness: {
				state: 'ready',
				name: 'foreign',
				repository: 'acme/test',
				remoteUrl: 'git@github.com:acme/test.git',
				sourceRef: 'origin/main',
			},
		});
		const handle = startWebServer({ port: 0, cwd, projectRegistry: registry });
		const origin = `http://${handle.hostname}:${handle.port}`;
		const base = `${origin}/api/projects/${foreign.id}`;
		try {
			const snapshot = await fetch(`${base}/snapshot`);
			expect(snapshot.status).toBe(200);
			expect(existsSync(join(foreignState, 'runtime.sqlite'))).toBe(true);

			const updated = await fetch(`${base}/brief`, {
				method: 'PUT',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({
					objective: 'Foreign objective', decisions: [], constraints: [], openItems: [],
				}),
			});
			expect(updated.status).toBe(200);
			expect(await fetch(`${base}/brief`).then((response) => response.json())).toMatchObject({
				brief: { objective: 'Foreign objective' },
			});
			expect(existsSync(join(cwd, '.gship', 'runtime.sqlite'))).toBe(true);
		} finally {
			await handle.stop();
			registry.close();
		}
	});

	test('rejects every lifecycle route for a registered project that is not ready', async () => {
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
					code: 'project-not-ready',
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

	test('inherits global agent defaults and removes project overrides back to inheritance', async () => {
		const cwd = createTestTmpdir('gship-project-agent-defaults-');
		readyProject(cwd);
		const registry = openProjectRegistry(createTestTmpdir('gship-project-agent-defaults-home-'));
		registry.setAgentDefaults({
			provider: 'codex',
			modelSettings: {
				claude: { orchestrator: {}, executor: {}, reviewer: {} },
				codex: { orchestrator: {}, executor: { model: 'gpt-5-codex', effort: 'high' }, reviewer: {} },
			},
		});
		const runtime = new RunRuntime({ cwd, store: new RunStore(':memory:') });
		const handle = startWebServer({
			port: 0,
			cwd,
			projectRegistry: registry,
			runRuntime: runtime,
			modelProber: { probe: async () => ({ outcome: 'accepted' }) },
			providerAuth: {
				list: async () => [], startCodexLogin: async () => ({ loginId: 'unused', authUrl: 'https://unused' }),
				validateClaudeCredential: async () => ({ ok: false, message: 'unused' }), close: async () => {},
			},
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			expect(runtime.getSelectedProvider()).toBe('codex');
			expect(runtime.getSelectedProviderSource()).toBe('global');
			runtime.selectProvider('claude');
			expect(await fetch(`${origin}/api/providers/claude/select`, {
				method: 'DELETE', headers: { origin },
			}).then((response) => response.json())).toMatchObject({
				source: 'global', selected: 'codex',
			});
			expect(await fetch(`${origin}/api/model-settings`).then((response) => response.json()))
				.toMatchObject({ source: 'global', settings: { codex: { executor: { model: 'gpt-5-codex' } } } });
			const saved = await fetch(`${origin}/api/model-settings`, {
				method: 'PUT', headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify({ codex: { executor: { model: 'local-model' } } }),
			});
			expect(await saved.json()).toMatchObject({ source: 'project', settings: { codex: { executor: { model: 'local-model' } } } });
			const cleared = await fetch(`${origin}/api/model-settings`, { method: 'DELETE', headers: { origin } });
			expect(await cleared.json()).toMatchObject({ source: 'global', settings: { codex: { executor: { model: 'gpt-5-codex' } } } });
		} finally {
			await handle.stop();
			runtime.close();
			registry.close();
		}
	});
});
