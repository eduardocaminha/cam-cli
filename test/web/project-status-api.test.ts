import { describe, expect, test } from 'bun:test';

import { startWebServer } from '../../src/commands/web.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

describe('GET /api/project', () => {
	test('reports an otherwise empty service directory as an onboarding target', async () => {
		const cwd = createTestTmpdir('gship-project-api-');
		const handle = startWebServer({ port: 0, cwd });
		try {
			const response = await fetch(`http://${handle.hostname}:${handle.port}/api/project`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				project: {
					state: 'empty',
					detail: 'This folder does not contain a Git project yet.',
				},
			});
		} finally {
			handle.stop();
		}
	});
});

describe('GET /api/projects', () => {
	test('lists the durable current-project registration with a stable identity', async () => {
		const cwd = createTestTmpdir('gship-project-list-api-');
		const gateshipHome = createTestTmpdir('gship-project-list-home-');
		const read = async () => {
			const handle = startWebServer({ port: 0, cwd, gateshipHome });
			try {
				const response = await fetch(`http://${handle.hostname}:${handle.port}/api/projects`);
				expect(response.status).toBe(200);
				return await response.json() as { projects: Array<Record<string, unknown>> };
			} finally {
				await handle.stop();
			}
		};

		const first = await read();
		const second = await read();
		expect(first.projects).toEqual([{
			id: expect.any(String),
			name: cwd.split('/').at(-1),
			root: cwd,
			stateDir: `${cwd}/.gship`,
			readiness: 'empty',
			current: true,
		}]);
		expect(second.projects[0]?.id).toBe(first.projects[0]?.id);
	});

	test('marks only the project served by this instance as current', async () => {
		const gateshipHome = createTestTmpdir('gship-project-list-shared-home-');
		const firstRoot = createTestTmpdir('gship-project-list-first-');
		const secondRoot = createTestTmpdir('gship-project-list-second-');
		const first = startWebServer({ port: 0, cwd: firstRoot, gateshipHome });
		await first.stop();
		const second = startWebServer({ port: 0, cwd: secondRoot, gateshipHome });
		try {
			const body = await fetch(`http://${second.hostname}:${second.port}/api/projects`)
				.then((response) => response.json()) as { projects: Array<{ root: string; current: boolean }> };
			expect(body.projects).toHaveLength(2);
			expect(body.projects.find((project) => project.root === firstRoot)?.current).toBe(false);
			expect(body.projects.find((project) => project.root === secondRoot)?.current).toBe(true);
		} finally {
			await second.stop();
		}
	});
});
