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
import { fingerprintSpec } from '../issues/spec.ts';
import type { IssueEntry } from '../issues/types.ts';
import { printError } from '../logging/color.ts';
import { ProviderCallError, type AgentProviderId } from '../runtime/agent-session.ts';
import { AgentExecutorRouter } from '../runtime/agent-executor-router.ts';
import { AgentCycleQuestionResolver } from '../runtime/agent-cycle-question-resolver.ts';
import { AgentReviewerRouter } from '../runtime/agent-reviewer-router.ts';
import { ClaudeAgentSession, ClaudeCliExecutor, probeClaudeModel } from '../runtime/claude-cli-executor.ts';
import { ClaudeCliReviewer } from '../runtime/claude-cli-reviewer.ts';
import {
	CodexAgentSession,
	CodexCliExecutor,
	CodexReviewSession,
	probeCodexModel,
} from '../runtime/codex-cli-executor.ts';
import { CodexCliReviewer } from '../runtime/codex-cli-reviewer.ts';
import {
	ConversationalOrchestrator,
	type OrchestratorCommand,
	OrchestratorBusyError,
	type OrchestratorTurnResult,
} from '../runtime/conversational-orchestrator.ts';
import { DiagnosticTransitionError } from '../runtime/diagnostic-finding.ts';
import {
	DIAGNOSTIC_CADENCES,
	type DiagnosticCadence,
} from '../runtime/diagnostic-schedule.ts';
import {
	DiagnosticsRuntime,
	DiagnosticRuntimeError,
	GitDiagnosticWorkspace,
	ReactDoctorAdapter,
} from '../runtime/diagnostics.ts';
import { checkGitIdentity, ensureGitIdentity, type GitIdentityResult } from '../runtime/git-identity.ts';
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
import {
	canonicalTimeZone,
	OPERATOR_PROFILE_LIMITS,
	type OperatorProfile,
} from '../runtime/operator-profile.ts';
import {
	createRemoteNotifier,
	isNtfyConfigured,
	RESEND_FIELD_LABELS,
	RESEND_SETTING_MAX_LENGTH,
	removeResendApiKey,
	resolveResendStatus,
	sendNtfyTestNotification,
	sendResendTestNotification,
	writeResendApiKey,
	writeResendSettings,
} from '../runtime/remote-notifier.ts';
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
import { isTerminalRunState } from '../runtime/run-state.ts';
import { NativeProviderAuth, type ProviderAuth } from '../runtime/provider-auth.ts';
import { ensureCodexHome } from '../runtime/provider-env.ts';
import { inspectProject } from '../runtime/project-readiness.ts';
import { RUNTIME_SOURCE_REF } from '../runtime/source-ref.ts';
import { SelfUpdateRuntime, type SelfUpdateSnapshot } from '../runtime/self-update.ts';
import { GSHIP_VERSION } from '../version.ts';
import { resolveWebAssets, serveWebAsset } from './web-assets.ts';

export const DEFAULT_WEB_PORT = 7777;
export const WEB_HOSTNAME = '127.0.0.1';
type MaybePromise<T> = T | Promise<T>;
type IssueIntakeWriter = (
	input: unknown,
	options?: { approve?: boolean },
) => MaybePromise<CreatedOperatorIssue>;
type IssueSpecifier = (id: string, input: unknown) => MaybePromise<CreatedOperatorIssue>;
type IssueApprover = (id: string) => MaybePromise<CreatedOperatorIssue>;
type IssueAbandoner = (id: string, input: unknown) => MaybePromise<CreatedOperatorIssue>;

/**
 * Overrides the interface `Bun.serve` binds to, independent from
 * `WEB_HOSTNAME` (the trusted-origin check below, and the default every
 * non-container caller still gets). Docker's published-port proxy always
 * connects to the container's own network address, never its loopback, so a
 * process bound only to `127.0.0.1` inside the container is unreachable
 * through `-p`/compose port publishing no matter what the host maps it to.
 * The browser still only ever presents an Origin of `127.0.0.1` or
 * `localhost`, because the container image keeps the published host port
 * restricted to loopback (see compose.yaml); only the bind address changes.
 */
export const BIND_HOSTNAME_ENV_VAR = 'GATESHIP_BIND_HOST';

export interface WebServerOptions {
	port: number;
	cwd: string;
	/** Injectable durable run runtime. Production defaults to .gship/runtime.sqlite. */
	runRuntime?: RunRuntime;
	/** Injectable in-process diagnostic owner. Production uses the same SQLite file. */
	diagnostics?: DiagnosticsRuntime;
	/** Injectable native updater. Production owns one over the runtime database. */
	selfUpdate?: SelfUpdateAccess;
	/** Test seam for the remote-main operator issue writer. */
	issueIntake?: IssueIntakeWriter;
	/** Test seam for promoting an existing idea with the operator contract. */
	issueSpecifier?: IssueSpecifier;
	/** Test seam for approving an existing specified issue. */
	issueApprover?: IssueApprover;
	/** Test seam for reading the currently published issue during agent approval. */
	issueReader?: (id: string) => IssueEntry | null;
	/** Test seam for closing an open issue with a durable justification. */
	issueAbandoner?: IssueAbandoner;
	/** Test seam for credential-blind provider status and managed Codex login. */
	providerAuth?: ProviderAuth;
	/** Test seam for probing a chosen model/effort against the provider's own CLI. */
	modelProber?: ModelProber;
	/**
	 * Test seam for the commit-path git author identity derivation (GSHIP-654):
	 * the intake and ship commit paths call this right before their own write,
	 * sharing one process-lifetime success cache. Production defaults to
	 * `ensureGitIdentity`, which is a fast no-op on any host that already has
	 * one. This never runs on the read-only snapshot path -- see
	 * `checkGitIdentity`, which that route calls directly and unconditionally,
	 * since it is cheap and safe enough to need no test seam of its own.
	 */
	ensureGitIdentity?: () => GitIdentityResult;
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

export interface SelfUpdateAccess {
	snapshot(): SelfUpdateSnapshot;
	setEnabled(enabled: boolean): SelfUpdateSnapshot;
	startScheduler(): void;
	stop(): Promise<void>;
	close?(): void;
}

export interface OrchestratorRuntime {
	listMessages(limit?: number): OrchestratorMessage[];
	turn(text: string): Promise<OrchestratorTurnResult>;
	stop(): Promise<void>;
}

export interface ProjectBriefAccess {
	get(): ProjectBrief;
	/** Persists the complete brief and atomically invalidates automatic handoff. */
	set(brief: ProjectBrief): void;
}

function briefList(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) {
		throw new IssueIntakeError('invalid-request', `${label} must be a list of strings.`, 400);
	}
	if (value.length > PROJECT_BRIEF_LIMITS.listItems) {
		throw new IssueIntakeError(
			'invalid-request',
			`${label} accepts at most ${PROJECT_BRIEF_LIMITS.listItems} items.`,
			400,
		);
	}
	const items: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string') {
			throw new IssueIntakeError('invalid-request', `${label} must be a list of strings.`, 400);
		}
		if (item.length > PROJECT_BRIEF_LIMITS.itemLength) {
			throw new IssueIntakeError(
				'invalid-request',
				`Each ${label} item accepts at most ${PROJECT_BRIEF_LIMITS.itemLength} characters.`,
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
		throw new IssueIntakeError('invalid-request', 'A JSON object is required.', 400);
	}
	const input = value as Record<string, unknown>;
	const objective = input['objective'];
	if (typeof objective !== 'string') {
		throw new IssueIntakeError('invalid-request', 'Objective must be a string.', 400);
	}
	if (objective.length > PROJECT_BRIEF_LIMITS.objective) {
		throw new IssueIntakeError(
			'invalid-request',
			`Objective accepts at most ${PROJECT_BRIEF_LIMITS.objective} characters.`,
			400,
		);
	}
	return {
		objective: objective.trim(),
		decisions: briefList(input['decisions'], 'Decisions'),
		constraints: briefList(input['constraints'], 'Constraints'),
		openItems: briefList(input['openItems'], 'Open items'),
	};
}

