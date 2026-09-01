import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import { readBacklogFromMain } from '../../src/issues/backlog.ts';
import type {
	DiagnosticAdapter,
	DiagnosticsSnapshot,
	DiagnosticWorkspace,
} from '../../src/runtime/diagnostics.ts';
import { DiagnosticsRuntime } from '../../src/runtime/diagnostics.ts';
import { ProjectRuntimeManager } from '../../src/runtime/project-runtime-manager.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore, type RunRecord } from '../../src/runtime/run-store.ts';
import { RUNTIME_SOURCE_REF } from '../../src/runtime/source-ref.ts';
import { openProjectRegistry } from '../../src/runtime/project-registry.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const SOURCE_SHA = 'b'.repeat(40);

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

function diagnosticHarness(options: {
	ready?: boolean;
	schedule?: { enabled: boolean; cadence: 'daily' | 'weekly' };
} = {}) {
	const project = options.ready === true ? publishableProject('gship-diagnostics-api-ready-') : undefined;
	const cwd = project?.local ?? createTestTmpdir('gship-diagnostics-api-');
	const stateDir = createTestTmpdir('gship-diagnostics-api-state-');
	const projectRegistry = project === undefined
		? undefined
		: openProjectRegistry(createTestTmpdir('gship-diagnostics-api-home-'));
	if (project !== undefined) {
		const readyRemote = 'git@github.com:acme/ready-diagnostics.git';
		execFileSync('git', ['remote', 'set-url', 'origin', readyRemote], { cwd });
		projectRegistry!.reconcile({
			root: cwd,
			stateDir,
			readiness: {
				state: 'ready',
				name: 'ready diagnostics project',
				repository: 'acme/ready-diagnostics',
				remoteUrl: readyRemote,
				sourceRef: 'origin/main',
			},
		});
	}
	const runRuntime = new RunRuntime({
		cwd: '/project',
		store: new RunStore(':memory:'),
	});
	const workspace: DiagnosticWorkspace = {
		prepare: async () => ({ path: '/tmp/diagnostic-checkout', sourceSha: SOURCE_SHA }),
		release: async () => ({ outcome: 'released' }),
		listNotices: () => [],
	};
	const adapter: DiagnosticAdapter = {
		id: 'react',
		label: 'React',
		version: '0.9.12',
		description: 'React diagnostics',
		scan: async () => ({
			version: '0.9.12',
			coverageComplete: true,
			findings: [
				{
					rule: 'first-rule',
					severity: 'error',
					file: 'webui/src/first.tsx',
					evidence: 'First finding',
				},
				{
					rule: 'second-rule',
					severity: 'warning',
					file: 'webui/src/second.tsx',
					evidence: 'Second finding',
				},
			],
		}),
	};
	const diagnostics = new DiagnosticsRuntime({
		store: new RunStore(options.ready === true ? join(stateDir, 'runtime.sqlite') : ':memory:'),
		workspace,
		adapters: [adapter],
		isProjectIdle: () => true,
		newId: () => 'scan-api',
		now: () => '2026-08-20T12:00:00.000Z',
	});
	if (options.schedule !== undefined) diagnostics.setSchedule(options.schedule);
	const intakeCalls: Array<{ input: unknown; approve: boolean | undefined }> = [];
	const handle = startWebServer({
		port: 0,
		cwd,
		stateDir,
		projectRegistry,
		runRuntime,
		diagnostics,
		issueIntake: (input, options) => {
			intakeCalls.push({ input, approve: options?.approve });
			return { id: 'GSHIP-900', title: 'Promoted diagnostic', sha: 'abc1234' };
		},
	});
	const origin = `http://${handle.hostname}:${handle.port}`;
	return {
		diagnostics,
		handle,
		intakeCalls,
		origin,
		runRuntime,
		stop: async () => {
			await handle.stop();
			diagnostics.close();
			runRuntime.close();
			projectRegistry?.close();
		},
	};
}

