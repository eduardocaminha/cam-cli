// webui/src/client.ts
//
// Same-origin transport for the screen. Reads include the global project
// registry and the current runtime; writes go to the existing POST routes already
// guarded by the trusted-origin check. No token, no second server, no
// alternate base URL: the bundle is served by the process it talks to.

import type {
	PlannableIssue,
	ProviderUsageView,
	RunEventView,
	RunProviderWaitView,
	RunView,
} from './run-view.ts';

export const SNAPSHOT_PATH = '/api/snapshot';
export const PROJECT_PATH = '/api/project';
export const PROJECTS_PATH = '/api/projects';
export const OPERATOR_PROFILE_PATH = '/api/operator-profile';
export const DIAGNOSTICS_PATH = '/api/diagnostics';
export const DIAGNOSTIC_SCHEDULE_PATH = '/api/diagnostics/schedule';
export const DIAGNOSTIC_FINDINGS_PATH = '/api/diagnostic-findings';
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
export const NOTIFICATIONS_PATH = '/api/notifications';
export const UPDATE_PATH = '/api/update';

/**
 * Which project a run- or issue-facing read or write names (GSHIP-707,
 * GSHIP-712). A project id is the selection the browser path carries, and
 * every such call goes to that project's own scoped route. `null` is the absence of a selection -- the
 * overview, and the legacy paths the service redirects to the boot project --
 * and keeps the unscoped routes the boot runtime already answers.
 */
export type ProjectScope = string | null;

function projectApiPath(projectId: string, suffix = ''): string {
	return `${PROJECTS_PATH}/${encodeURIComponent(projectId)}${suffix}`;
}

/** The SSE endpoint a document subscribes to for its selected project. */
export function eventsPathOf(scope: ProjectScope): string {
	return scope === null ? EVENTS_PATH : projectApiPath(scope, '/events');
}

function snapshotPathOf(scope: ProjectScope): string {
	return scope === null ? SNAPSHOT_PATH : projectApiPath(scope, '/snapshot');
}

function runsPathOf(scope: ProjectScope): string {
	return scope === null ? RUNS_PATH : projectApiPath(scope, '/runs');
}

/**
 * The issue collection of the selected project (GSHIP-712), derived from the
 * same scope runs already use so intake, specification, approval and abandon
 * all address the project the browser path names.
 */
function issuesPathOf(scope: ProjectScope): string {
	return scope === null ? ISSUES_PATH : projectApiPath(scope, '/issues');
}

/** One issue inside that collection, the base of its `/spec`, `/approve` and `/abandon` routes. */
function issuePathOf(scope: ProjectScope, id: string): string {
	return `${issuesPathOf(scope)}/${encodeURIComponent(id)}`;
}

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

export type ProjectStatusView =
	| { state: 'checking'; name: string; detail: string }
	| {
		state: 'ready';
		name: string;
		repository: string;
		remoteUrl: string;
		sourceRef: 'origin/main';
	}
	| { state: 'empty'; name: string; detail: string }
	| {
		state: 'needs-attention';
		name: string;
		reason: 'not-repository' | 'origin-missing' | 'github-origin-required' | 'origin-main-missing';
		detail: string;
	};

export interface RegisteredProjectView {
	id: string;
	name: string;
	root: string;
	stateDir: string;
	readiness: Exclude<ProjectStatusView['state'], 'checking'>;
	repository?: string;
	current: boolean;
}

export interface OperatorProfileView {
	name: string;
	timezone: string;
}

export interface SelfUpdateView {
	enabled: boolean;
	currentVersion: string;
	currentCommit: string | null;
	available: { version: string; tag: string; commit: string } | null;
	availability: { kind: 'native' | 'container' | 'development'; reason?: string };
	lastCheckedAt: string | null;
	result: {
		status: 'success' | 'rollback' | 'failed' | 'check-failed' | 'deferred';
		at: string;
		previousVersion: string;
		targetVersion: string | null;
		reason: string;
	} | null;
	applying: boolean;
}

