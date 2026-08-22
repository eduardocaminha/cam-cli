import { describe, expect, test } from 'bun:test';

import { openProjectRegistry } from '../../src/runtime/project-registry.ts';
import {
	ProjectRuntimeLookupError,
	ProjectRuntimeManager,
} from '../../src/runtime/project-runtime-manager.ts';
import { RuntimeConflictError } from '../../src/runtime/run-runtime.ts';
import type { RunRecord } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function ready(name: string) {
	return {
		state: 'ready' as const,
		name,
		repository: `acme/${name}`,
		remoteUrl: `git@github.com:acme/${name}.git`,
		sourceRef: 'origin/main' as const,
	};
}

function run(id: string, state: RunRecord['state'] = 'interrupted'): RunRecord {
	return {
		id,
		issueId: 'GSHIP-1',
		sessionId: `session-${id}`,
		providerId: 'codex',
		state,
		fixRounds: 0,
		workspacePath: `/tmp/${id}`,
		createdAt: '2026-08-22T10:00:00.000Z',
		updatedAt: '2026-08-22T10:00:00.000Z',
		summary: null,
		error: null,
	};
}

describe('ProjectRuntimeManager', () => {
	test('composes a ready project once and closes every composed context', async () => {
		const currentRoot = createTestTmpdir('gship-runtime-manager-current-');
		const targetRoot = createTestTmpdir('gship-runtime-manager-target-');
		const registry = openProjectRegistry(createTestTmpdir('gship-runtime-manager-home-'));
		const target = registry.reconcile({
			root: targetRoot,
			stateDir: createTestTmpdir('gship-runtime-manager-state-'),
			readiness: ready('target'),
		});
		let composed = 0;
		let closed = 0;
		const manager = new ProjectRuntimeManager(registry, currentRoot, () => {
			composed += 1;
			return {
				runtime: { listRuns: () => [] },
				close: () => { closed += 1; },
			};
		});

		expect(manager.get(target.id).context).toBe(manager.get(target.id).context);
		expect(composed).toBe(1);
		await manager.close();
		expect(closed).toBe(1);
		registry.close();
	});

	test('distinguishes unknown and not-ready registrations before composition', () => {
		const currentRoot = createTestTmpdir('gship-runtime-manager-guard-current-');
		const registry = openProjectRegistry(createTestTmpdir('gship-runtime-manager-guard-home-'));
		const target = registry.reconcile({
			root: createTestTmpdir('gship-runtime-manager-guard-target-'),
			stateDir: createTestTmpdir('gship-runtime-manager-guard-state-'),
			readiness: { state: 'empty', name: 'target', detail: 'empty' },
		});
		const manager = new ProjectRuntimeManager(registry, currentRoot, () => {
			throw new Error('must not compose');
		});

		expect(() => manager.get('unknown')).toThrow(ProjectRuntimeLookupError);
		try {
			manager.get(target.id);
			throw new Error('expected project-not-ready');
		} catch (error) {
			expect(error).toMatchObject({ code: 'project-not-ready', status: 409 });
		}
		registry.close();
	});

	test('admits only the sole global non-terminal run for resume', () => {
		const firstRoot = createTestTmpdir('gship-runtime-manager-first-');
		const secondRoot = createTestTmpdir('gship-runtime-manager-second-');
		const registry = openProjectRegistry(createTestTmpdir('gship-runtime-manager-admission-home-'));
		const first = registry.reconcile({
			root: firstRoot,
			stateDir: createTestTmpdir('gship-runtime-manager-first-state-'),
			readiness: ready('first'),
		});
		const second = registry.reconcile({
			root: secondRoot,
			stateDir: createTestTmpdir('gship-runtime-manager-second-state-'),
			readiness: ready('second'),
		});
		const runs = new Map<string, RunRecord[]>([[first.id, [run('run-first')]], [second.id, []]]);
		const manager = new ProjectRuntimeManager(registry, firstRoot, (project) => ({
			runtime: { listRuns: () => runs.get(project.id) ?? [] },
			close: () => undefined,
		}));

		expect(() => manager.admitStart(second.id)).toThrow(RuntimeConflictError);
		expect(manager.admitResume(first.id, 'run-first')).toBeDefined();
		expect(() => manager.admitResume(second.id, 'run-second')).toThrow(RuntimeConflictError);
		registry.close();
	});
});