function post(origin: string, path: string, body?: unknown, requestOrigin = origin): Promise<Response> {
	return fetch(`${origin}${path}`, {
		method: 'POST',
		headers: { origin: requestOrigin, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

function put(origin: string, path: string, body: unknown, requestOrigin = origin): Promise<Response> {
	return fetch(`${origin}${path}`, {
		method: 'PUT',
		headers: { origin: requestOrigin, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function fetchDiagnostics(origin: string): Promise<DiagnosticsSnapshot> {
	return await fetch(`${origin}/api/diagnostics`).then((response) => response.json()) as DiagnosticsSnapshot;
}

async function waitForCompleted(origin: string): Promise<DiagnosticsSnapshot> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const snapshot = await fetchDiagnostics(origin);
		if (snapshot.scan?.state === 'completed') return snapshot;
		await Bun.sleep(5);
	}
	throw new Error('diagnostic API did not complete');
}

describe('diagnostics web API', () => {
	test('keeps start and human inbox decisions same-origin and advisory', async () => {
		const harness = diagnosticHarness();
		try {
			const initial = await fetchDiagnostics(harness.origin);
			expect(initial).toMatchObject({
				scan: null,
				findings: [],
				analyzers: [{ id: 'react', version: '0.9.12' }],
				stats: { total: 0, pending: 0, dismissed: 0, promoted: 0, cleared: 0, recurring: 0 },
			});

			const forbidden = await post(
				harness.origin,
				'/api/diagnostics',
				{ analyzer: 'react' },
				'http://evil.example',
			);
			expect(forbidden.status).toBe(403);

			const started = await post(harness.origin, '/api/diagnostics', { analyzer: 'react' });
			expect(started.status).toBe(202);
			expect(await started.json()).toMatchObject({ ok: true, scan: { id: 'scan-api' } });

			const completed = await waitForCompleted(harness.origin);
			expect(completed).toMatchObject({
				scan: { state: 'completed', findingCount: 2, coverageComplete: true },
			});
			const findings = completed.findings;
			const first = findings.find((finding) => finding.rule === 'first-rule');
			const second = findings.find((finding) => finding.rule === 'second-rule');

			const dismissed = await post(
				harness.origin,
				`/api/diagnostic-findings/${first?.id}/dismiss`,
			);
			expect(dismissed.status).toBe(200);
			expect(await dismissed.json()).toMatchObject({ finding: { status: 'dismissed' } });

			const promoted = await post(
				harness.origin,
				`/api/diagnostic-findings/${second?.id}/promote`,
				{
					title: 'Promoted diagnostic',
					scope: 'Remove the verified React defect.',
					verificationCommand: 'bun test',
				},
			);
			expect(promoted.status).toBe(200);
			expect(await promoted.json()).toMatchObject({
				issue: { id: 'GSHIP-900' },
				finding: { status: 'promoted', promotedIssueId: 'GSHIP-900' },
			});
			expect(harness.intakeCalls).toEqual([{
				input: {
					title: 'Promoted diagnostic',
					scope: 'Remove the verified React defect.',
					verificationCommand: 'bun test',
				},
				approve: false,
			}]);

			const settled = await fetchDiagnostics(harness.origin);
			expect(settled.findings).toEqual([]);
			expect(settled.resolvedFindings).toHaveLength(2);
			expect(settled.stats).toEqual({
				total: 2,
				pending: 0,
				dismissed: 1,
				promoted: 1,
				cleared: 0,
				recurring: 0,
			});
		} finally {
			await harness.stop();
		}
	});

	test('persists a bounded same-origin schedule and starts one due scan', async () => {
		const harness = diagnosticHarness();
		try {
			const forbidden = await put(
				harness.origin,
				'/api/diagnostics/schedule',
				{ enabled: true, cadence: 'daily' },
				'http://evil.example',
			);
			expect(forbidden.status).toBe(403);

			const invalid = await put(
				harness.origin,
				'/api/diagnostics/schedule',
				{ enabled: true, cadence: 'hourly' },
			);
			expect(invalid.status).toBe(400);

			const beforeUnknownAnalyzer = await fetchDiagnostics(harness.origin);
			let scheduledCalls = 0;
			const originalRunScheduled = harness.diagnostics.runScheduledIfDue;
			harness.diagnostics.runScheduledIfDue = () => {
				scheduledCalls += 1;
				return 'disabled';
			};
			try {
				const unknownAnalyzer = await put(
					harness.origin,
					'/api/diagnostics/schedule',
					{ enabled: true, cadence: 'daily', analyzer: 'missing' },
				);
				expect(unknownAnalyzer.status).toBe(404);
				expect(await unknownAnalyzer.json()).toMatchObject({ code: 'analyzer-not-found' });
				expect((await fetchDiagnostics(harness.origin)).schedule).toEqual(beforeUnknownAnalyzer.schedule);
				expect(scheduledCalls).toBe(0);
			} finally {
				harness.diagnostics.runScheduledIfDue = originalRunScheduled;
			}

			const enabled = await put(
				harness.origin,
				'/api/diagnostics/schedule',
				{ enabled: true, cadence: 'daily' },
			);
			expect(enabled.status).toBe(200);
			expect(await enabled.json()).toMatchObject({
				ok: true,
				outcome: 'started',
				schedule: {
					enabled: true,
					cadence: 'daily',
					lastScanAt: '2026-08-20T12:00:00.000Z',
					nextRunAt: '2026-08-21T12:00:00.000Z',
					overdue: false,
				},
			});

			const completed = await waitForCompleted(harness.origin);
			expect(completed.schedule).toMatchObject({
				enabled: true,
				cadence: 'daily',
				nextRunAt: '2026-08-21T12:00:00.000Z',
				overdue: false,
			});

			const disabled = await put(
				harness.origin,
				'/api/diagnostics/schedule',
				{ enabled: false, cadence: 'weekly' },
			);
			expect(await disabled.json()).toMatchObject({
				ok: true,
				outcome: 'disabled',
				schedule: { enabled: false, cadence: 'weekly', nextRunAt: null, overdue: false },
			});
			expect((await fetchDiagnostics(harness.origin)).scan?.id).toBe('scan-api');
		} finally {
			await harness.stop();
		}
	});

	test('does not schedule an unready boot project when the service starts', async () => {
		const harness = diagnosticHarness({ schedule: { enabled: true, cadence: 'weekly' } });
		try {
			const snapshot = await fetchDiagnostics(harness.origin);
			expect(snapshot.scan).toBeNull();
		} finally {
			await harness.stop();
		}
	});

	test('activates a persisted overdue schedule for a ready boot project at startup', async () => {
		const harness = diagnosticHarness({
			ready: true,
			schedule: { enabled: true, cadence: 'weekly' },
		});
		try {
			const completed = await waitForCompleted(harness.origin);
			expect(completed).toMatchObject({
				scan: { id: 'scan-api', state: 'completed' },
				schedule: {
					enabled: true,
					cadence: 'weekly',
					lastScanAt: '2026-08-20T12:00:00.000Z',
					nextRunAt: '2026-08-27T12:00:00.000Z',
					overdue: false,
				},
			});
		} finally {
			await harness.stop();
		}
	});

	test('reconciles two ready project schedules independently', async () => {
		const firstProject = publishableProject('gship-diagnostics-schedule-first-');
		const secondProject = publishableProject('gship-diagnostics-schedule-second-');
		const firstState = createTestTmpdir('gship-diagnostics-schedule-first-state-');
		const secondState = createTestTmpdir('gship-diagnostics-schedule-second-state-');
		const registry = openProjectRegistry(createTestTmpdir('gship-diagnostics-schedule-home-'));
		const first = registry.reconcile({
			root: firstProject.local,
			stateDir: firstState,
			readiness: {
				state: 'ready', name: 'first', repository: 'acme/first',
				remoteUrl: firstProject.remote, sourceRef: 'origin/main',
			},
		});
		const second = registry.reconcile({
			root: secondProject.local,
			stateDir: secondState,
			readiness: {
				state: 'ready', name: 'second', repository: 'acme/second',
				remoteUrl: secondProject.remote, sourceRef: 'origin/main',
			},
		});
		for (const stateDir of [firstState, secondState]) {
			const store = new RunStore(join(stateDir, 'runtime.sqlite'));
			store.setDiagnosticSchedule({ enabled: true, cadence: 'daily', analyzer: 'react' });
			store.close();
		}
		const calls: string[] = [];
		const outcomes = new Map<string, string>();
		const manager = new ProjectRuntimeManager<any>(registry, firstProject.local, (project) => {
			const diagnostics = new DiagnosticsRuntime({
				store: new RunStore(join(project.stateDir, 'runtime.sqlite')),
				workspace: {
					prepare: async () => ({ path: `/tmp/${project.id}-diagnostic`, sourceSha: SOURCE_SHA }),
					release: async () => ({ outcome: 'released' as const }),
					listNotices: () => [],
				},
				adapters: [{
					id: 'react', label: 'React', version: '0.9.12', description: 'React diagnostics',
					scan: async () => ({ version: '0.9.12', coverageComplete: true, findings: [] }),
				}],
				isProjectIdle: () => project.id !== first.id,
				now: () => '2026-08-20T00:00:00.000Z',
				newId: () => `${project.id}-scheduled`,
			});
			const runScheduledIfDue = diagnostics.runScheduledIfDue.bind(diagnostics);
			diagnostics.runScheduledIfDue = () => {
				calls.push(project.id);
				const outcome = runScheduledIfDue();
				outcomes.set(project.id, outcome);
				return outcome;
			};
			return {
				runtime: { listRuns: () => [], acquireAdmissionFence: () => () => undefined },
				diagnostics,
				close: async () => {
					await diagnostics.stop();
					diagnostics.close();
				},
			};
		});
		try {
			manager.reconcileScheduledDiagnostics();
			expect(new Set(calls)).toEqual(new Set([first.id, second.id]));
			expect(outcomes).toEqual(new Map([[first.id, 'project-busy'], [second.id, 'started']]));
			expect(manager.get(first.id).context.diagnostics.getSchedule()).toMatchObject({ overdue: true });
			expect(manager.get(second.id).context.diagnostics.getSchedule()).toMatchObject({ overdue: false });
			await Bun.sleep(20);
			const firstStore = new RunStore(join(firstState, 'runtime.sqlite'));
			const secondStore = new RunStore(join(secondState, 'runtime.sqlite'));
			try {
				expect(firstStore.listDiagnosticScans()).toEqual([]);
				expect(secondStore.listDiagnosticScans()).toHaveLength(1);
				expect(firstStore.getDiagnosticSchedule()).toMatchObject({ enabled: true, cadence: 'daily', analyzer: 'react' });
				expect(secondStore.getDiagnosticSchedule()).toMatchObject({ enabled: true, cadence: 'daily', analyzer: 'react' });
			} finally {
				firstStore.close();
				secondStore.close();
			}
		} finally {
			await manager.close();
			registry.close();
		}
	});

	test('keeps diagnostics and run admission isolated across ready projects', async () => {
		const currentProject = publishableProject('gship-diagnostics-project-current-');
		const foreignProject = publishableProject('gship-diagnostics-project-foreign-');
		const cwd = currentProject.local;
		const foreignRoot = foreignProject.local;
		const currentState = createTestTmpdir('gship-diagnostics-project-current-state-');
		const foreignState = createTestTmpdir('gship-diagnostics-project-foreign-state-');

		const registry = openProjectRegistry(createTestTmpdir('gship-diagnostics-project-home-'));
		const foreign = registry.reconcile({
			root: foreignRoot,
			stateDir: foreignState,
			readiness: {
				state: 'ready',
				name: 'foreign',
				repository: 'acme/foreign',
				remoteUrl: foreignProject.remote,
				sourceRef: 'origin/main',
			},
		});
		const current = registry.reconcile({
			root: cwd,
			stateDir: currentState,
			readiness: {
				state: 'ready',
				name: 'current',
				repository: 'acme/current',
				remoteUrl: currentProject.remote,
				sourceRef: 'origin/main',
			},
		});

		const currentStore = new RunStore(join(currentState, 'runtime.sqlite'));
		const foreignStore = new RunStore(join(foreignState, 'runtime.sqlite'));
		for (const [store, prefix] of [[currentStore, 'current'], [foreignStore, 'foreign']] as const) {
			store.createDiagnosticScan({ id: `${prefix}-seed-scan`, analyzer: 'react', createdAt: '2026-08-20T12:00:00.000Z' });
			store.beginDiagnosticScan({ id: `${prefix}-seed-scan`, analyzerVersion: '0.9.12', sourceSha: SOURCE_SHA, updatedAt: '2026-08-20T12:00:00.000Z' });
			store.completeDiagnosticScan({
				id: `${prefix}-seed-scan`, analyzerVersion: '0.9.12', sourceSha: SOURCE_SHA,
				coverageComplete: true, updatedAt: '2026-08-20T12:00:00.000Z',
				findings: prefix === 'foreign'
					? [
						{ rule: 'foreign-dismiss-rule', severity: 'error', file: 'foreign-dismiss.tsx', evidence: 'foreign dismiss evidence' },
						{ rule: 'foreign-promote-rule', severity: 'warning', file: 'foreign-promote.tsx', evidence: 'foreign promote evidence' },
					]
					: [{ rule: 'current-rule', severity: 'error', file: 'current.tsx', evidence: 'current evidence' }],
			});
		}

		const runRuntime = new RunRuntime({ cwd, store: new RunStore(':memory:') });
		const currentDiagnostics = new DiagnosticsRuntime({
			store: currentStore,
			workspace: {
				prepare: async () => ({ path: '/tmp/current-diagnostic-checkout', sourceSha: SOURCE_SHA }),
				release: async () => ({ outcome: 'released' }),
				listNotices: () => [],
			},
			adapters: [{
				id: 'react', label: 'React', version: '0.9.12', description: 'React diagnostics',
				scan: async ({ signal }) => await new Promise((_, reject) => {
					signal.addEventListener('abort', () => reject(new Error('cancelled by test')), { once: true });
				}),
			}],
			isProjectIdle: () => true,
			newId: () => 'current-active-scan',
		});
		let serverProjectRuntimes: ProjectRuntimeManager<any> | undefined;
		const originalRegister = ProjectRuntimeManager.prototype.register;
		ProjectRuntimeManager.prototype.register = function (projectId, context) {
			serverProjectRuntimes = this;
			return originalRegister.call(this, projectId, context);
		};
		let handle;
		try {
			handle = startWebServer({
				port: 0, cwd, stateDir: currentState, projectRegistry: registry, runRuntime, diagnostics: currentDiagnostics,
				issueIntake: () => { throw new Error('boot issue intake must not be called'); },
			});
		} finally {
			ProjectRuntimeManager.prototype.register = originalRegister;
		}
		if (serverProjectRuntimes === undefined) throw new Error('server did not register a project runtime manager');
		const origin = `http://${handle.hostname}:${handle.port}`;
		const base = (projectId: string) => `${origin}/api/projects/${projectId}`;
		const command = (path: string, body?: unknown) => post(origin, new URL(path).pathname, body);
		try {
			const currentSnapshot = await fetch(`${base(current.id)}/diagnostics`).then((response) => response.json()) as DiagnosticsSnapshot;
			const foreignSnapshot = await fetch(`${base(foreign.id)}/diagnostics`).then((response) => response.json()) as DiagnosticsSnapshot;
			expect(currentSnapshot.findings.map((finding) => finding.rule)).toEqual(['current-rule']);
			expect(foreignSnapshot.findings.map((finding) => finding.rule)).toEqual(['foreign-dismiss-rule', 'foreign-promote-rule']);
			expect(foreignSnapshot.analyzers.map((analyzer) => analyzer.id)).toEqual(['react', 'project']);
			const currentContext = serverProjectRuntimes.get(current.id).context;
			const foreignContext = serverProjectRuntimes.get(foreign.id).context;
			const currentScheduleBefore = currentSnapshot.schedule;
			const foreignScheduleBefore = foreignSnapshot.schedule;
			const scheduledCalls: string[] = [];
			const originalCurrentScheduled = currentContext.diagnostics.runScheduledIfDue;
			const originalForeignScheduled = foreignContext.diagnostics.runScheduledIfDue;
			currentContext.diagnostics.runScheduledIfDue = () => {
				scheduledCalls.push(current.id);
				return 'disabled';
			};
			foreignContext.diagnostics.runScheduledIfDue = () => {
				scheduledCalls.push(foreign.id);
				return 'disabled';
			};
			try {
				const unknownAnalyzer = await put(origin, new URL(`${base(current.id)}/diagnostics/schedule`).pathname, {
					enabled: true, cadence: 'daily', analyzer: 'missing',
				});
				expect(unknownAnalyzer.status).toBe(404);
				expect(await unknownAnalyzer.json()).toMatchObject({ code: 'analyzer-not-found' });
				expect(scheduledCalls).toEqual([]);
				expect((await fetch(`${base(current.id)}/diagnostics`).then((response) => response.json()) as DiagnosticsSnapshot).schedule).toEqual(currentScheduleBefore);
				expect((await fetch(`${base(foreign.id)}/diagnostics`).then((response) => response.json()) as DiagnosticsSnapshot).schedule).toEqual(foreignScheduleBefore);

				const currentSchedule = await put(origin, new URL(`${base(current.id)}/diagnostics/schedule`).pathname, {
					enabled: false, cadence: 'daily', analyzer: 'react',
				});
				expect(currentSchedule.status).toBe(200);
				expect(await currentSchedule.json()).toMatchObject({
					schedule: { enabled: false, cadence: 'daily', analyzer: 'react' },
				});
				expect(scheduledCalls).toEqual([current.id]);
				expect((await fetch(`${base(current.id)}/diagnostics`).then((response) => response.json()) as DiagnosticsSnapshot).schedule).toMatchObject({
					enabled: false, cadence: 'daily', analyzer: 'react',
				});
				expect((await fetch(`${base(foreign.id)}/diagnostics`).then((response) => response.json()) as DiagnosticsSnapshot).schedule).toEqual(foreignScheduleBefore);

				const foreignSchedule = await put(origin, new URL(`${base(foreign.id)}/diagnostics/schedule`).pathname, {
					enabled: false, cadence: 'daily', analyzer: 'react',
				});
				expect(foreignSchedule.status).toBe(200);
				expect(await foreignSchedule.json()).toMatchObject({
					schedule: { enabled: false, cadence: 'daily', analyzer: 'react' },
				});
				expect(scheduledCalls).toEqual([current.id, foreign.id]);
				expect((await fetch(`${base(current.id)}/diagnostics`).then((response) => response.json()) as DiagnosticsSnapshot).schedule).toMatchObject({
					enabled: false, cadence: 'daily', analyzer: 'react',
				});
				expect((await fetch(`${base(foreign.id)}/diagnostics`).then((response) => response.json()) as DiagnosticsSnapshot).schedule).toMatchObject({
					enabled: false, cadence: 'daily', analyzer: 'react',
				});
			} finally {
				currentContext.diagnostics.runScheduledIfDue = originalCurrentScheduled;
				foreignContext.diagnostics.runScheduledIfDue = originalForeignScheduled;
			}
			const originalForeignStartRun = foreignContext.runtime.startRun;
			const foreignRunIssueIds: string[] = [];
			foreignContext.runtime.startRun = async (issueId: string): Promise<RunRecord> => {
				foreignRunIssueIds.push(issueId);
				return {
					id: 'foreign-diagnostic-independent-run',
					issueId,
					sessionId: 'foreign-diagnostic-independent-session',
					providerId: 'codex',
					workspacePath: foreignRoot,
					state: 'queued',
					fixRounds: 0,
					createdAt: '2026-08-23T00:00:00.000Z',
					updatedAt: '2026-08-23T00:00:00.000Z',
					summary: null,
					error: null,
				};
			};

			try {
				const started = await command(`${base(current.id)}/diagnostics`, { analyzer: 'react' });
				expect(started.status).toBe(202);
				const active = await command(`${base(current.id)}/runs`, { issueId: 'GSHIP-739' });
				expect(active.status).toBe(409);
				expect(await active.json()).toMatchObject({ code: 'run-preflight-failed', message: expect.stringContaining('diagnostic') });
				expect(currentContext.diagnostics.isActive()).toBe(true);
				const foreignRun = await command(`${base(foreign.id)}/runs`, { issueId: 'GSHIP-739' });
				expect(foreignRun.status).toBe(202);
				expect(await foreignRun.json()).toMatchObject({
					ok: true,
					run: { id: 'foreign-diagnostic-independent-run', issueId: 'GSHIP-739' },
				});
				expect(foreignRunIssueIds).toEqual(['GSHIP-739']);
			} finally {
				foreignContext.runtime.startRun = originalForeignStartRun;
			}

			const originalForeignDiagnosticStart = foreignContext.diagnostics.start;
			const originalForeignDiagnosticCancel = foreignContext.diagnostics.cancel;
			const foreignStartAnalyzers: string[] = [];
			const foreignCancelScanIds: string[] = [];
			const foreignActiveScan = {
				id: 'foreign-active-scan',
				analyzer: 'react',
				analyzerVersion: '0.9.12',
				sourceSha: SOURCE_SHA,
				state: 'running',
				coverageComplete: false,
				findingCount: 0,
				error: null,
				createdAt: '2026-08-23T00:00:00.000Z',
				updatedAt: '2026-08-23T00:00:00.000Z',
			};
			foreignContext.diagnostics.start = (analyzer = 'react') => {
				foreignStartAnalyzers.push(analyzer);
				return foreignActiveScan;
			};
			foreignContext.diagnostics.cancel = async (scanId: string) => {
				foreignCancelScanIds.push(scanId);
				return { ...foreignActiveScan, state: 'cancelled', updatedAt: '2026-08-23T00:00:01.000Z' };
			};
			try {
				const cancelled = await command(`${base(current.id)}/diagnostics/current-active-scan/cancel`);
				expect(cancelled.status).toBe(200);
				expect(currentContext.diagnostics.isActive()).toBe(false);
				expect(foreignStartAnalyzers).toEqual([]);
				expect(foreignCancelScanIds).toEqual([]);

				const foreignStarted = await command(`${base(foreign.id)}/diagnostics`, { analyzer: 'react' });
				expect(foreignStarted.status).toBe(202);
				expect(await foreignStarted.json()).toMatchObject({ ok: true, scan: { id: 'foreign-active-scan' } });
				const foreignCancelled = await command(`${base(foreign.id)}/diagnostics/foreign-active-scan/cancel`);
				expect(foreignCancelled.status).toBe(200);
				expect(foreignStartAnalyzers).toEqual(['react']);
				expect(foreignCancelScanIds).toEqual(['foreign-active-scan']);
			} finally {
				foreignContext.diagnostics.start = originalForeignDiagnosticStart;
				foreignContext.diagnostics.cancel = originalForeignDiagnosticCancel;
			}

			serverProjectRuntimes.get(foreign.id);
			const releaseFence = serverProjectRuntimes.acquireAdmission('global diagnostic fence');
			expect(releaseFence).not.toBeNull();
			try {
				for (const projectId of [current.id, foreign.id]) {
					const fenced = await command(`${base(projectId)}/diagnostics`, { analyzer: 'react' });
					expect(fenced.status).toBe(409);
					expect(await fenced.json()).toMatchObject({
						code: 'project-busy',
						message: expect.stringContaining('global diagnostic fence'),
					});
				}
			} finally {
				releaseFence!();
			}
			const foreignFinding = foreignSnapshot.findings.find((finding) => finding.rule === 'foreign-dismiss-rule')!;
			expect((await command(`${base(foreign.id)}/diagnostic-findings/${foreignFinding.id}/dismiss`)).status).toBe(200);
			const foreignPromoteFinding = foreignSnapshot.findings.find((finding) => finding.rule === 'foreign-promote-rule')!;
			const promoted = await command(`${base(foreign.id)}/diagnostic-findings/${foreignPromoteFinding.id}/promote`, {
				title: 'Foreign draft', scope: 'Foreign scope', verificationCommand: 'bun test',
			});
			expect(promoted.status).toBe(200);
			const promotedResult = await promoted.json() as {
				issue: { id: string; title: string };
				finding: { status: string; promotedIssueId: string | null };
			};
			expect(promotedResult.issue.title).toBe('Foreign draft');
			expect(promotedResult.finding).toEqual({
				...promotedResult.finding,
				status: 'promoted',
				promotedIssueId: promotedResult.issue.id,
			});
			expect((await fetch(`${base(current.id)}/diagnostics`).then((response) => response.json()) as DiagnosticsSnapshot).findings.map((finding) => ({
				rule: finding.rule,
				status: finding.status,
			}))).toEqual([{ rule: 'current-rule', status: 'pending' }]);
			expect((await fetch(`${base(foreign.id)}/diagnostics`).then((response) => response.json()) as DiagnosticsSnapshot).findings).toEqual([]);
			expect(readBacklogFromMain(cwd, undefined, RUNTIME_SOURCE_REF)).toEqual([]);
			const foreignBacklog = readBacklogFromMain(foreignRoot, undefined, RUNTIME_SOURCE_REF);
			expect(foreignBacklog).toHaveLength(1);
			expect(foreignBacklog).toMatchObject([{
				title: 'Foreign draft',
				description: 'Foreign scope',
			}]);
		} finally {
			await handle.stop();
			currentStore.close();
			foreignStore.close();
			registry.close();
		}
	});
});
