// test/web/page.test.ts
//
// String-contract coverage for the deliberately unstyled browser page, with
// no DOM test runtime, served by the same process as GET /api/snapshot.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const ACTIVE_CYCLE_BRANCH_MARKER = 'active-cycle-payload';
const IDLE_BRANCH_MARKER = 'idle-payload';

describe('GET /', () => {
	test('serves the same-origin polling page with markers for both payload shapes', async () => {
		const handle = startWebServer({ port: 0, cwd: REPO_ROOT });
		try {
			const response = await fetch(`http://${handle.hostname}:${handle.port}/`);
			const html = await response.text();

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('text/html');
			expect(html).toContain('/api/snapshot');
			expect(html).toContain('/api/runs');
			expect(html).toContain('/api/events');
			expect(html).toContain('Iniciar run');
			expect(html).toContain('run-issue');
			expect(html).toContain('Retomar run');
			expect(html).toContain('Cancelar run');
			expect(html).toContain('new EventSource(EVENTS_PATH)');
			expect(html).not.toContain('setInterval');
			expect(html).toContain(ACTIVE_CYCLE_BRANCH_MARKER);
			expect(html).toContain(IDLE_BRANCH_MARKER);
			expect(ACTIVE_CYCLE_BRANCH_MARKER).not.toBe(IDLE_BRANCH_MARKER);
			expect(html).not.toContain('<style');
			expect(html).not.toContain('stylesheet');
		} finally {
			await handle.stop();
		}
	});
});