export function emptySelfUpdate(): SelfUpdateView {
	return {
		enabled: false,
		currentVersion: '',
		currentCommit: null,
		available: null,
		availability: { kind: 'development', reason: 'Checking installation…' },
		lastCheckedAt: null,
		result: null,
		applying: false,
	};
}

export type DiagnosticScanStateView = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface DiagnosticScanView {
	id: string;
	analyzer: string;
	analyzerVersion: string | null;
	sourceSha: string | null;
	state: DiagnosticScanStateView;
	coverageComplete: boolean;
	findingCount: number;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface DiagnosticFindingView {
	id: string;
	analyzer: string;
	rule: string;
	severity: 'error' | 'warning' | 'info';
	file: string;
	evidence: string;
	line?: number;
	column?: number;
	toolVersion: string;
	sourceSha: string;
	status: 'pending' | 'dismissed' | 'promoted' | 'cleared';
	promotedIssueId: string | null;
	occurrenceCount: number;
	firstSeenAt: string;
	lastSeenAt: string;
	updatedAt: string;
}

export interface DiagnosticAnalyzerView {
	id: string;
	label: string;
	version: string;
	description: string;
}

export interface DiagnosticFindingStatsView {
	total: number;
	pending: number;
	dismissed: number;
	promoted: number;
	cleared: number;
	recurring: number;
}

export type DiagnosticCadenceView = 'daily' | 'weekly';

export interface DiagnosticScheduleView {
	enabled: boolean;
	analyzer: string;
	cadence: DiagnosticCadenceView;
	lastScanAt: string | null;
	nextRunAt: string | null;
	overdue: boolean;
}

export interface DiagnosticsView {
	analyzers: DiagnosticAnalyzerView[];
	scan: DiagnosticScanView | null;
	findings: DiagnosticFindingView[];
	resolvedFindings: DiagnosticFindingView[];
	resolvedFindingsOmittedCount: number;
	stats: DiagnosticFindingStatsView;
	schedule: DiagnosticScheduleView;
	workspaceNotices: string[];
}

export function emptyDiagnostics(): DiagnosticsView {
	return {
		analyzers: [],
		scan: null,
		findings: [],
		resolvedFindings: [],
		resolvedFindingsOmittedCount: 0,
		stats: { total: 0, pending: 0, dismissed: 0, promoted: 0, cleared: 0, recurring: 0 },
		schedule: {
			enabled: false,
			analyzer: 'react',
			cadence: 'weekly',
			lastScanAt: null,
			nextRunAt: null,
			overdue: false,
		},
		workspaceNotices: [],
	};
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
	/** `'dedicated'` is Claude-only (GSHIP-704): a subscription token from `claude setup-token`, isolated from Desktop's/the terminal's own login. */
	login: 'external' | 'web' | 'dedicated';
	/** An observed active hold; absence does not claim remaining subscription quota. */
	availability?: RunProviderWaitView;
	/** Truthful subscription-usage telemetry (GSHIP-664); absent means unavailable, never a fabricated zero. */
	usage?: ProviderUsageView;
	/** Claude only (GSHIP-704): whether `CLAUDE_CODE_OAUTH_TOKEN` in the service environment would override a Settings file write regardless. Rotate/disconnect availability comes from `login === 'dedicated'`, not from this field. */
	credential?: { envManaged: boolean };
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

interface ProjectPayload {
	project?: Record<string, unknown>;
}

interface ProjectsPayload {
	projects?: unknown[];
}

interface OperatorProfilePayload extends CommandPayload {
	profile?: Partial<OperatorProfileView>;
}

interface DiagnosticsPayload extends CommandPayload, Partial<DiagnosticsView> {
	scan?: DiagnosticScanView | null;
	outcome?: string;
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

interface ClaudeCredentialPayload extends CommandPayload {
	identity?: ClaudeCredentialIdentity;
	removed?: boolean;
}

interface ChatPayload extends CommandPayload {
	messages?: ChatMessageView[];
}

interface BriefPayload extends CommandPayload {
	brief?: Partial<ProjectBriefView>;
	handoff?: Partial<ProjectBriefView>;
}

async function readJson<T>(response: Response, what: string): Promise<T> {
	if (!response.ok) throw new Error(`${what} responded with ${response.status}`);
	return (await response.json()) as T;
}

/**
 * The typed refusal a scoped route answers with -- `project-not-found` or
 * `project-not-ready` -- is a statement about the selection, not a transport
 * failure. The shell already renders the typed unavailable surface for it from
 * the registry it reads separately, so the read resolves as no data and leaves
 * the rest of the refresh intact instead of failing all of it.
 */
async function readScopedJson<T>(response: Response, what: string): Promise<T | null> {
	if (response.status === 404 || response.status === 409) {
		const refusal = await response.json().catch(() => null) as { code?: unknown } | null;
		const code = refusal?.code;
		if (code === 'project-not-found' || code === 'project-not-ready') return null;
		throw new Error(`${what} responded with ${response.status}`);
	}
	return await readJson<T>(response, what);
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
export async function fetchBacklog(scope: ProjectScope): Promise<BacklogSnapshot> {
	const payload: SnapshotPayload = await readScopedJson<SnapshotPayload>(
		await fetch(snapshotPathOf(scope)),
		'Snapshot',
	) ?? {};
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
 * The project status blocks commands, so a malformed payload fails closed and
 * explains itself instead of rendering the operational screen optimistically.
 */
function projectRecord(record: Record<string, unknown> | undefined): ProjectStatusView {
	const name = typeof record?.['name'] === 'string' ? record['name'] : '';
	const detail = typeof record?.['detail'] === 'string'
		? record['detail']
		: 'The service did not report a valid project state.';
	if (record?.['state'] === 'ready') {
		const repository = record['repository'];
		const remoteUrl = record['remoteUrl'];
		if (typeof repository === 'string' && typeof remoteUrl === 'string') {
			return { state: 'ready', name, repository, remoteUrl, sourceRef: 'origin/main' };
		}
	}
	if (record?.['state'] === 'empty') return { state: 'empty', name, detail };
	const reason = record?.['reason'];
	if (
		record?.['state'] === 'needs-attention'
		&& (reason === 'not-repository'
			|| reason === 'origin-missing'
			|| reason === 'github-origin-required'
			|| reason === 'origin-main-missing')
	) {
		return { state: 'needs-attention', name, reason, detail };
	}
	return { state: 'needs-attention', name, reason: 'not-repository', detail };
}

export async function fetchProjectStatus(): Promise<ProjectStatusView> {
	const payload = await readJson<ProjectPayload>(await fetch(PROJECT_PATH), 'Project');
	return projectRecord(payload.project);
}

function registeredProjectRecord(value: unknown): RegisteredProjectView | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const { id, name, root, stateDir, readiness, repository, current } = record;
	if (
		typeof id !== 'string'
		|| typeof name !== 'string'
		|| typeof root !== 'string'
		|| typeof stateDir !== 'string'
		|| !['ready', 'empty', 'needs-attention'].includes(String(readiness))
		|| typeof current !== 'boolean'
	) return null;
	return {
		id,
		name,
		root,
		stateDir,
		readiness: readiness as RegisteredProjectView['readiness'],
		...(typeof repository === 'string' ? { repository } : {}),
		current,
	};
}

/** The global registry is defensive: malformed rows are omitted, never made selectable. */
export async function fetchProjects(): Promise<RegisteredProjectView[]> {
	const payload = await readJson<ProjectsPayload>(await fetch(PROJECTS_PATH), 'Projects');
	return (payload.projects ?? [])
		.map(registeredProjectRecord)
		.filter((project): project is RegisteredProjectView => project !== null);
}

function operatorProfileRecord(record: Partial<OperatorProfileView> | undefined): OperatorProfileView {
	return {
		name: typeof record?.name === 'string' ? record.name : '',
		timezone: typeof record?.timezone === 'string' ? record.timezone : '',
	};
}

export async function fetchOperatorProfile(): Promise<OperatorProfileView> {
	const payload = await readJson<OperatorProfilePayload>(
		await fetch(OPERATOR_PROFILE_PATH),
		'Operator profile',
	);
	return operatorProfileRecord(payload.profile);
}

export async function saveOperatorProfile(profile: OperatorProfileView): Promise<string> {
	const response = await fetch(OPERATOR_PROFILE_PATH, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(profile),
	});
	const payload = (await response.json()) as OperatorProfilePayload;
	if (!response.ok) {
		throw new Error(payload.message ?? `Profile rejected (${response.status}).`);
	}
	return 'Operator profile updated.';
}

export async function fetchDiagnostics(): Promise<DiagnosticsView> {
	const payload = await readJson<DiagnosticsPayload>(await fetch(DIAGNOSTICS_PATH), 'Diagnostics');
	return {
		analyzers: payload.analyzers ?? [],
		scan: payload.scan ?? null,
		findings: payload.findings ?? [],
		resolvedFindings: payload.resolvedFindings ?? [],
		resolvedFindingsOmittedCount: payload.resolvedFindingsOmittedCount ?? 0,
		stats: payload.stats ?? {
			total: 0,
			pending: 0,
			dismissed: 0,
			promoted: 0,
			cleared: 0,
			recurring: 0,
		},
		schedule: payload.schedule ?? emptyDiagnostics().schedule,
		workspaceNotices: payload.workspaceNotices ?? [],
	};
}

export async function saveDiagnosticSchedule(
	enabled: boolean,
	cadence: DiagnosticCadenceView,
): Promise<string> {
	const response = await fetch(DIAGNOSTIC_SCHEDULE_PATH, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ enabled, cadence }),
	});
	const payload = (await response.json()) as DiagnosticsPayload;
	if (!response.ok) throw new Error(payload.message ?? `Schedule rejected (${response.status}).`);
	if (!enabled) return 'Diagnostic schedule disabled.';
	if (payload.outcome === 'started') return 'Schedule saved; overdue diagnostic started.';
	if (payload.outcome === 'project-busy') {
		return 'Schedule saved; the diagnostic will run when the project is idle.';
	}
	return 'Diagnostic schedule saved.';
}

