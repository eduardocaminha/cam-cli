// test/web/project-scoped-browser-runs.test.ts
//
// The runs surface, made operational for any registered ready project
// (GSHIP-707). Two halves are asserted here: the service's project-scoped SSE
// endpoint, bound to that project's own RunRuntime and refusing before it opens
// a stream; and the browser transport, which derives the project from the URL
// alone and addresses the scoped routes for every read and every command.

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import { readBacklogFromMain } from '../../src/issues/backlog.ts';
import { openProjectRegistry } from '../../src/runtime/project-registry.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { RUNTIME_SOURCE_REF } from '../../src/runtime/source-ref.ts';
import { projectIdOf } from '../../webui/src/App.tsx';
import {
	commandRun,
	EVENTS_PATH,
	eventsPathOf,
	fetchBacklog,
	fetchRunEvents,
	fetchRuns,
	PROJECTS_PATH,
	RUNS_PATH,
} from '../../webui/src/client.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

interface ProjectList {
	projects: Array<{ id: string; current: boolean }>;
}

interface ProposalResponse {
	proposals: Array<{ id: string; status: string }>;
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

/** A repository the operator has not finished setting up: no origin yet. */
function onboardingProject(root: string): void {
	execFileSync('git', ['init', '-b', 'main'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'operator@example.com'], { cwd: root });
	writeFileSync(join(root, 'README.md'), '# Test\n');
	execFileSync('git', ['add', 'README.md'], { cwd: root });
	execFileSync('git', ['commit', '-m', 'seed'], { cwd: root });
}

/** A durable run and one activity event, written the way a past run left them. */
function seedRun(store: RunStore, runId: string, issueId: string): void {
	store.createRun({
		id: runId,
		issueId,
		sessionId: `session-${runId}`,
		workspacePath: `/tmp/${runId}`,
		createdAt: '2026-08-22T10:00:00.000Z',
	});
	store.transition({
		runId,
		toState: 'interrupted',
		kind: 'run.interrupted',
		createdAt: '2026-08-22T10:01:00.000Z',
	});
}

function seedProposal(store: RunStore, runId: string, issueId: string, title: string): void {
	store.createRun({
		id: runId,
		issueId,
		sessionId: `session-${runId}`,
		workspacePath: `/tmp/${runId}`,
		createdAt: '2026-08-22T10:00:00.000Z',
	});
	store.recordProposals({
		runId,
		issueId,
		proposals: [{ title, evidence: `Evidência de ${title}.` }],
		createdAt: '2026-08-22T10:01:00.000Z',
	});
}

function publishableProject(prefix: string): { local: string; remote: string } {
	const root = createTestTmpdir(prefix);
	const seed = join(root, 'seed');
	mkdirSync(seed, { recursive: true });
	execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: seed });
	execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: seed });
	execFileSync('git', ['config', 'user.email', 'operator@example.com'], { cwd: seed });
	writeFileSync(join(seed, 'README.md'), '# Test\n');
	execFileSync('git', ['add', '.'], { cwd: seed });
	execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: seed });
	const remote = join(root, 'remote.git');
	execFileSync('git', ['clone', '-q', '--bare', seed, remote], { cwd: root });
	const local = join(root, 'local');
	execFileSync('git', ['clone', '-q', remote, local], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test Operator'], { cwd: local });
	execFileSync('git', ['config', 'user.email', 'operator@example.com'], { cwd: local });
	return { local, remote };
}

async function currentProjectId(origin: string): Promise<string> {
	const listed = await fetch(`${origin}${PROJECTS_PATH}`).then((response) => response.json()) as ProjectList;
	const current = listed.projects.find((project) => project.current);
	if (current === undefined) throw new Error('the boot project is not registered');
	return current.id;
}

/** The web reader alone, so a `Response.body` reader satisfies it structurally. */
interface ChunkReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/** Read the stream until `marker` shows up, or give up after a bounded number of chunks. */
async function readStreamUntil(reader: ChunkReader, marker: string): Promise<string> {
	const decoder = new TextDecoder();
	let text = '';
	for (let attempt = 0; attempt < 10 && !text.includes(marker); attempt += 1) {
		const chunk = await reader.read();
		if (chunk.done) break;
		text += decoder.decode(chunk.value);
	}
	return text;
}