export function parseOperatorProfileInput(value: unknown): OperatorProfile {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new IssueIntakeError('invalid-request', 'A JSON object is required.', 400);
	}
	const input = value as Record<string, unknown>;
	const name = input['name'];
	const timezoneInput = input['timezone'];
	if (typeof name !== 'string' || typeof timezoneInput !== 'string') {
		throw new IssueIntakeError('invalid-request', 'Nome e timezone devem ser textos.', 400);
	}
	if (name.length > OPERATOR_PROFILE_LIMITS.name || /[\u0000-\u001f\u007f]/.test(name)) {
		throw new IssueIntakeError(
			'invalid-request',
			`Name accepts up to ${OPERATOR_PROFILE_LIMITS.name} characters on one line.`,
			400,
		);
	}
	const timezone = canonicalTimeZone(timezoneInput);
	if (timezone === null) {
		throw new IssueIntakeError(
			'invalid-request',
			'Timezone must be a valid IANA identifier, such as America/Sao_Paulo.',
			400,
		);
	}
	return { name: name.trim(), timezone };
}

function jsonObjectInput(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new IssueIntakeError('invalid-request', `${label} must be a JSON object.`, 400);
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
		throw new IssueIntakeError('invalid-request', `${label} must be a string.`, 400);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	if (/\s/.test(trimmed)) {
		throw new IssueIntakeError(
			'invalid-request',
			`${label} cannot contain whitespace.`,
			400,
		);
	}
	return trimmed;
}

function parseModelSlot(value: unknown, label: string): { model?: string; effort?: string } {
	const slot = jsonObjectInput(value, label);
	for (const field of Object.keys(slot)) {
		if (field !== 'model' && field !== 'effort') {
			throw new IssueIntakeError('invalid-request', `${label} has an unknown field: ${field}.`, 400);
		}
	}
	const model = parseModelToken(slot['model'], `${label} model`);
	const effort = parseModelToken(slot['effort'], `${label} effort`);
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
	const input = jsonObjectInput(value, 'Model configuration');
	const settings = emptyModelSettings();
	for (const [provider, roles] of Object.entries(input)) {
		if (!isModelProvider(provider)) {
			throw new IssueIntakeError('invalid-request', `Unknown provider: ${provider}.`, 400);
		}
		for (const [role, slot] of Object.entries(jsonObjectInput(roles, `Provider ${provider}`))) {
			if (!isModelRole(role)) {
				throw new IssueIntakeError('invalid-request', `Unknown role: ${role}.`, 400);
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
			{ ok: false, code: 'invalid-request', message: 'A JSON object is required.' },
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
			{ ok: false, code: 'invalid-request', message: 'A JSON object is required.' },
			{ status: 400 },
		);
	}
	const enabled = body !== null && typeof body === 'object'
		? (body as { enabled?: unknown }).enabled
		: undefined;
	if (typeof enabled !== 'boolean') {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: '"enabled" must be a boolean.' },
			{ status: 400 },
		);
	}
	runtime.setChainRuns(enabled);
	return Response.json({ ok: true, ...chainRunsSnapshot(runtime) });
}

/** Safe notification status; the Resend key itself is structurally absent. */
function notificationChannelsSnapshot(cwd: string): Record<string, unknown> {
	const resend = resolveResendStatus(cwd);
	return {
		ntfy: { configured: isNtfyConfigured(cwd), missing: [] },
		resend: {
			configured: resend.configured,
			missing: resend.missing.map((field) => RESEND_FIELD_LABELS[field]),
			from: resend.from,
			to: resend.to,
			fileCredentialExists: resend.fileCredentialExists,
			externallyManaged: resend.externallyManaged,
		},
	};
}

function resendSettingsValue(body: Record<string, unknown>, field: 'from' | 'to'): string | null {
	const value = body[field];
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= RESEND_SETTING_MAX_LENGTH ? trimmed : null;
}

async function writeResendConfiguration(request: Request, cwd: string): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let input: unknown;
	try {
		input = await request.json();
	} catch {
		return Response.json({ ok: false, code: 'invalid-request', message: 'A JSON object is required.' }, { status: 400 });
	}
	if (input === null || typeof input !== 'object') {
		return Response.json({ ok: false, code: 'invalid-request', message: 'A JSON object is required.' }, { status: 400 });
	}
	const body = input as Record<string, unknown>;
	const from = resendSettingsValue(body, 'from');
	const to = resendSettingsValue(body, 'to');
	const apiKey = body.apiKey;
	if (from === null || to === null || typeof apiKey !== 'string') {
		return Response.json({
			ok: false,
			code: 'invalid-request',
			message: `Sender and recipient must be non-empty strings of at most ${RESEND_SETTING_MAX_LENGTH} characters; API key must be a string.`,
		}, { status: 400 });
	}

	try {
		writeResendSettings(cwd, from, to);
		if (apiKey.trim().length > 0) writeResendApiKey(cwd, apiKey);
	} catch {
		return Response.json({ ok: false, code: 'write-failed', message: 'Resend settings could not be saved.' }, { status: 500 });
	}
	const status = resolveResendStatus(cwd);
	const external = Object.entries(status.externallyManaged)
		.filter(([, managed]) => managed)
		.map(([field]) => RESEND_FIELD_LABELS[field as keyof typeof RESEND_FIELD_LABELS]);
	return Response.json({
		ok: true,
		message: external.length === 0
			? 'Resend settings saved.'
			: `Resend file settings saved. Environment-managed ${external.join(', ')} remain effective.`,
		channels: notificationChannelsSnapshot(cwd),
	});
}

