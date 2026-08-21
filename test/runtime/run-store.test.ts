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

// GSHIP-627: separates ephemeral provider/review stream chatter from durable
// decisions in the event log, so a derived read no longer depends on the same
// display-bounded window the screen uses.
describe('run event class migration', () => {
	test('classifies rows written before the column existed once, by kind suffix', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-event-class-'), 'runtime.sqlite');
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
			CREATE TABLE run_events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				from_state TEXT,
				to_state TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			INSERT INTO runs (
				id, issue_id, session_id, provider_id, workspace_path, state, fix_rounds, created_at, updated_at
			) VALUES (
				'legacy-run', 'CAM-70', 'legacy-session', 'claude', '/workspaces/legacy-run',
				'done', 0, '2026-08-10T10:00:00Z', '2026-08-10T10:05:00Z'
			);
			INSERT INTO run_events (run_id, kind, from_state, to_state, payload_json, created_at) VALUES
				('legacy-run', 'run.created', NULL, 'queued', '{}', '2026-08-10T10:00:00Z'),
				('legacy-run', 'provider.system', 'queued', 'queued', '{}', '2026-08-10T10:00:01Z'),
				('legacy-run', 'provider.activity', 'queued', 'queued', '{}', '2026-08-10T10:00:02Z'),
				('legacy-run', 'review.system', 'queued', 'queued', '{}', '2026-08-10T10:00:03Z'),
				('legacy-run', 'review.activity', 'queued', 'queued', '{}', '2026-08-10T10:00:04Z'),
				('legacy-run', 'run.verified', 'queued', 'ready-to-ship', '{}', '2026-08-10T10:00:05Z');
		`);
		legacy.close();

		const migrated = new RunStore(dbPath);
		expect(migrated.listRunEvents('legacy-run').map((event) => ({
			kind: event.kind,
			eventClass: event.eventClass,
		}))).toEqual([
			{ kind: 'run.created', eventClass: 'decision' },
			{ kind: 'provider.system', eventClass: 'activity' },
			{ kind: 'provider.activity', eventClass: 'activity' },
			{ kind: 'review.system', eventClass: 'activity' },
			{ kind: 'review.activity', eventClass: 'activity' },
			{ kind: 'run.verified', eventClass: 'decision' },
		]);
		migrated.close();
	});
});

describe('run event class', () => {
	test('createRun and transition always record a decision, regardless of kind', () => {
		const store = new RunStore(':memory:');
		const { event: created } = store.createRun({
			id: 'run-class',
			issueId: 'CAM-71',
			sessionId: 'session-class',
			workspacePath: '/workspaces/run-class',
			createdAt: '2026-08-17T09:00:00.000Z',
		});
		expect(created.eventClass).toBe('decision');

		const { event: transitioned } = store.transition({
			runId: 'run-class',
			toState: 'working',
			kind: 'run.started',
			createdAt: '2026-08-17T09:00:01.000Z',
		});
		expect(transitioned.eventClass).toBe('decision');
		store.close();
	});

	test('appendEvent records the class its caller declares, and defaults an undeclared kind to decision', () => {
		const store = storeWithRun('run-class-append', 'CAM-72');

		const activity = store.appendEvent({
			runId: 'run-class-append',
			kind: 'provider.activity',
			createdAt: '2026-08-17T09:00:02.000Z',
			eventClass: 'activity',
		});
		expect(activity.eventClass).toBe('activity');

		// A kind nobody declared a class for -- new or forgotten -- must fail open
		// into the derived read rather than silently vanish from it.
		const undeclared = store.appendEvent({
			runId: 'run-class-append',
			kind: 'some.brand-new.kind',
			createdAt: '2026-08-17T09:00:03.000Z',
		});
		expect(undeclared.eventClass).toBe('decision');
		store.close();
	});

	test('the live read stays limited while the derived read returns every decision', () => {
		const store = storeWithRun('run-class-reads', 'CAM-73');
		const total = 210;
		for (let index = 0; index < total; index += 1) {
			store.appendEvent({
				runId: 'run-class-reads',
				kind: 'provider.activity',
				createdAt: '2026-08-17T09:00:00.000Z',
				eventClass: 'activity',
			});
			store.appendEvent({
				runId: 'run-class-reads',
				kind: 'run.operator-note',
				createdAt: '2026-08-17T09:00:00.000Z',
			});
		}

		// Live read: still capped at its historical default -- it serves the
		// screen, unaffected by this change.
		expect(store.listRunEvents('run-class-reads').length).toBe(200);

		// Derived read: every decision event, including the ones the window
		// above already dropped -- plus the run.created event createRun wrote.
		const decisions = store.listRunDecisionEvents('run-class-reads');
		expect(decisions.length).toBe(total + 1);
		expect(decisions.every((event) => event.eventClass === 'decision')).toBe(true);
		expect(decisions.some((event) => event.kind === 'run.operator-note')).toBe(true);
		expect(decisions.some((event) => event.kind === 'provider.activity')).toBe(false);
		store.close();
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

	// GSHIP-643: the operator can read what a settled proposal became, without
	// that history ever competing with the pending inbox above.
	test('resolved proposals are read newest-decided-first, distinct from the pending inbox', () => {
		const store = storeWithProposals();
		// Captured in order -1, -2 (storeWithProposals), but decided in the
		// opposite order: -2 first, -1 last. Newest-*decided*-first must read
		// -1 on top despite it having the lower capture sequence, or this would
		// pass just as well sorted by capture order alone.
		store.promoteProposal('run-inbox-proposal-2', 'CAM-91', '2026-08-16T23:00:00.000Z');
		store.dismissProposal('run-inbox-proposal-1', '2026-08-16T23:10:00.000Z');

		const { proposals, omittedCount } = store.listResolvedProposals();
		expect(proposals.map((proposal) => proposal.id)).toEqual([
			'run-inbox-proposal-1',
			'run-inbox-proposal-2',
		]);
		expect(omittedCount).toBe(0);
		expect(proposals[0]).toMatchObject({ status: 'dismissed', promotedIssueId: null });
		expect(proposals[1]).toMatchObject({ status: 'promoted', promotedIssueId: 'CAM-91' });
		// The pending inbox this run started with is now empty: neither decision
		// leaves anything behind for it to compete with.
		expect(store.listPendingProposals()).toEqual([]);
		store.close();
	});

	test('a resolved history beyond the limit reports how many were left out', () => {
		const store = storeWithProposals();
		store.dismissProposal('run-inbox-proposal-1', '2026-08-16T23:00:00.000Z');
		store.promoteProposal('run-inbox-proposal-2', 'CAM-91', '2026-08-16T23:10:00.000Z');

		const { proposals, omittedCount } = store.listResolvedProposals(1);
		expect(proposals.map((proposal) => proposal.id)).toEqual(['run-inbox-proposal-2']);
		expect(omittedCount).toBe(1);
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

// GSHIP-638: the chain switch is off by default and survives a restart, kept
// beside the provider and the per-role model slots in `runtime_settings`.
describe('chain runs switch', () => {
	test('is off by default and round-trips through the same store', () => {
		const store = new RunStore(':memory:');
		expect(store.getChainRunsEnabled()).toBe(false);

		store.setChainRunsEnabled(true);
		expect(store.getChainRunsEnabled()).toBe(true);

		store.setChainRunsEnabled(false);
		expect(store.getChainRunsEnabled()).toBe(false);
		store.close();
	});

	test('survives a service restart, as its own runtime_settings row', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-chain-runs-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		store.setChainRunsEnabled(true);
		store.close();

		const reopened = new RunStore(dbPath);
		expect(reopened.getChainRunsEnabled()).toBe(true);
		reopened.close();

		const rows = new Database(dbPath);
		const stored = rows.query('SELECT key, value FROM runtime_settings ORDER BY key')
			.all() as Array<{ key: string; value: string }>;
		expect(stored).toContainEqual({ key: 'chain-runs', value: 'true' });
		rows.close();
	});
});

describe('diagnostic schedule settings', () => {
	test('is off by default and survives a restart as one normalized settings row', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-diagnostic-schedule-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		expect(store.getDiagnosticSchedule()).toEqual({
			enabled: false,
			analyzer: 'react',
			cadence: 'weekly',
		});
		store.setDiagnosticSchedule({ enabled: true, analyzer: 'react', cadence: 'daily' });
		store.close();

		const reopened = new RunStore(dbPath);
		expect(reopened.getDiagnosticSchedule()).toEqual({
			enabled: true,
			analyzer: 'react',
			cadence: 'daily',
		});
		reopened.close();

		const rows = new Database(dbPath);
		expect(rows.query("SELECT value FROM runtime_settings WHERE key = 'diagnostic-schedule'")
			.get()).toEqual({ value: '{"enabled":true,"analyzer":"react","cadence":"daily"}' });
		rows.close();
	});

	test('a corrupt row fails closed instead of enabling background work', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-bad-diagnostic-schedule-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		store.setDiagnosticSchedule({ enabled: true, analyzer: 'react', cadence: 'daily' });
		store.close();

		const rows = new Database(dbPath);
		rows.exec("UPDATE runtime_settings SET value = '{not json' WHERE key = 'diagnostic-schedule';");
		rows.close();
		const reopened = new RunStore(dbPath);
		expect(reopened.getDiagnosticSchedule().enabled).toBe(false);
		reopened.close();
	});
});

describe('operator profile', () => {
	test('round-trips as one runtime setting and survives reopen', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-operator-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		expect(store.getOperatorProfile()).toEqual({ name: '', timezone: '' });
		store.setOperatorProfile({ name: ' Eduardo ', timezone: 'America/Sao_Paulo' });
		store.close();

		const reopened = new RunStore(dbPath);
		expect(reopened.getOperatorProfile()).toEqual({
			name: 'Eduardo',
			timezone: 'America/Sao_Paulo',
		});
		reopened.close();

		const rows = new Database(dbPath);
		const stored = rows.query("SELECT value FROM runtime_settings WHERE key = 'operator-profile'")
			.get() as { value: string };
		expect(JSON.parse(stored.value)).toEqual({
			name: 'Eduardo',
			timezone: 'America/Sao_Paulo',
		});
		rows.close();
	});

	test('a corrupt row reads as empty instead of blocking the service', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-operator-corrupt-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		store.setOperatorProfile({ name: 'Eduardo', timezone: 'UTC' });
		store.close();

		const corrupted = new Database(dbPath);
		corrupted.exec(
			"UPDATE runtime_settings SET value = '{not json' WHERE key = 'operator-profile';",
		);
		corrupted.close();

		const reopened = new RunStore(dbPath);
		expect(reopened.getOperatorProfile()).toEqual({ name: '', timezone: '' });
		reopened.close();
	});
});

describe('project brief', () => {
	test('round-trips the brief and clears the generated handoff in the same write', () => {
		const store = new RunStore(':memory:');
		expect(store.getProjectBrief()).toEqual(EMPTY_BRIEF);

		const brief = {
			objective: 'Manter o brief do produto sob controle do operador.',
			decisions: ['O brief é um registro único, não um histórico.'],
			constraints: ['Somente o serviço determinístico persiste o brief.'],
			openItems: ['Construir o editor web na fatia 2.'],
		};
		store.setOrchestratorHandoff({
			objective: 'Memória automática antiga.',
			decisions: ['Uma decisão gerada.'],
			constraints: [],
			openItems: [],
		}, '2026-08-16T20:59:00.000Z');
		store.setProjectBrief(brief, '2026-08-16T21:00:00.000Z');
		expect(store.getProjectBrief()).toEqual(brief);
		expect(store.getOrchestratorHandoff()).toEqual(EMPTY_BRIEF);

		const rewritten = { ...brief, objective: 'Objetivo substituído.', openItems: [] };
		store.setProjectBrief(rewritten, '2026-08-16T21:05:00.000Z');
		expect(store.getProjectBrief()).toEqual(rewritten);
		store.close();
	});

	test('rolls back the brief when SQLite refuses the handoff invalidation', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-brief-atomic-'), 'runtime.sqlite');
		const store = new RunStore(dbPath);
		const original = {
			objective: 'Brief anterior.', decisions: [], constraints: [], openItems: [],
		};
		const handoff = {
			objective: 'Handoff anterior.', decisions: [], constraints: [], openItems: [],
		};
		store.setProjectBrief(original, '2026-08-16T21:00:00.000Z');
		store.setOrchestratorHandoff(handoff, '2026-08-16T21:01:00.000Z');

		const guard = new Database(dbPath);
		guard.exec(`
			CREATE TRIGGER refuse_empty_handoff
			BEFORE UPDATE ON orchestrator_handoff
			WHEN NEW.handoff_json = '{"objective":"","decisions":[],"constraints":[],"openItems":[]}'
			BEGIN
				SELECT RAISE(ABORT, 'refused handoff invalidation');
			END;
		`);
		guard.close();

		expect(() => store.setProjectBrief(
			{ ...original, objective: 'Não pode sobreviver sozinho.' },
			'2026-08-16T21:02:00.000Z',
		)).toThrow('refused handoff invalidation');
		expect(store.getProjectBrief()).toEqual(original);
		expect(store.getOrchestratorHandoff()).toEqual(handoff);
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

// GSHIP-623: the run's total cost is derived server-side from every usage
// event it has, so no display limit can ever shrink the number shown.
describe('run cost summary', () => {
	function appendUsage(
		store: RunStore,
		runId: string,
		kind: 'provider.usage' | 'review.usage',
		payload: Record<string, unknown>,
	): void {
		store.appendEvent({ runId, kind, createdAt: '2026-08-17T10:00:00.000Z', payload });
	}

	test('sums the total and the per-role, per-model breakdown across every invocation', () => {
		const store = storeWithRun('run-cost', 'CAM-60');
		// First pass: executor on opus.
		appendUsage(store, 'run-cost', 'provider.usage', {
			model: 'opus',
			effort: 'high',
			totalCostUsd: 0.12,
			usage: { inputTokens: 900, outputTokens: 150 },
			modelUsage: [{ model: 'claude-opus-4-6', inputTokens: 900, outputTokens: 150, costUsd: 0.12 }],
		});
		// Independent reviewer, its own model.
		appendUsage(store, 'run-cost', 'review.usage', {
			model: 'sonnet',
			totalCostUsd: 0.03,
			modelUsage: [{ model: 'claude-sonnet-4-6', inputTokens: 300, outputTokens: 40, costUsd: 0.03 }],
		});
		// The single automatic fix round: a second executor invocation, same
		// model, whose cost must add to the first instead of replacing it.
		appendUsage(store, 'run-cost', 'provider.usage', {
			model: 'opus',
			effort: 'high',
			totalCostUsd: 0.04,
			modelUsage: [{ model: 'claude-opus-4-6', inputTokens: 200, outputTokens: 60, costUsd: 0.04 }],
		});

		expect(store.getRunCostSummary('run-cost')).toEqual({
			totalCostUsd: 0.19,
			breakdown: [
				{
					role: 'executor',
					model: 'claude-opus-4-6',
					costUsd: 0.16,
					inputTokens: 1100,
					outputTokens: 210,
				},
				{
					role: 'reviewer',
					model: 'claude-sonnet-4-6',
					costUsd: 0.03,
					inputTokens: 300,
					outputTokens: 40,
				},
			],
			// The executor's two invocations agreed on 'high'; the reviewer never
			// reported an effort or a thinking count at all, so it has no row here.
			roles: [{ role: 'executor', effort: 'high' }],
		});
		store.close();
	});

	// GSHIP-628: effort and thinkingTokens describe the whole invocation, not
	// one model in it -- the effort flag it was called with, the thinking count
	// `usage` reports at the call level -- so both are reported per role
	// instead of matched against any model id. Real usage is always
	// multi-model: the model-settings alias sits at the top of the event, and
	// `modelUsage` carries the CLI's own resolved ids for the configured model
	// plus an auxiliary call the operator's settings never named. Thinking
	// always sums across a role's invocations, including the automatic fix
	// round; effort stays absent for the whole role the moment two of its
	// invocations disagree, instead of guessing by picking one.
	test('reports effort and thinking per role, never on a model row, dropping effort when a role\'s invocations disagree', () => {
		const store = storeWithRun('run-cost-thinking', 'CAM-64');
		// First pass: the executor's alias at the top, modelUsage resolved into
		// the configured model plus an auxiliary call.
		appendUsage(store, 'run-cost-thinking', 'provider.usage', {
			model: 'opus',
			effort: 'xhigh',
			totalCostUsd: 0.22,
			usage: { inputTokens: 500, outputTokens: 100, thinkingTokens: 35704 },
			modelUsage: [
				{ model: 'claude-opus-4-6', inputTokens: 500, outputTokens: 100, costUsd: 0.2 },
				{ model: 'claude-haiku-4-5', costUsd: 0.02 },
			],
		});
		// The automatic fix round: same role, same effort. Its thinking tokens
		// add to the first invocation's instead of replacing or duplicating it.
		appendUsage(store, 'run-cost-thinking', 'provider.usage', {
			model: 'opus',
			effort: 'xhigh',
			totalCostUsd: 0.07,
			usage: { thinkingTokens: 1200 },
			modelUsage: [
				{ model: 'claude-opus-4-6', costUsd: 0.05 },
				{ model: 'claude-haiku-4-5', costUsd: 0.02 },
			],
		});
		// The reviewer, called twice at two different efforts: the role's effort
		// must stay absent, but its thinking still sums across both invocations.
		appendUsage(store, 'run-cost-thinking', 'review.usage', {
			model: 'sonnet',
			effort: 'high',
			totalCostUsd: 0.02,
			usage: { thinkingTokens: 900 },
			modelUsage: [{ model: 'claude-sonnet-4-6', costUsd: 0.02 }],
		});
		appendUsage(store, 'run-cost-thinking', 'review.usage', {
			model: 'sonnet',
			effort: 'medium',
			totalCostUsd: 0.01,
			usage: { thinkingTokens: 300 },
			modelUsage: [{ model: 'claude-sonnet-4-6', costUsd: 0.01 }],
		});

		const summary = store.getRunCostSummary('run-cost-thinking');
		expect(summary.totalCostUsd).toBeCloseTo(0.32, 6);
		expect(summary.breakdown).toEqual([
			{
				role: 'executor',
				model: 'claude-opus-4-6',
				costUsd: expect.closeTo(0.25, 6),
				inputTokens: 500,
				outputTokens: 100,
			},
			{
				role: 'executor',
				model: 'claude-haiku-4-5',
				costUsd: expect.closeTo(0.04, 6),
			},
			{
				role: 'reviewer',
				model: 'claude-sonnet-4-6',
				costUsd: expect.closeTo(0.03, 6),
			},
		]);
		expect(summary.roles).toEqual([
			{ role: 'executor', thinkingTokens: 36904, effort: 'xhigh' },
			// 'high' and 'medium' disagree, so the reviewer's effort is absent --
			// its thinking still summed both invocations.
			{ role: 'reviewer', thinkingTokens: 1200 },
		]);
		store.close();
	});

	test('reads as null, never zero, when the run has no usage event at all', () => {
		const store = storeWithRun('run-cost-none', 'CAM-61');
		expect(store.getRunCostSummary('run-cost-none'))
			.toEqual({ totalCostUsd: null, breakdown: [], roles: [] });
		store.close();
	});

	test('a run with more events than listRunEvents\' read limit still reports its true total', () => {
		const store = storeWithRun('run-cost-many', 'CAM-62');
		const invocations = 210;
		for (let index = 0; index < invocations; index += 1) {
			appendUsage(store, 'run-cost-many', 'provider.usage', {
				model: 'opus',
				totalCostUsd: 0.01,
				modelUsage: [{ model: 'claude-opus-4-6', inputTokens: 10, outputTokens: 2, costUsd: 0.01 }],
			});
		}
		// The display read is capped well under what was written...
		expect(store.listRunEvents('run-cost-many').length).toBeLessThan(invocations);
		// ...but the cost aggregate is not: it reads the complete, unbounded log.
		const summary = store.getRunCostSummary('run-cost-many');
		expect(summary.totalCostUsd).toBeCloseTo(invocations * 0.01, 6);
		expect(summary.breakdown).toEqual([{
			role: 'executor',
			model: 'claude-opus-4-6',
			costUsd: expect.closeTo(invocations * 0.01, 6),
			inputTokens: invocations * 10,
			outputTokens: invocations * 2,
		}]);
		store.close();
	});

	test('ignores an event whose model or cost is unusable instead of throwing', () => {
		const store = storeWithRun('run-cost-noisy', 'CAM-63');
		appendUsage(store, 'run-cost-noisy', 'provider.usage', {
			totalCostUsd: 0.05,
			modelUsage: [
				{ model: 'claude-opus-4-6', costUsd: 'not-a-number' },
				{ costUsd: 0.05 },
				{ model: 'claude-opus-4-6', costUsd: 0.05 },
			],
		});
		expect(store.getRunCostSummary('run-cost-noisy')).toEqual({
			totalCostUsd: 0.05,
			breakdown: [{ role: 'executor', model: 'claude-opus-4-6', costUsd: 0.05 }],
			roles: [],
		});
		store.close();
	});
});

// GSHIP-664: the subscription's rate-limit windows are shared across the whole
// install, not owned by one run, so this reads across every run's events --
// never invoking Claude itself, only replaying what a real invocation already
// reported through provider.rate-limit / review.rate-limit.
describe('claude usage windows', () => {
	function appendRateLimit(
		store: RunStore,
		runId: string,
		kind: 'provider.rate-limit' | 'review.rate-limit',
		createdAt: string,
		payload: Record<string, unknown>,
	): void {
		store.appendEvent({ runId, kind, createdAt, payload });
	}

	test('reads as empty, never fabricated, when no invocation ever reported a window', () => {
		const store = storeWithRun('run-usage-none', 'CAM-70');
		expect(store.getClaudeUsageWindows('2026-08-17T10:00:00.000Z')).toEqual([]);
		store.close();
	});

	test('keeps only the freshest observation per window across both roles', () => {
		const store = storeWithRun('run-usage-latest', 'CAM-71');
		appendRateLimit(store, 'run-usage-latest', 'provider.rate-limit', '2026-08-17T10:00:00.000Z', {
			status: 'allowed',
			limit: 'five_hour',
			usedPercent: 10,
		});
		// A later reviewer invocation reports the same window at a higher
		// utilization: this is the observation that must survive, not the first.
		appendRateLimit(store, 'run-usage-latest', 'review.rate-limit', '2026-08-17T11:00:00.000Z', {
			status: 'allowed_warning',
			limit: 'five_hour',
			usedPercent: 78,
			retryAt: '2026-08-17T15:00:00.000Z',
		});
		// A distinct window is kept alongside it, not merged into it.
		appendRateLimit(store, 'run-usage-latest', 'provider.rate-limit', '2026-08-17T10:30:00.000Z', {
			status: 'allowed',
			limit: 'seven_day',
			usedPercent: 20,
		});

		expect(store.getClaudeUsageWindows('2026-08-17T14:59:59.999Z')).toEqual([
			{
				window: 'five_hour',
				status: 'allowed_warning',
				usedPercent: 78,
				observedAt: '2026-08-17T11:00:00.000Z',
				resetsAt: '2026-08-17T15:00:00.000Z',
			},
			{
				window: 'seven_day',
				status: 'allowed',
				usedPercent: 20,
				observedAt: '2026-08-17T10:30:00.000Z',
			},
		]);
		expect(store.getClaudeUsageWindows('2026-08-17T15:00:00.000Z')).toEqual([
			{
				window: 'seven_day',
				status: 'allowed',
				usedPercent: 20,
				observedAt: '2026-08-17T10:30:00.000Z',
			},
		]);
		store.close();
	});

	test('drops an event with no reported window instead of inventing one', () => {
		const store = storeWithRun('run-usage-unnamed', 'CAM-72');
		// The malformed-payload shape consumeClaudeLine emits when readClaudeRateLimit
		// returned null (an unrecognized status, e.g.): no `limit`, no `status`.
		appendRateLimit(store, 'run-usage-unnamed', 'provider.rate-limit', '2026-08-17T10:00:00.000Z', {});
		expect(store.getClaudeUsageWindows('2026-08-17T10:00:00.000Z')).toEqual([]);
		store.close();
	});
});

// GSHIP-634: orchestrator_messages already wrote exactly one row per turn, so
// its usage columns are added to that table instead of a new one, migrated by
// PRAGMA the same way promoted_issue_id was.
describe('orchestrator message usage migration', () => {
	test('a pre-GSHIP-634 database gains the usage columns without losing its messages', () => {
		const dbPath = join(createTestTmpdir('gship-run-store-orchestrator-usage-'), 'runtime.sqlite');
		const legacy = new Database(dbPath, { create: true });
		legacy.exec(`
			CREATE TABLE orchestrator_messages (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				provider_id TEXT NOT NULL,
				role TEXT NOT NULL,
				text TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			INSERT INTO orchestrator_messages (provider_id, role, text, created_at) VALUES
				('claude', 'operator', 'Qual é o objetivo desta fatia?', '2026-08-18T10:00:00Z'),
				('claude', 'orchestrator', 'Vou investigar o core.', '2026-08-18T10:00:05Z');
		`);
		legacy.close();

		const migrated = new RunStore(dbPath);
		const messages = migrated.listOrchestratorMessages();
		expect(messages).toHaveLength(2);
		// A row written before the columns existed reads back with no usage at
		// all -- never a fabricated free turn.
		for (const message of messages) expect(message.usage).toBeUndefined();

		// The migrated table still accepts a usage-carrying write going forward.
		const withUsage = migrated.appendOrchestratorMessage({
			providerId: 'claude',
			role: 'orchestrator',
			text: 'Contexto recuperado.',
			createdAt: '2026-08-18T10:00:10Z',
			usage: { model: 'opus', effort: 'high', totalCostUsd: 0.08, inputTokens: 500 },
		});
		expect(withUsage.usage).toEqual({ model: 'opus', effort: 'high', totalCostUsd: 0.08, inputTokens: 500 });
		migrated.close();
	});
});
