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

export interface OperatorIssueDraft {
	title: string;
	scope: string;
	verificationCommand: string;
}

export interface OperatorSpecDraft {
	scope: string;
	verificationCommand: string;
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
	/** Version of the binary serving the screen; empty when it did not say. */
	version: string;
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

export interface ChatMessageView {
	seq: number;
	providerId: ProviderStatusView['id'];
	role: 'operator' | 'orchestrator' | 'system';
	text: string;
	createdAt: string;
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

/** Read the executable queue and the ideas that can be specified while idle. */
export async function fetchBacklog(): Promise<BacklogSnapshot> {
	const payload = await readJson<SnapshotPayload>(await fetch(SNAPSHOT_PATH), 'Snapshot');
	return {
		plannable: payload.idleState?.backlog?.plannable ?? [],
		ideas: payload.idleState?.backlog?.byStage?.idea ?? [],
		drafts: payload.idleState?.backlog?.drafts ?? [],
		workspaceNotices: payload.workspaceNotices ?? [],
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
