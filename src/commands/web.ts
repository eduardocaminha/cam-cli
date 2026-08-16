// src/commands/web.ts
//
// Localhost-only HTTP process for the web control surface. Snapshot reads stay
// read-only; explicit command routes delegate to the durable local runtime.
// Routing stays in Bun.serve's native `routes` table.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { readBacklogFromMain } from '../issues/backlog.ts';
import { type BacklogJsonView, deriveBacklogJson } from '../issues/list.ts';
import { printError } from '../logging/color.ts';
import { AgentExecutorRouter } from '../runtime/agent-executor-router.ts';
import { AgentReviewerRouter } from '../runtime/agent-reviewer-router.ts';
import { ClaudeAgentSession, ClaudeCliExecutor } from '../runtime/claude-cli-executor.ts';
import { ClaudeCliReviewer } from '../runtime/claude-cli-reviewer.ts';
import { CodexAgentSession, CodexCliExecutor } from '../runtime/codex-cli-executor.ts';
import { CodexCliReviewer } from '../runtime/codex-cli-reviewer.ts';
import {
	ConversationalOrchestrator,
	type OrchestratorCommand,
	OrchestratorBusyError,
	type OrchestratorTurnResult,
} from '../runtime/conversational-orchestrator.ts';
import { createGitRuntimePreflight, GitIssueVerifier, RuntimePreflightError } from '../runtime/git-runtime.ts';
import { GitWorkspaceManager, RuntimeWorkspaceError } from '../runtime/git-workspace.ts';
import { GithubShipper } from '../runtime/github-shipper.ts';
import {
	abandonOperatorIssue,
	type CreatedOperatorIssue,
	createOperatorIssue,
	IssueIntakeError,
	parseOperatorIssueInput,
	parseOperatorSpecInput,
	specifyOperatorIssue,
} from '../runtime/issue-intake.ts';
import {
	RunRuntime,
	type RunRuntimeOptions,
	RuntimeConflictError,
	RuntimeUnavailableError,
} from '../runtime/run-runtime.ts';
import { type OrchestratorMessage, type RunEvent, RunStore } from '../runtime/run-store.ts';
import { NativeProviderAuth, type ProviderAuth } from '../runtime/provider-auth.ts';
import { RUNTIME_SOURCE_REF } from '../runtime/source-ref.ts';
import { GSHIP_VERSION } from '../version.ts';
import { resolveWebAssets, serveWebAsset } from './web-assets.ts';

export const DEFAULT_WEB_PORT = 7777;
export const WEB_HOSTNAME = '127.0.0.1';

export interface WebServerOptions {
	port: number;
	cwd: string;
	/** Injectable durable run runtime. Production defaults to .gship/runtime.sqlite. */
	runRuntime?: RunRuntime;
	/** Test seam for the remote-main operator issue writer. */
	issueIntake?: (input: unknown) => CreatedOperatorIssue;
	/** Test seam for promoting an existing idea with the operator contract. */
	issueSpecifier?: (id: string, input: unknown) => CreatedOperatorIssue;
	/** Test seam for closing an open issue with a durable justification. */
	issueAbandoner?: (id: string, input: unknown) => CreatedOperatorIssue;
	/** Test seam for credential-blind provider status and managed Codex login. */
	providerAuth?: ProviderAuth;
	/**
	 * Test seam for the read-only conversational facade. It is built over the
	 * deterministic command executor the production orchestrator also runs on.
	 */
	orchestrator?: (
		execute: (command: OrchestratorCommand) => Promise<string>,
	) => OrchestratorRuntime;
}

