// src/commands/web.ts
//
// Localhost-only HTTP process for the read-only web surface. Routing stays in
// Bun.serve's native `routes` table so handlers can grow without introducing a
// second router or a manual pathname switch.

import process from 'node:process';

import { printError } from '../logging/color.ts';
import { readSnapshot } from './dashboard.ts';

export const DEFAULT_WEB_PORT = 7777;
export const WEB_HOSTNAME = '127.0.0.1';

export interface WebServerOptions {
	port: number;
	cwd: string;
	claudeDir?: string;
}

export interface WebServerHandle {
	port: number;
	hostname: string;
	stop: () => Promise<void>;
}

/** Start the localhost-only web server. Port 0 is supported for test callers. */
export function startWebServer(options: WebServerOptions): WebServerHandle {
	const server = Bun.serve({
		hostname: WEB_HOSTNAME,
		port: options.port,
		routes: {
			'/': () => new Response('Gateship web\n', {
				headers: { 'content-type': 'text/plain; charset=utf-8' },
			}),
			'/api/snapshot': () => {
				const snapshot = readSnapshot({
					cwd: options.cwd,
					nowMs: Date.now(),
					claudeDir: options.claudeDir,
				});
				delete snapshot.tokensInput;
				delete snapshot.tokensOutput;
				delete snapshot.tokensCacheRead;
				delete snapshot.tokensCacheCreation;
				delete snapshot.storyTokens;
				return Response.json(snapshot);
			},
		},
	});

	const { hostname, port } = server;
	if (hostname === undefined || port === undefined) {
		void server.stop(true);
		throw new Error('Bun.serve did not report its resolved TCP address');
	}

	return {
		hostname,
		port,
		stop: () => server.stop(),
	};
}

/** Run the CLI server until SIGINT or SIGTERM requests a graceful stop. */
export async function runWeb(options: WebServerOptions): Promise<number> {
	let handle: WebServerHandle;
	try {
		handle = startWebServer(options);
	} catch (error) {
		printError(
			`gship web: failed to bind --port ${options.port} on ${WEB_HOSTNAME}`,
			error instanceof Error ? error.message : String(error),
		);
		return 1;
	}

	process.stdout.write(`http://${handle.hostname}:${handle.port}\n`);

	return new Promise<number>((resolve) => {
		let cleaned = false;
		const cleanup = async (exitCode: number): Promise<void> => {
			if (cleaned) return;
			cleaned = true;
			try {
				await handle.stop();
			} finally {
				resolve(exitCode);
			}
		};

		process.once('SIGINT', () => {
			void cleanup(130);
		});
		process.once('SIGTERM', () => {
			void cleanup(143);
		});
	});
}