export async function startDiagnostic(analyzer: string): Promise<string> {
	const response = await fetch(DIAGNOSTICS_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ analyzer }),
	});
	const payload = (await response.json()) as DiagnosticsPayload;
	if (!response.ok) throw new Error(payload.message ?? `Diagnostic rejected (${response.status}).`);
	return 'Diagnostic started in an isolated checkout.';
}

export async function cancelDiagnostic(scanId: string): Promise<string> {
	const response = await fetch(`${DIAGNOSTICS_PATH}/${encodeURIComponent(scanId)}/cancel`, {
		method: 'POST',
	});
	const payload = (await response.json()) as DiagnosticsPayload;
	if (!response.ok) throw new Error(payload.message ?? `Cancellation rejected (${response.status}).`);
	return 'Diagnostic cancelled.';
}

export async function dismissDiagnosticFinding(id: string): Promise<string> {
	const response = await fetch(
		`${DIAGNOSTIC_FINDINGS_PATH}/${encodeURIComponent(id)}/dismiss`,
		{ method: 'POST' },
	);
	const payload = (await response.json()) as CommandPayload;
	if (!response.ok) throw new Error(payload.message ?? `Dismissal rejected (${response.status}).`);
	return 'Diagnostic finding dismissed.';
}

export async function promoteDiagnosticFinding(
	id: string,
	input: OperatorIssueDraft,
): Promise<CreatedIssue> {
	const response = await fetch(
		`${DIAGNOSTIC_FINDINGS_PATH}/${encodeURIComponent(id)}/promote`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input),
		},
	);
	const payload = (await response.json()) as CreateIssuePayload;
	if (!response.ok) throw new Error(payload.message ?? `Promotion rejected (${response.status}).`);
	if (payload.issue === undefined || typeof payload.issue.id !== 'string') {
		throw new Error('The server did not return the created issue.');
	}
	return payload.issue;
}

