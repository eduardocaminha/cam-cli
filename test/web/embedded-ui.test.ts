// test/web/embedded-ui.test.ts
//
// The bundle the browser gets comes from the same process that answers
// /api/*: the built Vite output, embedded through static
// `with { type: "file" }` imports so it survives `bun build --compile`, with
// GSHIP_WEB_DIR as the explicit disk override for development.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import { resolveWebAssets, WEB_DIR_ENV } from '../../src/commands/web-assets.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const DIST_DIR = join(REPO_ROOT, 'webui', 'dist');

async function get(handle: { hostname: string; port: number }, path: string): Promise<Response> {
	return await fetch(`http://${handle.hostname}:${handle.port}${path}`);
}

describe('embedded web bundle', () => {
	test('serves index.html, app.js and app.css with the right types', async () => {
		const handle = startWebServer({ port: 0, cwd: REPO_ROOT });
		try {
			const page = await get(handle, '/');
			const html = await page.text();

			expect(page.status).toBe(200);
			expect(page.headers.get('content-type')).toContain('text/html');
			// Stable, unhashed names are what the static import specifiers can name.
			expect(html).toContain('/app.js');
			expect(html).toContain('/app.css');
			expect(html).toContain('id="root"');
			expect(html).toContain('<html lang="en-US">');
			expect(html).toContain('<title>Gateship</title>');
			expect(html).toContain('rel="icon" href="data:image/svg+xml,');
			// The inline diagnostic page is gone: no script body, no raw JSON dump.
			expect(html).not.toContain('JSON.stringify');
			expect(html).not.toContain('Loading snapshot...');

			const script = await get(handle, '/app.js');
			expect(script.status).toBe(200);
			expect(script.headers.get('content-type')).toContain('text/javascript');
			const scriptText = await script.text();
			expect(scriptText).toBe(readFileSync(join(DIST_DIR, 'app.js'), 'utf8'));
			// dist is generated before embedding rather than tracked (PR #486). Prove
			// the bytes production serves contain this slice's locale seam.
			expect(scriptText).toContain('Superfícies do operador');
			expect(scriptText).toContain('Pular para o conteúdo');
			expect(scriptText).toContain('document.documentElement.lang');
			expect(scriptText).toContain('gateship.locale');
			expect(scriptText).toContain('English (US)');
			expect(scriptText).toContain('Português (Brasil)');

			const style = await get(handle, '/app.css');
			expect(style.status).toBe(200);
			expect(style.headers.get('content-type')).toContain('text/css');
			expect(await style.text()).toBe(readFileSync(join(DIST_DIR, 'app.css'), 'utf8'));
		} finally {
			await handle.stop();
		}
	});

	test('canonical project surfaces share one document and legacy paths redirect to them', async () => {
		const handle = startWebServer({ port: 0, cwd: REPO_ROOT });
		try {
			const overview = await get(handle, '/overview');
			const home = await overview.text();
			expect(overview.status).toBe(200);
			const projects = await (await get(handle, '/api/projects')).json() as {
				projects: Array<{ id: string; current: boolean }>;
			};
			const currentId = projects.projects.find((project) => project.current)?.id;
			expect(currentId).toBeString();

			for (const path of [
				`/projects/${currentId}`,
				`/projects/${currentId}/runs`,
				`/projects/${currentId}/work`,
				`/projects/${currentId}/settings`,
			]) {
				const surface = await get(handle, path);
				expect(surface.status).toBe(200);
				expect(surface.headers.get('content-type')).toContain('text/html');
				expect(await surface.text()).toBe(home);
			}
			for (const [legacy, canonical] of [
				['/', '/overview'],
				['/runs', `/projects/${currentId}/runs`],
				['/work', `/projects/${currentId}/work`],
				['/settings', `/projects/${currentId}/settings`],
			] as const) {
				const response = await fetch(
					`http://${handle.hostname}:${handle.port}${legacy}`,
					{ redirect: 'manual' },
				);
				expect(response.status).toBe(302);
				expect(new URL(response.headers.get('location')!).pathname).toBe(canonical);
			}
			// Enumerated paths, not a universal fallback: anything else is a 404.
			expect((await get(handle, `/projects/${currentId}/runs/run-1`)).status).toBe(404);
			expect((await get(handle, '/qualquer-coisa')).status).toBe(404);
		} finally {
			await handle.stop();
		}
	});

	test('the built bundle is what the static import specifiers name', () => {
		const assets = resolveWebAssets({});

		expect(assets.indexHtml.path.endsWith('index.html')).toBe(true);
		expect(assets.appJs.path.endsWith('app.js')).toBe(true);
		expect(assets.appCss.path.endsWith('app.css')).toBe(true);
		expect(readFileSync(assets.indexHtml.path, 'utf8')).toBe(
			readFileSync(join(DIST_DIR, 'index.html'), 'utf8'),
		);
	});

	test('GSHIP_WEB_DIR redirects every asset to disk, and only when set', () => {
		const dir = createTestTmpdir('gship-web-dir-');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'index.html'), '<!doctype html>override');

		const overridden = resolveWebAssets({ [WEB_DIR_ENV]: dir });
		expect(overridden.indexHtml.path).toBe(join(dir, 'index.html'));
		expect(overridden.appJs.path).toBe(join(dir, 'app.js'));
		expect(overridden.appCss.path).toBe(join(dir, 'app.css'));
		expect(overridden.indexHtml.contentType).toContain('text/html');

		// Absent and blank both keep the embedded copy; the override is explicit.
		expect(resolveWebAssets({}).indexHtml.path).not.toBe(overridden.indexHtml.path);
		expect(resolveWebAssets({ [WEB_DIR_ENV]: '  ' }).indexHtml.path).not.toBe(
			overridden.indexHtml.path,
		);
	});

	test('an overridden directory is what the running server actually serves', async () => {
		const dir = createTestTmpdir('gship-web-dir-serve-');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'index.html'), '<!doctype html><title>disco</title>');
		writeFileSync(join(dir, 'app.js'), 'export const fromDisk = true;\n');
		writeFileSync(join(dir, 'app.css'), '.from-disk{color:red}\n');

		const previous = process.env[WEB_DIR_ENV];
		process.env[WEB_DIR_ENV] = dir;
		const handle = startWebServer({ port: 0, cwd: REPO_ROOT });
		try {
			expect(await (await get(handle, '/')).text()).toContain('disco');
			expect(await (await get(handle, '/app.js')).text()).toContain('fromDisk');
			expect(await (await get(handle, '/app.css')).text()).toContain('from-disk');
		} finally {
			await handle.stop();
			if (previous === undefined) delete process.env[WEB_DIR_ENV];
			else process.env[WEB_DIR_ENV] = previous;
		}
	});
});
