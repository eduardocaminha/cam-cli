import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createTestTmpdir } from './helpers/test-tmpdir.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const WEBUI_ROOT = join(REPO_ROOT, 'webui');

function outputText(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

describe('web UI scaffold', () => {
	test('builds used Tailwind utilities into a stably named Vite CSS asset', () => {
		// Built into a scratch directory, not webui/dist: that canonical
		// directory is what test/web/embedded-ui.test.ts's static
		// `with { type: 'file' }` imports resolved at module load, so
		// rebuilding it here would race that test's concurrent reads of the
		// same files (GSHIP-749).
		const distDir = createTestTmpdir('gship-webui-scaffold-dist-');
		const result = Bun.spawnSync(
			['bun', 'run', 'build:ui', '--', '--outDir', distDir, '--emptyOutDir'],
			{
				cwd: REPO_ROOT,
				env: { ...process.env, NODE_ENV: 'production' },
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		if (result.exitCode !== 0) {
			throw new Error(outputText(result.stderr));
		}
		expect(result.exitCode).toBe(0);

		const html = readFileSync(join(WEBUI_ROOT, 'index.html'), 'utf8');
		const builtCss = readFileSync(join(distDir, 'app.css'), 'utf8');

		// Unhashed names, because static `with { type: "file" }` specifiers
		// (src/commands/web-assets.ts) cannot name a content hash.
		expect(readdirSync(distDir).sort()).toEqual([
			'app.css',
			'app.js',
			'apple-touch-icon.png',
			'favicon.svg',
			'icon-192.png',
			'icon-512.png',
			'index.html',
			'manifest.webmanifest',
		]);
		expect(html).toContain('class="flex');
		expect(builtCss).toContain('display:flex');
		expect(builtCss).not.toContain('@import "tailwindcss"');
		expect(builtCss).not.toContain('Saans');
		expect(builtCss).not.toContain('/fonts/');
	});

	test('keeps browser types and dependencies scoped without a nested package graph', () => {
		const rootConfigResult = Bun.spawnSync(['bunx', 'tsc', '--showConfig'], {
			cwd: REPO_ROOT,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(rootConfigResult.exitCode).toBe(0);

		const rootConfig = JSON.parse(outputText(rootConfigResult.stdout)) as { exclude?: string[] };
		const appConfig = JSON.parse(readFileSync(join(WEBUI_ROOT, 'tsconfig.app.json'), 'utf8')) as {
			compilerOptions?: { lib?: string[] };
		};
		const packageManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};

		expect(rootConfig.exclude).toContain('webui');
		expect(appConfig.compilerOptions?.lib).toContain('DOM');
		expect(existsSync(join(WEBUI_ROOT, 'package.json'))).toBe(false);
		expect(packageManifest.devDependencies?.['@tailwindcss/vite']).toBeDefined();
		expect(packageManifest.dependencies?.['shadcn']).toBeUndefined();
	});
});
