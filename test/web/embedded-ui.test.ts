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
import { gitAvailable } from '../helpers/test-deps.ts';
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
			// The inline diagnostic page is gone: no script body, no raw JSON dump.
			expect(html).not.toContain('JSON.stringify');
			expect(html).not.toContain('Loading snapshot...');

			const script = await get(handle, '/app.js');
			expect(script.status).toBe(200);
			expect(script.headers.get('content-type')).toContain('text/javascript');
			expect(await script.text()).toBe(readFileSync(join(DIST_DIR, 'app.js'), 'utf8'));

			const style = await get(handle, '/app.css');
			expect(style.status).toBe(200);
			expect(style.headers.get('content-type')).toContain('text/css');
			expect(await style.text()).toBe(readFileSync(join(DIST_DIR, 'app.css'), 'utf8'));
		} finally {
			await handle.stop();
		}
	});

	test('every operator surface is the same document, and nothing else is', async () => {
		const handle = startWebServer({ port: 0, cwd: REPO_ROOT });
		try {
			const home = await (await get(handle, '/')).text();

			for (const path of ['/runs', '/work', '/settings']) {
				const surface = await get(handle, path);
				expect(surface.status).toBe(200);
				expect(surface.headers.get('content-type')).toContain('text/html');
				expect(await surface.text()).toBe(home);
			}
			// Enumerated paths, not a universal fallback: anything else is a 404.
			expect((await get(handle, '/runs/run-1')).status).toBe(404);
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

	// webui/dist is committed and served as-is (see the file header); nothing
	// in `check:all` previously rebuilt it, so a dist gone stale relative to
	// webui/src passed every test silently. Rebuilding here and diffing
	// against the tracked copy turns that drift into a red, explained gate
	// instead of a green one.
	test.skipIf(!gitAvailable)(
		'rebuilding webui reproduces the committed webui/dist exactly (bundle is not stale)',
		() => {
			const build = Bun.spawnSync(['bun', 'run', 'build:ui'], {
				cwd: REPO_ROOT,
				// `bun test` sets NODE_ENV=test on its own process, which
				// Bun.spawnSync inherits by default; vite reads that and builds
				// unminified dev output, a false "stale" diff against the
				// production bundle that's actually committed. Force the same
				// mode `bun run build:ui` runs under outside of tests.
				env: { ...process.env, NODE_ENV: 'production' },
				stdout: 'pipe',
				stderr: 'pipe',
			});
			if (build.exitCode !== 0) {
				throw new Error(`bun run build:ui failed:\n${new TextDecoder().decode(build.stderr)}`);
			}

			const diff = Bun.spawnSync(['git', 'diff', '--exit-code', '--', 'webui/dist'], {
				cwd: REPO_ROOT,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			if (diff.exitCode !== 0) {
				throw new Error(
					'webui/dist is stale: rebuilding webui/src produced different bytes than the ' +
						'committed bundle. Run `bun run build:ui` and commit the result.\n\n' +
						new TextDecoder().decode(diff.stdout),
				);
			}
			expect(diff.exitCode).toBe(0);
		},
	);
});
