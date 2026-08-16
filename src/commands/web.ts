// src/commands/web.ts
//
// Localhost-only HTTP process for the web control surface. Snapshot reads stay
// read-only; explicit command routes delegate to the durable local runtime.
// Routing stays in Bun.serve's native `routes` table.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { readBacklogFromMain } from '../issues/backlog.ts';
import { type BacklogJsonView, deriveBacklogJson } from '../issues/list.ts';
import { printError } from '../logging/color.ts';
import { ClaudeCliExecutor } from '../runtime/claude-cli-executor.ts';
import { ClaudeCliReviewer } from '../runtime/claude-cli-reviewer.ts';
import { createGitRuntimePreflight, GitIssueVerifier, RuntimePreflightError } from '../runtime/git-runtime.ts';
import { GitWorkspaceManager, RuntimeWorkspaceError } from '../runtime/git-workspace.ts';
import { GithubShipper } from '../runtime/github-shipper.ts';
import {
	createOperatorIssue,
	type CreatedOperatorIssue,
	IssueIntakeError,
	parseOperatorIssueInput,
} from '../runtime/issue-intake.ts';
import { RUNTIME_SOURCE_REF } from '../runtime/source-ref.ts';
import {
	RunRuntime,
	type RunRuntimeOptions,
	RuntimeConflictError,
	RuntimeUnavailableError,
} from '../runtime/run-runtime.ts';
import { type RunEvent, RunStore } from '../runtime/run-store.ts';
import type { CycleMetricsRow } from '../stats/cycles.ts';
import {
	type EventLogReader,
	RECENT_ENTRIES_COUNT,
	readSnapshot,
} from './dashboard.ts';
import { resolvePrdPath } from './status.ts';
import { resolveWebAssets, serveWebAsset } from './web-assets.ts';

export const DEFAULT_WEB_PORT = 7777;
export const WEB_HOSTNAME = '127.0.0.1';

export interface WebServerOptions {
	port: number;
	cwd: string;
	claudeDir?: string;
	/** Test seam for measuring only worker-event bytes read by the real route. */
	eventLogReader?: EventLogReader;
	/** Injectable durable run runtime. Production defaults to .gship/runtime.sqlite. */
	runRuntime?: RunRuntime;
	/** Test seam for the remote-main operator issue writer. */
	issueIntake?: (input: unknown) => CreatedOperatorIssue;
}

async function createIssueFromOperator(
	request: Request,
	issueIntake: (input: unknown) => CreatedOperatorIssue,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'Um objeto JSON é obrigatório.' },
			{ status: 400 },
		);
	}
	try {
		const input = parseOperatorIssueInput(body);
		return Response.json({ ok: true, issue: issueIntake(input) }, { status: 201 });
	} catch (error) {
		if (!(error instanceof IssueIntakeError)) throw error;
		return Response.json(
			{ ok: false, code: error.code, message: error.message },
			{ status: error.status },
		);
	}
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

function parseEventCursor(request: Request): number {
	const raw = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('after');
	if (raw === null || raw.trim().length === 0) return 0;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function encodeServerEvent(event: RunEvent): Uint8Array {
	const body = `id: ${event.seq}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`;
	return new TextEncoder().encode(body);
}

/** Stream persisted transitions first, then live events without a polling loop. */
export function createRunEventStream(runtime: RunRuntime, request: Request): Response {
	const initial = runtime.listEvents(parseEventCursor(request));
	let unsubscribe = (): void => {};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let lastSeq = parseEventCursor(request);
			for (const event of initial) {
				controller.enqueue(encodeServerEvent(event));
				lastSeq = event.seq;
			}
			unsubscribe = runtime.subscribe((event) => {
				if (event.seq <= lastSeq) return;
				lastSeq = event.seq;
				controller.enqueue(encodeServerEvent(event));
			});
		},
		cancel() {
			unsubscribe();
		},
	});
	return new Response(stream, {
		headers: {
			'cache-control': 'no-cache',
			'content-type': 'text/event-stream; charset=utf-8',
		},
	});
}

function forbiddenOriginResponse(): Response {
	return Response.json(
		{ ok: false, code: 'forbidden-origin', message: 'Untrusted command origin.' },
		{ status: 403 },
	);
}

async function readIssueId(request: Request): Promise<string | Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A JSON issueId is required.' },
			{ status: 400 },
		);
	}
	const issueId = body !== null && typeof body === 'object'
		? (body as { issueId?: unknown }).issueId
		: undefined;
	if (typeof issueId !== 'string' || issueId.trim().length === 0) {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A JSON issueId is required.' },
			{ status: 400 },
		);
	}
	return issueId.trim();
}

async function startDurableRun(request: Request, runtime: RunRuntime): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	const issueId = await readIssueId(request);
	if (issueId instanceof Response) return issueId;
	try {
		return Response.json({ ok: true, run: runtime.startRun(issueId) }, { status: 202 });
	} catch (error) {
		const unavailable = error instanceof RuntimeUnavailableError;
		const rejected = error instanceof RuntimePreflightError
			|| error instanceof RuntimeWorkspaceError
			|| error instanceof RuntimeConflictError;
		if (!unavailable && !rejected) throw error;
		return Response.json(
			{
				ok: false,
				code: unavailable ? 'runtime-unavailable' : 'run-preflight-failed',
				message: error.message,
			},
			{ status: unavailable ? 503 : 409 },
		);
	}
}

async function cancelDurableRun(
	request: Request,
	runtime: RunRuntime,
	runId: string,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	const run = await runtime.cancelRun(runId);
	if (run === null) {
		return Response.json(
			{ ok: false, code: 'run-not-found', message: 'Run not found.' },
			{ status: 404 },
		);
	}
	return Response.json({ ok: true, run });
}

