import { describe, expect, test } from 'bun:test';

import { startWebServer } from '../../src/commands/web.ts';
import type {
	DiagnosticAdapter,
	DiagnosticsSnapshot,
	DiagnosticWorkspace,
} from '../../src/runtime/diagnostics.ts';
import { DiagnosticsRuntime } from '../../src/runtime/diagnostics.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const SOURCE_SHA = 'b'.repeat(40);

function diagnosticHarness() {
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
		store: new RunStore(':memory:'),
		workspace,
		adapters: [adapter],
		isProjectIdle: () => true,
		newId: () => 'scan-api',
		now: () => '2026-08-20T12:00:00.000Z',
	});
	const intakeCalls: Array<{ input: unknown; approve: boolean | undefined }> = [];
	const handle = startWebServer({
		port: 0,
		cwd: createTestTmpdir('gship-diagnostics-api-'),
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
});
