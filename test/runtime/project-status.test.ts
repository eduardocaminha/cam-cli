import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';

import {
	readProjectOperationalOverview,
	type ProjectOperationalStatus,
} from '../../src/runtime/project-status.ts';
import { readPersistedRunHistory, RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const project = {
	id: 'project-1',
	name: 'project',
	root: '/project',
	stateDir: '/state',
	readiness: 'ready' as const,
	repository: 'acme/project',
	current: true,
};

test('marks a project unavailable when its second database read fails', () => {
	const status: ProjectOperationalStatus = {
		project,
		root: { state: 'available' },
		backlog: {
			state: 'available',
			counts: { idea: 0, specified: 0, planned: 0 },
			plannable: [],
			byStage: { idea: [], specified: [], planned: [] },
			drafts: [],
		},
		database: {
			state: 'available',
			path: '/state/runtime.sqlite',
			runs: [],
		},
	};

	const overview = readProjectOperationalOverview(
		[project],
		() => status,
		() => { throw new Error('database changed during overview'); },
	);

	expect(overview.projects[0]?.database).toEqual({
		state: 'unavailable',
		path: '/state/runtime.sqlite',
		reason: 'database changed during overview',
	});
	expect(overview.projects[0]?.activeRun).toBeNull();
	expect(overview.summary).toMatchObject({
		readyProjects: 0,
		unavailableProjects: 1,
		nonTerminalRuns: 0,
	});
});

test('ignores malformed activity events when reading historical decisions', () => {
	const databasePath = join(createTestTmpdir('gship-project-history-'), 'runtime.sqlite');
	const store = new RunStore(databasePath);
	store.createRun({
		id: 'run-history',
		issueId: 'GSHIP-730',
		sessionId: 'session-history',
		workspacePath: '/workspaces/history',
		createdAt: '2026-08-23T10:00:00.000Z',
	});
	store.appendEvent({
		runId: 'run-history',
		kind: 'provider.activity',
		createdAt: '2026-08-23T10:01:00.000Z',
		eventClass: 'activity',
	});
	store.close();

	const database = new Database(databasePath, { strict: true });
	database.query(`
		UPDATE run_events
		SET to_state = 'invalid-state', payload_json = '{malformed'
		WHERE event_class = 'activity'
	`).run();
	database.close();

	const history = readPersistedRunHistory(databasePath);
	expect(history).toHaveLength(1);
	expect(history[0]?.events.map((event) => event.kind)).toEqual(['run.created']);
	expect(history[0]?.evaluation.outcome).toBe('incomplete');
});
