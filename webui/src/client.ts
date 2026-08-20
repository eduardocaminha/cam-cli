// webui/src/client.ts
//
// Same-origin transport for the screen. Reads go to the two existing GET
// routes; writes go to the existing POST routes, which are the ones already
// guarded by the trusted-origin check. No token, no second server, no
// alternate base URL: the bundle is served by the process it talks to.

import type { PlannableIssue, RunEventView, RunView } from './run-view.ts';

export const SNAPSHOT_PATH = '/api/snapshot';
export const RUNS_PATH = '/api/runs';
export const EVENTS_PATH = '/api/events';
export const ISSUES_PATH = '/api/issues';
export const PROVIDERS_PATH = '/api/providers';
export const CHAT_PATH = '/api/chat';
export const BRIEF_PATH = '/api/brief';
export const PROPOSALS_PATH = '/api/proposals';
export const RESOLVED_PROPOSALS_PATH = '/api/proposals/resolved';
export const MODEL_SETTINGS_PATH = '/api/model-settings';
export const CHAIN_RUNS_PATH = '/api/chain-runs';

/**
 * One command run while specifying, and the output observed then -- the
 * spec's executable premise (GSHIP-629). Read-only here: this screen never
 * edits it, and a revision that omits it drops it, the same as any other
 * field this form does not carry.
 */
export interface EvidenceView {
	command: string;
	output: string;
}

export interface OperatorIssueDraft {
	title: string;
	scope: string;
	verificationCommand: string;
}

export interface OperatorSpecDraft {
	scope: string;
	verificationCommand: string;
	evidence?: EvidenceView[];
}

export interface CreatedIssue {
	id: string;
	title: string;
}

export type RunAction = 'resume' | 'abandon' | 'cancel' | 'ship';

export interface BacklogSnapshot {
	plannable: PlannableIssue[];
	ideas: PlannableIssue[];
	drafts: IssueReviewDraft[];
	workspaceNotices: WorkspaceNoticeView[];
	/** The service is older than origin/main; null while it is current. */
	staleService: StaleServiceView | null;
	/** No git author identity is configured yet; null once one is. */
	gitIdentity: GitIdentityView | null;
	/** Version of the binary serving the screen; empty when it did not say. */
	version: string;
}

/**
 * The service is running code older than origin/main and has to be restarted to
 * pick up what landed after its boot. Informative only: it holds no command
 * back, and it is absent from the snapshot as soon as the restart happens.
 */
export interface StaleServiceView {
	bootSha: string;
	currentSha: string;
	detail: string;
}

/**
 * No global git author identity exists yet, so the first commit a run or a
 * ship attempts would fail with "Author identity unknown". Informative only:
 * it holds no command back. The derive-and-write itself happens on that same
 * commit path, not here and not on a poll -- there is none -- so this can
 * still show stale between a completed `gh auth login` and the next
 * snapshot read, which a command or a run event triggers, not a timer;
 * nothing here ever needs a restart.
 */
export interface GitIdentityView {
	detail: string;
}

export interface IssueReviewDraft extends CreatedIssue, OperatorSpecDraft {
	state: 'draft' | 'approved' | 'stale';
	approvedAt?: string;
}

/**
 * One idea an executed run found outside its issue, still awaiting a decision.
 * The evidence is read-only here: the operator discards it or authors a new
 * contract for it, and never edits what the run reported.
 */
export interface ProposalView {
	id: string;
	title: string;
	evidence: string;
	sourceRunId: string;
	sourceIssueId: string;
}

/**
 * A proposal the operator already settled: discarded, or promoted into the
 * issue named by `promotedIssueId` (GSHIP-643). Read-only, same as
 * `ProposalView` -- this screen never reopens or re-decides one.
 */
export interface ResolvedProposalView extends ProposalView {
	status: 'dismissed' | 'promoted';
	promotedIssueId: string | null;
}

export interface WorkspaceNoticeView {
	kind: 'cleanup-failed' | 'dirty' | 'failed-run' | 'orphan';
	runId: string | null;
	workspacePath: string | null;
	branch: string | null;
	detail: string;
}

