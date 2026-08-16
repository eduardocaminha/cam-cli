import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

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