/**
 * Newest run first. The first entry is the only one the screen commands; the
 * rest are the history the operator reads to pick a session back up.
 */
export async function fetchRuns(scope: ProjectScope): Promise<RunView[]> {
	const payload = await readScopedJson<RunsPayload>(await fetch(runsPathOf(scope)), 'Runs');
	return payload?.runs ?? [];
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
	const payload = await readJson<ChatPayload>(await fetch(CHAT_PATH), 'Conversation');
	return payload.messages ?? [];
}

export async function sendChat(message: string): Promise<string> {
	const response = await fetch(CHAT_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ message }),
	});
	const payload = (await response.json()) as ChatPayload;
	if (!response.ok) throw new Error(payload.message ?? `Conversation rejected (${response.status}).`);
	return 'Orchestrator response received.';
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
 * The whole brief is overwritten at once. The handoff is never sent back; the
 * service invalidates it as part of the successful brief write. A refusal
 * surfaces the server's own validation message.
 */
export async function saveBrief(brief: ProjectBriefView): Promise<string> {
	const response = await fetch(BRIEF_PATH, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(brief),
	});
	const payload = (await response.json()) as BriefPayload;
	if (response.ok) return 'Project brief updated.';
	return payload.message ?? `Brief rejected (${response.status}).`;
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
		'Models',
	);
	return modelSettingsRecord(payload.settings);
}