function removeResendCredential(request: Request, cwd: string): Response {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let removed: boolean;
	try {
		removed = removeResendApiKey(cwd);
	} catch {
		return Response.json({ ok: false, code: 'remove-failed', message: 'The file-backed Resend credential could not be removed.' }, { status: 500 });
	}
	const environmentWins = resolveResendStatus(cwd).externallyManaged.apiKey;
	const action = removed ? 'File-backed Resend credential removed.' : 'No file-backed Resend credential was present.';
	return Response.json({
		ok: true,
		message: environmentWins ? `${action} The environment-managed API key remains effective.` : action,
		channels: notificationChannelsSnapshot(cwd),
	});
}

interface NotificationChannelTest {
	send: (cwd: string) => Promise<{ outcome: string; detail?: string }>;
	label: string;
	sentMessage: string;
}

const NOTIFICATION_CHANNEL_TESTS: Readonly<Record<string, NotificationChannelTest>> = {
	ntfy: {
		send: (cwd) => sendNtfyTestNotification({ cwd }),
		label: 'ntfy',
		sentMessage: 'Test message delivered to ntfy.',
	},
	resend: {
		send: (cwd) => sendResendTestNotification({ cwd }),
		label: 'Resend',
		sentMessage: 'Test message delivered by email.',
	},
};

/**
 * Fires a real delivery through the named channel and reports only whether it
 * was accepted (GSHIP-652, GSHIP-653): the secret itself never enters this
 * response, on any outcome -- a partial Resend configuration names which
 * values are missing, never their values.
 */
async function sendNotificationChannelTest(request: Request, cwd: string, channelId: string): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	// `Object.hasOwn` guards the lookup itself: `channelId` is attacker-controlled
	// request input, and a plain `NOTIFICATION_CHANNEL_TESTS[channelId]` resolves
	// inherited `Object.prototype` members (`toString`, `constructor`, `valueOf`,
	// `__proto__`) to defined values, so `test === undefined` alone never catches
	// them -- the request would fall through to `test.send is not a function`.
	const test = Object.hasOwn(NOTIFICATION_CHANNEL_TESTS, channelId)
		? NOTIFICATION_CHANNEL_TESTS[channelId]
		: undefined;
	if (test === undefined) {
		return Response.json(
			{ ok: false, code: 'unknown-channel', message: `Unknown channel: "${channelId}".` },
			{ status: 404 },
		);
	}
	const result = await test.send(cwd);
	if (result.outcome === 'sent') {
		return Response.json({ ok: true, outcome: result.outcome, message: test.sentMessage });
	}
	if (result.outcome === 'not-configured') {
		return Response.json(
			{
				ok: false,
				code: 'not-configured',
				outcome: result.outcome,
				message: `Channel ${test.label} is not configured`
					+ `${result.detail === undefined ? '' : ` (missing: ${result.detail})`}.`,
			},
			{ status: 409 },
		);
	}
	return Response.json(
		{
			ok: false,
			code: 'delivery-failed',
			outcome: result.outcome,
			message: `${test.label} rejected the test${result.detail === undefined ? '' : ` (${result.detail})`}.`,
		},
		{ status: 502 },
	);
}

async function writeProjectBrief(
	request: Request,
	projectBrief: ProjectBriefAccess,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	const authorization = request.headers.get('x-gateship-operator-authorization');
	if (commandSource(request) === 'agent-cli'
		&& (authorization === null || authorization.trim().length === 0)) {
		return Response.json(
			{ ok: false, code: 'authorization-required', message: 'Explicit operator authorization is required to update the project brief.' },
			{ status: 403 },
		);
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A JSON object is required.' },
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

async function writeOperatorProfile(request: Request, runtime: RunRuntime): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A JSON object is required.' },
			{ status: 400 },
		);
	}
	try {
		runtime.setOperatorProfile(parseOperatorProfileInput(body));
		return Response.json({ ok: true, profile: runtime.getOperatorProfile() });
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
	issueIntake: IssueIntakeWriter,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A JSON object is required.' },
			{ status: 400 },
		);
	}
	try {
		const input = parseOperatorIssueInput(body);
		return Response.json({ ok: true, issue: await issueIntake(input) }, { status: 201 });
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
		// Claude's usage is derived from this process's own event log (GSHIP-664),
		// never from a live provider call -- the opposite of Codex's `usage`,
		// which the ProviderAuth implementation already attached per provider.
		const claudeUsageWindows = runtime.getClaudeUsageWindows();
		const providers = (await providerAuth.list()).map((provider) => {
			const availability = runtime.getProviderWait(provider.id);
			const claudeUsage = provider.id === 'claude' && claudeUsageWindows.length > 0
				? { windows: claudeUsageWindows }
				: undefined;
			return {
				...provider,
				...(availability === null ? {} : { availability }),
				...(claudeUsage === undefined ? {} : { usage: claudeUsage }),
			};
		});
		return Response.json({
			providers,
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
			{ ok: false, code: 'invalid-request', message: 'A JSON message is required.' },
			{ status: 400 },
		);
	}
	const message = body !== null && typeof body === 'object'
		? (body as { message?: unknown }).message
		: undefined;
	if (typeof message !== 'string' || message.trim().length === 0) {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A non-empty message is required.' },
			{ status: 400 },
		);
	}
	try {
		const turn = await orchestrator.turn(message);
		return Response.json({ ok: true, turn, messages: orchestrator.listMessages() });
	} catch (error) {
		return orchestratorFailureResponse(error);
	}
}

function orchestratorFailureResponse(error: unknown): Response {
	if (error instanceof OrchestratorBusyError) {
		return Response.json(
			{ ok: false, code: 'orchestrator-busy', message: error.message },
			{ status: 409 },
		);
	}
	if (error instanceof ProviderCallError) {
		return Response.json({
			ok: false,
			code: `provider-${error.kind}`,
			message: error.message,
			provider: error.provider,
			kind: error.kind,
			...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
		}, { status: 503 });
	}
	return Response.json(
		{
			ok: false,
			code: 'orchestrator-failed',
			message: error instanceof Error ? error.message : String(error),
		},
		{ status: 503 },
	);
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
		`${issueId} is being executed by run ${active.id} (${active.state});`
		+ ' the issue file belongs to it until the run ends.',
		409,
	);
}

