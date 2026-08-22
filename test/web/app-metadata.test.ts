import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { startWebServer, type WebServerHandle } from '../../src/commands/web.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const DESCRIPTION =
	'Local operator control center for planning, reviewing, and shipping software changes.';

function pngSize(bytes: Uint8Array): { width: number; height: number } {
	expect(Array.from(bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe('application metadata and icons', () => {
	let handle: WebServerHandle;

	beforeAll(() => {
		handle = startWebServer({ port: 0, cwd: REPO_ROOT });
	});

	afterAll(async () => {
		await handle.stop();
	});

	async function get(path: string): Promise<Response> {
		return await fetch(`http://${handle.hostname}:${handle.port}${path}`);
	}

	test('publishes local-operator metadata in the localized application document', async () => {
		const response = await get('/overview');
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain('<html lang="en-US">');
		expect(html).toContain('<title>Gateship</title>');
		expect(html).toContain('<meta name="application-name" content="Gateship"');
		expect(html).toContain(`<meta name="description" content="${DESCRIPTION}"`);
		expect(html).toContain('<meta name="color-scheme" content="light dark"');
		expect(html).toContain(
			'<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"',
		);
		expect(html).toContain(
			'<meta name="theme-color" content="#111111" media="(prefers-color-scheme: dark)"',
		);
		expect(html).toContain('<meta name="robots" content="noindex,nofollow"');
		expect(html).toContain(
			'<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any"',
		);
		expect(html).toContain(
			'<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180"',
		);
		expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
		expect(html).not.toContain('data:image/svg+xml');
	});

	test('serves the install manifest with the canonical overview entry point', async () => {
		const response = await get('/manifest.webmanifest');
		const manifest = await response.json() as {
			name: string;
			short_name: string;
			description: string;
			start_url: string;
			scope: string;
			display: string;
			theme_color: string;
			background_color: string;
			icons: Array<Record<string, string>>;
		};

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/manifest+json');
		expect(manifest).toMatchObject({
			name: 'Gateship',
			short_name: 'Gateship',
			description: DESCRIPTION,
			start_url: '/overview',
			scope: '/',
			display: 'standalone',
			theme_color: '#171717',
			background_color: '#ffffff',
		});
		expect(manifest.icons).toEqual([
			{
				src: '/icon-192.png',
				sizes: '192x192',
				type: 'image/png',
				purpose: 'any maskable',
			},
			{
				src: '/icon-512.png',
				sizes: '512x512',
				type: 'image/png',
				purpose: 'any maskable',
			},
		]);
	});

	test('serves the simplified official mark at every declared size', async () => {
		const favicon = await get('/favicon.svg');
		const faviconSvg = await favicon.text();
		expect(favicon.status).toBe(200);
		expect(favicon.headers.get('content-type')).toContain('image/svg+xml');
		expect(faviconSvg).toContain('M1250 125C1871');
		expect(faviconSvg).toContain('M1750 875V1625');

		for (const [path, size] of [
			['/apple-touch-icon.png', 180],
			['/icon-192.png', 192],
			['/icon-512.png', 512],
		] as const) {
			const response = await get(path);
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('image/png');
			expect(pngSize(new Uint8Array(await response.arrayBuffer()))).toEqual({
				width: size,
				height: size,
			});
		}
	});
});