/** One line for a probed slot that did not cleanly accept, in the CLI's own words. */
function describeModelProbe(provider: string, role: string, value: unknown): string | undefined {
	const probe = value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
	const message = typeof probe?.['message'] === 'string' ? probe['message'] : '';
	if (probe?.['outcome'] === 'refused') return `${provider}/${role}: rejected by the CLI — ${message}`;
	if (probe?.['outcome'] === 'inconclusive') return `${provider}/${role}: validation inconclusive — ${message}`;
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
	if (!response.ok) return payload.message ?? `Configuration rejected (${response.status}).`;
	const notes = describeModelProbes(payload.probes);
	return notes.length === 0 ? 'Models by role updated.' : `Models by role updated. ${notes}`;
}

interface SelfUpdatePayload extends CommandPayload {
	update?: Partial<SelfUpdateView>;
}

function selfUpdateRecord(value: Partial<SelfUpdateView> | undefined): SelfUpdateView {
	const empty = emptySelfUpdate();
	if (value === undefined) return empty;
	const availability = value.availability;
	return {
		...empty,
		enabled: value.enabled === true,
		currentVersion: typeof value.currentVersion === 'string' ? value.currentVersion : '',
		currentCommit: typeof value.currentCommit === 'string' ? value.currentCommit : null,
		available: value.available !== null && typeof value.available?.version === 'string'
			&& typeof value.available.tag === 'string' && typeof value.available.commit === 'string'
			? value.available : null,
		availability: availability?.kind === 'native'
			|| availability?.kind === 'container'
			|| availability?.kind === 'development'
			? availability : empty.availability,
		lastCheckedAt: typeof value.lastCheckedAt === 'string' ? value.lastCheckedAt : null,
		result: value.result ?? null,
		applying: value.applying === true,
	};
}

export async function fetchSelfUpdate(): Promise<SelfUpdateView> {
	const payload = await readJson<SelfUpdatePayload>(await fetch(UPDATE_PATH), 'Updates');
	return selfUpdateRecord(payload.update);
}

