import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DiagnosticDraft } from '../../src/runtime/diagnostic-finding.ts';
import {
	type DiagnosticAdapter,
	type DiagnosticAdapterResult,
	DiagnosticRuntimeError,
	DiagnosticsRuntime,
	type DiagnosticWorkspace,
	GitDiagnosticWorkspace,
	parseProjectDiagnosticReport,
	parseReactDoctorReport,
	ProjectDiagnosticAdapter,
	ReactDoctorAdapter,
} from '../../src/runtime/diagnostics.ts';
import type { CommandResult } from '../../src/runtime/git-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const SOURCE_SHA = 'a'.repeat(40);
const FINDING: DiagnosticDraft = {
	rule: 'no-transition-all',
	severity: 'warning',
	file: 'webui/src/App.tsx',
	evidence: 'Avoid transition-all because it animates unintended properties.',
	line: 42,
	column: 3,
};

function report(options: { complete?: boolean; diagnostics?: unknown[] } = {}): string {
	return JSON.stringify({
		schemaVersion: 3,
		version: '0.9.12',
		ok: true,
		directory: '/tmp/checkout',
		projects: [{
			directory: '/tmp/checkout/webui',
			complete: options.complete ?? true,
			diagnostics: options.diagnostics ?? [{
				filePath: 'src/App.tsx',
				normalizedFilePath: 'src/App.tsx',
				rule: 'no-transition-all',
				severity: 'warning',
				title: 'Avoid transition-all',
				message: 'It animates unintended properties.',
				help: 'List the properties explicitly.',
				line: 42,
				column: 3,
			}],
		}],
	});
}

class FakeWorkspace implements DiagnosticWorkspace {
	releases = 0;

	async prepare(): Promise<{ path: string; sourceSha: string }> {
		return { path: '/tmp/diagnostic-workspace', sourceSha: SOURCE_SHA };
	}

	async release(): Promise<{ outcome: 'released' }> {
		this.releases += 1;
		return { outcome: 'released' };
	}

	listNotices(): string[] {
		return [];
	}
}

class QueueAdapter implements DiagnosticAdapter {
	readonly id = 'react';
	readonly label = 'React';
	readonly version = '0.9.12';
	readonly description = 'React diagnostics';
	readonly results: DiagnosticAdapterResult[];

	constructor(results: DiagnosticAdapterResult[]) {
		this.results = [...results];
	}

	async scan(): Promise<DiagnosticAdapterResult> {
		const result = this.results.shift();
		if (result === undefined) throw new Error('missing queued diagnostic result');
		return result;
	}
}

async function waitForScan(
	runtime: DiagnosticsRuntime,
	state: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (runtime.snapshot().scan?.state === state) return;
		await Bun.sleep(5);
	}
	throw new Error(`diagnostic did not reach ${state}`);
}

