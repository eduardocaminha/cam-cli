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
import type { AgentProviderId } from '../runtime/agent-session.ts';
import { AgentExecutorRouter } from '../runtime/agent-executor-router.ts';
import { AgentReviewerRouter } from '../runtime/agent-reviewer-router.ts';
import { ClaudeAgentSession, ClaudeCliExecutor, probeClaudeModel } from '../runtime/claude-cli-executor.ts';
import { ClaudeCliReviewer } from '../runtime/claude-cli-reviewer.ts';
import { CodexAgentSession, CodexCliExecutor, probeCodexModel } from '../runtime/codex-cli-executor.ts';
import { CodexCliReviewer } from '../runtime/codex-cli-reviewer.ts';
import {
	ConversationalOrchestrator,
	type OrchestratorCommand,
	OrchestratorBusyError,
	type OrchestratorTurnResult,
} from '../runtime/conversational-orchestrator.ts';
import {
	createGitRuntimePreflight,
	defaultRunGit,
	GitEvidenceChecker,
	GitFullVerifier,
	GitIssueVerifier,
	RuntimePreflightError,
} from '../runtime/git-runtime.ts';
import { GitWorkspaceManager, RuntimeWorkspaceError } from '../runtime/git-workspace.ts';
import { GithubShipper } from '../runtime/github-shipper.ts';
import {
	abandonOperatorIssue,
	approveOperatorIssue,
	type CreatedOperatorIssue,
	createOperatorIssue,
	IssueIntakeError,
	parseOperatorAbandonInput,
	parseOperatorIssueInput,
	parseOperatorSpecInput,
	specifyOperatorIssue,
} from '../runtime/issue-intake.ts';
import {
	changedModelSlots,
	emptyModelSettings,
	isModelProvider,
	isModelRole,
	type ModelProbeResult,
	type ModelRole,
	type ModelSettings,
	type ModelSlot,
	type ModelSlotResolver,
} from '../runtime/model-settings.ts';
import { ProposalTransitionError } from '../runtime/run-proposal.ts';
import {
	type ChainPauseView,
	RunRuntime,
	type RunRuntimeOptions,
	RuntimeConflictError,
	RuntimeUnavailableError,
} from '../runtime/run-runtime.ts';
import {
	type OrchestratorMessage,
	PROJECT_BRIEF_LIMITS,
	type ProjectBrief,
	type RunEvent,
	RunStore,
} from '../runtime/run-store.ts';
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
	issueIntake?: (input: unknown, options?: { approve?: boolean }) => CreatedOperatorIssue;
	/** Test seam for promoting an existing idea with the operator contract. */
	issueSpecifier?: (id: string, input: unknown) => CreatedOperatorIssue;
	/** Test seam for approving an existing specified issue. */
	issueApprover?: (id: string) => CreatedOperatorIssue;
	/** Test seam for closing an open issue with a durable justification. */
	issueAbandoner?: (id: string, input: unknown) => CreatedOperatorIssue;
	/** Test seam for credential-blind provider status and managed Codex login. */
	providerAuth?: ProviderAuth;
	/** Test seam for probing a chosen model/effort against the provider's own CLI. */
	modelProber?: ModelProber;
	/** Test seam for the operator-maintained project brief. */
	projectBrief?: ProjectBriefAccess;
	/**
	 * Test seam for the read-only conversational facade. It is built over the
	 * deterministic command executor the production orchestrator also runs on.
	 */
	orchestrator?: (
		execute: (command: OrchestratorCommand) => Promise<string>,
	) => OrchestratorRuntime;
	/**
	 * Test seam for the commit the running binary was compiled from (GSHIP-648).
	 * Production reads `readBuildSha()`, which only resolves to something other
	 * than null inside a binary `scripts/build-release.sh` produced. `undefined`
	 * defers to that real read; `null` or a string is taken verbatim, including a
	 * sha that does not resolve in the local repository.
	 */
	buildSha?: string | null;
}

export interface OrchestratorRuntime {
	listMessages(limit?: number): OrchestratorMessage[];
	turn(text: string): Promise<OrchestratorTurnResult>;
	stop(): Promise<void>;
}

export interface ProjectBriefAccess {
	get(): ProjectBrief;
	set(brief: ProjectBrief): void;
}