export interface OrchestratorRuntime {
	listMessages(limit?: number): OrchestratorMessage[];
	turn(text: string): Promise<OrchestratorTurnResult>;
	stop(): Promise<void>;
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

async function listProviders(
	providerAuth: ProviderAuth,
	runtime: RunRuntime,
): Promise<Response> {
	try {
		return Response.json({
			providers: await providerAuth.list(),
			selected: runtime.getSelectedProvider(),
		});
	} catch (error) {
		return Response.json(
			{
				ok: false,
				code: 'provider-status-failed',
				message: error instanceof Error ? error.message : String(error),
			},
			{ status: 503 },
		);
	}
}

async function selectProvider(
	request: Request,
	providerId: string,
	providerAuth: ProviderAuth,
	runtime: RunRuntime,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	if (providerId !== 'claude' && providerId !== 'codex') {
		return Response.json(
			{ ok: false, code: 'invalid-provider', message: 'Unknown provider.' },
			{ status: 400 },
		);
	}
	const status = (await providerAuth.list()).find((provider) => provider.id === providerId);
	if (status?.subscription !== true) {
		return Response.json(
			{
				ok: false,
				code: 'provider-not-connected',
				message: 'Connect a subscription before selecting this provider.',
			},
			{ status: 409 },
		);
	}
	runtime.selectProvider(providerId);
	return Response.json({ ok: true, selected: providerId });
}

async function startCodexLogin(request: Request, providerAuth: ProviderAuth): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	try {
		return Response.json({ ok: true, login: await providerAuth.startCodexLogin() });
	} catch (error) {
		return Response.json(
			{
				ok: false,
				code: 'provider-login-failed',
				message: error instanceof Error ? error.message : String(error),
			},
			{ status: 503 },
		);
	}
}

async function converse(
	request: Request,
	orchestrator: OrchestratorRuntime,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'Uma mensagem JSON é obrigatória.' },
			{ status: 400 },
		);
	}
	const message = body !== null && typeof body === 'object'
		? (body as { message?: unknown }).message
		: undefined;
	if (typeof message !== 'string' || message.trim().length === 0) {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'Uma mensagem não vazia é obrigatória.' },
			{ status: 400 },
		);
	}
	try {
		const turn = await orchestrator.turn(message);
		return Response.json({ ok: true, turn, messages: orchestrator.listMessages() });
	} catch (error) {
		const busy = error instanceof OrchestratorBusyError;
		return Response.json(
			{
				ok: false,
				code: busy ? 'orchestrator-busy' : 'orchestrator-failed',
				message: error instanceof Error ? error.message : String(error),
			},
			{ status: busy ? 409 : 503 },
		);
	}
}