describe('React diagnostic adapter boundary', () => {
	test('normalizes the pinned schema into provider-neutral findings', () => {
		const parsed = parseReactDoctorReport(report({ complete: false }));
		expect(parsed).toEqual({
			version: '0.9.12',
			coverageComplete: false,
			findings: [{
				rule: 'no-transition-all',
				severity: 'warning',
				file: 'webui/src/App.tsx',
				evidence: 'Avoid transition-all\nIt animates unintended properties.\nList the properties explicitly.',
				line: 42,
				column: 3,
			}],
		});
	});

	test('fails closed on an unknown schema and drops paths outside the checkout', () => {
		expect(() => parseReactDoctorReport(report().replace('"schemaVersion":3', '"schemaVersion":4')))
			.toThrow('Unsupported React diagnostic report schema');
		const parsed = parseReactDoctorReport(report({
			diagnostics: [{
				normalizedFilePath: '../../secret',
				rule: 'unsafe',
				severity: 'error',
				title: 'unsafe path',
			}],
		}));
		expect(parsed.findings).toEqual([]);
		const noProject = parseReactDoctorReport(report().replace(/"projects":\[.*\]}/, '"projects":[]}'));
		expect(noProject.coverageComplete).toBe(false);
	});

	test('pins argv, disables telemetry and keeps its cache outside the checkout', async () => {
		const projectRoot = createTestTmpdir('gship-diagnostic-adapter-');
		let invocation: {
			cmd: string[];
			cwd: string;
			env?: Record<string, string | undefined>;
		} | undefined;
		const run = async (input: {
			cmd: string[];
			cwd: string;
			signal: AbortSignal;
			env?: Record<string, string | undefined>;
		}): Promise<CommandResult> => {
			invocation = input;
			return { exitCode: 0, stdout: report(), stderr: '' };
		};
		const adapter = new ReactDoctorAdapter(projectRoot, run);
		await adapter.scan({ cwd: '/tmp/checkout', signal: new AbortController().signal });
		expect(invocation?.cwd).toBe('/tmp/checkout');
		expect(invocation?.cmd).toContain('react-doctor@0.9.12');
		expect(invocation?.cmd).toContain('--no-telemetry');
		expect(invocation?.cmd).toContain('--no-score');
		expect(invocation?.env?.REACT_DOCTOR_NO_TELEMETRY).toBe('1');
		expect(invocation?.env?.BUN_INSTALL_CACHE_DIR).toBe(
			join(projectRoot, '.gship', 'diagnostics', 'cache'),
		);
	});

	test('uses an explicit state directory for cache without consulting project .gship', async () => {
		const projectRoot = createTestTmpdir('gship-diagnostic-project-');
		const stateDir = createTestTmpdir('gship-diagnostic-state-');
		const adapter = new ReactDoctorAdapter(
			projectRoot,
			async () => ({ exitCode: 0, stdout: report(), stderr: '' }),
			stateDir,
		);

		await adapter.scan({ cwd: projectRoot, signal: new AbortController().signal });

		expect(existsSync(join(stateDir, 'diagnostics', 'cache'))).toBe(true);
		expect(existsSync(join(projectRoot, '.gship'))).toBe(false);
	});
});

describe('project diagnostic adapter boundary', () => {
	test('normalizes its strict report schema and drops paths outside the checkout', () => {
		const checkout = '/tmp/project-diagnostic-checkout';
		expect(parseProjectDiagnosticReport(JSON.stringify({
			schemaVersion: 1,
			version: '1.2.3',
			coverageComplete: true,
			findings: [
				{ ...FINDING, file: 'src/../src/diagnostic.ts' },
				{ ...FINDING, rule: 'outside', file: '../secret' },
				{ ...FINDING, rule: 'absolute', file: '/secret' },
			],
		}), checkout)).toEqual({
			version: '1.2.3',
			coverageComplete: true,
			findings: [{ ...FINDING, file: 'src/diagnostic.ts' }],
		});
		for (const reportValue of [
			{ schemaVersion: 2, version: '1', coverageComplete: true, findings: [] },
			{ schemaVersion: 1, version: '', coverageComplete: true, findings: [] },
			{ schemaVersion: 1, version: '1', coverageComplete: 'yes', findings: [] },
			{ schemaVersion: 1, version: '1', coverageComplete: true },
		]) {
			expect(() => parseProjectDiagnosticReport(JSON.stringify(reportValue), checkout)).toThrow();
		}
	});

	test('rereads the checkout manifest and runs exactly its command through the cancellable runner', async () => {
		const checkout = createTestTmpdir('gship-project-diagnostic-');
		mkdirSync(join(checkout, '.gateship'));
		writeFileSync(join(checkout, '.gateship', 'project.json'), JSON.stringify({
			version: 1,
			verify: ['bun test'],
			diagnostic: { command: 'bun run diagnostic' },
		}));
		let invocation: { command: string; cwd: string; signal: AbortSignal } | undefined;
		const adapter = new ProjectDiagnosticAdapter(async (input) => {
			invocation = input;
			return {
				exitCode: 0,
				stdout: JSON.stringify({ schemaVersion: 1, version: 'tool-1', coverageComplete: true, findings: [FINDING] }),
				stderr: '',
			};
		});
		await expect(adapter.scan({ cwd: checkout, signal: new AbortController().signal })).resolves.toEqual({
			version: 'tool-1', coverageComplete: true, findings: [FINDING],
		});
		expect(invocation).toMatchObject({ command: 'bun run diagnostic', cwd: checkout });

		writeFileSync(join(checkout, '.gateship', 'project.json'), JSON.stringify({ version: 1, verify: ['bun test'] }));
		await expect(adapter.scan({ cwd: checkout, signal: new AbortController().signal }))
			.rejects.toThrow('Project diagnostic is not configured');
	});

	test('surfaces a bounded command failure without affecting other adapters', async () => {
		const checkout = createTestTmpdir('gship-project-diagnostic-failure-');
		mkdirSync(join(checkout, '.gateship'));
		writeFileSync(join(checkout, '.gateship', 'project.json'), JSON.stringify({
			version: 1, verify: ['bun test'], diagnostic: { command: 'false' },
		}));
		const adapter = new ProjectDiagnosticAdapter(async () => ({
			exitCode: 1, stdout: '', stderr: 'x'.repeat(2_500),
		}));
		await expect(adapter.scan({ cwd: checkout, signal: new AbortController().signal }))
			.rejects.toThrow(new RegExp(`x{2000}$`));
	});

	test('forwards runtime cancellation to the project command runner', async () => {
		const checkout = createTestTmpdir('gship-project-diagnostic-cancel-');
		mkdirSync(join(checkout, '.gateship'));
		writeFileSync(join(checkout, '.gateship', 'project.json'), JSON.stringify({
			version: 1, verify: ['bun test'], diagnostic: { command: 'long-running-tool' },
		}));
		let aborted = false;
		const adapter = new ProjectDiagnosticAdapter(async ({ signal }) => await new Promise((_, reject) => {
			signal.addEventListener('abort', () => {
				aborted = true;
				reject(new DOMException('cancelled', 'AbortError'));
			}, { once: true });
		}));
		const runtime = new DiagnosticsRuntime({
			store: new RunStore(':memory:'),
			workspace: {
				prepare: async () => ({ path: checkout, sourceSha: SOURCE_SHA }),
				release: async () => ({ outcome: 'released' as const }),
				listNotices: () => [],
			},
			adapters: [adapter],
			isProjectIdle: () => true, newId: () => 'project-cancelled',
		});
		const scan = runtime.start('project');
		await Bun.sleep(5);
		expect((await runtime.cancel(scan.id)).state).toBe('cancelled');
		expect(aborted).toBe(true);
		runtime.close();
	});
});

