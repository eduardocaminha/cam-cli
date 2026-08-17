import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { emptyModelSettings } from '../../src/runtime/model-settings.ts';
import { PROPOSAL_LIMITS, ProposalTransitionError } from '../../src/runtime/run-proposal.ts';
import { PROJECT_BRIEF_LIMITS, RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const EMPTY_BRIEF = { objective: '', decisions: [], constraints: [], openItems: [] };
const EMPTY_MODEL_SETTINGS = emptyModelSettings();

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
				promotedIssueId: null,
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
				promotedIssueId: null,
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

// GSHIP-613: the operator settles each captured proposal exactly once, and
// neither decision reaches the run, the issue or the approval.
describe('proposal decisions', () => {
	function storeWithProposals(): RunStore {
		const store = storeWithRun('run-inbox', 'CAM-50');
		store.recordProposals({
			runId: 'run-inbox',
			issueId: 'CAM-50',
			proposals: [
				{ title: 'Descartável', evidence: 'Já resolvido em outro lugar.' },
				{ title: 'Promovível', evidence: 'Sem cobertura no caminho de erro.' },
			],
			createdAt: '2026-08-16T22:10:00.000Z',
		});
		return store;
	}

	test('a dismissed proposal leaves the inbox and refuses a second decision', () => {
		const store = storeWithProposals();

		const dismissed = store.dismissProposal('run-inbox-proposal-1', '2026-08-16T23:00:00.000Z');
		expect(dismissed).toMatchObject({
			id: 'run-inbox-proposal-1',
			status: 'dismissed',
			promotedIssueId: null,
			updatedAt: '2026-08-16T23:00:00.000Z',
		});
		// Durable, but settled: the record stays readable and leaves the inbox.
		expect(store.getProposal('run-inbox-proposal-1')).toEqual(dismissed);
		expect(store.listPendingProposals().map((proposal) => proposal.id))
			.toEqual(['run-inbox-proposal-2']);
		expect(store.listProposals()).toHaveLength(2);

		for (const second of [
			() => store.dismissProposal('run-inbox-proposal-1', '2026-08-16T23:05:00.000Z'),
			() => store.promoteProposal('run-inbox-proposal-1', 'CAM-90', '2026-08-16T23:05:00.000Z'),
		]) {
			expect(second).toThrow(ProposalTransitionError);
			try {
				second();
			} catch (error) {
				expect((error as ProposalTransitionError).code).toBe('proposal-not-pending');
				expect((error as ProposalTransitionError).status).toBe(409);
			}
		}
		// The refused decisions changed nothing.
		expect(store.getProposal('run-inbox-proposal-1')).toEqual(dismissed);
		// The run that produced the proposals is untouched by either decision.
		expect(store.getRun('run-inbox')).toMatchObject({ state: 'queued', fixRounds: 0 });
		expect(store.listRunEvents('run-inbox').map((event) => event.kind)).toEqual(['run.created']);
		store.close();
	});

	test('a promoted proposal keeps the issue it became and refuses to move again', () => {
		const store = storeWithProposals();

		const promoted = store.promoteProposal(
			'run-inbox-proposal-2',
			'CAM-91',
			'2026-08-16T23:10:00.000Z',
		);
		expect(promoted).toMatchObject({
			id: 'run-inbox-proposal-2',
			status: 'promoted',
			promotedIssueId: 'CAM-91',
			title: 'Promovível',
			evidence: 'Sem cobertura no caminho de erro.',
			updatedAt: '2026-08-16T23:10:00.000Z',
		});
		expect(store.listPendingProposals().map((proposal) => proposal.id))
			.toEqual(['run-inbox-proposal-1']);

		expect(() => store.promoteProposal('run-inbox-proposal-2', 'CAM-92', '2026-08-16T23:11:00.000Z'))
			.toThrow(ProposalTransitionError);
		expect(store.getProposal('run-inbox-proposal-2')?.promotedIssueId).toBe('CAM-91');
		// A promotion without a filed issue is a programming error, not a status.
		expect(() => store.promoteProposal('run-inbox-proposal-1', '  ', '2026-08-16T23:12:00.000Z'))
			.toThrow('promoted issueId is required');
		expect(store.getProposal('run-inbox-proposal-1')?.status).toBe('pending');
		store.close();
	});

	test('an unknown proposal is refused as missing, not as settled', () => {
		const store = storeWithProposals();
		for (const decide of [
			() => store.dismissProposal('run-inbox-proposal-9', '2026-08-16T23:20:00.000Z'),
			() => store.promoteProposal('run-inbox-proposal-9', 'CAM-93', '2026-08-16T23:20:00.000Z'),
		]) {
			try {
				decide();
				throw new Error('unreachable');
			} catch (error) {
				expect(error).toBeInstanceOf(ProposalTransitionError);
				expect((error as ProposalTransitionError).code).toBe('proposal-not-found');
				expect((error as ProposalTransitionError).status).toBe(404);
			}
		}
		expect(store.getProposal('run-inbox-proposal-9')).toBeNull();
		store.close();
	});

	test('a GSHIP-612 database gains the promoted column without losing its proposals', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-proposals-'), 'runtime.sqlite');
		const legacy = new Database(dbPath, { create: true });
		legacy.exec(`
			CREATE TABLE runs (
				id TEXT PRIMARY KEY,
				issue_id TEXT NOT NULL,
				session_id TEXT,
				provider_id TEXT,
				workspace_path TEXT,
				state TEXT NOT NULL,
				fix_rounds INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				summary TEXT,
				error TEXT
			);
			CREATE TABLE run_proposals (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				issue_id TEXT NOT NULL,
				relationship TEXT NOT NULL,
				status TEXT NOT NULL,
				title TEXT NOT NULL,
				evidence TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			INSERT INTO runs (
				id, issue_id, session_id, state, fix_rounds, created_at, updated_at
			) VALUES (
				'legacy-run', 'CAM-612', 'legacy-session', 'done', 0,
				'2026-08-16T10:00:00Z', '2026-08-16T10:01:00Z'
			);
			INSERT INTO run_proposals (
				id, run_id, issue_id, relationship, status, title, evidence, created_at, updated_at
			) VALUES (
				'legacy-run-proposal-1', 'legacy-run', 'CAM-612', 'derived-from', 'pending',
				'Ideia capturada antes da caixa de entrada', 'Vista na implementação da etapa 4A.',
				'2026-08-16T10:01:00Z', '2026-08-16T10:01:00Z'
			);
		`);
		legacy.close();

		const migrated = new RunStore(dbPath);
		expect(migrated.getProposal('legacy-run-proposal-1')).toMatchObject({
			status: 'pending',
			relationship: 'derived-from',
			promotedIssueId: null,
			sourceRunId: 'legacy-run',
			sourceIssueId: 'CAM-612',
		});
		expect(migrated.promoteProposal('legacy-run-proposal-1', 'CAM-613', '2026-08-17T02:00:00Z'))
			.toMatchObject({ status: 'promoted', promotedIssueId: 'CAM-613' });
		expect(migrated.listPendingProposals()).toEqual([]);
		migrated.close();
	});
});