export async function saveSelfUpdate(enabled: boolean): Promise<string> {
	const response = await fetch(UPDATE_PATH, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ enabled }),
	});
	const payload = await response.json() as SelfUpdatePayload;
	if (!response.ok) throw new Error(payload.message ?? `Update policy rejected (${response.status}).`);
	return enabled ? 'Automatic native updates enabled.' : 'Automatic native updates disabled.';
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
	const payload = await readJson<ChainRunsPayload>(await fetch(CHAIN_RUNS_PATH), 'Run chaining');
	return { enabled: payload.enabled === true, pause: chainPauseRecord(payload.pause) };
}

export async function saveChainRuns(enabled: boolean): Promise<string> {
	const response = await fetch(CHAIN_RUNS_PATH, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ enabled }),
	});
	const payload = (await response.json()) as ChainRunsPayload;
	if (!response.ok) return payload.message ?? `Run chaining rejected (${response.status}).`;
	return enabled ? 'Automatic run chaining enabled.' : 'Automatic run chaining disabled.';
}

/** ntfy and Resend (GSHIP-653), neither depending on the other for the panel to show it. */
export const NOTIFICATION_CHANNEL_IDS = ['ntfy', 'resend'] as const;

export type NotificationChannelId = (typeof NOTIFICATION_CHANNEL_IDS)[number];

/**
 * Never a secret itself -- only whether the channel resolved a complete
 * configuration (GSHIP-652), and, for a channel needing more than one value,
 * which ones are still missing, named, never valued (GSHIP-653).
 */
export interface NotificationChannelView {
	configured: boolean;
	missing: string[];
	/** Effective non-secret Resend values; null for ntfy or when absent. */
	from: string | null;
	to: string | null;
	fileCredentialExists: boolean;
	externallyManaged: Readonly<Record<'apiKey' | 'from' | 'to', boolean>>;
}

export type NotificationChannelsView = Record<NotificationChannelId, NotificationChannelView>;

export function emptyNotificationChannels(): NotificationChannelsView {
	const empty = (): NotificationChannelView => ({
		configured: false,
		missing: [],
		from: null,
		to: null,
		fileCredentialExists: false,
		externallyManaged: { apiKey: false, from: false, to: false },
	});
	return { ntfy: empty(), resend: empty() };
}

interface NotificationChannelsPayload {
	channels?: Partial<Record<NotificationChannelId, Partial<NotificationChannelView>>>;
}

/** A channel absent from the payload, or missing its own field, reads as not configured -- never a hole. */
export async function fetchNotificationChannels(): Promise<NotificationChannelsView> {
	const payload = await readJson<NotificationChannelsPayload>(
		await fetch(NOTIFICATIONS_PATH),
		'Notifications',
	);
	const channels = emptyNotificationChannels();
	for (const id of NOTIFICATION_CHANNEL_IDS) {
		const raw = payload.channels?.[id];
		channels[id] = {
			configured: raw?.configured === true,
			missing: Array.isArray(raw?.missing) ? raw.missing.filter((item) => typeof item === 'string') : [],
			from: typeof raw?.from === 'string' ? raw.from : null,
			to: typeof raw?.to === 'string' ? raw.to : null,
			fileCredentialExists: raw?.fileCredentialExists === true,
			externallyManaged: {
				apiKey: raw?.externallyManaged?.apiKey === true,
				from: raw?.externallyManaged?.from === true,
				to: raw?.externallyManaged?.to === true,
			},
		};
	}
	return channels;
}

interface NotificationTestPayload extends CommandPayload {
	outcome?: string;
}

/** Fires a real delivery through the channel and reports whether it was accepted, never the secret. */
export async function sendNotificationTest(channelId: NotificationChannelId): Promise<string> {
	const response = await fetch(`${NOTIFICATIONS_PATH}/${channelId}/test`, { method: 'POST' });
	const payload = (await response.json()) as NotificationTestPayload;
	if (response.ok) return payload.message ?? 'Test message delivered.';
	return payload.message ?? `Test rejected (${response.status}).`;
}

export interface ResendSettingsInput {
	from: string;
	to: string;
	/** Empty preserves the current file-backed credential. */
	apiKey: string;
}

