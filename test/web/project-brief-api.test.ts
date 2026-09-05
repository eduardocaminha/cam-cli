import { describe, expect, test } from 'bun:test';

import { startWebServer } from '../../src/commands/web.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { PROJECT_BRIEF_LIMITS, type ProjectBrief, RunStore } from '../../src/runtime/run-store.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const BRIEF: ProjectBrief = {
	objective: 'Manter a intenção do produto sob controle do operador.',
	decisions: ['O agente externo é a interface conversacional.'],
	constraints: ['Somente o serviço determinístico persiste o brief.'],
	openItems: ['Construir o editor web na fatia 2.'],
};
const EMPTY = { objective: '', decisions: [], constraints: [], openItems: [] };

async function withServer(body: (base: string, runtime: RunRuntime) => Promise<void>): Promise<void> {
	const runtime = new RunRuntime({
		cwd: createTestTmpdir('gship-brief-api-'),
		store: new RunStore(':memory:'),
	});
	const handle = startWebServer({
		port: 0,
		cwd: createTestTmpdir('gship-brief-api-cwd-'),
		runRuntime: runtime,
	});
	try {
		await body(`http://${handle.hostname}:${handle.port}`, runtime);
	} finally {
		await handle.stop();
		await runtime.stop();
		runtime.close();
	}
}

describe('project brief web API', () => {
	test('GET reads the persisted brief without an Origin header', async () => {
		await withServer(async (base, runtime) => {
			expect(await (await fetch(`${base}/api/brief`)).json()).toEqual({ brief: EMPTY });
			runtime.setProjectBrief(BRIEF);
			expect(await (await fetch(`${base}/api/brief`)).json()).toEqual({ brief: BRIEF });
		});
	});

	test('a valid PUT stores the complete brief and ignores extra fields', async () => {
		await withServer(async (base, runtime) => {
			const written = await fetch(`${base}/api/brief`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json', origin: base },
				body: JSON.stringify({ ...BRIEF, handoff: { objective: 'ignored' } }),
			});
			expect(written.status).toBe(200);
			expect(await written.json()).toEqual({ ok: true, brief: BRIEF });
			expect(runtime.getProjectBrief()).toEqual(BRIEF);
		});
	});

	test('an invalid or cross-origin PUT is refused and stores nothing', async () => {
		await withServer(async (base, runtime) => {
			const invalid = await fetch(`${base}/api/brief`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json', origin: base },
				body: JSON.stringify({ ...BRIEF, objective: 'o'.repeat(PROJECT_BRIEF_LIMITS.objective + 1) }),
			});
			expect(invalid.status).toBe(400);
			const crossOrigin = await fetch(`${base}/api/brief`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
				body: JSON.stringify(BRIEF),
			});
			expect(crossOrigin.status).toBe(403);
			expect(runtime.getProjectBrief()).toEqual(EMPTY);
		});
	});
});