function briefList(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) {
		throw new IssueIntakeError('invalid-request', `${label} deve ser uma lista de textos.`, 400);
	}
	if (value.length > PROJECT_BRIEF_LIMITS.listItems) {
		throw new IssueIntakeError(
			'invalid-request',
			`${label} aceita no máximo ${PROJECT_BRIEF_LIMITS.listItems} itens.`,
			400,
		);
	}
	const items: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string') {
			throw new IssueIntakeError('invalid-request', `${label} deve ser uma lista de textos.`, 400);
		}
		if (item.length > PROJECT_BRIEF_LIMITS.itemLength) {
			throw new IssueIntakeError(
				'invalid-request',
				`Cada item de ${label} aceita no máximo ${PROJECT_BRIEF_LIMITS.itemLength} caracteres.`,
				400,
			);
		}
		const trimmed = item.trim();
		if (trimmed.length > 0) items.push(trimmed);
	}
	return items;
}

/**
 * The brief is a whole record overwritten by the operator, so the four fields
 * are required. Anything oversized is refused instead of silently truncated:
 * the durable read path clamps defensively, the write path never guesses.
 */
export function parseProjectBriefInput(value: unknown): ProjectBrief {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new IssueIntakeError('invalid-request', 'Um objeto JSON é obrigatório.', 400);
	}
	const input = value as Record<string, unknown>;
	const objective = input['objective'];
	if (typeof objective !== 'string') {
		throw new IssueIntakeError('invalid-request', 'Objetivo deve ser um texto.', 400);
	}
	if (objective.length > PROJECT_BRIEF_LIMITS.objective) {
		throw new IssueIntakeError(
			'invalid-request',
			`Objetivo aceita no máximo ${PROJECT_BRIEF_LIMITS.objective} caracteres.`,
			400,
		);
	}
	return {
		objective: objective.trim(),
		decisions: briefList(input['decisions'], 'Decisões'),
		constraints: briefList(input['constraints'], 'Restrições'),
		openItems: briefList(input['openItems'], 'Itens em aberto'),
	};
}

function jsonObjectInput(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new IssueIntakeError('invalid-request', `${label} deve ser um objeto JSON.`, 400);
	}
	return value as Record<string, unknown>;
}

/**
 * One configured argv element. An absent or blank value clears the slot, which
 * is how the operator goes back to the CLI default. Anything else is checked for
 * SHAPE only -- a single token with no whitespace -- because the list of valid
 * models and efforts belongs to the CLI, not to Gateship.
 */
function parseModelToken(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') {
		throw new IssueIntakeError('invalid-request', `${label} deve ser um texto.`, 400);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	if (/\s/.test(trimmed)) {
		throw new IssueIntakeError(
			'invalid-request',
			`${label} não pode conter espaço em branco.`,
			400,
		);
	}
	return trimmed;
}

function parseModelSlot(value: unknown, label: string): { model?: string; effort?: string } {
	const slot = jsonObjectInput(value, label);
	for (const field of Object.keys(slot)) {
		if (field !== 'model' && field !== 'effort') {
			throw new IssueIntakeError('invalid-request', `${label} tem campo desconhecido: ${field}.`, 400);
		}
	}
	const model = parseModelToken(slot['model'], `Modelo de ${label}`);
	const effort = parseModelToken(slot['effort'], `Effort de ${label}`);
	return {
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort }),
	};
}

/**
 * The whole per-role record is overwritten at once. An unknown provider or role
 * is refused instead of dropped, so a typo never reads back as "not configured".
 */
export function parseModelSettingsInput(value: unknown): ModelSettings {
	const input = jsonObjectInput(value, 'A configuração de modelos');
	const settings = emptyModelSettings();
	for (const [provider, roles] of Object.entries(input)) {
		if (!isModelProvider(provider)) {
			throw new IssueIntakeError('invalid-request', `Provider desconhecido: ${provider}.`, 400);
		}
		for (const [role, slot] of Object.entries(jsonObjectInput(roles, `O provider ${provider}`))) {
			if (!isModelRole(role)) {
				throw new IssueIntakeError('invalid-request', `Papel desconhecido: ${role}.`, 400);
			}
			settings[provider][role] = parseModelSlot(slot, `${provider}/${role}`);
		}
	}
	return settings;
}

/**
 * GSHIP-620: validates a chosen model/effort by asking the provider's own CLI,
 * instead of Gateship keeping a catalog of valid names. A test seam stands in
 * for the real child-process probe below.
 */
export interface ModelProber {
	probe(
		providerId: AgentProviderId,
		role: ModelRole,
		slot: ModelSlot,
		cwd: string,
	): Promise<ModelProbeResult>;
}

/** Routes to the real read-only probe each provider adapter already owns. */
export class NativeModelProber implements ModelProber {
	probe(providerId: AgentProviderId, _role: ModelRole, slot: ModelSlot, cwd: string): Promise<ModelProbeResult> {
		return providerId === 'codex' ? probeCodexModel(slot, cwd) : probeClaudeModel(slot, cwd);
	}
}

