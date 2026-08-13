// src/commands/web.ts
//
// Localhost-only HTTP process for the read-only web surface. Routing stays in
// Bun.serve's native `routes` table so handlers can grow without introducing a
// second router or a manual pathname switch.

import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { printError } from '../logging/color.ts';
import { readBacklogFromMain } from '../issues/backlog.ts';
import { deriveBacklogJson, type BacklogJsonView } from '../issues/list.ts';
import type { CycleMetricsRow } from '../stats/cycles.ts';
import { readSnapshot, RECENT_ENTRIES_COUNT, type EventLogReader } from './dashboard.ts';
import { resolvePrdPath } from './status.ts';

export const DEFAULT_WEB_PORT = 7777;
export const WEB_HOSTNAME = '127.0.0.1';

export interface WebServerOptions {
	port: number;
	cwd: string;
	claudeDir?: string;
	/** Test seam for measuring only worker-event bytes read by the real route. */
	eventLogReader?: EventLogReader;
}

export interface WebServerHandle {
	port: number;
	hostname: string;
	stop: () => Promise<void>;
}

export interface IdleSnapshotState {
	recentCycles: CycleMetricsRow[];
	backlog: BacklogJsonView;
}

/**
 * Parse the committed cycle store. Its first physical line is metadata; only
 * subsequent lines are cycle rows. Newest rows are returned first.
 */
export function parseRecentCycles(jsonl: string): CycleMetricsRow[] {
	const rows: CycleMetricsRow[] = [];
	for (const rawLine of jsonl.split('\n').slice(1)) {
		const trimmed = rawLine.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (!isCycleMetricsRow(parsed)) continue;
			rows.push(copyCycleMetricsRow(parsed));
		} catch {
			// A partial append must not make the read-only route fail.
		}
	}
	return rows.slice(-RECENT_ENTRIES_COUNT).reverse();
}

function isCycleMetricsRow(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row['cycleId'] === 'string' &&
		typeof row['issueNumber'] === 'string' &&
		typeof row['closedAt'] === 'string' &&
		typeof row['workerRounds'] === 'number' &&
		typeof row['reviewRounds'] === 'number' &&
		typeof row['orchTokens'] === 'number' &&
		typeof row['workerTokens'] === 'number' &&
		typeof row['total'] === 'number'
	);
}

function copyCycleMetricsRow(source: Record<string, unknown>): CycleMetricsRow {
	const row: CycleMetricsRow = {
		cycleId: source['cycleId'] as string,
		issueNumber: source['issueNumber'] as string,
		closedAt: source['closedAt'] as string,
		workerRounds: source['workerRounds'] as number,
		reviewRounds: source['reviewRounds'] as number,
		orchTokens: source['orchTokens'] as number,
		workerTokens: source['workerTokens'] as number,
		total: source['total'] as number,
	};
	if (typeof source['prNumber'] === 'number') row.prNumber = source['prNumber'];
	if (typeof source['mergeMode'] === 'string') {
		row.mergeMode = source['mergeMode'] as CycleMetricsRow['mergeMode'];
	}
	return row;
}

function readRecentCycles(cwd: string): CycleMetricsRow[] {
	try {
		const path = join(cwd, 'scripts', 'cam', 'cycle-metrics.jsonl');
		if (!existsSync(path)) return [];
		return parseRecentCycles(readFileSync(path, 'utf8'));
	} catch {
		return [];
	}
}

function readIdleSnapshotState(cwd: string): IdleSnapshotState {
	let backlog: BacklogJsonView;
	try {
		backlog = deriveBacklogJson(readBacklogFromMain(cwd));
	} catch {
		backlog = deriveBacklogJson([]);
	}
	return { recentCycles: readRecentCycles(cwd), backlog };
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
					...(options.eventLogReader !== undefined ? { eventLogReader: options.eventLogReader } : {}),
				});
				delete snapshot.tokensInput;
				delete snapshot.tokensOutput;
				delete snapshot.tokensCacheRead;
				delete snapshot.tokensCacheCreation;
				delete snapshot.storyTokens;
				const payload: Record<string, unknown> = { ...snapshot };
				if (!existsSync(resolvePrdPath(options.cwd))) {
					payload['idleState'] = readIdleSnapshotState(options.cwd);
				}
				return Response.json(payload);
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