async function specifyIssueFromOperator(
	request: Request,
	id: string,
	runtime: RunRuntime,
	issueSpecifier: IssueSpecifier,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A JSON object is required.' },
			{ status: 400 },
		);
	}
	try {
		const input = parseOperatorSpecInput(body);
		assertIssueFileIsFree(runtime, id);
		return Response.json({ ok: true, issue: await issueSpecifier(id, input) });
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
	issueApprover: IssueApprover,
	issueReader: (id: string) => IssueEntry | null,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	try {
		if (commandSource(request) === 'agent-cli') await assertAgentApproval(request, id, issueReader);
		assertIssueFileIsFree(runtime, id);
		return Response.json({ ok: true, issue: await issueApprover(id) });
	} catch (error) {
		if (!(error instanceof IssueIntakeError)) throw error;
		return Response.json(
			{ ok: false, code: error.code, message: error.message },
			{ status: error.status },
		);
	}
}

async function assertAgentApproval(
	request: Request,
	id: string,
	issueReader: (id: string) => IssueEntry | null,
): Promise<void> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new IssueIntakeError('authorization-required', 'Fingerprint and explicit operator authorization are required.', 403);
	}
	const input = body !== null && typeof body === 'object' && !Array.isArray(body)
		? body as Record<string, unknown> : {};
	const authorization = input['authorization'];
	if (typeof authorization !== 'string' || authorization.trim().length === 0) {
		throw new IssueIntakeError('authorization-required', 'Explicit operator authorization is required to approve an issue.', 403);
	}
	const current = issueReader(id);
	if (current === null || current.spec === undefined) {
		throw new IssueIntakeError('issue-not-found', `${id} does not have a current executable specification.`, 404);
	}
	if (input['fingerprint'] !== fingerprintSpec(current.spec)) {
		throw new IssueIntakeError('fingerprint-mismatch', 'The issue specification changed; read the issue again before approval.', 409);
	}
}

function commandSource(request: Request): 'agent-cli' | undefined {
	return request.headers.get('x-gateship-command-source') === 'agent-cli' ? 'agent-cli' : undefined;
}

function readPublishedIssues(cwd: string): IssueEntry[] {
	return readBacklogFromMain(cwd, spawnSync, RUNTIME_SOURCE_REF);
}

function readPublishedIssue(cwd: string, id: string): IssueEntry | null {
	return readPublishedIssues(cwd).find((issue) => issue.id === id) ?? null;
}

function resolveIssueReader(options: WebServerOptions): (id: string) => IssueEntry | null {
	return options.issueReader ?? ((id: string) => readPublishedIssue(options.cwd, id));
}

function listPublishedIssues(cwd: string): Response {
	try {
		return Response.json({ issues: readPublishedIssues(cwd) });
	} catch (error) {
		return Response.json(
			{ ok: false, code: 'backlog-unavailable', message: error instanceof Error ? error.message : String(error) },
			{ status: 503 },
		);
	}
}

function readPublishedIssueResponse(issueReader: (id: string) => IssueEntry | null, id: string): Response {
	try {
		const issue = issueReader(id);
		if (issue === null) {
			return Response.json({ ok: false, code: 'issue-not-found', message: 'Issue not found.' }, { status: 404 });
		}
		return Response.json({
			issue,
			...(issue.spec === undefined ? {} : { fingerprint: fingerprintSpec(issue.spec) }),
		});
	} catch (error) {
		return Response.json(
			{ ok: false, code: 'backlog-unavailable', message: error instanceof Error ? error.message : String(error) },
			{ status: 503 },
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
	issueAbandoner: IssueAbandoner,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A JSON object is required.' },
			{ status: 400 },
		);
	}
	try {
		const input = parseOperatorAbandonInput(body);
		assertIssueFileIsFree(runtime, id);
		return Response.json({ ok: true, issue: await issueAbandoner(id, input) });
	} catch (error) {
		if (!(error instanceof IssueIntakeError)) throw error;
		return Response.json(
			{ ok: false, code: error.code, message: error.message },
			{ status: error.status },
		);
	}
}

/** Operator refusals already carry the code, message and status to answer. */
function refusalResponse(
	error:
		| IssueIntakeError
		| ProposalTransitionError
		| DiagnosticTransitionError
		| DiagnosticRuntimeError,
): Response {
	return Response.json(
		{ ok: false, code: error.code, message: error.message },
		{ status: error.status },
	);
}

async function startDiagnosticFromOperator(
	request: Request,
	diagnostics: DiagnosticsRuntime,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A JSON object is required.' },
			{ status: 400 },
		);
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A JSON object is required.' },
			{ status: 400 },
		);
	}
	const analyzer = (body as Record<string, unknown>)['analyzer'];
	if (typeof analyzer !== 'string' || analyzer.trim().length === 0) {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'Analyzer is required.' },
			{ status: 400 },
		);
	}
	try {
		return Response.json({ ok: true, scan: diagnostics.start(analyzer.trim()) }, { status: 202 });
	} catch (error) {
		if (!(error instanceof DiagnosticRuntimeError)) throw error;
		return refusalResponse(error);
	}
}

async function writeDiagnosticSchedule(
	request: Request,
	diagnostics: DiagnosticsRuntime,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A JSON object is required.' },
			{ status: 400 },
		);
	}
	const record = body !== null && typeof body === 'object' && !Array.isArray(body)
		? body as Record<string, unknown>
		: {};
	const enabled = record['enabled'];
	const cadence = record['cadence'];
	if (typeof enabled !== 'boolean'
		|| typeof cadence !== 'string'
		|| !DIAGNOSTIC_CADENCES.includes(cadence as DiagnosticCadence)) {
		return Response.json(
			{
				ok: false,
				code: 'invalid-request',
				message: 'A agenda exige "enabled" booleano e cadence daily ou weekly.',
			},
			{ status: 400 },
		);
	}
	diagnostics.setSchedule({ enabled, cadence: cadence as DiagnosticCadence });
	const outcome = diagnostics.runScheduledIfDue();
	return Response.json({ ok: true, schedule: diagnostics.getSchedule(), outcome });
}

async function writeSelfUpdatePolicy(
	request: Request,
	selfUpdate: SelfUpdateAccess,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ ok: false, message: 'A JSON object is required.' }, { status: 400 });
	}
	const enabled = body !== null && typeof body === 'object' && !Array.isArray(body)
		? (body as Record<string, unknown>)['enabled']
		: undefined;
	if (typeof enabled !== 'boolean') {
		return Response.json({ ok: false, message: 'enabled must be boolean.' }, { status: 400 });
	}
	return Response.json({ ok: true, update: selfUpdate.setEnabled(enabled) });
}