export type ModelProbeReport = Partial<Record<AgentProviderId, Partial<Record<ModelRole, ModelProbeResult>>>>;

/**
 * Probes only the slots whose model or effort changed, in parallel, so saving
 * one field never spawns six processes. A slot the CLI explicitly refuses
 * keeps its previously stored value; an inconclusive probe still saves the new
 * one, since refusing on an ambiguous result would lock the operator out of
 * Ajustes while offline.
 */
async function resolveModelSettingsWrite(
	previous: ModelSettings,
	next: ModelSettings,
	prober: ModelProber,
	cwd: string,
): Promise<{ settings: ModelSettings; probes: ModelProbeReport }> {
	const toProbe = changedModelSlots(previous, next).filter(({ provider, role }) => {
		const slot = next[provider][role];
		return slot.model !== undefined || slot.effort !== undefined;
	});
	const settings = next;
	const probes: ModelProbeReport = {};
	await Promise.all(toProbe.map(async ({ provider, role }) => {
		const result = await prober.probe(provider, role, next[provider][role], cwd);
		(probes[provider] ??= {})[role] = result;
		if (result.outcome === 'refused') settings[provider][role] = previous[provider][role];
	}));
	return { settings, probes };
}

async function writeModelSettings(
	request: Request,
	runtime: RunRuntime,
	prober: ModelProber,
	cwd: string,
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
		const next = parseModelSettingsInput(body);
		const previous = runtime.getModelSettings();
		const { settings, probes } = await resolveModelSettingsWrite(previous, next, prober, cwd);
		runtime.setModelSettings(settings);
		return Response.json({ ok: true, settings: runtime.getModelSettings(), probes });
	} catch (error) {
		if (!(error instanceof IssueIntakeError)) throw error;
		return Response.json(
			{ ok: false, code: error.code, message: error.message },
			{ status: error.status },
		);
	}
}

/** The switch plus, when the queue is stopped, why (GSHIP-638). */
function chainRunsSnapshot(runtime: RunRuntime): { enabled: boolean; pause: ChainPauseView | null } {
	return { enabled: runtime.getChainRuns(), pause: runtime.getChainPause() };
}

async function writeChainRuns(request: Request, runtime: RunRuntime): Promise<Response> {
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
	const enabled = body !== null && typeof body === 'object'
		? (body as { enabled?: unknown }).enabled
		: undefined;
	if (typeof enabled !== 'boolean') {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: '"enabled" deve ser um booleano.' },
			{ status: 400 },
		);
	}
	runtime.setChainRuns(enabled);
	return Response.json({ ok: true, ...chainRunsSnapshot(runtime) });
}

async function writeProjectBrief(
	request: Request,
	projectBrief: ProjectBriefAccess,
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
		projectBrief.set(parseProjectBriefInput(body));
		return Response.json({ ok: true, brief: projectBrief.get() });
	} catch (error) {
		if (!(error instanceof IssueIntakeError)) throw error;
		return Response.json(
			{ ok: false, code: error.code, message: error.message },
			{ status: error.status },
		);
	}
}

async function createIssueFromOperator(
	request: Request,
	issueIntake: (input: unknown, options?: { approve?: boolean }) => CreatedOperatorIssue,
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

/**
 * The issue file belongs to the run while one is in flight. The shipper closes
 * the issue on the run's branch and never on main, so a write here during a run
 * is a guaranteed conflict at ship time: refuse before any git work happens.
 */
function assertIssueFileIsFree(runtime: RunRuntime, issueId: string): void {
	const active = runtime.findActiveRunForIssue(issueId);
	if (active === null) return;
	throw new IssueIntakeError(
		'issue-run-active',
		`${issueId} está sendo executada pela run ${active.id} (${active.state});`
		+ ' o arquivo da issue pertence a ela até a run terminar.',
		409,
	);
}

async function specifyIssueFromOperator(
	request: Request,
	id: string,
	runtime: RunRuntime,
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
		assertIssueFileIsFree(runtime, id);
		return Response.json({ ok: true, issue: issueSpecifier(id, input) });
	} catch (error) {
		if (!(error instanceof IssueIntakeError)) throw error;
		return Response.json(
			{ ok: false, code: error.code, message: error.message },
			{ status: error.status },
		);
	}
}