export async function saveResendSettings(input: ResendSettingsInput): Promise<string> {
	const response = await fetch(`${NOTIFICATIONS_PATH}/resend`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});
	const payload = (await response.json()) as CommandPayload;
	if (!response.ok) return payload.message ?? `Resend settings rejected (${response.status}).`;
	return payload.message ?? 'Resend settings saved.';
}

export async function removeResendCredential(): Promise<string> {
	const response = await fetch(`${NOTIFICATIONS_PATH}/resend/credential`, { method: 'DELETE' });
	const payload = (await response.json()) as CommandPayload;
	if (!response.ok) return payload.message ?? `Resend credential removal rejected (${response.status}).`;
	return payload.message ?? 'File-backed Resend credential removed.';
}

export async function startCodexLogin(): Promise<string> {
	const response = await fetch(`${PROVIDERS_PATH}/codex/login`, { method: 'POST' });
	const payload = (await response.json()) as CodexLoginPayload;
	if (!response.ok || payload.login === undefined) {
		throw new Error(payload.message ?? `Login rejected (${response.status}).`);
	}
	return payload.login.authUrl;
}

export function selectProvider(providerId: ProviderStatusView['id']): Promise<string> {
	return postCommand(`${PROVIDERS_PATH}/${providerId}/select`);
}

/**
 * Whatever identity the connected credential happened to expose (GSHIP-705),
 * never the proof that it works and never the token. Absent fields are
 * absent, not empty strings: a `claude setup-token` credential is limited to
 * inference and commonly reports no identity at all.
 */
export interface ClaudeCredentialIdentity {
	account?: string;
	organization?: string;
	plan?: string;
}

/** What Ajustes tells the operator after a dedicated credential was accepted (GSHIP-704), never the token itself. */
export interface ClaudeCredentialConfirmation {
	identity?: ClaudeCredentialIdentity;
}

/**
 * Connect, reconnect and rotate the dedicated Claude credential all share
 * this one call: the service validates the candidate token with one real,
 * isolated inference call before persisting it, and this resolves only once
 * that succeeded -- never with the token, which the service never returns on
 * any outcome. A rejection throws with the service's own refusal, so the
 * caller can show it beside the field the operator must correct.
 */
export async function connectClaudeCredential(token: string): Promise<ClaudeCredentialConfirmation> {
	const response = await fetch(`${PROVIDERS_PATH}/claude/credential`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ token }),
	});
	const payload = (await response.json()) as ClaudeCredentialPayload;
	if (!response.ok || payload.ok !== true) {
		throw new Error(payload.message ?? `Connection rejected (${response.status}).`);
	}
	return payload.identity === undefined ? {} : { identity: payload.identity };
}

/**
 * The one sentence Ajustes reports after a successful connection. It claims
 * exactly what the service demonstrated -- the credential was accepted for
 * inference -- and says so plainly when Claude reported no identity to go
 * with it, rather than leaving the operator to read an empty confirmation as
 * a missing account (GSHIP-705).
 */
export function describeClaudeCredentialConfirmation(
	confirmation: ClaudeCredentialConfirmation,
): string {
	const identity = [
		confirmation.identity?.account,
		confirmation.identity?.organization,
		confirmation.identity?.plan,
	].filter((value): value is string => value !== undefined && value.trim().length > 0);
	return identity.length === 0
		? 'Dedicated Claude credential validated for inference. Claude reports no account, organization or plan for this token.'
		: `Dedicated Claude credential validated for inference: ${identity.join(' · ')}.`;
}

export async function disconnectClaudeCredential(): Promise<string> {
	const response = await fetch(`${PROVIDERS_PATH}/claude/credential`, { method: 'DELETE' });
	const payload = (await response.json()) as ClaudeCredentialPayload;
	if (!response.ok) return payload.message ?? `Disconnection rejected (${response.status}).`;
	return payload.removed
		? 'Dedicated Claude credential removed.'
		: 'No dedicated Claude credential was present.';
}