export interface ProviderStatusView {
	id: 'claude' | 'codex';
	installed: boolean;
	subscription: boolean;
	label: string;
	plan?: string;
	login: 'external' | 'web';
}

/**
 * The four fields the brief and the automatic handoff both carry. One shape,
 * two records: the operator writes the first and only reads the second.
 */
export interface ProjectBriefView {
	objective: string;
	decisions: readonly string[];
	constraints: readonly string[];
	openItems: readonly string[];
}

export interface BriefSnapshot {
	/** Authoritative human context, the only one the screen can write. */
	brief: ProjectBriefView;
	/** Session state written by orchestrator turns; read-only here. */
	handoff: ProjectBriefView;
}

export const MODEL_PROVIDER_IDS = ['claude', 'codex'] as const;

/** The three roles that call a model, in the order the screen shows them. */
export const MODEL_ROLE_NAMES = ['orchestrator', 'executor', 'reviewer'] as const;

export type ModelRoleName = (typeof MODEL_ROLE_NAMES)[number];

/** Empty text is "not configured": the CLI default decides, as it always has. */
export interface ModelSlotView {
	model: string;
	effort: string;
}

export type ModelSettingsView = Record<
	ProviderStatusView['id'],
	Record<ModelRoleName, ModelSlotView>
>;

export function emptyModelSettings(): ModelSettingsView {
	const roles = (): Record<ModelRoleName, ModelSlotView> => ({
		orchestrator: { model: '', effort: '' },
		executor: { model: '', effort: '' },
		reviewer: { model: '', effort: '' },
	});
	return { claude: roles(), codex: roles() };
}

/**
 * One orchestrator turn's own reported usage (GSHIP-634). Mirrors
 * OrchestratorMessageUsage in src/runtime/run-store.ts: a field the CLI never
 * reported stays absent, never a fabricated zero.
 */
export interface ChatMessageUsageView {
	model?: string;
	effort?: string;
	totalCostUsd?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheReadInputTokens?: number;
	thinkingTokens?: number;
}

export interface ChatMessageView {
	seq: number;
	providerId: ProviderStatusView['id'];
	role: 'operator' | 'orchestrator' | 'system';
	text: string;
	createdAt: string;
	/** Present only on the orchestrator's own message, and only when that turn reported usage. */
	usage?: ChatMessageUsageView;
}

/** A cost total plus exactly how many orchestrator turns it spans (GSHIP-634). */
export interface ChatCostAggregate {
	totalCostUsd: number | null;
	turnCount: number;
}

/**
 * The expected cost across every orchestrator turn the transcript carries a
 * usage event for -- never the executor's or the reviewer's own runs, which
 * report through RunCostView instead. A turn that reported nothing measurable
 * contributes nothing to the sum and is not counted in `turnCount`, the same
 * absence-over-zero rule GSHIP-623 established for a run's cost.
 */
export function aggregateChatTurnCosts(messages: readonly ChatMessageView[]): ChatCostAggregate {
	const known = messages.filter((message) => message.usage?.totalCostUsd !== undefined);
	if (known.length === 0) return { totalCostUsd: null, turnCount: 0 };
	const totalCostUsd = known.reduce((sum, message) => sum + (message.usage?.totalCostUsd ?? 0), 0);
	return { totalCostUsd, turnCount: known.length };
}

interface SnapshotPayload {
	idleState?: {
		backlog?: {
			plannable?: PlannableIssue[];
			byStage?: { idea?: PlannableIssue[] };
			drafts?: IssueReviewDraft[];
		};
	};
	workspaceNotices?: WorkspaceNoticeView[];
	staleService?: Partial<StaleServiceView>;
	gitIdentity?: Partial<GitIdentityView>;
	version?: string;
}

interface RunsPayload {
	runs: RunView[];
}

interface RunEventsPayload {
	events: RunEventView[];
}

interface CommandPayload {
	ok?: boolean;
	message?: string;
}