async function approveIssueFromOperator(
	request: Request,
	id: string,
	runtime: RunRuntime,
	issueApprover: (id: string) => CreatedOperatorIssue,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	try {
		assertIssueFileIsFree(runtime, id);
		return Response.json({ ok: true, issue: issueApprover(id) });
	} catch (error) {
		if (!(error instanceof IssueIntakeError)) throw error;
		return Response.json(
			{ ok: false, code: error.code, message: error.message },
			{ status: error.status },
		);
	}
}

/**
 * Close one open issue without shipping it. Same run-active guard as every
 * other issue write, checked before the abandon itself touches git.
 */
async function abandonIssueFromOperator(
	request: Request,
	id: string,
	runtime: RunRuntime,
	issueAbandoner: (id: string, input: unknown) => CreatedOperatorIssue,
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
		const input = parseOperatorAbandonInput(body);
		assertIssueFileIsFree(runtime, id);
		return Response.json({ ok: true, issue: issueAbandoner(id, input) });
	} catch (error) {
		if (!(error instanceof IssueIntakeError)) throw error;
		return Response.json(
			{ ok: false, code: error.code, message: error.message },
			{ status: error.status },
		);
	}
}

/** Both operator refusals already carry the code, message and status to answer. */
function refusalResponse(error: IssueIntakeError | ProposalTransitionError): Response {
	return Response.json(
		{ ok: false, code: error.code, message: error.message },
		{ status: error.status },
	);
}

/**
 * Discard one captured idea. The proposal is the only record that changes: no
 * issue is written, no run is touched, and a proposal already settled refuses
 * instead of being discarded twice.
 */
function dismissProposalFromOperator(
	request: Request,
	runtime: RunRuntime,
	proposalId: string,
): Response {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	try {
		return Response.json({ ok: true, proposal: runtime.dismissProposal(proposalId) });
	} catch (error) {
		if (!(error instanceof ProposalTransitionError)) throw error;
		return refusalResponse(error);
	}
}

/**
 * Turn one captured idea into a filed issue, with the title, scope and command
 * the operator authored here -- never the captured evidence. The order is what
 * makes it safe: the proposal is checked pending first so a settled one never
 * files anything, the existing intake writes the issue without approving it,
 * and only a published issue marks the proposal promoted. A failing intake
 * therefore leaves the proposal pending and retryable.
 */
