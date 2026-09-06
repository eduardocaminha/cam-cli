import { describe, expect, test } from 'bun:test';

import type { RegisteredProject } from '../../src/runtime/project-registry.ts';
import { readRunOverview } from '../../src/runtime/run-overview.ts';
import type { PersistedRunHistory } from '../../src/runtime/run-store.ts';

function project(id: string, name = id): RegisteredProject {
	return {
		id, name, root: `/safe/${id}`, stateDir: `/safe/${id}/.gship`, readiness: 'ready',
		repository: `acme/${id}`, current: false,
	};
}

function history(id: string, updatedAt: string, providerId: 'claude' | 'codex' = 'claude'): PersistedRunHistory {
	const run = {
		id, issueId: `GSHIP-${id}`, sessionId: id, providerId, workspacePath: '/private/workspace',
		state: 'done' as const, fixRounds: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt,
		summary: null, error: null,
	};
	return {
		run,
		events: [],
		evaluation: {
		workflowRevision: null, provider: providerId, outcome: 'shipped', wallTimeMs: 1,
		attentionRequests: 0, operatorInterventions: 0, providerHolds: 0, roles: [],
	},
		cost: { totalCostUsd: null, breakdown: [], roles: [] },
	};
}

describe('readRunOverview', () => {
	test('agrega, filtra e ordena com desempate estável antes de paginar', () => {
		const data: Record<string, PersistedRunHistory[]> = {
			'/safe/one/.gship/runtime.sqlite': [history('z', '2026-09-02T00:00:00.000Z')],
			'/safe/two/.gship/runtime.sqlite': [history('a', '2026-09-02T00:00:00.000Z', 'codex')],
		};
		const result = readRunOverview([project('two'), project('one')], {
			providerId: 'codex', limit: 1, offset: 0,
		}, { readHistory: (path) => data[path] ?? [] });
		expect(result.runs.map((run) => run.runId)).toEqual(['a']);
		expect(result.page).toEqual({ limit: 1, offset: 0, returned: 1, total: 1 });
		expect(result.runs[0]?.repository).toBe('acme/two');
	});

	test('mantém resultados e identifica projeto indisponível sem expor path', () => {
		const result = readRunOverview([project('good'), project('bad', 'Projeto indisponível')], {}, {
			readHistory: (path) => {
				if (path.includes('/bad/')) throw new Error('/private/secret/runtime.sqlite');
				return [history('good-run', '2026-09-03T00:00:00.000Z')];
			},
		});
		expect(result.runs).toHaveLength(1);
		expect(result.errors).toEqual([{
			projectId: 'bad', projectName: 'Projeto indisponível', code: 'project-unavailable',
			message: 'Project runs are unavailable.',
		}]);
		expect(JSON.stringify(result)).not.toContain('private');
	});
});
