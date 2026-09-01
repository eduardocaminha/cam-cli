// src/commands/web-assets.ts
//
// Where the browser bundle comes from, and nothing else.
//
// The specifiers below are static `with { type: "file" }` imports, so
// `bun build --compile` copies the built bundle verbatim into the binary and
// each import evaluates to a `$bunfs` path there and to a real disk path in
// development. That is the only embedding mechanism this repository accepts:
// importing the Vite `index.html` without the attribute re-bundles it and
// inlines assets as data URIs, and passing `dist/*` as extra entrypoints to
// `--compile` silently mutates the CSS and drops the JS.
//
// Because the specifiers are static, `webui/dist` has to exist for this module
// to resolve. It is a build output and is not tracked: the `prepare` script runs
// `build:ui` on every `bun install`, so a clean checkout has the bundle before
// anything imports this module, and `build:release` rebuilds it before compiling.
// The bundle used to be committed, which made a copy older than `webui/src`
// possible at all; generating it removes that failure instead of gating it.

import { join } from 'node:path';
import process from 'node:process';

import appCssPath from '../../webui/dist/app.css' with { type: 'file' };
import appJsPath from '../../webui/dist/app.js' with { type: 'file' };
import appleTouchIconPath from '../../webui/dist/apple-touch-icon.png' with { type: 'file' };
import faviconPath from '../../webui/dist/favicon.svg' with { type: 'file' };
import icon192Path from '../../webui/dist/icon-192.png' with { type: 'file' };
import icon512Path from '../../webui/dist/icon-512.png' with { type: 'file' };
import indexHtmlPath from '../../webui/dist/index.html' with { type: 'file' };
import manifestPath from '../../webui/dist/manifest.webmanifest' with { type: 'file' };

/** Explicit disk override, for iterating on the UI without recompiling. */
export const WEB_DIR_ENV = 'GSHIP_WEB_DIR';

export interface WebAsset {
	path: string;
	contentType: string;
}

export interface WebAssets {
	indexHtml: WebAsset;
	appJs: WebAsset;
	appCss: WebAsset;
	favicon: WebAsset;
	appleTouchIcon: WebAsset;
	icon192: WebAsset;
	icon512: WebAsset;
	manifest: WebAsset;
}

/**
 * `type: "file"` makes every one of these specifiers a path string at runtime.
 * TypeScript models none of that: it types a specifier from whatever the file
 * resolves to, so index.html arrives as an HTMLBundle and app.js as a JS
 * module. The attribute is the contract; this is the one place it is restated.
 */
function embeddedPath(imported: unknown): string {
	return imported as string;
}

const EMBEDDED: WebAssets = {
	indexHtml: { path: embeddedPath(indexHtmlPath), contentType: 'text/html; charset=utf-8' },
	appJs: { path: embeddedPath(appJsPath), contentType: 'text/javascript; charset=utf-8' },
	appCss: { path: embeddedPath(appCssPath), contentType: 'text/css; charset=utf-8' },
	favicon: { path: embeddedPath(faviconPath), contentType: 'image/svg+xml' },
	appleTouchIcon: { path: embeddedPath(appleTouchIconPath), contentType: 'image/png' },
	icon192: { path: embeddedPath(icon192Path), contentType: 'image/png' },
	icon512: { path: embeddedPath(icon512Path), contentType: 'image/png' },
	manifest: {
		path: embeddedPath(manifestPath),
		contentType: 'application/manifest+json; charset=utf-8',
	},
};

/**
 * The embedded bundle, unless `GSHIP_WEB_DIR` names a directory to serve from
 * instead. The override is explicit and never a fallback: an empty or unset
 * variable keeps the embedded copy, and a wrong directory fails loudly at the
 * route rather than silently serving stale embedded bytes.
 */
export function resolveWebAssets(env: NodeJS.ProcessEnv = process.env): WebAssets {
	const dir = env[WEB_DIR_ENV]?.trim();
	if (dir === undefined || dir.length === 0) return EMBEDDED;
	return {
		indexHtml: { path: join(dir, 'index.html'), contentType: EMBEDDED.indexHtml.contentType },
		appJs: { path: join(dir, 'app.js'), contentType: EMBEDDED.appJs.contentType },
		appCss: { path: join(dir, 'app.css'), contentType: EMBEDDED.appCss.contentType },
		favicon: { path: join(dir, 'favicon.svg'), contentType: EMBEDDED.favicon.contentType },
		appleTouchIcon: {
			path: join(dir, 'apple-touch-icon.png'),
			contentType: EMBEDDED.appleTouchIcon.contentType,
		},
		icon192: { path: join(dir, 'icon-192.png'), contentType: EMBEDDED.icon192.contentType },
		icon512: { path: join(dir, 'icon-512.png'), contentType: EMBEDDED.icon512.contentType },
		manifest: {
			path: join(dir, 'manifest.webmanifest'),
			contentType: EMBEDDED.manifest.contentType,
		},
	};
}

/** Serve one asset with its declared type, never sniffed from the path. */
export function serveWebAsset(asset: WebAsset): Response {
	return new Response(Bun.file(asset.path), {
		headers: { 'content-type': asset.contentType },
	});
}
