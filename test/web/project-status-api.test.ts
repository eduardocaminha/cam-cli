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
					detail: 'Esta pasta ainda não contém um projeto Git.',
				},
			});
		} finally {
			handle.stop();
		}
	});
});