interface CreateIssuePayload extends CommandPayload {
	issue?: CreatedIssue;
}

interface ProposalsPayload {
	proposals?: ProposalView[];
}

interface ResolvedProposalsPayload {
	proposals?: ResolvedProposalView[];
	omittedCount?: number;
}

/** The settled proposals shown, and how many more exist beyond that window. */
export interface ResolvedProposalsSnapshot {
	proposals: ResolvedProposalView[];
	omittedCount: number;
}

interface ProvidersPayload {
	providers: ProviderStatusView[];
	selected: ProviderStatusView['id'];
}

interface CodexLoginPayload extends CommandPayload {
	login?: { loginId: string; authUrl: string };
}

interface ChatPayload extends CommandPayload {
	messages?: ChatMessageView[];
}

interface BriefPayload extends CommandPayload {
	brief?: Partial<ProjectBriefView>;
	handoff?: Partial<ProjectBriefView>;
}

async function readJson<T>(response: Response, what: string): Promise<T> {
	if (!response.ok) throw new Error(`${what} respondeu ${response.status}`);
	return (await response.json()) as T;
}

/**
 * The absent field is the ordinary case -- the service is current -- so a
 * payload without it, or with an incomplete one, reads as no divergence.
 */
function staleServiceRecord(record: Partial<StaleServiceView> | undefined): StaleServiceView | null {
	if (record === undefined) return null;
	const { bootSha, currentSha, detail } = record;
	if (typeof bootSha !== 'string' || typeof currentSha !== 'string') return null;
	return { bootSha, currentSha, detail: detail ?? '' };
}

/** Same absence-is-the-ordinary-case rule as `staleServiceRecord`: a missing or incomplete field reads as configured. */
function gitIdentityRecord(record: Partial<GitIdentityView> | undefined): GitIdentityView | null {
	if (record === undefined) return null;
	const { detail } = record;
	if (typeof detail !== 'string') return null;
	return { detail };
}

/** Read the executable queue and the ideas that can be specified while idle. */
export async function fetchBacklog(): Promise<BacklogSnapshot> {
	const payload = await readJson<SnapshotPayload>(await fetch(SNAPSHOT_PATH), 'Snapshot');
	return {
		plannable: payload.idleState?.backlog?.plannable ?? [],
		ideas: payload.idleState?.backlog?.byStage?.idea ?? [],
		drafts: payload.idleState?.backlog?.drafts ?? [],
		workspaceNotices: payload.workspaceNotices ?? [],
		staleService: staleServiceRecord(payload.staleService),
		gitIdentity: gitIdentityRecord(payload.gitIdentity),
		version: payload.version ?? '',
	};
}

/**
 * Newest run first. The first entry is the only one the screen commands; the
 * rest are the history the operator reads to pick a session back up.
 */
export async function fetchRuns(): Promise<RunView[]> {
	const payload = await readJson<RunsPayload>(await fetch(RUNS_PATH), 'Runs');
	return payload.runs ?? [];
}

export interface ProvidersSnapshot {
	providers: ProviderStatusView[];
	selected: ProviderStatusView['id'];
}

export async function fetchProviders(): Promise<ProvidersSnapshot> {
	const payload = await readJson<ProvidersPayload>(await fetch(PROVIDERS_PATH), 'Providers');
	return { providers: payload.providers ?? [], selected: payload.selected ?? 'claude' };
}

export async function fetchChat(): Promise<ChatMessageView[]> {
	const payload = await readJson<ChatPayload>(await fetch(CHAT_PATH), 'Conversa');
	return payload.messages ?? [];
}

export async function sendChat(message: string): Promise<string> {
	const response = await fetch(CHAT_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ message }),
	});
	const payload = (await response.json()) as ChatPayload;
	if (!response.ok) throw new Error(payload.message ?? `Conversa recusada (${response.status}).`);
	return 'Resposta do orquestrador recebida.';
}

