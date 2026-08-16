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

export type RunAction = 'resume' | 'cancel' | 'ship';

export interface BacklogSnapshot {
	plannable: PlannableIssue[];
	ideas: PlannableIssue[];
	workspaceNotices: WorkspaceNoticeView[];
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
		};
	};
	workspaceNotices?: WorkspaceNoticeView[];
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
		workspaceNotices: payload.workspaceNotices ?? [],
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