async function promoteProposalFromOperator(
	request: Request,
	runtime: RunRuntime,
	proposalId: string,
	issueIntake: (input: unknown, options?: { approve?: boolean }) => CreatedOperatorIssue,
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
		const proposal = runtime.getProposal(proposalId);
		if (proposal === null) {
			throw new ProposalTransitionError(
				'proposal-not-found',
				`Proposta ${proposalId} não existe.`,
				404,
			);
		}
		if (proposal.status !== 'pending') {
			throw new ProposalTransitionError(
				'proposal-not-pending',
				`Proposta ${proposalId} já está ${proposal.status}.`,
				409,
			);
		}
		const issue = issueIntake(input, { approve: false });
		return Response.json({
			ok: true,
			issue,
			proposal: runtime.promoteProposal(proposalId, issue.id),
		});
	} catch (error) {
		if (error instanceof IssueIntakeError || error instanceof ProposalTransitionError) {
			return refusalResponse(error);
		}
		throw error;
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

/**
 * End an interrupted run without resuming its provider session. Only that state
 * admits the action: done, failed and cancelled are terminal and refuse it, and
 * cancelling an active run still produces a resumable interrupted run.
 */
function abandonDurableRun(
	request: Request,
	runtime: RunRuntime,
	runId: string,
): Response {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	if (runtime.getRun(runId) === null) {
		return Response.json(
			{ ok: false, code: 'run-not-found', message: 'Run not found.' },
			{ status: 404 },
		);
	}
	try {
		return Response.json({ ok: true, run: runtime.abandonRun(runId) });
	} catch (error) {
		return Response.json(
			{
				ok: false,
				code: 'run-not-abandonable',
				message: error instanceof Error ? error.message : String(error),
			},
			{ status: 409 },
		);
	}
}

/**
 * The run list with each run's total cost attached (GSHIP-623), derived from
 * the complete event log rather than any display-bounded read, so the number
 * the card shows can never be shrunk by a read limit. The breakdown by role
 * and model rides along on the same read: the run the operator is looking at
 * is always `runs[0]`, so there is no separate route to keep in sync with it.
 */
function listRunsWithCost(runtime: RunRuntime): unknown[] {
	return runtime.listRuns().map((run) => ({ ...run, cost: runtime.getRunCost(run.id) }));
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
 * The running process is older than the code it reads from: what it loaded at
 * boot no longer matches `origin/main`. It is the common cause behind a missing
 * table, a missing route and a security fix that is silently off, so the
 * snapshot says so instead of leaving the operator to infer it.
 *
 * It is informative only: nothing here refuses a run, an approval, a promotion
 * or a ship, and a restart makes it disappear on its own.
 */
interface StaleServiceNotice {
	/**
	 * The commit the running binary was compiled from (GSHIP-648) when it was
	 * built by `scripts/build-release.sh`; otherwise `origin/main` at the
	 * moment this process started, same as before that build sha existed.
	 */
	bootSha: string;
	/** `origin/main` right now. */
	currentSha: string;
	detail: string;
}

/**
 * Resolve the runtime source ref, or null when it cannot be read. Like the
 * backlog read above this is a pure ref read, never a fetch: refreshing the ref
 * belongs to the start of a run and to the terminal of a ship.
 */
function readSourceSha(cwd: string): string | null {
	const result = defaultRunGit(cwd, ['rev-parse', '--verify', RUNTIME_SOURCE_REF]);
	if (result.exitCode !== 0) return null;
	const sha = result.stdout.trim();
	return sha.length === 0 ? null : sha;
}

/**
 * `scripts/build-release.sh` bakes the commit it compiled into each binary
 * with `bun build --define GSHIP_BUILD_SHA='"<sha>"'`. Running from source --
 * `bun run`, `bun test`, `bun x gship` -- there is no such global: `typeof` on
 * an undeclared identifier never throws, so the read degrades to null instead
 * of crashing (GSHIP-648).
 */
declare const GSHIP_BUILD_SHA: string | undefined;

function readBuildSha(): string | null {
	return typeof GSHIP_BUILD_SHA === 'string' ? GSHIP_BUILD_SHA : null;
}

/**
 * Single files the running process loads at boot: the entrypoint itself, and
 * the two manifests that pin what `bun` installs.
 */
const LOADED_FILES = ['index.ts', 'package.json', 'bun.lock'];

/**
 * Directories the running process loads at boot, per the import graph rooted
 * at `index.ts`: everything under `src/`, and the browser UI under `webui/src/`.
 * The bundle this process actually serves lives at `webui/dist/`, but that is a
 * build output and is no longer tracked, so a commit can only ever show up here
 * as the source it was built from. Anything else -- docs, `test/`, `.github/`,
 * `scripts/`, `.gateship/` -- changes the tree without changing what this
 * process has in memory.
 */
const LOADED_DIR_PREFIXES = ['src/', 'webui/src/'];

function isLoadedPath(path: string): boolean {
	return LOADED_FILES.includes(path) || LOADED_DIR_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Whether the two shas differ on any path the running process actually loads
 * -- true if so, false if every changed path falls outside that set, null
 * when the listing itself failed. A caller that can't tell loaded code from
 * everything else must not guess: null is its own outcome, never coerced to
 * true or false.
 */
function changedPathsTouchCode(cwd: string, bootSha: string, currentSha: string): boolean | null {
	const result = defaultRunGit(cwd, ['diff', '--name-only', bootSha, currentSha]);
	if (result.exitCode !== 0) return null;
	return result.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.some((path) => isLoadedPath(path));
}

/**
 * Compare the sha this process booted on with the current one. A sha that
 * cannot be resolved -- on either side -- is unknown, not divergent: the
 * notice is omitted rather than invented. Same for the changed-path listing:
 * a diff that touches nothing the process loads, or one that can't be listed
 * at all, omits the notice rather than firing on unrelated churn or a guess.
 */
function staleServiceNotice(cwd: string, bootSha: string | null): StaleServiceNotice | null {
	if (bootSha === null) return null;
	const currentSha = readSourceSha(cwd);
	if (currentSha === null || currentSha === bootSha) return null;
	if (changedPathsTouchCode(cwd, bootSha, currentSha) !== true) return null;
	return {
		bootSha,
		currentSha,
		detail: `O serviço está rodando o código de ${RUNTIME_SOURCE_REF} no boot (${bootSha}),`
			+ ` e ${RUNTIME_SOURCE_REF} já está em ${currentSha}.`
			+ ' Reinicie o serviço para aplicar o que entrou depois do boot.',
	};
}

/**
 * One adapter's slot, read at the moment it spawns a child. The adapter holds
 * this function, never a value, so an Ajustes change reaches the next run
 * without restarting the service.
 */
function modelResolver(
	read: () => ModelSettings,
	providerId: AgentProviderId,
	role: ModelRole,
): ModelSlotResolver {
	return () => read()[providerId][role];
}

/**
 * Production composition of the durable runtime: the real implementer, the
 * real oracle verifier, the real full-project verifier (GSHIP-649), the real
 * independent reviewer and the real GitHub shipper over one sqlite store.
 */
export function createDefaultRunRuntimeOptions(cwd: string): RunRuntimeOptions {
	const store = new RunStore(join(cwd, '.gship', 'runtime.sqlite'));
	const model = (providerId: AgentProviderId, role: ModelRole) =>
		modelResolver(() => store.getModelSettings(), providerId, role);
	return {
		cwd,
		store,
		executor: new AgentExecutorRouter({
			claude: new ClaudeCliExecutor({ resolveModel: model('claude', 'executor') }),
			codex: new CodexCliExecutor({ resolveModel: model('codex', 'executor') }),
		}),
		verifier: new GitIssueVerifier(),
		fullVerifier: new GitFullVerifier(),
		reviewer: new AgentReviewerRouter({
			claude: new ClaudeCliReviewer({ resolveModel: model('claude', 'reviewer') }),
			codex: new CodexCliReviewer({ resolveModel: model('codex', 'reviewer') }),
		}),
		shipper: new GithubShipper(),
		preflight: createGitRuntimePreflight(cwd),
		evidenceCheck: new GitEvidenceChecker(),
		workspace: new GitWorkspaceManager(cwd, undefined, undefined, RUNTIME_SOURCE_REF),
		// Chain selection (GSHIP-638) reads the same source ref a new run is
		// admitted against, so a just-shipped issue is never re-offered.
		listBacklog: () => readBacklogFromMain(cwd, spawnSync, RUNTIME_SOURCE_REF),
	};
}

async function executeOrchestratorCommand(
	command: OrchestratorCommand,
	runtime: RunRuntime,
	issueIntake: (input: unknown, options?: { approve?: boolean }) => CreatedOperatorIssue,
	issueSpecifier: (id: string, input: unknown) => CreatedOperatorIssue,
	issueApprover: (id: string) => CreatedOperatorIssue,
	issueAbandoner: (id: string, input: unknown) => CreatedOperatorIssue,
): Promise<string> {
	switch (command.type) {
		case 'none':
			return 'Nenhum comando solicitado.';
		case 'create_issue': {
			const issue = issueIntake(command);
			return `${issue.id} criada no backlog.`;
		}
		case 'create_and_start_issue': {
			const issue = issueIntake(command, { approve: true });
			// The publication is already durable: a failing start must report the
			// created id instead of escaping as a generic refusal.
			try {
				const run = runtime.startRun(issue.id);
				return `${issue.id} criada no backlog e run ${run.id} iniciada.`;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return `${issue.id} criada no backlog, mas a run não iniciou: ${reason}.`
					+ ` Use start_run com ${issue.id} quando quiser iniciá-la.`;
			}
		}
		// The three typed commands that rewrite an existing issue file ask the same
		// ownership question the operator routes ask, so a conversation cannot do
		// on main what the screen refuses while a run is in flight.
		case 'specify_issue': {
			assertIssueFileIsFree(runtime, command.issueId);
			const issue = issueSpecifier(command.issueId, command);
			return `${issue.id} especificada no backlog.`;
		}
		case 'approve_issue': {
			assertIssueFileIsFree(runtime, command.issueId);
			const issue = issueApprover(command.issueId);
			return `${issue.id} aprovada no backlog.`;
		}
		case 'abandon_issue': {
			assertIssueFileIsFree(runtime, command.issueId);
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
		case 'abandon_run': {
			const run = runtime.abandonRun(command.runId);
			return `Run ${run.id} abandonada sem retomar o provider.`;
		}
		case 'ship_run': {
			const run = runtime.shipRun(command.runId);
			return `Ship da run ${run.id} iniciado.`;
		}
	}
}

/**
 * Limits enforced when pending proposals ride along in the orchestrator
 * context: a large inbox must not dominate the prompt, and how many
 * proposals were left out of the window is always reported, never silently
 * dropped.
 */
const ORCHESTRATOR_PENDING_PROPOSALS_LIMITS = {
	maxItems: 5,
	evidence: 200,
} as const;

interface OrchestratorPendingProposalView {
	id: string;
	title: string;
	evidence: string;
	sourceIssueId: string;
	sourceRunId: string;
	createdAt: string;
}

interface OrchestratorPendingProposalsView {
	pending: OrchestratorPendingProposalView[];
	omittedCount: number;
}

/**
 * The most recent pending proposals, read through the same
 * `listPendingProposals` the operator's inbox API already uses (GSHIP-635).
 * Undefined when nothing is pending, so an idle inbox leaves the snapshot
 * exactly as it read before this existed.
 */
function readPendingProposalsContext(runtime: RunRuntime): OrchestratorPendingProposalsView | undefined {
	const all = runtime.listPendingProposals();
	if (all.length === 0) return undefined;
	const { maxItems, evidence: evidenceLimit } = ORCHESTRATOR_PENDING_PROPOSALS_LIMITS;
	const kept = all.slice(-maxItems);
	const pending = kept.map((proposal) => ({
		id: proposal.id,
		title: proposal.title,
		evidence: proposal.evidence.length > evidenceLimit
			? `${proposal.evidence.slice(0, evidenceLimit)}…`
			: proposal.evidence,
		sourceIssueId: proposal.sourceIssueId,
		sourceRunId: proposal.sourceRunId,
		createdAt: proposal.createdAt,
	}));
	return { pending, omittedCount: all.length - kept.length };
}

/**
 * The read-only snapshot handed to every orchestrator turn. Exported for
 * direct unit coverage: the production context lives inside a closure that
 * also wires a live provider CLI, which a unit test has no reason to spin up.
 */
export function buildOrchestratorContext(cwd: string, runtime: RunRuntime) {
	const pendingProposals = readPendingProposalsContext(runtime);
	return {
		provider: runtime.getSelectedProvider(),
		backlog: readIdleSnapshotState(cwd).backlog,
		runs: runtime.listRuns(10),
		workspaceNotices: runtime.listWorkspaceNotices(),
		...(pendingProposals === undefined ? {} : { pendingProposals }),
	};
}

function createDefaultOrchestrator(
	cwd: string,
	runtime: RunRuntime,
	execute: (command: OrchestratorCommand) => Promise<string>,
): ConversationalOrchestrator {
	const model = (providerId: AgentProviderId) =>
		modelResolver(() => runtime.getModelSettings(), providerId, 'orchestrator');
	return new ConversationalOrchestrator({
		cwd,
		persistence: runtime,
		sessions: {
			claude: new ClaudeAgentSession({ resolveModel: model('claude') }),
			codex: new CodexAgentSession({ resolveModel: model('codex') }),
		},
		context: () => buildOrchestratorContext(cwd, runtime),
		execute,
	});
}

/** Each operator issue writer defaults to the remote-main publisher for this cwd. */
function resolveIssueWriters(options: WebServerOptions): {
	issueIntake: (input: unknown, options?: { approve?: boolean }) => CreatedOperatorIssue;
	issueSpecifier: (id: string, input: unknown) => CreatedOperatorIssue;
	issueApprover: (id: string) => CreatedOperatorIssue;
	issueAbandoner: (id: string, input: unknown) => CreatedOperatorIssue;
} {
	return {
		issueIntake: options.issueIntake
			?? ((input, intakeOptions) => createOperatorIssue(options.cwd, input, intakeOptions)),
		issueSpecifier: options.issueSpecifier
			?? ((id, input) => specifyOperatorIssue(options.cwd, id, input)),
		issueApprover: options.issueApprover
			?? ((id) => approveOperatorIssue(options.cwd, id)),
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
	const { issueIntake, issueSpecifier, issueApprover, issueAbandoner } = resolveIssueWriters(options);
	const providerAuth = options.providerAuth ?? new NativeProviderAuth();
	const modelProber = options.modelProber ?? new NativeModelProber();
	const projectBrief = options.projectBrief ?? {
		get: () => runRuntime.getProjectBrief(),
		set: (brief: ProjectBrief) => runRuntime.setProjectBrief(brief),
	};
	const execute = (command: OrchestratorCommand): Promise<string> =>
		executeOrchestratorCommand(
			command, runRuntime, issueIntake, issueSpecifier, issueApprover, issueAbandoner,
		);
	const orchestrator = options.orchestrator?.(execute)
		?? createDefaultOrchestrator(options.cwd, runRuntime, execute);
	const assets = resolveWebAssets();
	// Read once, at boot, and kept in memory: it is what this process loaded, so
	// no later read of the ref can change it short of a restart. The compiled
	// build sha (GSHIP-648) is preferred when the binary carries one, since it
	// names the commit the executable actually came from rather than the ref
	// this process happened to read at start; a source run falls back to the
	// ref read exactly as before that sha existed.
	const buildSha = options.buildSha !== undefined ? options.buildSha : readBuildSha();
	const bootSourceSha = buildSha ?? readSourceSha(options.cwd);
	const server = Bun.serve({
		hostname: WEB_HOSTNAME,
		port: options.port,
		routes: {
			// The operator surfaces are four enumerated paths, each answered with
			// the same document; the client reads which one it is from the path.
			// There is no catch-all, so an unknown path is still a 404.
			'/': () => serveWebAsset(assets.indexHtml),
			'/runs': () => serveWebAsset(assets.indexHtml),
			'/work': () => serveWebAsset(assets.indexHtml),
			'/settings': () => serveWebAsset(assets.indexHtml),
			'/app.js': () => serveWebAsset(assets.appJs),
			'/app.css': () => serveWebAsset(assets.appCss),
			'/api/snapshot': () => {
				const snapshot: Record<string, unknown> = {
					idleState: readIdleSnapshotState(options.cwd),
					version: GSHIP_VERSION,
				};
				const workspaceNotices = runRuntime.listWorkspaceNotices();
				if (workspaceNotices.length > 0) snapshot['workspaceNotices'] = workspaceNotices;
				// Its own field: `workspaceNotices` means a preserved local resource
				// waiting for a decision, which this is not.
				const staleService = staleServiceNotice(options.cwd, bootSourceSha);
				if (staleService !== null) snapshot['staleService'] = staleService;
				return Response.json(snapshot);
			},
			'/api/runs': {
				GET: () => Response.json({ runs: listRunsWithCost(runRuntime) }),
				POST: (request) => startDurableRun(request, runRuntime),
			},
			'/api/providers': () => listProviders(providerAuth, runRuntime),
			// The read stays unguarded like every other GET: a same-origin browser
			// read sends no Origin header, and 127.0.0.1 is the read boundary.
			//
			// The automatic handoff rides along on the same read because the screen
			// shows it beside the brief the operator is correcting. It is the
			// orchestrator's own record, so it has no write here and never gets one:
			// the PUT below takes the brief and nothing else.
			'/api/brief': {
				GET: () => Response.json({
					brief: projectBrief.get(),
					handoff: runRuntime.getOrchestratorHandoff(),
				}),
				PUT: (request) => writeProjectBrief(request, projectBrief),
			},
			// The per-role model and effort choice. The read is unguarded like every
			// other GET; the write is same-origin, and an empty slot means the CLI
			// default keeps deciding.
			'/api/model-settings': {
				GET: () => Response.json({ settings: runRuntime.getModelSettings() }),
				PUT: (request) => writeModelSettings(request, runRuntime, modelProber, options.cwd),
			},
			// The chain switch (GSHIP-638), stored beside the provider and the model
			// slots. The read is unguarded like every other GET; the write is
			// same-origin, and it starts nothing itself -- it only flips the switch
			// the next terminal transition reads.
			'/api/chain-runs': {
				GET: () => Response.json(chainRunsSnapshot(runRuntime)),
				PUT: (request) => writeChainRuns(request, runRuntime),
			},
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
					runRuntime,
					issueSpecifier,
				),
			},
			'/api/issues/:issueId/approve': {
				POST: (request) => approveIssueFromOperator(
					request,
					request.params.issueId,
					runRuntime,
					issueApprover,
				),
			},
			'/api/issues/:issueId/abandon': {
				POST: (request) => abandonIssueFromOperator(
					request,
					request.params.issueId,
					runRuntime,
					issueAbandoner,
				),
			},
			// The inbox is the pending proposals alone: a settled one stays durable
			// in the store and leaves the list the operator is deciding on.
			'/api/proposals': {
				GET: () => Response.json({ proposals: runRuntime.listPendingProposals() }),
			},
			// Read-only history of settled proposals, distinct from the pending
			// inbox above: a dismissed one and a promoted one, the latter carrying
			// the issue it became (GSHIP-643).
			'/api/proposals/resolved': {
				GET: () => {
					const { proposals, omittedCount } = runRuntime.listResolvedProposals();
					return Response.json({ proposals, omittedCount });
				},
			},
			'/api/proposals/:proposalId/dismiss': {
				POST: (request) => dismissProposalFromOperator(
					request,
					runRuntime,
					request.params.proposalId,
				),
			},
			'/api/proposals/:proposalId/promote': {
				POST: (request) => promoteProposalFromOperator(
					request,
					runRuntime,
					request.params.proposalId,
					issueIntake,
				),
			},
			'/api/runs/:runId/cancel': {
				POST: (request) => cancelDurableRun(request, runRuntime, request.params.runId),
			},
			'/api/runs/:runId/abandon': {
				POST: (request) => abandonDurableRun(request, runRuntime, request.params.runId),
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