describe('project-scoped browser runs', () => {
	test('the scoped stream replays the named project runtime, never the boot one', async () => {
		const cwd = createTestTmpdir('gship-browser-runs-boot-');
		const foreignRoot = createTestTmpdir('gship-browser-runs-foreign-');
		const foreignState = createTestTmpdir('gship-browser-runs-foreign-state-');
		readyProject(cwd);
		readyProject(foreignRoot);
		const foreignStore = new RunStore(join(foreignState, 'runtime.sqlite'));
		seedRun(foreignStore, 'run-foreign', 'GSHIP-707');
		foreignStore.close();
		const bootStore = new RunStore(':memory:');
		seedRun(bootStore, 'run-boot', 'GSHIP-000');
		const bootRuntime = new RunRuntime({ cwd, store: bootStore });
		const registry = openProjectRegistry(createTestTmpdir('gship-browser-runs-home-'));
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
		const handle = startWebServer({ port: 0, cwd, projectRegistry: registry, runRuntime: bootRuntime });
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const stream = await fetch(`${origin}${eventsPathOf(foreign.id)}?after=0`);
			expect(stream.status).toBe(200);
			expect(stream.headers.get('content-type')).toContain('text/event-stream');
			const reader = stream.body?.getReader();
			expect(reader).toBeDefined();
			const replayed = await readStreamUntil(reader!, 'run.interrupted');
			expect(replayed).toContain('event: run-event');
			expect(replayed).toContain('"runId":"run-foreign"');
			expect(replayed).not.toContain('run-boot');
			await reader?.cancel();

			// The same separation on the reads the page loads beside the stream.
			const scopedRuns = await fetch(`${origin}${PROJECTS_PATH}/${foreign.id}/runs`).then((r) => r.json()) as {
				runs: Array<{ id: string }>;
			};
			expect(scopedRuns.runs.map((run) => run.id)).toEqual(['run-foreign']);
			const scopedEvents = await fetch(
				`${origin}${PROJECTS_PATH}/${foreign.id}/runs/run-foreign/events`,
			).then((r) => r.json()) as { events: Array<{ kind: string }> };
			expect(scopedEvents.events.map((event) => event.kind)).toEqual([
				'run.created',
				'run.interrupted',
			]);
			const bootRuns = await fetch(`${origin}${RUNS_PATH}`).then((r) => r.json()) as {
				runs: Array<{ id: string }>;
			};
			expect(bootRuns.runs.map((run) => run.id)).toEqual(['run-boot']);
		} finally {
			await handle.stop();
			bootRuntime.close();
			registry.close();
		}
	});

	test('proposal reads and decisions stay in the named project, including promotion', async () => {
		const boot = publishableProject('gship-browser-proposals-boot-');
		const foreign = publishableProject('gship-browser-proposals-foreign-');
		const bootState = createTestTmpdir('gship-browser-proposals-boot-state-');
		const foreignState = createTestTmpdir('gship-browser-proposals-foreign-state-');
		const bootStore = new RunStore(join(bootState, 'runtime.sqlite'));
		seedProposal(bootStore, 'run-boot-proposal', 'GSHIP-737-boot', 'Ideia do projeto boot');
		const foreignStore = new RunStore(join(foreignState, 'runtime.sqlite'));
		seedProposal(foreignStore, 'run-foreign-proposal', 'GSHIP-737-foreign', 'Ideia do projeto estrangeiro');
		foreignStore.close();
		const bootRuntime = new RunRuntime({ cwd: boot.local, store: bootStore });
		const registry = openProjectRegistry(createTestTmpdir('gship-browser-proposals-home-'));
		const registered = registry.reconcile({
			root: foreign.local,
			stateDir: foreignState,
			readiness: {
				state: 'ready',
				name: 'foreign',
				repository: 'acme/foreign',
				remoteUrl: foreign.remote,
				sourceRef: RUNTIME_SOURCE_REF,
			},
		});
		const handle = startWebServer({
			port: 0,
			cwd: boot.local,
			stateDir: bootState,
			projectRegistry: registry,
			runRuntime: bootRuntime,
		});
		const origin = `http://${handle.hostname}:${handle.port}`;
		const bootId = (await fetch(`${origin}/api/projects`).then((response) => response.json()) as {
			projects: Array<{ id: string; current: boolean }>;
		}).projects.find((project) => project.current)?.id;
		expect(bootId).toBeDefined();
		const base = (projectId: string) => `${origin}/api/projects/${encodeURIComponent(projectId)}`;
		const proposal = (runId: string) => `${runId}-proposal-1`;
		const body = {
			title: 'Draft promovido no projeto estrangeiro',
			scope: 'Escopo do projeto estrangeiro.',
			verificationCommand: 'bun test focused',
		};

		try {
			const bootPending = await fetch(`${base(bootId!)}/proposals`).then((response) => response.json()) as ProposalResponse;
			const foreignPending = await fetch(`${base(registered.id)}/proposals`).then((response) => response.json()) as ProposalResponse;
			expect(bootPending.proposals.map((item: { id: string }) => item.id)).toEqual([proposal('run-boot-proposal')]);
			expect(foreignPending.proposals.map((item: { id: string }) => item.id)).toEqual([proposal('run-foreign-proposal')]);

			const dismissed = await fetch(`${base(bootId!)}/proposals/${proposal('run-boot-proposal')}/dismiss`, {
				method: 'POST', headers: { origin },
			});
			expect(dismissed.status).toBe(200);
			expect((await dismissed.json() as { proposal: { status: string } }).proposal).toMatchObject({ status: 'dismissed' });
			const foreignStillPending = await fetch(`${base(registered.id)}/proposals`);
			expect(foreignStillPending.status).toBe(200);
			expect(await foreignStillPending.json()).toMatchObject({
				proposals: [{ id: proposal('run-foreign-proposal'), status: 'pending' }],
			});

			const promoted = await fetch(`${base(registered.id)}/proposals/${proposal('run-foreign-proposal')}/promote`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(promoted.status).toBe(200);
			const promotedPayload = await promoted.json();
			expect(promotedPayload).toMatchObject({
				ok: true,
				proposal: { id: proposal('run-foreign-proposal'), status: 'promoted' },
				issue: { title: body.title },
			});

			const bootResolved = await fetch(`${base(bootId!)}/proposals/resolved`).then((response) => response.json()) as ProposalResponse;
			const foreignResolved = await fetch(`${base(registered.id)}/proposals/resolved`).then((response) => response.json()) as ProposalResponse;
			expect(bootResolved.proposals.map(({ id, status }) => ({ id, status }))).toEqual([
				{ id: proposal('run-boot-proposal'), status: 'dismissed' },
			]);
			expect(foreignResolved.proposals.map(({ id, status }) => ({ id, status }))).toEqual([
				{ id: proposal('run-foreign-proposal'), status: 'promoted' },
			]);

			const bootBacklog = readBacklogFromMain(boot.local, undefined, RUNTIME_SOURCE_REF);
			const foreignBacklog = readBacklogFromMain(foreign.local, undefined, RUNTIME_SOURCE_REF);
			expect(bootBacklog).toEqual([]);
			expect(foreignBacklog).toContainEqual(expect.objectContaining({
				title: body.title,
				stage: 'specified',
				status: 'open',
			}));
		} finally {
			await handle.stop();
			bootRuntime.close();
			registry.close();
		}
	});

	test('a command from the page settles the selected project alone', async () => {
		const cwd = createTestTmpdir('gship-browser-runs-command-boot-');
		const foreignRoot = createTestTmpdir('gship-browser-runs-command-foreign-');
		const foreignState = createTestTmpdir('gship-browser-runs-command-state-');
		readyProject(cwd);
		readyProject(foreignRoot);
		const foreignStore = new RunStore(join(foreignState, 'runtime.sqlite'));
		seedRun(foreignStore, 'run-foreign', 'GSHIP-707');
		foreignStore.close();
		const bootStore = new RunStore(':memory:');
		seedRun(bootStore, 'run-boot', 'GSHIP-000');
		const bootRuntime = new RunRuntime({ cwd, store: bootStore });
		const registry = openProjectRegistry(createTestTmpdir('gship-browser-runs-command-home-'));
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
		const handle = startWebServer({ port: 0, cwd, projectRegistry: registry, runRuntime: bootRuntime });
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const abandoned = await fetch(
				`${origin}${PROJECTS_PATH}/${foreign.id}/runs/run-foreign/abandon`,
				{ method: 'POST', headers: { origin } },
			);
			expect(abandoned.status).toBe(200);
			// `abandon` settles an interrupted run as cancelled, the terminal state
			// the run model already has for a run the operator gave up on.
			expect(await abandoned.json()).toMatchObject({ ok: true, run: { state: 'cancelled' } });
			expect(bootRuntime.getRun('run-boot')?.state).toBe('interrupted');

			const reopened = new RunStore(join(foreignState, 'runtime.sqlite'));
			try {
				expect(reopened.getRun('run-foreign')?.state).toBe('cancelled');
			} finally {
				reopened.close();
			}
		} finally {
			await handle.stop();
			bootRuntime.close();
			registry.close();
		}
	});

	test('an unknown or not-ready project is refused before any stream opens', async () => {
		const cwd = createTestTmpdir('gship-browser-runs-refused-');
		const emptyRoot = createTestTmpdir('gship-browser-runs-empty-');
		const emptyState = createTestTmpdir('gship-browser-runs-empty-state-');
		readyProject(cwd);
		const registry = openProjectRegistry(createTestTmpdir('gship-browser-runs-refused-home-'));
		const notReady = registry.reconcile({
			root: emptyRoot,
			stateDir: emptyState,
			readiness: { state: 'empty', name: 'empty', detail: 'no commit yet' },
		});
		const handle = startWebServer({ port: 0, cwd, projectRegistry: registry });
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const unknown = await fetch(`${origin}${eventsPathOf('project-missing')}`);
			expect(unknown.status).toBe(404);
			expect(unknown.headers.get('content-type')).toContain('application/json');
			expect(await unknown.json()).toMatchObject({ ok: false, code: 'project-not-found' });

			const refused = await fetch(`${origin}${eventsPathOf(notReady.id)}`);
			expect(refused.status).toBe(409);
			expect(refused.headers.get('content-type')).toContain('application/json');
			expect(await refused.json()).toMatchObject({ ok: false, code: 'project-not-ready' });
			// Refused before composition: the project still has no SQLite of its own.
			expect(existsSync(join(emptyState, 'runtime.sqlite'))).toBe(false);
		} finally {
			await handle.stop();
			registry.close();
		}
	});

	test('closing the connection unsubscribes from that project runtime', async () => {
		const cwd = createTestTmpdir('gship-browser-runs-unsubscribe-');
		readyProject(cwd);
		const store = new RunStore(':memory:');
		seedRun(store, 'run-boot', 'GSHIP-707');
		const runtime = new RunRuntime({ cwd, store });
		const handle = startWebServer({ port: 0, cwd, runRuntime: runtime });
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const projectId = await currentProjectId(origin);
			const stream = await fetch(`${origin}${eventsPathOf(projectId)}?after=0`);
			const reader = stream.body?.getReader();
			await readStreamUntil(reader!, 'run.interrupted');
			await reader?.cancel();

			// A listener left behind would write into the cancelled stream and make
			// the next transition throw out of the runtime that published it.
			await Bun.sleep(50);
			const abandoned = await fetch(
				`${origin}${PROJECTS_PATH}/${projectId}/runs/run-boot/abandon`,
				{ method: 'POST', headers: { origin } },
			);
			expect(abandoned.status).toBe(200);
			expect(runtime.getRun('run-boot')?.state).toBe('cancelled');
		} finally {
			await handle.stop();
			runtime.close();
		}
	});

	test('the boot project keeps its own reads and stream while still in onboarding', async () => {
		const cwd = createTestTmpdir('gship-browser-runs-onboarding-');
		const foreignRoot = createTestTmpdir('gship-browser-runs-onboarding-foreign-');
		const foreignState = createTestTmpdir('gship-browser-runs-onboarding-foreign-state-');
		onboardingProject(cwd);
		const store = new RunStore(':memory:');
		seedRun(store, 'run-boot', 'GSHIP-707');
		const runtime = new RunRuntime({ cwd, store });
		const registry = openProjectRegistry(createTestTmpdir('gship-browser-runs-onboarding-home-'));
		const foreign = registry.reconcile({
			root: foreignRoot,
			stateDir: foreignState,
			readiness: { state: 'empty', name: 'foreign', detail: 'no commit yet' },
		});
		const handle = startWebServer({ port: 0, cwd, projectRegistry: registry, runRuntime: runtime });
		const origin = `http://${handle.hostname}:${handle.port}`;
		try {
			const projectId = await currentProjectId(origin);
			const inspected = await fetch(`${origin}/api/project`).then((r) => r.json()) as {
				project: { state: string };
			};
			expect(inspected.project.state).not.toBe('ready');

			// The scoped routes answer what the unscoped ones always answered: the
			// boot runtime exists from boot, so onboarding keeps its snapshot, its
			// version, its notices and its run list.
			const scoped = await fetch(`${origin}${PROJECTS_PATH}/${projectId}/snapshot`);
			expect(scoped.status).toBe(200);
			const unscoped = await fetch(`${origin}/api/snapshot`);
			expect(await scoped.json()).toEqual(await unscoped.json());

			const runs = await fetch(`${origin}${PROJECTS_PATH}/${projectId}/runs`).then((r) => r.json()) as {
				runs: Array<{ id: string }>;
			};
			expect(runs.runs.map((run) => run.id)).toEqual(['run-boot']);

			const stream = await fetch(`${origin}${eventsPathOf(projectId)}?after=0`);
			expect(stream.status).toBe(200);
			expect(stream.headers.get('content-type')).toContain('text/event-stream');
			const reader = stream.body?.getReader();
			expect(await readStreamUntil(reader!, 'run.interrupted')).toContain('"runId":"run-boot"');
			await reader?.cancel();

			// A registered project the service never composed keeps the refusal.
			const refused = await fetch(`${origin}${PROJECTS_PATH}/${foreign.id}/snapshot`);
			expect(refused.status).toBe(409);
			expect(await refused.json()).toMatchObject({ ok: false, code: 'project-not-ready' });
		} finally {
			await handle.stop();
			runtime.close();
			registry.close();
		}
	});

	test('the browser derives the project from the URL alone', () => {
		expect(projectIdOf('/projects/project-other/runs')).toBe('project-other');
		expect(projectIdOf('/projects/project-other/runs/')).toBe('project-other');
		expect(projectIdOf('/projects/project%20other')).toBe('project other');
		// No selection: the overview, and the legacy paths the service redirects.
		expect(projectIdOf('/overview')).toBeNull();
		expect(projectIdOf('/runs')).toBeNull();
		expect(projectIdOf('/')).toBeNull();
	});

	test('every run-facing read and command addresses the selected project', async () => {
		const calls: Array<{ url: string; method: string }> = [];
		const real = globalThis.fetch;
		globalThis.fetch = ((input: string, init?: RequestInit) => {
			calls.push({ url: String(input), method: init?.method ?? 'GET' });
			return Promise.resolve(Response.json({ runs: [], events: [] }, { status: 200 }));
		}) as typeof globalThis.fetch;
		try {
			await fetchRuns('project-other');
			await fetchBacklog('project-other');
			await fetchRunEvents('project-other', 'run-1');
			await commandRun('project-other', 'run-1', 'resume');
			await commandRun('project-other', 'run-1', 'ship');
			// Without a selection the boot project's own unscoped routes are kept.
			await fetchRuns(null);
			await fetchRunEvents(null, 'run-1');
		} finally {
			globalThis.fetch = real;
		}

		expect(calls).toEqual([
			{ url: '/api/projects/project-other/runs', method: 'GET' },
			{ url: '/api/projects/project-other/snapshot', method: 'GET' },
			{ url: '/api/projects/project-other/runs/run-1/events', method: 'GET' },
			{ url: '/api/projects/project-other/runs/run-1/resume', method: 'POST' },
			{ url: '/api/projects/project-other/runs/run-1/ship', method: 'POST' },
			{ url: RUNS_PATH, method: 'GET' },
			{ url: `${RUNS_PATH}/run-1/events`, method: 'GET' },
		]);
		expect(eventsPathOf('project-other')).toBe('/api/projects/project-other/events');
		expect(eventsPathOf(null)).toBe(EVENTS_PATH);
	});

	test('a typed refusal leaves the document with no data instead of a failed refresh', async () => {
		const real = globalThis.fetch;
		globalThis.fetch = ((_input: string, _init?: RequestInit) => Promise.resolve(Response.json(
			{ ok: false, code: 'project-not-ready', message: 'The requested project is not ready.' },
			{ status: 409 },
		))) as typeof globalThis.fetch;
		try {
			expect(await fetchRuns('project-other')).toEqual([]);
			expect(await fetchRunEvents('project-other', 'run-1')).toEqual([]);
			expect(await fetchBacklog('project-other')).toEqual({
				plannable: [],
				ideas: [],
				drafts: [],
				workspaceNotices: [],
				staleService: null,
				gitIdentity: null,
				version: '',
			});
		} finally {
			globalThis.fetch = real;
		}

		// A transport failure is still a failure: only the two typed refusals read
		// as an answer about the selection.
		const failing = globalThis.fetch;
		globalThis.fetch = ((_input: string, _init?: RequestInit) =>
			Promise.resolve(Response.json({}, { status: 500 }))) as typeof globalThis.fetch;
		try {
			await expect(fetchRuns('project-other')).rejects.toThrow('Runs responded with 500');
		} finally {
			globalThis.fetch = failing;
		}
	});
});