describe('diagnostic checkout ownership', () => {
	test('places diagnostic worktrees under explicit state while Git stays rooted in the project', async () => {
		const projectRoot = createTestTmpdir('gship-diagnostic-project-');
		const stateDir = createTestTmpdir('gship-diagnostic-state-');
		const commands: string[][] = [];
		const workspace = new GitDiagnosticWorkspace(projectRoot, async ({ cmd }) => {
			commands.push(cmd);
			if (cmd.includes('rev-parse')) return { exitCode: 0, stdout: `${SOURCE_SHA}\n`, stderr: '' };
			return { exitCode: 0, stdout: '', stderr: '' };
		}, stateDir);

		const lease = await workspace.prepare('external scan', new AbortController().signal);

		expect(lease.path).toBe(join(stateDir, 'diagnostics', 'worktrees', 'external-scan'));
		expect(commands.at(-1)?.slice(0, 3)).toEqual(['git', '-C', projectRoot]);
		expect(existsSync(join(projectRoot, '.gship'))).toBe(false);
	});

	test('refreshes origin/main and creates a detached exact-SHA worktree without a branch', async () => {
		const projectRoot = createTestTmpdir('gship-diagnostic-workspace-');
		const commands: string[][] = [];
		const workspace = new GitDiagnosticWorkspace(projectRoot, async ({ cmd }) => {
			commands.push(cmd);
			if (cmd.includes('rev-parse')) return { exitCode: 0, stdout: `${SOURCE_SHA}\n`, stderr: '' };
			return { exitCode: 0, stdout: '', stderr: '' };
		});

		const lease = await workspace.prepare('scan 1', new AbortController().signal);
		expect(lease.sourceSha).toBe(SOURCE_SHA);
		expect(commands[0]).toContain('fetch');
		expect(commands[0]).toContain('+refs/heads/main:refs/remotes/origin/main');
		expect(commands[1]).toContain('origin/main');
		expect(commands[2]).toEqual([
			'git', '-C', projectRoot, 'worktree', 'add', '--detach', lease.path, SOURCE_SHA,
		]);
		expect(commands.flat()).not.toContain('--force');

		expect(await workspace.release('scan 1', lease.path, lease.sourceSha)).toEqual({ outcome: 'released' });
		expect(commands.at(-1)).toEqual([
			'git', '-C', projectRoot, 'worktree', 'remove', lease.path,
		]);
	});

	test('preserves a checkout an analyzer changed instead of deleting evidence', async () => {
		const projectRoot = createTestTmpdir('gship-diagnostic-dirty-workspace-');
		const commands: string[][] = [];
		const workspace = new GitDiagnosticWorkspace(projectRoot, async ({ cmd }) => {
			commands.push(cmd);
			if (cmd.includes('rev-parse')) return { exitCode: 0, stdout: `${SOURCE_SHA}\n`, stderr: '' };
			if (cmd.includes('status')) return { exitCode: 0, stdout: ' M webui/src/App.tsx\n', stderr: '' };
			return { exitCode: 0, stdout: '', stderr: '' };
		});

		const lease = await workspace.prepare('scan-dirty', new AbortController().signal);
		expect(await workspace.release('scan-dirty', lease.path, lease.sourceSha)).toEqual({
			outcome: 'preserved',
			detail: 'diagnostic analyzer changed its isolated workspace',
		});
		expect(commands.some((command) => command.includes('remove'))).toBe(false);
	});

	test('preserves a clean checkout whose HEAD moved instead of deleting a hidden commit', async () => {
		const projectRoot = createTestTmpdir('gship-diagnostic-moved-head-');
		let resolvedHeads = 0;
		const workspace = new GitDiagnosticWorkspace(projectRoot, async ({ cmd }) => {
			if (cmd.includes('rev-parse')) {
				resolvedHeads += 1;
				return {
					exitCode: 0,
					stdout: `${resolvedHeads === 1 ? SOURCE_SHA : 'c'.repeat(40)}\n`,
					stderr: '',
				};
			}
			return { exitCode: 0, stdout: '', stderr: '' };
		});

		const lease = await workspace.prepare('scan-committed', new AbortController().signal);
		expect(await workspace.release('scan-committed', lease.path, lease.sourceSha)).toEqual({
			outcome: 'preserved',
			detail: 'diagnostic analyzer moved its isolated checkout HEAD',
		});
	});
});