// GSHIP-617: the per-role model choice is one JSON row in runtime_settings,
// beside the selected provider, and never a new table or column.
describe('per-role model settings', () => {
	test('round-trips one slot per provider and role in a single settings row', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-models-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		expect(store.getModelSettings()).toEqual(EMPTY_MODEL_SETTINGS);

		store.setModelSettings({
			claude: {
				orchestrator: { model: 'sonnet' },
				executor: { model: 'opus', effort: 'xhigh' },
				reviewer: { effort: 'high' },
			},
			codex: {
				orchestrator: {},
				executor: { model: 'gpt-5-codex' },
				reviewer: {},
			},
		});
		expect(store.getModelSettings()).toEqual({
			claude: {
				orchestrator: { model: 'sonnet' },
				executor: { model: 'opus', effort: 'xhigh' },
				reviewer: { effort: 'high' },
			},
			codex: { orchestrator: {}, executor: { model: 'gpt-5-codex' }, reviewer: {} },
		});
		// The provider selection is a sibling row, so neither write disturbs the other.
		store.setSelectedProvider('codex');
		expect(store.getSelectedProvider()).toBe('codex');
		expect(store.getModelSettings().claude.executor).toEqual({ model: 'opus', effort: 'xhigh' });
		store.close();

		const rows = new Database(dbPath);
		const stored = rows.query('SELECT key, value FROM runtime_settings ORDER BY key')
			.all() as Array<{ key: string; value: string }>;
		expect(stored.map((row) => row.key)).toEqual(['model-settings', 'provider']);
		expect(JSON.parse(stored[0]?.value ?? 'null')).toMatchObject({
			claude: { executor: { model: 'opus', effort: 'xhigh' } },
		});
		rows.close();
	});

	test('a corrupt or wrongly shaped row reads as no choice at all', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-models-corrupt-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		store.setModelSettings({
			claude: { orchestrator: {}, executor: { model: 'opus' }, reviewer: {} },
			codex: { orchestrator: {}, executor: {}, reviewer: {} },
		});
		store.close();

		const corrupted = new Database(dbPath);
		corrupted.exec("UPDATE runtime_settings SET value = '{not json' WHERE key = 'model-settings';");
		corrupted.close();
		const reopened = new RunStore(dbPath);
		expect(reopened.getModelSettings()).toEqual(EMPTY_MODEL_SETTINGS);
		reopened.close();

		const reshaped = new Database(dbPath);
		reshaped.exec("UPDATE runtime_settings SET value = '[1,2]' WHERE key = 'model-settings';");
		reshaped.close();
		const rereopened = new RunStore(dbPath);
		expect(rereopened.getModelSettings()).toEqual(EMPTY_MODEL_SETTINGS);
		rereopened.close();
	});

	test('a value argv could not carry is dropped on read instead of stored', () => {
		const store = new RunStore(':memory:');
		store.setModelSettings({
			claude: {
				orchestrator: { model: '  sonnet  ' },
				executor: { model: 'two words', effort: '   ' },
				reviewer: {},
			},
			codex: { orchestrator: {}, executor: {}, reviewer: {} },
		});

		expect(store.getModelSettings().claude).toEqual({
			orchestrator: { model: 'sonnet' },
			executor: {},
			reviewer: {},
		});
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
