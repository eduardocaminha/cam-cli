import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { PROJECT_BRIEF_LIMITS, RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const EMPTY_BRIEF = { objective: '', decisions: [], constraints: [], openItems: [] };

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