async function cancelDiagnosticFromOperator(
	request: Request,
	diagnostics: DiagnosticsRuntime,
	scanId: string,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	try {
		return Response.json({ ok: true, scan: await diagnostics.cancel(scanId) });
	} catch (error) {
		if (!(error instanceof DiagnosticRuntimeError)) throw error;
		return refusalResponse(error);
	}
}

function dismissDiagnosticFindingFromOperator(
	request: Request,
	diagnostics: DiagnosticsRuntime,
	findingId: string,
): Response {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	try {
		return Response.json({ ok: true, finding: diagnostics.dismissFinding(findingId) });
	} catch (error) {
		if (!(error instanceof DiagnosticTransitionError)) throw error;
		return refusalResponse(error);
	}
}

async function promoteDiagnosticFindingFromOperator(
	request: Request,
	diagnostics: DiagnosticsRuntime,
	findingId: string,
	issueIntake: IssueIntakeWriter,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A JSON object is required.' },
			{ status: 400 },
		);
	}
	try {
		const input = parseOperatorIssueInput(body);
		const finding = diagnostics.getFinding(findingId);
		if (finding === null) {
			throw new DiagnosticTransitionError(
				'diagnostic-finding-not-found',
				`Diagnostic finding ${findingId} does not exist.`,
				404,
			);
		}
		if (finding.status !== 'pending') {
			throw new DiagnosticTransitionError(
				'diagnostic-finding-not-pending',
				`Diagnostic finding ${findingId} is already ${finding.status}.`,
				409,
			);
		}
		const issue = await issueIntake(input, { approve: false });
		return Response.json({
			ok: true,
			issue,
			finding: diagnostics.promoteFinding(findingId, issue.id),
		});
	} catch (error) {
		if (error instanceof IssueIntakeError || error instanceof DiagnosticTransitionError) {
			return refusalResponse(error);
		}
		throw error;
	}
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
	issueIntake: IssueIntakeWriter,
): Promise<Response> {
	if (!isTrustedCommandOrigin(request)) return forbiddenOriginResponse();
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A JSON object is required.' },
			{ status: 400 },
		);
	}
	try {
		const input = parseOperatorIssueInput(body);
		const proposal = runtime.getProposal(proposalId);
		if (proposal === null) {
			throw new ProposalTransitionError(
				'proposal-not-found',
				`Proposal ${proposalId} does not exist.`,
				404,
			);
		}
		if (proposal.status !== 'pending') {
			throw new ProposalTransitionError(
				'proposal-not-pending',
				`Proposal ${proposalId} is already ${proposal.status}.`,
				409,
			);
		}
		const issue = await issueIntake(input, { approve: false });
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
		return Response.json({ ok: true, run: runtime.startRun(issueId, commandSource(request)) }, { status: 202 });
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
	const run = await runtime.cancelRun(runId, commandSource(request));
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
			{ ok: false, code: 'invalid-request', message: 'The response must be a JSON object.' },
			{ status: 400 },
		);
	}
	const message = body !== null && typeof body === 'object'
		? (body as { message?: unknown }).message
		: undefined;
	if (typeof message !== 'string' || message.trim().length === 0) {
		return Response.json(
			{ ok: false, code: 'invalid-request', message: 'A non-empty response is required.' },
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
			{ ok: true, run: runtime.resumeRun(runId, operatorGuidance, commandSource(request)) },
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
		return Response.json({ ok: true, run: runtime.abandonRun(runId, commandSource(request)) });
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
 * The run list with cost, correction origins and replayable evaluation
 * attached. All three derive from the complete event log rather than a
 * display-bounded read, and ride on the same route the screen already owns.
 */
function listRunsWithInsights(runtime: RunRuntime): unknown[] {
	return runtime.listRuns().map((run) => ({
		...run,
		cost: runtime.getRunCost(run.id),
		roundOrigins: runtime.getRunRoundOrigins(run.id),
		evaluation: runtime.getRunEvaluation(run.id),
		providerWait: runtime.getRunProviderWait(run.id),
		pullRequest: runtime.getPullRequestDelivery(run.id),
	}));
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
		return Response.json({ ok: true, run: runtime.shipRun(runId, commandSource(request)) }, { status: 202 });
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
 * with `bun build --define GSHIP_BUILD_SHA='"<sha>"'`; the Dockerfile does the
 * same from its own `GSHIP_BUILD_SHA` build arg, which is optional and
 * defaults to an empty string. Running from source -- `bun run`, `bun test`,
 * `bun x gship` -- there is no such global at all: `typeof` on an undeclared
 * identifier never throws, so the read degrades to null instead of crashing
 * (GSHIP-648). A present-but-blank global (a container built without its
 * build arg) reads as null the same way.
 */
declare const GSHIP_BUILD_SHA: string | undefined;

function readBuildSha(): string | null {
	if (typeof GSHIP_BUILD_SHA !== 'string') return null;
	const trimmed = GSHIP_BUILD_SHA.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** The Gateship checkout itself, used only by uncompiled development runs. */
function readRuntimeSourceSha(): string | null {
	const result = defaultRunGit(join(import.meta.dir, '..', '..'), ['rev-parse', '--verify', 'HEAD']);
	if (result.exitCode !== 0) return null;
	const sha = result.stdout.trim();
	return sha.length === 0 ? null : sha;
}

/**
 * A second, unconditional define the Dockerfile always bakes in, regardless
 * of whether `GSHIP_BUILD_SHA` itself was supplied (see the Dockerfile). Its
 * only job is telling apart "a container image with no known build sha" from
 * "a genuine source run with no such global at all" -- see
 * `resolveBootSourceSha`, the one place this distinction changes behavior.
 */
declare const GSHIP_CONTAINER_BUILD: string | undefined;

function isContainerBuild(): boolean {
	return typeof GSHIP_CONTAINER_BUILD === 'string';
}

/**
 * The sha `staleServiceNotice` compares the boot-time ref read against. A
 * known build sha (embedded by `build-release.sh` or the Dockerfile) is used
 * verbatim; failing that, a container image still says nothing rather than
 * fall back to reading `cwd`'s ref -- inside a container `cwd` is the project
 * being managed, not Gateship's own source tree, so that ref has nothing to
 * do with the running binary, and a container "restart" can never apply
 * newer Gateship code regardless, only a rebuilt image can. Every other
 * caller (a genuine source run, or a native binary that always carries its
 * sha) keeps exactly the boot-time ref read GSHIP-648 replaced. Exported for
 * direct unit coverage, since the compile-time globals it otherwise reads
 * cannot be faked from a `bun test` process.
 */
export function resolveBootSourceSha(
	buildSha: string | null,
	isContainer: boolean,
	readSourceShaOfCwd: () => string | null,
): string | null {
	if (buildSha !== null) return buildSha;
	return isContainer ? null : readSourceShaOfCwd();
}

/**
 * The known Gateship workflow sha, or null when none can be identified.
 * Release binaries carry a build SHA; source checkouts can read their own
 * HEAD; an installed source package or unlabelled container has neither and
 * gets null rather than an invented commit identity. Exported so the
 * `/api/snapshot` route (GSHIP-665) can tell a real sha apart from
 * `resolveWorkflowRevision`'s own public-version fallback below, which is
 * never itself a sha and must never be appended to the reported version as
 * SemVer build metadata.
 */
export function resolveWorkflowRevisionSha(
	buildSha: string | null,
	isContainer: boolean,
	readRuntimeSha: () => string | null,
): string | null {
	if (buildSha !== null) return buildSha;
	if (!isContainer) {
		const runtimeSha = readRuntimeSha();
		if (runtimeSha !== null) return runtimeSha;
	}
	return null;
}

/**
 * Identity of the Gateship workflow, never of the repository it manages. An
 * installed source package or unlabelled container falls back to the public
 * version rather than inventing a commit identity.
 */
export function resolveWorkflowRevision(
	buildSha: string | null,
	isContainer: boolean,
	readRuntimeSha: () => string | null,
): string {
	return resolveWorkflowRevisionSha(buildSha, isContainer, readRuntimeSha) ?? `v${GSHIP_VERSION}`;
}

/**
 * The snapshot's `version` field: the plain version when no workflow sha is
 * known, or that version with the sha appended as SemVer build metadata
 * otherwise (GSHIP-665) -- so the header identifies both release and
 * revision without a second field. A pure formatter, kept outside
 * `startWebServer` itself so that function's own branching stays flat.
 */
export function formatSnapshotVersion(version: string, workflowRevisionSha: string | null): string {
	return workflowRevisionSha === null ? version : `${version}+${workflowRevisionSha}`;
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
		detail: `The service booted from ${RUNTIME_SOURCE_REF} code at ${bootSha},`
			+ ` and ${RUNTIME_SOURCE_REF} is now at ${currentSha}.`
			+ ' Restart the service to apply changes that landed after boot.',
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
 *
 * `ensureIdentity` defaults to an uncached, unshared call bound to `cwd`,
 * which is what any caller other than `startWebServer` gets (existing direct
 * callers of this function, and its own tests); `startWebServer` always
 * passes its shared, process-lifetime-cached closure instead (GSHIP-654), so
 * the shipper's own commit and issue intake's agree and `gh` is queried at
 * most once per outcome across both.
 */
export function createDefaultRunRuntimeOptions(
	cwd: string,
	ensureIdentity: () => GitIdentityResult = () => ensureGitIdentity(cwd),
	workflowRevision?: string,
): RunRuntimeOptions {
	const store = new RunStore(join(cwd, '.gship', 'runtime.sqlite'));
	const model = (providerId: AgentProviderId, role: ModelRole) =>
		modelResolver(() => store.getModelSettings(), providerId, role);
	return {
		cwd,
		store,
		workflowRevision,
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
		cycleQuestionResolver: new AgentCycleQuestionResolver({
			claude: new ClaudeAgentSession({ resolveModel: model('claude', 'orchestrator') }),
			codex: new CodexReviewSession({ resolveModel: model('codex', 'orchestrator') }),
		}),
		shipper: new GithubShipper({ ensureIdentity }),
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
	issueIntake: IssueIntakeWriter,
	issueSpecifier: IssueSpecifier,
	issueApprover: IssueApprover,
	issueAbandoner: IssueAbandoner,
): Promise<string> {
	switch (command.type) {
		case 'none':
			return 'No command requested.';
		case 'update_project_brief':
			runtime.setProjectBrief(command.brief);
			return 'Project brief updated and automatic handoff cleared.';
		case 'create_issue': {
			const issue = await issueIntake(command);
			return `${issue.id} created in the backlog.`;
		}
		case 'create_and_start_issue': {
			const issue = await issueIntake(command, { approve: true });
			// The publication is already durable: a failing start must report the
			// created id instead of escaping as a generic refusal.
			try {
				const run = runtime.startRun(issue.id);
				return `${issue.id} created in the backlog and run ${run.id} started.`;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return `${issue.id} was created in the backlog, but the run did not start: ${reason}.`
					+ ` Use start_run with ${issue.id} when you want to start it.`;
			}
		}
		// The three typed commands that rewrite an existing issue file ask the same
		// ownership question the operator routes ask, so a conversation cannot do
		// on main what the screen refuses while a run is in flight.
		case 'specify_issue': {
			assertIssueFileIsFree(runtime, command.issueId);
			const issue = await issueSpecifier(command.issueId, command);
			return `${issue.id} specified in the backlog.`;
		}
		case 'approve_issue': {
			assertIssueFileIsFree(runtime, command.issueId);
			const issue = await issueApprover(command.issueId);
			return `${issue.id} approved in the backlog.`;
		}
		case 'abandon_issue': {
			assertIssueFileIsFree(runtime, command.issueId);
			const issue = await issueAbandoner(command.issueId, command);
			return `${issue.id} abandoned in the backlog.`;
		}
		case 'start_run': {
			const run = runtime.startRun(command.issueId);
			return `Run ${run.id} started for ${run.issueId}.`;
		}
		case 'resume_run': {
			const run = runtime.resumeRun(command.runId, command.guidance);
			return `Run ${run.id} retomada.`;
		}
		case 'cancel_run': {
			const run = await runtime.cancelRun(command.runId);
			if (run === null) throw new Error(`run not found: ${command.runId}`);
			return `Run ${run.id} is ${run.state}.`;
		}
		case 'abandon_run': {
			const run = runtime.abandonRun(command.runId);
			return `Run ${run.id} abandoned without resuming the provider.`;
		}
		case 'ship_run': {
			const run = runtime.shipRun(command.runId);
			return `Shipping started for run ${run.id}.`;
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
		operatorProfile: runtime.getOperatorProfile(),
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

/**
 * Each operator issue writer defaults to the remote-main publisher for this
 * cwd. `ensureIdentity` is the shared, process-lifetime-cached derive-and-
 * write `startWebServer` constructs (GSHIP-654) and also hands to the
 * shipper: each writer's own commit path calls it right before its write.
 * The read-only snapshot notice is a separate, uncached `checkGitIdentity`
 * call and never touches this.
 */
function resolveIssueWriters(
	options: WebServerOptions,
	ensureIdentity: () => GitIdentityResult,
): {
	issueIntake: IssueIntakeWriter;
	issueSpecifier: IssueSpecifier;
	issueApprover: IssueApprover;
	issueAbandoner: IssueAbandoner;
} {
	return {
		issueIntake: options.issueIntake
			?? ((input, intakeOptions) => createOperatorIssue(
				options.cwd, input, intakeOptions, undefined, ensureIdentity,
			)),
		issueSpecifier: options.issueSpecifier
			?? ((id, input) => specifyOperatorIssue(options.cwd, id, input, undefined, ensureIdentity)),
		issueApprover: options.issueApprover
			?? ((id) => approveOperatorIssue(options.cwd, id, undefined, ensureIdentity)),
		issueAbandoner: options.issueAbandoner
			?? ((id, input) => abandonOperatorIssue(options.cwd, id, input, undefined, ensureIdentity)),
	};
}

/**
 * The socket address to bind, from `GATESHIP_BIND_HOST`. Absent or blank
 * keeps `WEB_HOSTNAME`, so every non-container caller still binds exactly
 * `127.0.0.1`, same as before this existed.
 */
export function resolveBindHostname(env: Record<string, string | undefined> = process.env): string {
	const raw = env[BIND_HOSTNAME_ENV_VAR]?.trim();
	return raw !== undefined && raw.length > 0 ? raw : WEB_HOSTNAME;
}

interface DefaultSelfUpdateInput {
	options: WebServerOptions;
	runRuntime: RunRuntime;
	diagnostics: DiagnosticsRuntime;
	workflowRevisionSha: string | null;
	containerBuild: boolean;
	hostname: string;
	port: number;
	ownsRunRuntime: boolean;
}

function resolveSelfUpdate(input: DefaultSelfUpdateInput): SelfUpdateAccess {
	if (input.options.selfUpdate !== undefined) return input.options.selfUpdate;
	const databasePath = join(input.options.cwd, '.gship', 'runtime.sqlite');
	const updaterStore = new RunStore(input.ownsRunRuntime ? databasePath : ':memory:');
	const isIdle = () => input.runRuntime.listRuns(1).every((run) => isTerminalRunState(run.state))
		&& !input.diagnostics.isActive();
	return new SelfUpdateRuntime({
		store: updaterStore,
		databasePath,
		cwd: input.options.cwd,
		currentVersion: GSHIP_VERSION,
		currentCommit: input.workflowRevisionSha,
		port: input.port,
		hostname: input.hostname,
		isContainer: input.containerBuild,
		isIdle,
		acquireAdmission: () => {
			const reason = 'Gateship is handing off a native update; new work is temporarily unavailable.';
			input.runRuntime.setAdmissionBlocked(reason);
			input.diagnostics.setAdmissionBlocked(reason);
			return () => {
				input.runRuntime.setAdmissionBlocked(null);
				input.diagnostics.setAdmissionBlocked(null);
			};
		},
		requestShutdown: () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 0),
	});
}

function readSelfUpdate(selfUpdate: SelfUpdateAccess | undefined): Response {
	return selfUpdate === undefined
		? Response.json({ ok: false }, { status: 503 })
		: Response.json({ update: selfUpdate.snapshot() });
}

function updateSelfUpdate(request: Request, selfUpdate: SelfUpdateAccess | undefined): Response | Promise<Response> {
	return selfUpdate === undefined
		? Response.json({ ok: false }, { status: 503 })
		: writeSelfUpdatePolicy(request, selfUpdate);
}

/** Start the localhost-only web server. Port 0 is supported for test callers. */
export function startWebServer(options: WebServerOptions): WebServerHandle {
	const ownsRunRuntime = options.runRuntime === undefined;
	const ownsDiagnostics = options.diagnostics === undefined;
	const ownsSelfUpdate = options.selfUpdate === undefined;
	const ownsProviderAuth = options.providerAuth === undefined;
	const ownsOrchestrator = options.orchestrator === undefined;
	// Read once before constructing the runtime: every run this process creates
	// records the same Gateship revision its stale-service notice uses. A
	// container without a known build SHA falls back to the release version.
	const buildSha = options.buildSha !== undefined ? options.buildSha : readBuildSha();
	const containerBuild = isContainerBuild();
	const bootSourceSha = resolveBootSourceSha(
		buildSha,
		containerBuild,
		() => readSourceSha(options.cwd),
	);
	const workflowRevisionSha = resolveWorkflowRevisionSha(buildSha, containerBuild, readRuntimeSourceSha);
	const workflowRevision = workflowRevisionSha ?? `v${GSHIP_VERSION}`;
	const snapshotVersion = formatSnapshotVersion(GSHIP_VERSION, workflowRevisionSha);
	// Constructed before anything that might commit, and shared by the two
	// commit paths alone -- the shipper's and issue intake's own writes, each
	// calling this right before its write (GSHIP-654) -- never by the
	// snapshot, which reads `checkGitIdentity` directly below instead: see
	// that route for why the two must not share this cache or this function.
	// One shared cache between the two commit paths means a derive-and-write
	// on either is immediately visible to the other, and `gh` is queried at
	// most once per outcome.
	//
	// Only a settled outcome -- already-configured or derived -- is cached for
	// the process's lifetime. `missing` is retried on every call instead: the
	// container's own documented first-boot order is compose up, open the UI,
	// then run `gh auth login` inside the container, so an early call is
	// expected to see it missing. Caching that would wedge the identity as
	// permanently missing for the rest of the process and let the first
	// commit fail with "Author identity unknown" regardless of a login that
	// happens seconds later -- exactly the failure this exists to prevent.
	const ensureGitIdentityFn = options.ensureGitIdentity ?? (() => ensureGitIdentity(options.cwd));
	let gitIdentityEnsured: GitIdentityResult | undefined;
	const ensureGitIdentityOnce = (): GitIdentityResult => {
		if (gitIdentityEnsured === undefined || gitIdentityEnsured.outcome === 'missing') {
			gitIdentityEnsured = ensureGitIdentityFn();
		}
		return gitIdentityEnsured;
	};
	const runRuntime = options.runRuntime
		?? new RunRuntime(createDefaultRunRuntimeOptions(
			options.cwd,
			ensureGitIdentityOnce,
			workflowRevision,
		));
	const diagnostics = options.diagnostics ?? new DiagnosticsRuntime({
		store: new RunStore(ownsRunRuntime ? join(options.cwd, '.gship', 'runtime.sqlite') : ':memory:'),
		workspace: new GitDiagnosticWorkspace(options.cwd),
		adapters: [new ReactDoctorAdapter(options.cwd)],
		isProjectIdle: () => runRuntime.listRuns(1).every((run) => isTerminalRunState(run.state)),
	});
	let selfUpdate = options.selfUpdate;
	// The same durable event log the SSE stream below reads per-connection
	// (GSHIP-651); a missing GATESHIP_NTFY_URL and project file (GSHIP-652)
	// makes this a no-op subscriber.
	const unsubscribeRemoteNotifier = runRuntime.subscribe(createRemoteNotifier({ cwd: options.cwd }));
	const { issueIntake, issueSpecifier, issueApprover, issueAbandoner } =
		resolveIssueWriters(options, ensureGitIdentityOnce);
	const issueReader = resolveIssueReader(options);
	// Only for the real NativeProviderAuth this process owns: an injected fake
	// in tests has no reason to touch the filesystem, and CODEX_HOME is unset
	// outside the container image anyway.
	if (ownsProviderAuth) ensureCodexHome(process.env);
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
	const server = Bun.serve({
		hostname: resolveBindHostname(),
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
					version: snapshotVersion,
				};
				const workspaceNotices = runRuntime.listWorkspaceNotices();
				if (workspaceNotices.length > 0) snapshot['workspaceNotices'] = workspaceNotices;
				// Its own field: `workspaceNotices` means a preserved local resource
				// waiting for a decision, which this is not.
				const staleService = staleServiceNotice(options.cwd, bootSourceSha);
				if (staleService !== null) snapshot['staleService'] = staleService;
				// `checkGitIdentity`, never `ensureGitIdentity`, and never the commit
				// paths' cache above (GSHIP-654): this is a GET handler on Bun's
				// single-threaded server, so it must never be the one that calls
				// `gh` -- that call carries its own five-second timeout, and a
				// blocked GET would stall every other request the service is
				// trying to answer at the same time. One cheap local `git var`
				// read, on every request, with no cache of its own: derivation
				// itself belongs only to the intake and ship commit paths, which
				// call `ensureGitIdentity` right before their own write, so this
				// notice reflects whatever they most recently derived without ever
				// causing that derivation itself.
				const gitIdentity = checkGitIdentity(options.cwd);
				if (gitIdentity.outcome === 'missing') snapshot['gitIdentity'] = { detail: gitIdentity.detail };
				return Response.json(snapshot);
			},
			'/api/project': () => Response.json({ project: inspectProject(options.cwd) }),
			'/api/backlog': () => Response.json(readIdleSnapshotState(options.cwd)),
			'/api/update': {
				GET: () => readSelfUpdate(selfUpdate),
				PUT: (request) => updateSelfUpdate(request, selfUpdate),
			},
			'/api/operator-profile': {
				GET: () => Response.json({ profile: runRuntime.getOperatorProfile() }),
				PUT: (request) => writeOperatorProfile(request, runRuntime),
			},
			'/api/diagnostics': {
				GET: () => Response.json(diagnostics.snapshot()),
				POST: (request) => startDiagnosticFromOperator(request, diagnostics),
			},
			'/api/diagnostics/schedule': {
				PUT: (request) => writeDiagnosticSchedule(request, diagnostics),
			},
			'/api/diagnostics/:scanId/cancel': {
				POST: (request) => cancelDiagnosticFromOperator(
					request,
					diagnostics,
					request.params.scanId,
				),
			},
			'/api/diagnostic-findings/:findingId/dismiss': {
				POST: (request) => dismissDiagnosticFindingFromOperator(
					request,
					diagnostics,
					request.params.findingId,
				),
			},
			'/api/diagnostic-findings/:findingId/promote': {
				POST: (request) => promoteDiagnosticFindingFromOperator(
					request,
					diagnostics,
					request.params.findingId,
					issueIntake,
				),
			},
			'/api/runs': {
				GET: () => Response.json({ runs: listRunsWithInsights(runRuntime) }),
				POST: (request) => startDurableRun(request, runRuntime),
			},
			'/api/providers': () => listProviders(providerAuth, runRuntime),
			// The read stays unguarded like every other GET: a same-origin browser
			// read sends no Origin header, and the bind address is the read
			// boundary -- WEB_HOSTNAME (127.0.0.1) by default. GATESHIP_BIND_HOST
			// moves that boundary out of the service's own socket (needed for the
			// container's published port to be reachable at all, see
			// resolveBindHostname above); from there it lives entirely in how the
			// port is published on the host, e.g. compose.yaml's `127.0.0.1:<port>`.
			// A route published on any other interface is unauthenticated.
			//
			// The automatic handoff rides along on the same read because the screen
			// shows it beside the brief the operator is correcting. The PUT takes
			// only the brief; its shared runtime operation clears the generated
			// handoff atomically rather than accepting a handoff from the browser.
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
			// The remote notification channels (GSHIP-652, GSHIP-653): the read is
			// unguarded like every other GET and returns a boolean plus any named
			// missing values per channel, never a secret itself -- those live only
			// in the env vars or project-local files `createRemoteNotifier` also
			// reads. Resend's dedicated same-origin routes accept a write-only key
			// and non-secret sender/recipient settings without involving SQLite.
			'/api/notifications': {
				GET: () => Response.json({ channels: notificationChannelsSnapshot(options.cwd) }),
			},
			'/api/notifications/resend': {
				PUT: (request) => writeResendConfiguration(request, options.cwd),
			},
			'/api/notifications/resend/credential': {
				DELETE: (request) => removeResendCredential(request, options.cwd),
			},
			'/api/notifications/:channelId/test': {
				POST: (request) => sendNotificationChannelTest(request, options.cwd, request.params.channelId),
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
				GET: () => listPublishedIssues(options.cwd),
				POST: (request) => createIssueFromOperator(request, issueIntake),
			},
			'/api/issues/:issueId': {
				GET: (request) => readPublishedIssueResponse(issueReader, request.params.issueId),
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
					issueReader,
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
	selfUpdate = resolveSelfUpdate({
		options,
		runRuntime,
		diagnostics,
		workflowRevisionSha,
		containerBuild,
		hostname,
		port,
		ownsRunRuntime,
	});
	diagnostics.startScheduler();
	selfUpdate.startScheduler();

	let stopped = false;
	return {
		hostname,
		port,
		stop: async () => {
			if (stopped) return;
			stopped = true;
			unsubscribeRemoteNotifier();
			await selfUpdate.stop();
			if (ownsOrchestrator) await orchestrator.stop();
			await diagnostics.stop();
			await runRuntime.stop();
			if (ownsProviderAuth) await providerAuth.close();
			await server.stop(true);
			if (ownsDiagnostics) diagnostics.close();
			if (ownsSelfUpdate) selfUpdate.close?.();
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
			`gship: failed to bind --port ${options.port} on ${resolveBindHostname()}`,
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