/** A record whose fields are all missing reads as the empty one, not as a hole. */
function briefRecord(record: Partial<ProjectBriefView> | undefined): ProjectBriefView {
	return {
		objective: record?.objective ?? '',
		decisions: record?.decisions ?? [],
		constraints: record?.constraints ?? [],
		openItems: record?.openItems ?? [],
	};
}

/** One read for both records: the brief to edit and the handoff to read. */
export async function fetchBrief(): Promise<BriefSnapshot> {
	const payload = await readJson<BriefPayload>(await fetch(BRIEF_PATH), 'Brief');
	return { brief: briefRecord(payload.brief), handoff: briefRecord(payload.handoff) };
}

/**
 * The whole brief is overwritten at once, and only the brief: the handoff is
 * never sent back. A refusal surfaces the server's own validation message.
 */
export async function saveBrief(brief: ProjectBriefView): Promise<string> {
	const response = await fetch(BRIEF_PATH, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(brief),
	});
	const payload = (await response.json()) as BriefPayload;
	if (response.ok) return 'Project brief atualizado.';
	return payload.message ?? `Brief recusado (${response.status}).`;
}

interface ModelSettingsPayload extends CommandPayload {
	settings?: unknown;
	probes?: unknown;
}

function modelSlotRecord(value: unknown): ModelSlotView {
	const slot = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
	return {
		model: typeof slot['model'] === 'string' ? slot['model'] : '',
		effort: typeof slot['effort'] === 'string' ? slot['effort'] : '',
	};
}

/** A payload missing a provider or a role reads as unconfigured, not as a hole. */
function modelSettingsRecord(value: unknown): ModelSettingsView {
	const record = value !== null && typeof value === 'object'
		? value as Record<string, unknown>
		: {};
	const settings = emptyModelSettings();
	for (const provider of MODEL_PROVIDER_IDS) {
		const roles = record[provider] !== null && typeof record[provider] === 'object'
			? record[provider] as Record<string, unknown>
			: {};
		for (const role of MODEL_ROLE_NAMES) {
			settings[provider][role] = modelSlotRecord(roles[role]);
		}
	}
	return settings;
}

export async function fetchModelSettings(): Promise<ModelSettingsView> {
	const payload = await readJson<ModelSettingsPayload>(
		await fetch(MODEL_SETTINGS_PATH),
		'Modelos',
	);
	return modelSettingsRecord(payload.settings);
}

/** One line for a probed slot that did not cleanly accept, in the CLI's own words. */
function describeModelProbe(provider: string, role: string, value: unknown): string | undefined {
	const probe = value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
	const message = typeof probe?.['message'] === 'string' ? probe['message'] : '';
	if (probe?.['outcome'] === 'refused') return `${provider}/${role}: recusado pelo CLI — ${message}`;
	if (probe?.['outcome'] === 'inconclusive') return `${provider}/${role}: validação não concluída — ${message}`;
	return undefined;
}

/**
 * One line per slot the save actually probed and did not cleanly accept, in
 * the CLI's own words (GSHIP-620). A slot that was not probed, or that the
 * CLI accepted outright, adds nothing: no news there is the expected outcome.
 */
function describeModelProbes(value: unknown): string {
	const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
	const lines: string[] = [];
	for (const provider of MODEL_PROVIDER_IDS) {
		const roles = record[provider] !== null && typeof record[provider] === 'object'
			? record[provider] as Record<string, unknown>
			: {};
		for (const role of MODEL_ROLE_NAMES) {
			const line = describeModelProbe(provider, role, roles[role]);
			if (line !== undefined) lines.push(line);
		}
	}
	return lines.join(' ');
}

/**
 * The whole record is overwritten at once; a refusal surfaces the server's
 * message. A slot the CLI probed comes back with its own outcome, folded into
 * the same status line every other command already reports through.
 */
export async function saveModelSettings(settings: ModelSettingsView): Promise<string> {
	const response = await fetch(MODEL_SETTINGS_PATH, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(settings),
	});
	const payload = (await response.json()) as ModelSettingsPayload;
	if (!response.ok) return payload.message ?? `Configuração recusada (${response.status}).`;
	const notes = describeModelProbes(payload.probes);
	return notes.length === 0 ? 'Modelos por papel atualizados.' : `Modelos por papel atualizados. ${notes}`;
}