export async function fetchRunEvents(scope: ProjectScope, runId: string): Promise<RunEventView[]> {
	const payload = await readScopedJson<RunEventsPayload>(
		await fetch(`${runsPathOf(scope)}/${runId}/events`),
		'Activity',
	);
	return payload?.events ?? [];
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
	if (response.ok) return 'Run updated.';
	return payload.message ?? `Command rejected (${response.status}).`;
}

/** Starts the issue in the selected project's runtime, never the boot one. */
export function startRun(scope: ProjectScope, issueId: string): Promise<string> {
	return postCommand(runsPathOf(scope), { issueId });
}

export async function createIssue(
	scope: ProjectScope,
	input: OperatorIssueDraft,
): Promise<CreatedIssue> {
	const response = await fetch(issuesPathOf(scope), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});
	const payload = (await response.json()) as CreateIssuePayload;
	if (!response.ok) {
		throw new Error(payload.message ?? `Creation rejected (${response.status}).`);
	}
	if (payload.issue === undefined || typeof payload.issue.id !== 'string') {
		throw new Error('The server did not return the created issue.');
	}
	return payload.issue;
}

export async function specifyIssue(
	scope: ProjectScope,
	id: string,
	input: OperatorSpecDraft,
): Promise<CreatedIssue> {
	const response = await fetch(`${issuePathOf(scope, id)}/spec`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});
	const payload = (await response.json()) as CreateIssuePayload;
	if (!response.ok) {
		throw new Error(payload.message ?? `Specification rejected (${response.status}).`);
	}
	if (payload.issue === undefined || typeof payload.issue.id !== 'string') {
		throw new Error('The server did not return the specified idea.');
	}
	return payload.issue;
}

/** The inbox the server already filtered: only proposals still pending. */
export async function fetchProposals(): Promise<ProposalView[]> {
	const payload = await readJson<ProposalsPayload>(await fetch(PROPOSALS_PATH), 'Proposals');
	return payload.proposals ?? [];
}

/**
 * The settled proposals, newest decision first, separate from the pending
 * inbox above so a historical record never mixes with a pending decision.
 */
export async function fetchResolvedProposals(): Promise<ResolvedProposalsSnapshot> {
	const payload = await readJson<ResolvedProposalsPayload>(
		await fetch(RESOLVED_PROPOSALS_PATH),
		'Resolved proposals',
	);
	return { proposals: payload.proposals ?? [], omittedCount: payload.omittedCount ?? 0 };
}

export async function dismissProposal(id: string): Promise<string> {
	const response = await fetch(`${PROPOSALS_PATH}/${encodeURIComponent(id)}/dismiss`, {
		method: 'POST',
	});
	const payload = (await response.json()) as CommandPayload;
	if (response.ok) return 'Proposal dismissed.';
	return payload.message ?? `Dismissal rejected (${response.status}).`;
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
		throw new Error(payload.message ?? `Promotion rejected (${response.status}).`);
	}
	if (payload.issue === undefined || typeof payload.issue.id !== 'string') {
		throw new Error('The server did not return the created issue.');
	}
	return payload.issue;
}

export function approveIssue(scope: ProjectScope, id: string): Promise<string> {
	return postCommand(`${issuePathOf(scope, id)}/approve`);
}

/** Closes an open issue without shipping it, keeping the justification durable. */
export function abandonIssue(
	scope: ProjectScope,
	id: string,
	reason: string,
): Promise<string> {
	return postCommand(`${issuePathOf(scope, id)}/abandon`, { reason });
}

/**
 * Resume, cancel, abandon and ship, all addressed to the same project the
 * screen is reading (GSHIP-707): the command never falls back to the boot
 * runtime when another project is selected.
 */
export function commandRun(
	scope: ProjectScope,
	runId: string,
	action: RunAction,
	operatorGuidance?: string,
): Promise<string> {
	return postCommand(
		`${runsPathOf(scope)}/${runId}/${action}`,
		action === 'resume' && operatorGuidance !== undefined
			? { message: operatorGuidance }
			: undefined,
	);
}