async function resumeDurableRun(
	request: Request,
	runtime: RunRuntime,
	runId: string,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	if (runtime.getRun(runId) === null) {
		return Response.json(
			{ ok: false, code: 'run-not-found', message: 'Run not found.' },
			{ status: 404 },
		);
	}
	try {
		return Response.json({ ok: true, run: runtime.resumeRun(runId) }, { status: 202 });
	} catch (error) {
		const unavailable = error instanceof RuntimeUnavailableError;
		return Response.json(
			{
				ok: false,
				code: unavailable ? 'runtime-unavailable' : 'run-not-resumable',
				message: error instanceof Error ? error.message : String(error),
			},
			{ status: unavailable ? 503 : 409 },
		);
	}
}

/**
 * Hand a ready-to-ship run to the shipper and answer immediately: the ship
 * operation belongs to the service, and its progress reaches the browser over
 * the same SQLite-backed event stream as every other phase.
 */
async function shipDurableRun(
	request: Request,
	runtime: RunRuntime,
	runId: string,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	if (runtime.getRun(runId) === null) {
		return Response.json(
			{ ok: false, code: 'run-not-found', message: 'Run not found.' },
			{ status: 404 },
		);
	}
	try {
		return Response.json({ ok: true, run: runtime.shipRun(runId) }, { status: 202 });
	} catch (error) {
		const unavailable = error instanceof RuntimeUnavailableError;
		return Response.json(
			{
				ok: false,
				code: unavailable ? 'runtime-unavailable' : 'run-not-shippable',
				message: error instanceof Error ? error.message : String(error),
			},
			{ status: unavailable ? 503 : 409 },
		);
	}
}

/** Reject cross-origin browser writes to the localhost control endpoint. */
export function isTrustedCommandOrigin(request: Request): boolean {
	const rawOrigin = request.headers.get('origin');
	if (rawOrigin === null) return false;
	try {
		const origin = new URL(rawOrigin);
		const target = new URL(request.url);
		const isLocal = (hostname: string) => hostname === WEB_HOSTNAME || hostname === 'localhost';
		return (
			origin.protocol === 'http:' &&
			target.protocol === 'http:' &&
			isLocal(origin.hostname) &&
			isLocal(target.hostname) &&
			origin.port === target.port
		);
	} catch {
		return false;
	}
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

/**
 * Derive the idle backlog from the runtime source ref, the same ref a new run
 * is admitted against: an issue a merge already shipped stops being plannable
 * here even while the local `main` is deliberately behind.
 *
 * This is a pure ref read, never a fetch. Refreshing the source ref belongs to
 * the start of a run and to the terminal of a ship, not to a route the browser
 * polls.
 */
function readIdleSnapshotState(cwd: string): IdleSnapshotState {
	let backlog: BacklogJsonView;
	try {
		backlog = deriveBacklogJson(readBacklogFromMain(cwd, spawnSync, RUNTIME_SOURCE_REF));
	} catch {
		backlog = deriveBacklogJson([]);
	}
	return { recentCycles: readRecentCycles(cwd), backlog };
}

/**
 * Production composition of the durable runtime: the real implementer, the
 * real oracle verifier, the real independent reviewer and the real GitHub
 * shipper over one sqlite store.
 */
export function createDefaultRunRuntimeOptions(cwd: string): RunRuntimeOptions {
	return {
		cwd,
		store: new RunStore(join(cwd, '.gship', 'runtime.sqlite')),
		executor: new ClaudeCliExecutor(),
		verifier: new GitIssueVerifier(),
		reviewer: new ClaudeCliReviewer(),
		shipper: new GithubShipper(),
		preflight: createGitRuntimePreflight(cwd),
		workspace: new GitWorkspaceManager(cwd, undefined, undefined, RUNTIME_SOURCE_REF),
	};
}

/** Start the localhost-only web server. Port 0 is supported for test callers. */
export function startWebServer(options: WebServerOptions): WebServerHandle {
	const ownsRunRuntime = options.runRuntime === undefined;
	const runRuntime = options.runRuntime
		?? new RunRuntime(createDefaultRunRuntimeOptions(options.cwd));
	const issueIntake = options.issueIntake ?? ((input: unknown) =>
		createOperatorIssue(options.cwd, input));
	const assets = resolveWebAssets();
	const server = Bun.serve({
		hostname: WEB_HOSTNAME,
		port: options.port,
		routes: {
			'/': () => serveWebAsset(assets.indexHtml),
			'/app.js': () => serveWebAsset(assets.appJs),
			'/app.css': () => serveWebAsset(assets.appCss),
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
			'/api/runs': {
				GET: () => Response.json({ runs: runRuntime.listRuns() }),
				POST: (request) => startDurableRun(request, runRuntime),
			},
			'/api/issues': {
				POST: (request) => createIssueFromOperator(request, issueIntake),
			},
			'/api/runs/:runId/cancel': {
				POST: (request) => cancelDurableRun(request, runRuntime, request.params.runId),
			},
			'/api/runs/:runId/resume': {
				POST: (request) => resumeDurableRun(request, runRuntime, request.params.runId),
			},
			'/api/runs/:runId/ship': {
				POST: (request) => shipDurableRun(request, runRuntime, request.params.runId),
			},
			'/api/events': (request) => createRunEventStream(runRuntime, request),
		},
	});

	const { hostname, port } = server;
	if (hostname === undefined || port === undefined) {
		void server.stop(true);
		throw new Error('Bun.serve did not report its resolved TCP address');
	}

	let stopped = false;
	return {
		hostname,
		port,
		stop: async () => {
			if (stopped) return;
			stopped = true;
			await runRuntime.stop();
			await server.stop(true);
			if (ownsRunRuntime) runRuntime.close();
		},
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
