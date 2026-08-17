import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { PROPOSAL_LIMITS } from '../../src/runtime/run-proposal.ts';
import { PROJECT_BRIEF_LIMITS, RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const EMPTY_BRIEF = { objective: '', decisions: [], constraints: [], openItems: [] };

function storeWithRun(id: string, issueId: string): RunStore {
	const store = new RunStore(':memory:');
	store.createRun({
		id,
		issueId,
		sessionId: `session-${id}`,
		workspacePath: `/workspaces/${id}`,
		createdAt: '2026-08-16T22:00:00.000Z',
	});
	return store;
}

describe('run store workspace migration', () => {
	test('adds workspace_path to a CAM-574 database without losing existing runs', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-migrate-'), 'runtime.sqlite');
		const legacy = new Database(dbPath, { create: true });
		legacy.exec(`
			CREATE TABLE runs (
				id TEXT PRIMARY KEY,
				issue_id TEXT NOT NULL,
				session_id TEXT,
				state TEXT NOT NULL,
				fix_rounds INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				summary TEXT,
				error TEXT
			);
			INSERT INTO runs (
				id, issue_id, session_id, state, fix_rounds, created_at, updated_at
			) VALUES (
				'legacy-run', 'CAM-574', 'legacy-session', 'interrupted', 0,
				'2026-08-15T10:00:00Z', '2026-08-15T10:01:00Z'
			);
		`);
		legacy.close();

		const migrated = new RunStore(dbPath);
		expect(migrated.getRun('legacy-run')).toMatchObject({
			issueId: 'CAM-574',
			sessionId: 'legacy-session',
			providerId: 'claude',
			workspacePath: '',
			state: 'interrupted',
		});
		migrated.createRun({
			id: 'new-run',
			issueId: 'CAM-576',
			sessionId: 'new-session',
			workspacePath: '/project/.gship/worktrees/new-run',
			createdAt: '2026-08-15T11:00:00Z',
		});
		expect(migrated.getRun('new-run')?.workspacePath).toBe(
			'/project/.gship/worktrees/new-run',
		);
		expect(migrated.getSelectedProvider()).toBe('claude');
		migrated.setSelectedProvider('codex');
		expect(migrated.getSelectedProvider()).toBe('codex');
		migrated.createRun({
			id: 'codex-run',
			issueId: 'CAM-577',
			sessionId: 'provisional',
			providerId: 'codex',
			workspacePath: '/project/.gship/worktrees/codex-run',
			createdAt: '2026-08-15T12:00:00Z',
		});
		expect(migrated.getRun('codex-run')?.providerId).toBe('codex');
		migrated.close();
	});
});

// GSHIP-612: ideas the executor finds outside its issue are kept as evidence,
// without touching the run that produced them.
describe('derived proposals', () => {
	test('stores each idea as a pending derived-from record with a stable id', () => {
		const store = storeWithRun('run-proposals', 'CAM-40');

		const captured = store.recordProposals({
			runId: 'run-proposals',
			issueId: 'CAM-40',
			proposals: [
				{ title: 'Extrair o parser de eventos', evidence: 'Duplicado em dois adaptadores.' },
				{ title: 'Cobrir o caminho de erro do shipper', evidence: 'Sem teste para retry.' },
			],
			createdAt: '2026-08-16T22:10:00.000Z',
		});

		expect(captured).toEqual([
			{
				id: 'run-proposals-proposal-1',
				relationship: 'derived-from',
				status: 'pending',
				sourceRunId: 'run-proposals',
				sourceIssueId: 'CAM-40',
				title: 'Extrair o parser de eventos',
				evidence: 'Duplicado em dois adaptadores.',
				createdAt: '2026-08-16T22:10:00.000Z',
				updatedAt: '2026-08-16T22:10:00.000Z',
			},
			{
				id: 'run-proposals-proposal-2',
				relationship: 'derived-from',
				status: 'pending',
				sourceRunId: 'run-proposals',
				sourceIssueId: 'CAM-40',
				title: 'Cobrir o caminho de erro do shipper',
				evidence: 'Sem teste para retry.',
				createdAt: '2026-08-16T22:10:00.000Z',
				updatedAt: '2026-08-16T22:10:00.000Z',
			},
		]);
		// The read is deterministic: same order, same ids, no run state touched.
		expect(store.listProposals()).toEqual(captured);
		expect(store.getRun('run-proposals')).toMatchObject({ state: 'queued', fixRounds: 0 });
		expect(store.listRunEvents('run-proposals').map((event) => event.kind)).toEqual([
			'run.created',
		]);
		store.close();
	});

	test('a later capture on the same run continues the id sequence', () => {
		const store = storeWithRun('run-second', 'CAM-41');
		store.recordProposals({
			runId: 'run-second',
			issueId: 'CAM-41',
			proposals: [{ title: 'Primeira ideia', evidence: 'Vista na primeira passagem.' }],
			createdAt: '2026-08-16T22:10:00.000Z',
		});

		const second = store.recordProposals({
			runId: 'run-second',
			issueId: 'CAM-41',
			proposals: [{ title: 'Segunda ideia', evidence: 'Vista na rodada de correção.' }],
			createdAt: '2026-08-16T22:20:00.000Z',
		});

		expect(second.map((proposal) => proposal.id)).toEqual(['run-second-proposal-2']);
		expect(store.listProposals().map((proposal) => proposal.title)).toEqual([
			'Primeira ideia',
			'Segunda ideia',
		]);
		store.close();
	});

	test('drops unusable items and clamps the rest instead of failing the run', () => {
		const store = storeWithRun('run-noisy', 'CAM-42');

		const captured = store.recordProposals({
			runId: 'run-noisy',
			issueId: 'CAM-42',
			proposals: [
				{ title: '   ', evidence: 'Sem título.' },
				{ title: 'Sem evidência', evidence: '  ' },
				{ title: 't'.repeat(PROPOSAL_LIMITS.title + 40), evidence: 'e'.repeat(PROPOSAL_LIMITS.evidence + 40) },
				{ title: 'Ideia 2', evidence: 'Evidência 2.' },
				{ title: 'Ideia 3', evidence: 'Evidência 3.' },
				{ title: 'Ideia 4', evidence: 'Evidência 4.' },
			],
			createdAt: '2026-08-16T22:30:00.000Z',
		});

		expect(captured).toHaveLength(PROPOSAL_LIMITS.maxItems);
		expect(captured[0]?.title).toHaveLength(PROPOSAL_LIMITS.title);
		expect(captured[0]?.evidence).toHaveLength(PROPOSAL_LIMITS.evidence);
		expect(captured.slice(1).map((proposal) => proposal.title)).toEqual(['Ideia 2', 'Ideia 3']);
		expect(store.recordProposals({
			runId: 'run-noisy',
			issueId: 'CAM-42',
			proposals: [],
			createdAt: '2026-08-16T22:31:00.000Z',
		})).toEqual([]);
		store.close();
	});
});