/**
 * Why the queue is not advancing on its own right now (GSHIP-638). Mirrors
 * ChainPauseReason in src/runtime/run-runtime.ts.
 */
export type ChainPauseReason =
	| 'chain-disabled'
	| 'previous-run-not-done'
	| 'no-admissible-issue'
	| 'run-active'
	| 'chain-start-failed';

/** Mirrors ChainPauseView in src/runtime/run-runtime.ts. */
export interface ChainPauseView {
	reason: ChainPauseReason;
	createdAt: string;
	run?: { id: string; issueId: string };
	issue?: { id: string; title: string };
}

/** The chain switch, off by default, plus why the queue is stopped when it is. */
export interface ChainRunsView {
	enabled: boolean;
	pause: ChainPauseView | null;
}

interface ChainRunsPayload extends CommandPayload {
	enabled?: boolean;
	pause?: Partial<ChainPauseView> | null;
}

/** Read as absent unless both identifying fields parse -- never a half link. */
function chainPauseRun(value: unknown): ChainPauseView['run'] {
	if (value === null || typeof value !== 'object') return undefined;
	const { id, issueId } = value as Record<string, unknown>;
	return typeof id === 'string' && typeof issueId === 'string' ? { id, issueId } : undefined;
}

function chainPauseIssue(value: unknown): ChainPauseView['issue'] {
	if (value === null || typeof value !== 'object') return undefined;
	const { id, title } = value as Record<string, unknown>;
	return typeof id === 'string' && typeof title === 'string' ? { id, title } : undefined;
}

/** A pause missing either core field reads as none: there is nothing coherent to show. */
function chainPauseRecord(value: Partial<ChainPauseView> | null | undefined): ChainPauseView | null {
	if (value === null || value === undefined) return null;
	const { reason, createdAt } = value;
	if (typeof reason !== 'string' || typeof createdAt !== 'string') return null;
	const run = chainPauseRun(value.run);
	const issue = chainPauseIssue(value.issue);
	return {
		reason: reason as ChainPauseReason,
		createdAt,
		...(run === undefined ? {} : { run }),
		...(issue === undefined ? {} : { issue }),
	};
}

export async function fetchChainRuns(): Promise<ChainRunsView> {
	const payload = await readJson<ChainRunsPayload>(await fetch(CHAIN_RUNS_PATH), 'Encadeamento');
	return { enabled: payload.enabled === true, pause: chainPauseRecord(payload.pause) };
}

export async function saveChainRuns(enabled: boolean): Promise<string> {
	const response = await fetch(CHAIN_RUNS_PATH, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ enabled }),
	});
	const payload = (await response.json()) as ChainRunsPayload;
	if (!response.ok) return payload.message ?? `Encadeamento recusado (${response.status}).`;
	return enabled ? 'Encadeamento automático ativado.' : 'Encadeamento automático desativado.';
}

export async function startCodexLogin(): Promise<string> {
	const response = await fetch(`${PROVIDERS_PATH}/codex/login`, { method: 'POST' });
	const payload = (await response.json()) as CodexLoginPayload;
	if (!response.ok || payload.login === undefined) {
		throw new Error(payload.message ?? `Login recusado (${response.status}).`);
	}
	return payload.login.authUrl;
}

export function selectProvider(providerId: ProviderStatusView['id']): Promise<string> {
	return postCommand(`${PROVIDERS_PATH}/${providerId}/select`);
}

export async function fetchRunEvents(runId: string): Promise<RunEventView[]> {
	const payload = await readJson<RunEventsPayload>(
		await fetch(`${RUNS_PATH}/${runId}/events`),
		'Atividade',
	);
	return payload.events;
}