describe('diagnostics runtime and inbox', () => {
	test('runs one overdue schedule only while idle and never catches up missed intervals', async () => {
		const store = new RunStore(':memory:');
		let idle = false;
		let now = '2026-08-20T00:00:00.000Z';
		let nextId = 0;
		const runtime = new DiagnosticsRuntime({
			store,
			workspace: new FakeWorkspace(),
			adapters: [new QueueAdapter([
				{ version: '0.9.12', coverageComplete: true, findings: [] },
				{ version: '0.9.12', coverageComplete: true, findings: [] },
			])],
			isProjectIdle: () => idle,
			newId: () => `scheduled-${++nextId}`,
			now: () => now,
		});

		expect(runtime.runScheduledIfDue()).toBe('disabled');
		expect(runtime.setSchedule({ enabled: true, cadence: 'daily' })).toMatchObject({
			enabled: true,
			overdue: true,
			nextRunAt: now,
		});
		expect(runtime.runScheduledIfDue()).toBe('project-busy');
		expect(store.listDiagnosticScans()).toEqual([]);

		idle = true;
		expect(runtime.runScheduledIfDue()).toBe('started');
		// Creating the scan advances the single due instant immediately, so the
		// minute poll cannot enqueue a duplicate while the scan is still running.
		expect(runtime.runScheduledIfDue()).toBe('not-due');
		await waitForScan(runtime, 'completed');
		expect(runtime.getSchedule()).toMatchObject({
			lastScanAt: '2026-08-20T00:00:00.000Z',
			nextRunAt: '2026-08-21T00:00:00.000Z',
			overdue: false,
		});

		// Missing two daily instants still creates only one new scan when the
		// project becomes idle; there is no per-interval backlog to drain.
		now = '2026-08-23T00:00:00.000Z';
		idle = false;
		expect(runtime.runScheduledIfDue()).toBe('project-busy');
		idle = true;
		expect(runtime.runScheduledIfDue()).toBe('started');
		expect(runtime.runScheduledIfDue()).toBe('not-due');
		await waitForScan(runtime, 'completed');
		expect(store.listDiagnosticScans()).toHaveLength(2);
		expect(runtime.getSchedule()).toMatchObject({
			nextRunAt: '2026-08-24T00:00:00.000Z',
			overdue: false,
		});
		runtime.close();
	});

	test('deduplicates recurrence, clears only on complete coverage and preserves human decisions', async () => {
		const store = new RunStore(':memory:');
		const workspace = new FakeWorkspace();
		let tick = 0;
		const adapter = new QueueAdapter([
			{ version: '0.9.12', coverageComplete: true, findings: [FINDING] },
			{ version: '0.9.12', coverageComplete: false, findings: [] },
			{ version: '0.9.12', coverageComplete: true, findings: [FINDING] },
			{ version: '0.9.12', coverageComplete: true, findings: [] },
			{ version: '0.9.12', coverageComplete: true, findings: [FINDING] },
		]);
		const runtime = new DiagnosticsRuntime({
			store,
			workspace,
			adapters: [adapter],
			isProjectIdle: () => true,
			newId: () => `scan-${tick}`,
			now: () => `2026-08-20T00:00:0${tick++}.000Z`,
		});

		runtime.start();
		await waitForScan(runtime, 'completed');
		const first = runtime.snapshot().findings[0];
		expect(first).toMatchObject({ status: 'pending', occurrenceCount: 1 });

		runtime.start();
		await waitForScan(runtime, 'completed');
		expect(runtime.snapshot().findings).toHaveLength(1);

		runtime.start();
		await waitForScan(runtime, 'completed');
		expect(runtime.snapshot().findings[0]).toMatchObject({ id: first?.id, occurrenceCount: 2 });
		runtime.dismissFinding(first?.id ?? 'missing');

		runtime.start();
		await waitForScan(runtime, 'completed');
		expect(runtime.snapshot().findings).toEqual([]);
		expect(runtime.snapshot().resolvedFindings[0]).toMatchObject({ status: 'dismissed' });

		runtime.start();
		await waitForScan(runtime, 'completed');
		expect(runtime.snapshot().findings).toEqual([]);
		expect(runtime.snapshot().resolvedFindings[0]).toMatchObject({
			status: 'dismissed',
			occurrenceCount: 3,
		});
		expect(runtime.snapshot().stats).toEqual({
			total: 1,
			pending: 0,
			dismissed: 1,
			promoted: 0,
			cleared: 0,
			recurring: 1,
		});
		expect(workspace.releases).toBe(5);
		runtime.close();
	});

	test('refuses to compete with project work and owns cancellation and timeout', async () => {
		const busy = new DiagnosticsRuntime({
			store: new RunStore(':memory:'),
			workspace: new FakeWorkspace(),
			adapters: [new QueueAdapter([])],
			isProjectIdle: () => false,
		});
		expect(() => busy.start()).toThrow(DiagnosticRuntimeError);
		busy.close();

		const blockingAdapter: DiagnosticAdapter = {
			id: 'react',
			label: 'React',
			version: '0.9.12',
			description: 'React diagnostics',
			scan: ({ signal }) => new Promise((_, reject) => {
				const abort = (): void => reject(new DOMException('aborted', 'AbortError'));
				if (signal.aborted) abort();
				else signal.addEventListener('abort', abort, { once: true });
			}),
		};
		const cancelled = new DiagnosticsRuntime({
			store: new RunStore(':memory:'),
			workspace: new FakeWorkspace(),
			adapters: [blockingAdapter],
			isProjectIdle: () => true,
			newId: () => 'cancelled-scan',
		});
		const scan = cancelled.start();
		await Bun.sleep(5);
		expect((await cancelled.cancel(scan.id)).state).toBe('cancelled');
		cancelled.close();

		const timedOut = new DiagnosticsRuntime({
			store: new RunStore(':memory:'),
			workspace: new FakeWorkspace(),
			adapters: [blockingAdapter],
			isProjectIdle: () => true,
			newId: () => 'timeout-scan',
			scanTimeoutMs: 5,
		});
		timedOut.start();
		await waitForScan(timedOut, 'failed');
		expect(timedOut.snapshot().scan?.error).toContain('exceeded 1 seconds');
		timedOut.close();
	});
});