describe('project brief', () => {
	test('round-trips the four fields as a single overwritten record', () => {
		const store = new RunStore(':memory:');
		expect(store.getProjectBrief()).toEqual(EMPTY_BRIEF);

		const brief = {
			objective: 'Manter o brief do produto sob controle do operador.',
			decisions: ['O brief é um registro único, não um histórico.'],
			constraints: ['Nenhum turno do orquestrador escreve o brief.'],
			openItems: ['Construir o editor web na fatia 2.'],
		};
		store.setProjectBrief(brief, '2026-08-16T21:00:00.000Z');
		expect(store.getProjectBrief()).toEqual(brief);

		const rewritten = { ...brief, objective: 'Objetivo substituído.', openItems: [] };
		store.setProjectBrief(rewritten, '2026-08-16T21:05:00.000Z');
		expect(store.getProjectBrief()).toEqual(rewritten);
		store.close();
	});

	test('a corrupt row reads as the empty brief instead of throwing', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-brief-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		store.setProjectBrief(
			{ objective: 'Será corrompido.', decisions: [], constraints: [], openItems: [] },
			'2026-08-16T21:00:00.000Z',
		);
		store.close();

		const corrupted = new Database(dbPath);
		corrupted.exec("UPDATE project_brief SET brief_json = '{not json' WHERE id = 1;");
		corrupted.close();

		const reopened = new RunStore(dbPath);
		expect(reopened.getProjectBrief()).toEqual(EMPTY_BRIEF);
		reopened.close();
	});

	test('a row that parses into the wrong shape still reads as the empty brief', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-brief-shape-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		store.setProjectBrief(
			{ objective: 'Será substituído por uma lista.', decisions: [], constraints: [], openItems: [] },
			'2026-08-16T21:00:00.000Z',
		);
		store.close();

		const corrupted = new Database(dbPath);
		corrupted.exec("UPDATE project_brief SET brief_json = '[1, 2, 3]' WHERE id = 1;");
		corrupted.close();

		const reopened = new RunStore(dbPath);
		expect(reopened.getProjectBrief()).toEqual(EMPTY_BRIEF);
		reopened.close();
	});

	test('the write clamps the objective, the list length, and each item', () => {
		const store = new RunStore(':memory:');
		store.setProjectBrief({
			objective: 'o'.repeat(PROJECT_BRIEF_LIMITS.objective + 50),
			decisions: Array.from(
				{ length: PROJECT_BRIEF_LIMITS.listItems + 5 },
				(_, index) => `decisão ${index}`,
			),
			constraints: ['c'.repeat(PROJECT_BRIEF_LIMITS.itemLength + 20)],
			openItems: ['   ', '', 'Item que sobrevive.'],
		}, '2026-08-16T21:10:00.000Z');

		const stored = store.getProjectBrief();
		expect(stored.objective).toHaveLength(PROJECT_BRIEF_LIMITS.objective);
		expect(stored.decisions).toHaveLength(PROJECT_BRIEF_LIMITS.listItems);
		expect(stored.decisions.at(-1)).toBe(`decisão ${PROJECT_BRIEF_LIMITS.listItems - 1}`);
		expect(stored.constraints[0]).toHaveLength(PROJECT_BRIEF_LIMITS.itemLength);
		expect(stored.openItems).toEqual(['Item que sobrevive.']);
		store.close();
	});
});