/** Resolves to the operator-facing outcome message for either verdict. */
async function postCommand(path: string, body?: unknown): Promise<string> {
	const response = await fetch(path, {
		method: 'POST',
		...(body === undefined
			? {}
			: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
	});
	const payload = (await response.json()) as CommandPayload;
	if (response.ok) return 'Run atualizada.';
	return payload.message ?? `Comando recusado (${response.status}).`;
}

export function startRun(issueId: string): Promise<string> {
	return postCommand(RUNS_PATH, { issueId });
}

export async function createIssue(input: OperatorIssueDraft): Promise<CreatedIssue> {
	const response = await fetch(ISSUES_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});
	const payload = (await response.json()) as CreateIssuePayload;
	if (!response.ok) {
		throw new Error(payload.message ?? `Criação recusada (${response.status}).`);
	}
	if (payload.issue === undefined || typeof payload.issue.id !== 'string') {
		throw new Error('O servidor não devolveu a tarefa criada.');
	}
	return payload.issue;
}

export async function specifyIssue(id: string, input: OperatorSpecDraft): Promise<CreatedIssue> {
	const response = await fetch(`${ISSUES_PATH}/${encodeURIComponent(id)}/spec`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});
	const payload = (await response.json()) as CreateIssuePayload;
	if (!response.ok) {
		throw new Error(payload.message ?? `Especificação recusada (${response.status}).`);
	}
	if (payload.issue === undefined || typeof payload.issue.id !== 'string') {
		throw new Error('O servidor não devolveu a ideia especificada.');
	}
	return payload.issue;
}

/** The inbox the server already filtered: only proposals still pending. */
export async function fetchProposals(): Promise<ProposalView[]> {
	const payload = await readJson<ProposalsPayload>(await fetch(PROPOSALS_PATH), 'Propostas');
	return payload.proposals ?? [];
}

/**
 * The settled proposals, newest decision first, separate from the pending
 * inbox above so a historical record never mixes with a pending decision.
 */
export async function fetchResolvedProposals(): Promise<ResolvedProposalsSnapshot> {
	const payload = await readJson<ResolvedProposalsPayload>(
		await fetch(RESOLVED_PROPOSALS_PATH),
		'Propostas resolvidas',
	);
	return { proposals: payload.proposals ?? [], omittedCount: payload.omittedCount ?? 0 };
}

export async function dismissProposal(id: string): Promise<string> {
	const response = await fetch(`${PROPOSALS_PATH}/${encodeURIComponent(id)}/dismiss`, {
		method: 'POST',
	});
	const payload = (await response.json()) as CommandPayload;
	if (response.ok) return 'Proposta descartada.';
	return payload.message ?? `Descarte recusado (${response.status}).`;
}

/**
 * The operator's own contract for the idea, filed through the same intake as a
 * new task. The proposal is only settled by the server once the issue exists.
 */
export async function promoteProposal(
	id: string,
	input: OperatorIssueDraft,
): Promise<CreatedIssue> {
	const response = await fetch(`${PROPOSALS_PATH}/${encodeURIComponent(id)}/promote`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});
	const payload = (await response.json()) as CreateIssuePayload;
	if (!response.ok) {
		throw new Error(payload.message ?? `Promoção recusada (${response.status}).`);
	}
	if (payload.issue === undefined || typeof payload.issue.id !== 'string') {
		throw new Error('O servidor não devolveu a tarefa criada.');
	}
	return payload.issue;
}

export function approveIssue(id: string): Promise<string> {
	return postCommand(`${ISSUES_PATH}/${encodeURIComponent(id)}/approve`);
}

/** Closes an open issue without shipping it, keeping the justification durable. */
export function abandonIssue(id: string, reason: string): Promise<string> {
	return postCommand(`${ISSUES_PATH}/${encodeURIComponent(id)}/abandon`, { reason });
}

export function commandRun(
	runId: string,
	action: RunAction,
	operatorGuidance?: string,
): Promise<string> {
	return postCommand(
		`${RUNS_PATH}/${runId}/${action}`,
		action === 'resume' && operatorGuidance !== undefined
			? { message: operatorGuidance }
			: undefined,
	);
}