async function specifyIssueFromOperator(
	request: Request,
	id: string,
	issueSpecifier: (id: string, input: unknown) => CreatedOperatorIssue,
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
		const input = parseOperatorSpecInput(body);
		return Response.json({ ok: true, issue: issueSpecifier(id, input) });
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
export function createRunEventStream(
	runtime: RunRuntime,
	request: Request,
	server: Pick<Bun.Server<unknown>, 'timeout'>,
): Response {
	// Bun closes quiet responses after ten seconds by default. SSE connections
	// are intentionally long-lived and may be quiet between run transitions.
	server.timeout(request, 0);
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

async function startDurableRun(
	request: Request,
	runtime: RunRuntime,
): Promise<Response> {
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

async function readOptionalOperatorGuidance(
	request: Request,
): Promise<string | Response | undefined> {
	if (request.headers.get('content-type')?.includes('application/json') !== true) return undefined;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A resposta deve ser um objeto JSON.' },
			{ status: 400 },
		);
	}
	const message = body !== null && typeof body === 'object'
		? (body as { message?: unknown }).message
		: undefined;
	if (typeof message !== 'string' || message.trim().length === 0) {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'Uma resposta não vazia é obrigatória.' },
			{ status: 400 },
		);
	}
	return message.trim();
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
	const operatorGuidance = await readOptionalOperatorGuidance(request);
	if (operatorGuidance instanceof Response) return operatorGuidance;
	try {
		return Response.json(
			{ ok: true, run: runtime.resumeRun(runId, operatorGuidance) },
			{ status: 202 },
		);
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

function readRunEvents(runtime: RunRuntime, runId: string): Response {
	if (runtime.getRun(runId) === null) {
		return Response.json(
			{ ok: false, code: 'run-not-found', message: 'Run not found.' },
			{ status: 404 },
		);
	}
	return Response.json({ events: runtime.listRunEvents(runId) });
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
 * Derive the idle backlog from the runtime source ref, the same ref a new run
 * is admitted against: an issue a merge already shipped stops being plannable
 * here even while the local `main` is deliberately behind.
 *
 * This is a pure ref read, never a fetch. Refreshing the source ref belongs to
 * the start of a run and to the terminal of a ship, not to a route the browser
 * polls.
 */
function readIdleSnapshotState(cwd: string): { backlog: BacklogJsonView } {
	let backlog: BacklogJsonView;
	try {
		backlog = deriveBacklogJson(readBacklogFromMain(cwd, spawnSync, RUNTIME_SOURCE_REF));
	} catch {
		backlog = deriveBacklogJson([]);
	}
	return { backlog };
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
		executor: new AgentExecutorRouter({
			claude: new ClaudeCliExecutor(),
			codex: new CodexCliExecutor(),
		}),
		verifier: new GitIssueVerifier(),
		reviewer: new AgentReviewerRouter({
			claude: new ClaudeCliReviewer(),
			codex: new CodexCliReviewer(),
		}),
		shipper: new GithubShipper(),
		preflight: createGitRuntimePreflight(cwd),
		workspace: new GitWorkspaceManager(cwd, undefined, undefined, RUNTIME_SOURCE_REF),
	};
}

async function executeOrchestratorCommand(
	command: OrchestratorCommand,
	runtime: RunRuntime,
	issueIntake: (input: unknown) => CreatedOperatorIssue,
	issueSpecifier: (id: string, input: unknown) => CreatedOperatorIssue,
	issueAbandoner: (id: string, input: unknown) => CreatedOperatorIssue,
): Promise<string> {
	switch (command.type) {
		case 'none':
			return 'Nenhum comando solicitado.';
		case 'create_issue': {
			const issue = issueIntake(command);
			return `${issue.id} criada no backlog.`;
		}
		case 'specify_issue': {
			const issue = issueSpecifier(command.issueId, command);
			return `${issue.id} especificada no backlog.`;
		}
		case 'abandon_issue': {
			const issue = issueAbandoner(command.issueId, command);
			return `${issue.id} abandonada no backlog.`;
		}
		case 'start_run': {
			const run = runtime.startRun(command.issueId);
			return `Run ${run.id} iniciada para ${run.issueId}.`;
		}
		case 'resume_run': {
			const run = runtime.resumeRun(command.runId, command.guidance);
			return `Run ${run.id} retomada.`;
		}
		case 'cancel_run': {
			const run = await runtime.cancelRun(command.runId);
			if (run === null) throw new Error(`run not found: ${command.runId}`);
			return `Run ${run.id} está ${run.state}.`;
		}
		case 'ship_run': {
			const run = runtime.shipRun(command.runId);
			return `Ship da run ${run.id} iniciado.`;
		}
	}
}

function createDefaultOrchestrator(
	cwd: string,
	runtime: RunRuntime,
	execute: (command: OrchestratorCommand) => Promise<string>,
): ConversationalOrchestrator {
	return new ConversationalOrchestrator({
		cwd,
		persistence: runtime,
		sessions: {
			claude: new ClaudeAgentSession(),
			codex: new CodexAgentSession(),
		},
		context: () => ({
			provider: runtime.getSelectedProvider(),
			backlog: readIdleSnapshotState(cwd).backlog,
			runs: runtime.listRuns(10),
			workspaceNotices: runtime.listWorkspaceNotices(),
		}),
		execute,
	});
}

/** Each operator issue writer defaults to the remote-main publisher for this cwd. */
function resolveIssueWriters(options: WebServerOptions): {
	issueIntake: (input: unknown) => CreatedOperatorIssue;
	issueSpecifier: (id: string, input: unknown) => CreatedOperatorIssue;
	issueAbandoner: (id: string, input: unknown) => CreatedOperatorIssue;
} {
	return {
		issueIntake: options.issueIntake
			?? ((input) => createOperatorIssue(options.cwd, input)),
		issueSpecifier: options.issueSpecifier
			?? ((id, input) => specifyOperatorIssue(options.cwd, id, input)),
		issueAbandoner: options.issueAbandoner
			?? ((id, input) => abandonOperatorIssue(options.cwd, id, input)),
	};
}

/** Start the localhost-only web server. Port 0 is supported for test callers. */
export function startWebServer(options: WebServerOptions): WebServerHandle {
	const ownsRunRuntime = options.runRuntime === undefined;
	const ownsProviderAuth = options.providerAuth === undefined;
	const ownsOrchestrator = options.orchestrator === undefined;
	const runRuntime = options.runRuntime
		?? new RunRuntime(createDefaultRunRuntimeOptions(options.cwd));
	const { issueIntake, issueSpecifier, issueAbandoner } = resolveIssueWriters(options);
	const providerAuth = options.providerAuth ?? new NativeProviderAuth();
	const execute = (command: OrchestratorCommand): Promise<string> =>
		executeOrchestratorCommand(command, runRuntime, issueIntake, issueSpecifier, issueAbandoner);
	const orchestrator = options.orchestrator?.(execute)
		?? createDefaultOrchestrator(options.cwd, runRuntime, execute);
	const assets = resolveWebAssets();
	const server = Bun.serve({
		hostname: WEB_HOSTNAME,
		port: options.port,
		routes: {
			'/': () => serveWebAsset(assets.indexHtml),
			'/app.js': () => serveWebAsset(assets.appJs),
			'/app.css': () => serveWebAsset(assets.appCss),
			'/api/snapshot': () => {
				const snapshot: Record<string, unknown> = {
					idleState: readIdleSnapshotState(options.cwd),
					version: GSHIP_VERSION,
				};
				const workspaceNotices = runRuntime.listWorkspaceNotices();
				if (workspaceNotices.length > 0) snapshot['workspaceNotices'] = workspaceNotices;
				return Response.json(snapshot);
			},
			'/api/runs': {
				GET: () => Response.json({ runs: runRuntime.listRuns() }),
				POST: (request) => startDurableRun(request, runRuntime),
			},
			'/api/providers': () => listProviders(providerAuth, runRuntime),
			'/api/chat': {
				GET: () => Response.json({ messages: orchestrator.listMessages() }),
				POST: (request) => converse(request, orchestrator),
			},
			'/api/providers/:providerId/select': {
				POST: (request) => selectProvider(
					request,
					request.params.providerId,
					providerAuth,
					runRuntime,
				),
			},
			'/api/providers/codex/login': {
				POST: (request) => startCodexLogin(request, providerAuth),
			},
			'/api/issues': {
				POST: (request) => createIssueFromOperator(request, issueIntake),
			},
			'/api/issues/:issueId/spec': {
				POST: (request) => specifyIssueFromOperator(
					request,
					request.params.issueId,
					issueSpecifier,
				),
			},
			'/api/runs/:runId/cancel': {
				POST: (request) => cancelDurableRun(request, runRuntime, request.params.runId),
			},
			'/api/runs/:runId/events': {
				GET: (request) => readRunEvents(runRuntime, request.params.runId),
			},
			'/api/runs/:runId/resume': {
				POST: (request) => resumeDurableRun(request, runRuntime, request.params.runId),
			},
			'/api/runs/:runId/ship': {
				POST: (request) => shipDurableRun(request, runRuntime, request.params.runId),
			},
			'/api/events': (request, requestServer) =>
				createRunEventStream(runRuntime, request, requestServer),
		},
	});

	const { hostname, port } = server;
	if (hostname === undefined || port === undefined) void server.stop(true);
	if (hostname === undefined || port === undefined) {
		throw new Error('Bun.serve did not report its resolved TCP address');
	}

	let stopped = false;
	return {
		hostname,
		port,
		stop: async () => {
			if (stopped) return;
			stopped = true;
			if (ownsOrchestrator) await orchestrator.stop();
			await runRuntime.stop();
			if (ownsProviderAuth) await providerAuth.close();
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
			`gship: failed to bind --port ${options.port} on ${WEB_HOSTNAME}`,
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
