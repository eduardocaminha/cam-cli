import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AgentProviderId } from './agent-session.ts';
import {
	type DiagnosticDraft,
	type DiagnosticFinding,
	type DiagnosticFindingStatus,
	type DiagnosticScan,
	type DiagnosticScanState,
	DiagnosticTransitionError,
	diagnosticFingerprint,
	isDiagnosticFindingStatus,
	isDiagnosticScanState,
	normalizeDiagnosticDrafts,
} from './diagnostic-finding.ts';
import {
	defaultDiagnosticSchedule,
	DIAGNOSTIC_SCHEDULE_KEY,
	type DiagnosticScheduleSettings,
	normalizeDiagnosticSchedule,
} from './diagnostic-schedule.ts';
import {
	emptyModelSettings,
	MODEL_SETTINGS_KEY,
	type ModelSettings,
	normalizeModelSettings,
} from './model-settings.ts';
import {
	emptyOperatorProfile,
	normalizeOperatorProfile,
	OPERATOR_PROFILE_KEY,
	type OperatorProfile,
} from './operator-profile.ts';
import {
	isProposalRelationship,
	isProposalStatus,
	normalizeProposalDrafts,
	type ProposalDraft,
	type ProposalRelationship,
	type ProposalStatus,
	ProposalTransitionError,
	type RunProposal,
} from './run-proposal.ts';
import { isRunState, nextFixRounds, type RunState } from './run-state.ts';

export interface RunRecord {
	id: string;
	issueId: string;
	sessionId: string;
	providerId: AgentProviderId;
	workspacePath: string;
	state: RunState;
	fixRounds: number;
	createdAt: string;
	updatedAt: string;
	summary: string | null;
	error: string | null;
}

/**
 * Ephemeral provider/review stream chatter versus a durable decision the run
 * made (GSHIP-627). Written once at emission and never re-derived at read
 * time: `createRun` and `transition` write `decision` by construction, and
 * `appendEvent` defaults to `decision` unless its caller declares otherwise,
 * so a new kind that forgets to declare stays visible to a derived read
 * instead of silently disappearing from it.
 */
export type RunEventClass = 'activity' | 'decision';

export interface RunEvent {
	seq: number;
	runId: string;
	kind: string;
	fromState: RunState | null;
	toState: RunState;
	payload: Record<string, unknown>;
	createdAt: string;
	eventClass: RunEventClass;
}

export type OrchestratorMessageRole = 'operator' | 'orchestrator' | 'system';

/**
 * One orchestrator turn's own reported usage (GSHIP-634), captured from the
 * CLI's `.usage` event during that turn's call and stored beside the message
 * the turn produced -- never on the operator's or the system's own message. A
 * field the CLI never reported stays absent, never a fabricated zero, the
 * same honesty rule GSHIP-623 established for a run's cost.
 */
export interface OrchestratorMessageUsage {
	model?: string;
	effort?: string;
	totalCostUsd?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheReadInputTokens?: number;
	thinkingTokens?: number;
}

/** Durable public transcript shared across orchestrator provider sessions. */
export interface OrchestratorMessage {
	seq: number;
	providerId: AgentProviderId;
	role: OrchestratorMessageRole;
	text: string;
	createdAt: string;
	/** Present only on the orchestrator's own message, and only when the turn reported usage. */
	usage?: OrchestratorMessageUsage;
}

/**
 * Durable synthesis of the conversation, stored as a single overwritten record
 * so every provider session reads the same handoff.
 */
export interface OrchestratorHandoff {
	objective: string;
	decisions: string[];
	constraints: string[];
	openItems: string[];
}

export function emptyOrchestratorHandoff(): OrchestratorHandoff {
	return { objective: '', decisions: [], constraints: [], openItems: [] };
}

function decodeHandoffList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/** Accepts any shape; anything unusable degrades to the empty handoff. */
export function normalizeOrchestratorHandoff(value: unknown): OrchestratorHandoff {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return emptyOrchestratorHandoff();
	}
	const record = value as Record<string, unknown>;
	const objective = record['objective'];
	return {
		objective: typeof objective === 'string' ? objective.trim() : '',
		decisions: decodeHandoffList(record['decisions']),
		constraints: decodeHandoffList(record['constraints']),
		openItems: decodeHandoffList(record['openItems']),
	};
}

/**
 * Small brief maintained by the operator. It carries the same four fields as
 * the handoff, but it is authored by a human and never by an orchestrator turn.
 */
export type ProjectBrief = OrchestratorHandoff;

/** Enforced on every write so one oversized record cannot grow the prompt. */
export const PROJECT_BRIEF_LIMITS = {
	objective: 2000,
	listItems: 20,
	itemLength: 500,
} as const;

export function emptyProjectBrief(): ProjectBrief {
	return emptyOrchestratorHandoff();
}

function clampBriefList(items: readonly string[]): string[] {
	return items
		.slice(0, PROJECT_BRIEF_LIMITS.listItems)
		.map((item) => item.slice(0, PROJECT_BRIEF_LIMITS.itemLength));
}

/** Defensive read/write shaping; the PUT contract validates strictly instead. */
export function normalizeProjectBrief(value: unknown): ProjectBrief {
	const brief = normalizeOrchestratorHandoff(value);
	return {
		objective: brief.objective.slice(0, PROJECT_BRIEF_LIMITS.objective),
		decisions: clampBriefList(brief.decisions),
		constraints: clampBriefList(brief.constraints),
		openItems: clampBriefList(brief.openItems),
	};
}

export interface CreateRunInput {
	id: string;
	issueId: string;
	sessionId: string;
	providerId?: AgentProviderId;
	workspacePath: string;
	createdAt: string;
}

export interface TransitionRunInput {
	runId: string;
	toState: RunState;
	kind: string;
	createdAt: string;
	payload?: Record<string, unknown>;
	summary?: string | null;
	error?: string | null;
}

export interface AppendRunEventInput {
	runId: string;
	kind: string;
	createdAt: string;
	payload?: Record<string, unknown>;
	/** Declared by the caller; omitted means `decision`, never guessed from `kind`. */
	eventClass?: RunEventClass;
}

export interface RecordProposalsInput {
	runId: string;
	issueId: string;
	proposals: readonly ProposalDraft[];
	createdAt: string;
}

/** Which provider invocation reported the cost: GSHIP-617's two run roles. */
export type RunCostRole = 'executor' | 'reviewer';

/** One (role, model) pair's cost and token counts, summed across every invocation that reported it. */
export interface RunCostBreakdownEntry {
	role: RunCostRole;
	model: string;
	costUsd: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheCreationInputTokens?: number;
	cacheReadInputTokens?: number;
}

/**
 * A role's effort and thinking-token totals, summed across every invocation of
 * that role (GSHIP-628). Both are properties of the invocation -- the effort
 * flag it was called with, the thinking count `usage` reports at the call
 * level -- never of one model inside it, which is why they are reported here
 * instead of on a `RunCostBreakdownEntry` row. `effort` is absent, not
 * guessed, when the role's invocations reported more than one distinct value.
 */
export interface RunCostRoleUsage {
	role: RunCostRole;
	thinkingTokens?: number;
	effort?: string;
}

/**
 * A run's whole reported cost (GSHIP-623), derived from every `.usage` event
 * the run has, never from a display-bounded read. `totalCostUsd` is `null`
 * when the CLI never reported a cost for this run -- never `0`, which would
 * read as free.
 */
export interface RunCostSummary {
	totalCostUsd: number | null;
	breakdown: RunCostBreakdownEntry[];
	roles: RunCostRoleUsage[];
}

/** Raw diagnostic outcomes; no disposition is reinterpreted as a quality score. */
export interface DiagnosticFindingStats {
	total: number;
	pending: number;
	dismissed: number;
	promoted: number;
	cleared: number;
	recurring: number;
}

/** The two `.usage` event kinds `emitUsage` (claude-cli-process.ts) writes, keyed to their role. */
const USAGE_EVENT_ROLES: Readonly<Record<string, RunCostRole>> = {
	'provider.usage': 'executor',
	'review.usage': 'reviewer',
};

function decodeUsageNumber(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

function addTokenCount(existing: number | undefined, addition: number | undefined): number | undefined {
	return addition === undefined ? existing : (existing ?? 0) + addition;
}

/** Folds one `modelUsage` entry into the running per-(role, model) breakdown. */
function mergeModelUsageEntry(
	breakdown: Map<string, RunCostBreakdownEntry>,
	role: RunCostRole,
	entry: unknown,
): void {
	if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return;
	const record = entry as Record<string, unknown>;
	const model = record['model'];
	const costUsd = record['costUsd'];
	if (typeof model !== 'string' || typeof costUsd !== 'number') return;
	const inputTokens = decodeUsageNumber(record['inputTokens']);
	const outputTokens = decodeUsageNumber(record['outputTokens']);
	const cacheCreationInputTokens = decodeUsageNumber(record['cacheCreationInputTokens']);
	const cacheReadInputTokens = decodeUsageNumber(record['cacheReadInputTokens']);
	const key = `${role} ${model}`;
	const existing = breakdown.get(key);
	if (existing === undefined) {
		breakdown.set(key, {
			role,
			model,
			costUsd,
			...(inputTokens === undefined ? {} : { inputTokens }),
			...(outputTokens === undefined ? {} : { outputTokens }),
			...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
			...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
		});
		return;
	}
	existing.costUsd += costUsd;
	existing.inputTokens = addTokenCount(existing.inputTokens, inputTokens);
	existing.outputTokens = addTokenCount(existing.outputTokens, outputTokens);
	existing.cacheCreationInputTokens =
		addTokenCount(existing.cacheCreationInputTokens, cacheCreationInputTokens);
	existing.cacheReadInputTokens = addTokenCount(existing.cacheReadInputTokens, cacheReadInputTokens);
}

/** Folds one `.usage` event's payload into the running total and breakdown. */
function accumulateUsageRow(
	breakdown: Map<string, RunCostBreakdownEntry>,
	totalCostUsd: number | null,
	role: RunCostRole,
	payload: Record<string, unknown>,
): number | null {
	const eventTotal = payload['totalCostUsd'];
	const next = typeof eventTotal === 'number' ? (totalCostUsd ?? 0) + eventTotal : totalCostUsd;
	const modelUsage = payload['modelUsage'];
	if (Array.isArray(modelUsage)) {
		for (const entry of modelUsage) mergeModelUsageEntry(breakdown, role, entry);
	}
	return next;
}

/** `payload.effort`, the flag `emitUsage` (claude-cli-process.ts) passed for the whole invocation. */
function decodeEffort(payload: Record<string, unknown>): string | undefined {
	const value = payload['effort'];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `payload.usage.thinkingTokens`, the invocation-level count `ClaudeResultUsage` reports (claude-stream.ts). */
function decodeThinkingTokens(payload: Record<string, unknown>): number | undefined {
	const usage = payload['usage'];
	if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
	return decodeUsageNumber((usage as Record<string, unknown>)['thinkingTokens']);
}

/** `payload.model`, the slot `emitUsage` (claude-cli-process.ts) passed for the whole invocation. */
function decodeUsageModel(payload: Record<string, unknown>): string | undefined {
	const value = payload['model'];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** One field out of `payload.usage`, the invocation-level object `ClaudeResultUsage` reports. */
function decodeUsageObjectField(payload: Record<string, unknown>, field: string): number | undefined {
	const usage = payload['usage'];
	if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
	return decodeUsageNumber((usage as Record<string, unknown>)[field]);
}

/**
 * Decodes one orchestrator turn's raw `orchestrator.usage` emit payload
 * (GSHIP-634) into the single-invocation shape `appendOrchestratorMessage`
 * persists: the model/effort pair the turn's call was made with, the total
 * cost it reported, and the five token counts `ClaudeResultUsage` extracts
 * (GSHIP-623). A field the CLI never reported stays absent -- never a
 * fabricated zero -- and the whole result is `undefined` when the turn
 * reported nothing measurable at all.
 */
export function decodeOrchestratorTurnUsage(
	payload: Record<string, unknown>,
): OrchestratorMessageUsage | undefined {
	const model = decodeUsageModel(payload);
	const effort = decodeEffort(payload);
	const eventTotalCostUsd = payload['totalCostUsd'];
	const totalCostUsd = typeof eventTotalCostUsd === 'number' ? eventTotalCostUsd : undefined;
	const inputTokens = decodeUsageObjectField(payload, 'inputTokens');
	const outputTokens = decodeUsageObjectField(payload, 'outputTokens');
	const cacheCreationInputTokens = decodeUsageObjectField(payload, 'cacheCreationInputTokens');
	const cacheReadInputTokens = decodeUsageObjectField(payload, 'cacheReadInputTokens');
	const thinkingTokens = decodeThinkingTokens(payload);
	const usage: OrchestratorMessageUsage = {
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort }),
		...(totalCostUsd === undefined ? {} : { totalCostUsd }),
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
		...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
		...(thinkingTokens === undefined ? {} : { thinkingTokens }),
	};
	return Object.keys(usage).length === 0 ? undefined : usage;
}

interface RoleUsageAccumulator {
	thinkingTokens: number | undefined;
	effort: string | undefined;
	/** Once two invocations of the role disagreed, `effort` stays absent for good. */
	effortDiverged: boolean;
}

/**
 * Folds one invocation's effort and thinking tokens into its role's running
 * total (GSHIP-628). Thinking always sums, the same as any other count; effort
 * is carried only while every invocation of the role agrees, and is cleared
 * for good the moment two of them disagree -- never guessed by picking one.
 */
function accumulateRoleUsage(
	roles: Map<RunCostRole, RoleUsageAccumulator>,
	role: RunCostRole,
	payload: Record<string, unknown>,
): void {
	const effort = decodeEffort(payload);
	const thinkingTokens = decodeThinkingTokens(payload);
	const existing = roles.get(role) ?? { thinkingTokens: undefined, effort: undefined, effortDiverged: false };
	existing.thinkingTokens = addTokenCount(existing.thinkingTokens, thinkingTokens);
	if (!existing.effortDiverged && effort !== undefined) {
		if (existing.effort === undefined) {
			existing.effort = effort;
		} else if (existing.effort !== effort) {
			existing.effort = undefined;
			existing.effortDiverged = true;
		}
	}
	roles.set(role, existing);
}

/** Drops a role with nothing to report, the same absence-over-empty-value pattern as the breakdown. */
function toRoleUsage(role: RunCostRole, acc: RoleUsageAccumulator): RunCostRoleUsage | undefined {
	if (acc.thinkingTokens === undefined && acc.effort === undefined) return undefined;
	return {
		role,
		...(acc.thinkingTokens === undefined ? {} : { thinkingTokens: acc.thinkingTokens }),
		...(acc.effort === undefined ? {} : { effort: acc.effort }),
	};
}

interface RunRow {
	id: string;
	issue_id: string;
	session_id: string | null;
	provider_id: string | null;
	workspace_path: string | null;
	state: string;
	fix_rounds: number;
	created_at: string;
	updated_at: string;
	summary: string | null;
	error: string | null;
}

interface EventRow {
	seq: number;
	run_id: string;
	kind: string;
	from_state: string | null;
	to_state: string;
	payload_json: string;
	created_at: string;
	event_class: string;
}

interface ProposalRow {
	id: string;
	run_id: string;
	issue_id: string;
	relationship: string;
	status: string;
	promoted_issue_id: string | null;
	title: string;
	evidence: string;
	created_at: string;
	updated_at: string;
}

interface DiagnosticScanRow {
	id: string;
	analyzer: string;
	analyzer_version: string | null;
	source_sha: string | null;
	state: string;
	coverage_complete: number;
	finding_count: number;
	error: string | null;
	created_at: string;
	updated_at: string;
}

interface DiagnosticFindingRow {
	id: string;
	fingerprint: string;
	analyzer: string;
	rule: string;
	severity: string;
	file: string;
	line: number | null;
	column: number | null;
	evidence: string;
	tool_version: string;
	source_sha: string;
	status: string;
	promoted_issue_id: string | null;
	occurrence_count: number;
	first_seen_at: string;
	last_seen_at: string;
	status_updated_at: string;
}

interface OrchestratorMessageRow {
	seq: number;
	provider_id: string;
	role: string;
	text: string;
	created_at: string;
	model: string | null;
	effort: string | null;
	total_cost_usd: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_creation_input_tokens: number | null;
	cache_read_input_tokens: number | null;
	thinking_tokens: number | null;
}

function decodeState(value: string): RunState {
	if (!isRunState(value)) throw new Error(`invalid persisted run state: ${value}`);
	return value;
}

function decodeRun(row: RunRow): RunRecord {
	const providerId = row.provider_id === 'codex' ? 'codex' : 'claude';
	return {
		id: row.id,
		issueId: row.issue_id,
		sessionId: row.session_id ?? row.id,
		providerId,
		workspacePath: row.workspace_path ?? '',
		state: decodeState(row.state),
		fixRounds: row.fix_rounds,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		summary: row.summary,
		error: row.error,
	};
}

function decodePayload(json: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(json) as unknown;
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// A malformed payload must not hide the state transition around it.
	}
	return {};
}

/** Single `runtime_settings` row holding the chain switch (GSHIP-638), beside `provider` and `MODEL_SETTINGS_KEY`. */
const CHAIN_RUNS_KEY = 'chain-runs';

/** Anything other than the literal `activity` reads as `decision`, the safe default. */
function decodeEventClass(value: string): RunEventClass {
	return value === 'activity' ? 'activity' : 'decision';
}

function decodeEvent(row: EventRow): RunEvent {
	return {
		seq: row.seq,
		runId: row.run_id,
		kind: row.kind,
		fromState: row.from_state === null ? null : decodeState(row.from_state),
		toState: decodeState(row.to_state),
		payload: decodePayload(row.payload_json),
		createdAt: row.created_at,
		eventClass: decodeEventClass(row.event_class),
	};
}

/**
 * The status is now the operator's decision, so it is read back from the row
 * instead of assumed. A row carrying anything else is a corrupt write rather
 * than a newer meaning, and is refused like an invalid run state.
 */
function decodeProposalStatus(value: string): ProposalStatus {
	if (!isProposalStatus(value)) throw new Error(`invalid persisted proposal status: ${value}`);
	return value;
}

function decodeProposalRelationship(value: string): ProposalRelationship {
	if (!isProposalRelationship(value)) {
		throw new Error(`invalid persisted proposal relationship: ${value}`);
	}
	return value;
}

function decodeProposal(row: ProposalRow): RunProposal {
	return {
		id: row.id,
		relationship: decodeProposalRelationship(row.relationship),
		status: decodeProposalStatus(row.status),
		sourceRunId: row.run_id,
		sourceIssueId: row.issue_id,
		promotedIssueId: row.promoted_issue_id,
		title: row.title,
		evidence: row.evidence,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function decodeDiagnosticScan(row: DiagnosticScanRow): DiagnosticScan {
	if (!isDiagnosticScanState(row.state)) {
		throw new Error(`invalid persisted diagnostic scan state: ${row.state}`);
	}
	return {
		id: row.id,
		analyzer: row.analyzer,
		analyzerVersion: row.analyzer_version,
		sourceSha: row.source_sha,
		state: row.state,
		coverageComplete: row.coverage_complete === 1,
		findingCount: row.finding_count,
		error: row.error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function decodeDiagnosticFinding(row: DiagnosticFindingRow): DiagnosticFinding {
	if (!isDiagnosticFindingStatus(row.status)) {
		throw new Error(`invalid persisted diagnostic finding status: ${row.status}`);
	}
	const severity = row.severity === 'error' || row.severity === 'warning'
		? row.severity
		: 'info';
	return {
		id: row.id,
		analyzer: row.analyzer,
		rule: row.rule,
		severity,
		file: row.file,
		evidence: row.evidence,
		...(row.line === null ? {} : { line: row.line }),
		...(row.column === null ? {} : { column: row.column }),
		toolVersion: row.tool_version,
		sourceSha: row.source_sha,
		status: row.status,
		promotedIssueId: row.promoted_issue_id,
		occurrenceCount: row.occurrence_count,
		firstSeenAt: row.first_seen_at,
		lastSeenAt: row.last_seen_at,
		updatedAt: row.status_updated_at,
	};
}

/** Absence over a fabricated zero: a column the row never had reads as no usage at all, never as a free turn. */
function decodeOrchestratorMessageUsage(row: OrchestratorMessageRow): OrchestratorMessageUsage | undefined {
	const usage: OrchestratorMessageUsage = {
		...(row.model === null ? {} : { model: row.model }),
		...(row.effort === null ? {} : { effort: row.effort }),
		...(row.total_cost_usd === null ? {} : { totalCostUsd: row.total_cost_usd }),
		...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
		...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
		...(row.cache_creation_input_tokens === null
			? {}
			: { cacheCreationInputTokens: row.cache_creation_input_tokens }),
		...(row.cache_read_input_tokens === null ? {} : { cacheReadInputTokens: row.cache_read_input_tokens }),
		...(row.thinking_tokens === null ? {} : { thinkingTokens: row.thinking_tokens }),
	};
	return Object.keys(usage).length === 0 ? undefined : usage;
}

function decodeOrchestratorMessage(row: OrchestratorMessageRow): OrchestratorMessage {
	const role = row.role === 'orchestrator' || row.role === 'system'
		? row.role
		: 'operator';
	const usage = decodeOrchestratorMessageUsage(row);
	return {
		seq: row.seq,
		providerId: row.provider_id === 'codex' ? 'codex' : 'claude',
		role,
		text: row.text,
		createdAt: row.created_at,
		...(usage === undefined ? {} : { usage }),
	};
}

export class RunStore {
	readonly #db: Database;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#db = new Database(path, { create: true, strict: true });
		this.#db.exec('PRAGMA foreign_keys = ON;');
		this.#db.exec('PRAGMA journal_mode = WAL;');
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS runs (
				id TEXT PRIMARY KEY,
				issue_id TEXT NOT NULL,
				session_id TEXT,
				provider_id TEXT,
				workspace_path TEXT,
				state TEXT NOT NULL,
				fix_rounds INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				summary TEXT,
				error TEXT
			);
			CREATE TABLE IF NOT EXISTS run_events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				from_state TEXT,
				to_state TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				event_class TEXT NOT NULL DEFAULT 'decision'
			);
			CREATE INDEX IF NOT EXISTS run_events_run_seq ON run_events(run_id, seq);
			CREATE TABLE IF NOT EXISTS run_proposals (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
				issue_id TEXT NOT NULL,
				relationship TEXT NOT NULL,
				status TEXT NOT NULL,
				promoted_issue_id TEXT,
				title TEXT NOT NULL,
				evidence TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS run_proposals_run_seq ON run_proposals(run_id, seq);
			CREATE TABLE IF NOT EXISTS diagnostic_scans (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				analyzer TEXT NOT NULL,
				analyzer_version TEXT,
				source_sha TEXT,
				state TEXT NOT NULL,
				coverage_complete INTEGER NOT NULL DEFAULT 0,
				finding_count INTEGER NOT NULL DEFAULT 0,
				error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS diagnostic_findings (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				fingerprint TEXT NOT NULL UNIQUE,
				analyzer TEXT NOT NULL,
				rule TEXT NOT NULL,
				severity TEXT NOT NULL,
				file TEXT NOT NULL,
				line INTEGER,
				column INTEGER,
				evidence TEXT NOT NULL,
				tool_version TEXT NOT NULL,
				source_sha TEXT NOT NULL,
				status TEXT NOT NULL,
				promoted_issue_id TEXT,
				occurrence_count INTEGER NOT NULL DEFAULT 1,
				first_seen_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				status_updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS diagnostic_findings_status_seq
				ON diagnostic_findings(status, seq);
			CREATE TABLE IF NOT EXISTS runtime_settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS orchestrator_sessions (
				provider_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS orchestrator_handoff (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					handoff_json TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS project_brief (
						id INTEGER PRIMARY KEY CHECK (id = 1),
						brief_json TEXT NOT NULL,
						updated_at TEXT NOT NULL
					);
					CREATE TABLE IF NOT EXISTS orchestrator_messages (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				provider_id TEXT NOT NULL,
				role TEXT NOT NULL,
				text TEXT NOT NULL,
				created_at TEXT NOT NULL,
				model TEXT,
				effort TEXT,
				total_cost_usd REAL,
				input_tokens INTEGER,
				output_tokens INTEGER,
				cache_creation_input_tokens INTEGER,
				cache_read_input_tokens INTEGER,
				thinking_tokens INTEGER
			);
		`);
		const columns = this.#db.query('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === 'session_id')) {
			this.#db.exec('ALTER TABLE runs ADD COLUMN session_id TEXT;');
		}
		if (!columns.some((column) => column.name === 'workspace_path')) {
			this.#db.exec('ALTER TABLE runs ADD COLUMN workspace_path TEXT;');
		}
		if (!columns.some((column) => column.name === 'provider_id')) {
			this.#db.exec('ALTER TABLE runs ADD COLUMN provider_id TEXT;');
		}
		this.#db.exec('UPDATE runs SET session_id = id WHERE session_id IS NULL;');
		this.#db.exec("UPDATE runs SET provider_id = 'claude' WHERE provider_id IS NULL;");
		// A GSHIP-612 database already carries captured proposals, and its table
		// predates the promoted issue: the column is added instead of recreated.
		const proposalColumns = this.#db
			.query('PRAGMA table_info(run_proposals)')
			.all() as Array<{ name: string }>;
		if (!proposalColumns.some((column) => column.name === 'promoted_issue_id')) {
			this.#db.exec('ALTER TABLE run_proposals ADD COLUMN promoted_issue_id TEXT;');
		}
		// A pre-GSHIP-627 database has no class at all. The suffixes below are a
		// one-time read of what those rows already were -- the four stream kinds
		// they name are exactly the ephemeral provider/review activity measured
		// at spec time -- and this rule never runs again after this migration:
		// every row written from here on carries the class its writer declared.
		const eventColumns = this.#db.query('PRAGMA table_info(run_events)').all() as Array<{ name: string }>;
		if (!eventColumns.some((column) => column.name === 'event_class')) {
			this.#db.exec("ALTER TABLE run_events ADD COLUMN event_class TEXT NOT NULL DEFAULT 'decision';");
			this.#db.exec(`
				UPDATE run_events SET event_class = 'activity'
				WHERE kind LIKE '%.system' OR kind LIKE '%.activity';
			`);
		}
		// A pre-GSHIP-634 database has no usage columns at all: every existing row
		// reads back with no usage, the same as a turn that never reported one.
		const orchestratorMessageColumns = this.#db
			.query('PRAGMA table_info(orchestrator_messages)')
			.all() as Array<{ name: string }>;
		if (!orchestratorMessageColumns.some((column) => column.name === 'model')) {
			this.#db.exec(`
				ALTER TABLE orchestrator_messages ADD COLUMN model TEXT;
				ALTER TABLE orchestrator_messages ADD COLUMN effort TEXT;
				ALTER TABLE orchestrator_messages ADD COLUMN total_cost_usd REAL;
				ALTER TABLE orchestrator_messages ADD COLUMN input_tokens INTEGER;
				ALTER TABLE orchestrator_messages ADD COLUMN output_tokens INTEGER;
				ALTER TABLE orchestrator_messages ADD COLUMN cache_creation_input_tokens INTEGER;
				ALTER TABLE orchestrator_messages ADD COLUMN cache_read_input_tokens INTEGER;
				ALTER TABLE orchestrator_messages ADD COLUMN thinking_tokens INTEGER;
			`);
		}
	}

	createRun(input: CreateRunInput): { run: RunRecord; event: RunEvent } {
		const create = this.#db.transaction(() => {
			this.#db.query(`
				INSERT INTO runs (
					id, issue_id, session_id, provider_id, workspace_path, state, fix_rounds, created_at, updated_at
				) VALUES ($id, $issueId, $sessionId, $providerId, $workspacePath, 'queued', 0, $createdAt, $createdAt)
			`).run({
				id: input.id,
				issueId: input.issueId,
				sessionId: input.sessionId,
				providerId: input.providerId ?? 'claude',
				workspacePath: input.workspacePath,
				createdAt: input.createdAt,
			});
			const inserted = this.#db.query(`
				INSERT INTO run_events (
					run_id, kind, from_state, to_state, payload_json, created_at, event_class
				) VALUES ($runId, 'run.created', NULL, 'queued', '{}', $createdAt, 'decision')
				RETURNING *
			`).get({ runId: input.id, createdAt: input.createdAt }) as EventRow;
			return inserted;
		});
		const event = create();
		const run = this.getRun(input.id);
		if (run === null) throw new Error(`created run disappeared: ${input.id}`);
		return { run, event: decodeEvent(event) };
	}

	transition(input: TransitionRunInput): { run: RunRecord; event: RunEvent } {
		const apply = this.#db.transaction(() => {
			const current = this.getRun(input.runId);
			if (current === null) throw new Error(`run not found: ${input.runId}`);
			const fixRounds = nextFixRounds(current, input.toState);
			this.#db.query(`
				UPDATE runs
				SET state = $toState,
					fix_rounds = $fixRounds,
					updated_at = $createdAt,
					summary = COALESCE($summary, summary),
					error = COALESCE($error, error)
				WHERE id = $runId
			`).run({
				runId: input.runId,
				toState: input.toState,
				fixRounds,
				createdAt: input.createdAt,
				summary: input.summary ?? null,
				error: input.error ?? null,
			});
			return this.#db.query(`
				INSERT INTO run_events (
					run_id, kind, from_state, to_state, payload_json, created_at, event_class
				) VALUES ($runId, $kind, $fromState, $toState, $payloadJson, $createdAt, 'decision')
				RETURNING *
			`).get({
				runId: input.runId,
				kind: input.kind,
				fromState: current.state,
				toState: input.toState,
				payloadJson: JSON.stringify(input.payload ?? {}),
				createdAt: input.createdAt,
			}) as EventRow;
		});
		const event = apply();
		const run = this.getRun(input.runId);
		if (run === null) throw new Error(`transitioned run disappeared: ${input.runId}`);
		return { run, event: decodeEvent(event) };
	}

	appendEvent(input: AppendRunEventInput): RunEvent {
		const current = this.getRun(input.runId);
		if (current === null) throw new Error(`run not found: ${input.runId}`);
		const row = this.#db.query(`
			INSERT INTO run_events (
				run_id, kind, from_state, to_state, payload_json, created_at, event_class
			) VALUES ($runId, $kind, $state, $state, $payloadJson, $createdAt, $eventClass)
			RETURNING *
		`).get({
			runId: input.runId,
			kind: input.kind,
			state: current.state,
			payloadJson: JSON.stringify(input.payload ?? {}),
			createdAt: input.createdAt,
			eventClass: input.eventClass ?? 'decision',
		}) as EventRow;
		return decodeEvent(row);
	}

	/**
	 * Persist the out-of-scope ideas one accepted result reported. Each id is
	 * derived from its run and its position in the run's capture sequence, so a
	 * stored proposal is always readable under the same id, and a later capture
	 * on the same run continues the sequence instead of overwriting it.
	 */
	recordProposals(input: RecordProposalsInput): RunProposal[] {
		const drafts = normalizeProposalDrafts(input.proposals);
		if (drafts.length === 0) return [];
		const insert = this.#db.transaction(() => {
			const recorded = this.#db.query(`
				SELECT COUNT(*) AS total FROM run_proposals WHERE run_id = $runId
			`).get({ runId: input.runId }) as { total: number };
			return drafts.map((draft, index) => this.#db.query(`
				INSERT INTO run_proposals (
					id, run_id, issue_id, relationship, status, title, evidence, created_at, updated_at
				) VALUES (
					$id, $runId, $issueId, 'derived-from', 'pending', $title, $evidence, $createdAt, $createdAt
				)
				RETURNING *
			`).get({
				id: `${input.runId}-proposal-${recorded.total + index + 1}`,
				runId: input.runId,
				issueId: input.issueId,
				title: draft.title,
				evidence: draft.evidence,
				createdAt: input.createdAt,
			}) as ProposalRow);
		});
		return insert().map(decodeProposal);
	}

	/** Newest bounded window of captured proposals, in capture order. */
	listProposals(limit = 200): RunProposal[] {
		const rows = this.#db.query(`
			SELECT * FROM (
				SELECT * FROM run_proposals ORDER BY seq DESC LIMIT $limit
			) ORDER BY seq ASC
		`).all({ limit }) as ProposalRow[];
		return rows.map(decodeProposal);
	}

	/**
	 * The proposals still awaiting an operator decision. A dismissed or promoted
	 * one is durable but settled, so it never competes for the same window.
	 */
	listPendingProposals(limit = 200): RunProposal[] {
		const rows = this.#db.query(`
			SELECT * FROM (
				SELECT * FROM run_proposals WHERE status = 'pending' ORDER BY seq DESC LIMIT $limit
			) ORDER BY seq ASC
		`).all({ limit }) as ProposalRow[];
		return rows.map(decodeProposal);
	}

	/**
	 * The proposals the operator already settled, newest decision first, capped
	 * at `limit` so a long-lived project's history never renders unbounded.
	 * `omittedCount` is the settled total beyond that cap -- reported instead of
	 * dropped in silence (GSHIP-643), the same way `omittedCount` already works
	 * for the orchestrator's own proposal context in web.ts.
	 */
	listResolvedProposals(limit = 20): { proposals: RunProposal[]; omittedCount: number } {
		const { total } = this.#db.query(`
			SELECT COUNT(*) AS total FROM run_proposals WHERE status != 'pending'
		`).get() as { total: number };
		const rows = this.#db.query(`
			SELECT * FROM run_proposals WHERE status != 'pending'
			ORDER BY updated_at DESC, seq DESC LIMIT $limit
		`).all({ limit }) as ProposalRow[];
		return { proposals: rows.map(decodeProposal), omittedCount: total - rows.length };
	}

	getProposal(id: string): RunProposal | null {
		const row = this.#db.query(`
			SELECT * FROM run_proposals WHERE id = $id
		`).get({ id }) as ProposalRow | null;
		return row === null ? null : decodeProposal(row);
	}

	/** The operator discarded the idea; nothing is filed and nothing is undone. */
	dismissProposal(id: string, updatedAt: string): RunProposal {
		return this.#settleProposal(id, 'dismissed', null, updatedAt);
	}

	/**
	 * The idea became `issueId`. The caller files the issue first, so a proposal
	 * only reaches this status once a real issue exists to point at.
	 */
	promoteProposal(id: string, issueId: string, updatedAt: string): RunProposal {
		const promotedIssueId = issueId.trim();
		if (promotedIssueId.length === 0) throw new Error('promoted issueId is required');
		return this.#settleProposal(id, 'promoted', promotedIssueId, updatedAt);
	}

	/**
	 * The single write that settles a proposal: guarded by `pending` inside the
	 * statement, so a repeated decision is refused rather than reapplied even
	 * when two of them race.
	 */
	#settleProposal(
		id: string,
		status: ProposalStatus,
		promotedIssueId: string | null,
		updatedAt: string,
	): RunProposal {
		const row = this.#db.query(`
			UPDATE run_proposals
			SET status = $status, promoted_issue_id = $promotedIssueId, updated_at = $updatedAt
			WHERE id = $id AND status = 'pending'
			RETURNING *
		`).get({ id, status, promotedIssueId, updatedAt }) as ProposalRow | null;
		if (row !== null) return decodeProposal(row);
		const current = this.getProposal(id);
		if (current === null) {
			throw new ProposalTransitionError('proposal-not-found', `Proposta ${id} não existe.`, 404);
		}
		throw new ProposalTransitionError(
			'proposal-not-pending',
			`Proposta ${id} já está ${current.status}.`,
			409,
		);
	}

	createDiagnosticScan(input: { id: string; analyzer: string; createdAt: string }): DiagnosticScan {
		const row = this.#db.query(`
			INSERT INTO diagnostic_scans (id, analyzer, state, created_at, updated_at)
			VALUES ($id, $analyzer, 'queued', $createdAt, $createdAt)
			RETURNING *
		`).get(input) as DiagnosticScanRow;
		return decodeDiagnosticScan(row);
	}

	beginDiagnosticScan(input: {
		id: string;
		analyzerVersion: string;
		sourceSha: string;
		updatedAt: string;
	}): DiagnosticScan {
		const row = this.#db.query(`
			UPDATE diagnostic_scans
			SET state = 'running', analyzer_version = $analyzerVersion,
				source_sha = $sourceSha, updated_at = $updatedAt
			WHERE id = $id AND state = 'queued'
			RETURNING *
		`).get(input) as DiagnosticScanRow | null;
		if (row === null) throw new Error(`diagnostic scan cannot start: ${input.id}`);
		return decodeDiagnosticScan(row);
	}

	/**
	 * One successful analyzer report and its inbox projection. A complete report
	 * clears older pending findings it no longer observes; a partial report never
	 * claims absence. Dismissed/promoted findings stay settled when they recur.
	 */
	completeDiagnosticScan(input: {
		id: string;
		analyzerVersion: string;
		sourceSha: string;
		coverageComplete: boolean;
		findings: readonly DiagnosticDraft[];
		updatedAt: string;
	}): { scan: DiagnosticScan; findings: DiagnosticFinding[] } {
		const drafts = normalizeDiagnosticDrafts(input.findings);
		const apply = this.#db.transaction(() => {
			const scan = this.getDiagnosticScan(input.id);
			if (scan === null || scan.state !== 'running') {
				throw new Error(`diagnostic scan cannot complete: ${input.id}`);
			}
			if (input.coverageComplete) {
				this.#db.query(`
					UPDATE diagnostic_findings
					SET status = 'cleared', status_updated_at = $updatedAt
					WHERE analyzer = $analyzer AND status = 'pending'
				`).run({ analyzer: scan.analyzer, updatedAt: input.updatedAt });
			}

			const findings = drafts.map((draft) => {
				const fingerprint = diagnosticFingerprint(scan.analyzer, draft);
				return this.#db.query(`
					INSERT INTO diagnostic_findings (
						id, fingerprint, analyzer, rule, severity, file, line, column,
						evidence, tool_version, source_sha, status, occurrence_count,
						first_seen_at, last_seen_at, status_updated_at
					) VALUES (
						$id, $fingerprint, $analyzer, $rule, $severity, $file, $line, $column,
						$evidence, $toolVersion, $sourceSha, 'pending', 1,
						$updatedAt, $updatedAt, $updatedAt
					)
					ON CONFLICT(fingerprint) DO UPDATE SET
						severity = excluded.severity,
						line = excluded.line,
						column = excluded.column,
						evidence = excluded.evidence,
						tool_version = excluded.tool_version,
						source_sha = excluded.source_sha,
						status = CASE
							WHEN diagnostic_findings.status = 'cleared' THEN 'pending'
							ELSE diagnostic_findings.status
						END,
						occurrence_count = diagnostic_findings.occurrence_count + 1,
						last_seen_at = excluded.last_seen_at,
						status_updated_at = CASE
							WHEN diagnostic_findings.status = 'cleared' THEN excluded.status_updated_at
							ELSE diagnostic_findings.status_updated_at
						END
					RETURNING *
				`).get({
					id: `diagnostic-${fingerprint}`,
					fingerprint,
					analyzer: scan.analyzer,
					rule: draft.rule,
					severity: draft.severity,
					file: draft.file,
					line: draft.line ?? null,
					column: draft.column ?? null,
					evidence: draft.evidence,
					toolVersion: input.analyzerVersion,
					sourceSha: input.sourceSha,
					updatedAt: input.updatedAt,
				}) as DiagnosticFindingRow;
			});

			const completed = this.#db.query(`
				UPDATE diagnostic_scans
				SET state = 'completed', analyzer_version = $analyzerVersion,
					source_sha = $sourceSha, coverage_complete = $coverageComplete,
					finding_count = $findingCount, error = NULL, updated_at = $updatedAt
				WHERE id = $id AND state = 'running'
				RETURNING *
			`).get({
				id: input.id,
				analyzerVersion: input.analyzerVersion,
				sourceSha: input.sourceSha,
				coverageComplete: input.coverageComplete ? 1 : 0,
				findingCount: drafts.length,
				updatedAt: input.updatedAt,
			}) as DiagnosticScanRow;
			return { scan: completed, findings };
		});
		const result = apply();
		return {
			scan: decodeDiagnosticScan(result.scan),
			findings: result.findings.map(decodeDiagnosticFinding),
		};
	}

	finishDiagnosticScan(
		id: string,
		state: Extract<DiagnosticScanState, 'failed' | 'cancelled'>,
		error: string,
		updatedAt: string,
	): DiagnosticScan {
		const row = this.#db.query(`
			UPDATE diagnostic_scans SET state = $state, error = $error, updated_at = $updatedAt
			WHERE id = $id AND state IN ('queued', 'running')
			RETURNING *
		`).get({ id, state, error, updatedAt }) as DiagnosticScanRow | null;
		if (row === null) throw new Error(`diagnostic scan cannot finish: ${id}`);
		return decodeDiagnosticScan(row);
	}

	/** A crashed service cannot still own the process a queued/running row described. */
	recoverDiagnosticScans(updatedAt: string): number {
		return this.#db.query(`
			UPDATE diagnostic_scans
			SET state = 'failed', error = 'Service restarted before the diagnostic finished.',
				updated_at = $updatedAt
			WHERE state IN ('queued', 'running')
		`).run({ updatedAt }).changes;
	}

	getDiagnosticScan(id: string): DiagnosticScan | null {
		const row = this.#db.query('SELECT * FROM diagnostic_scans WHERE id = $id')
			.get({ id }) as DiagnosticScanRow | null;
		return row === null ? null : decodeDiagnosticScan(row);
	}

	listDiagnosticScans(limit = 20): DiagnosticScan[] {
		const rows = this.#db.query(`
			SELECT * FROM diagnostic_scans ORDER BY seq DESC LIMIT $limit
		`).all({ limit }) as DiagnosticScanRow[];
		return rows.map(decodeDiagnosticScan);
	}

	listPendingDiagnosticFindings(limit = 200): DiagnosticFinding[] {
		const rows = this.#db.query(`
			SELECT * FROM diagnostic_findings WHERE status = 'pending'
			ORDER BY CASE severity
				WHEN 'error' THEN 0
				WHEN 'warning' THEN 1
				ELSE 2
			END, last_seen_at DESC, seq DESC LIMIT $limit
		`).all({ limit }) as DiagnosticFindingRow[];
		return rows.map(decodeDiagnosticFinding);
	}

	/**
	 * Complete local disposition counts for diagnostics observability. A
	 * dismissed finding is intentionally only dismissed: without an explicit
	 * operator reason it is not evidence of a false positive.
	 */
	getDiagnosticFindingStats(): DiagnosticFindingStats {
		return this.#db.query(`
			SELECT
				COUNT(*) AS total,
				COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
				COALESCE(SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END), 0) AS dismissed,
				COALESCE(SUM(CASE WHEN status = 'promoted' THEN 1 ELSE 0 END), 0) AS promoted,
				COALESCE(SUM(CASE WHEN status = 'cleared' THEN 1 ELSE 0 END), 0) AS cleared,
				COALESCE(SUM(CASE WHEN occurrence_count > 1 THEN 1 ELSE 0 END), 0) AS recurring
			FROM diagnostic_findings
		`).get() as DiagnosticFindingStats;
	}

	listResolvedDiagnosticFindings(
		limit = 20,
	): { findings: DiagnosticFinding[]; omittedCount: number } {
		const { total } = this.#db.query(`
			SELECT COUNT(*) AS total FROM diagnostic_findings WHERE status != 'pending'
		`).get() as { total: number };
		const rows = this.#db.query(`
			SELECT * FROM diagnostic_findings WHERE status != 'pending'
			ORDER BY status_updated_at DESC, seq DESC LIMIT $limit
		`).all({ limit }) as DiagnosticFindingRow[];
		return { findings: rows.map(decodeDiagnosticFinding), omittedCount: total - rows.length };
	}

	getDiagnosticFinding(id: string): DiagnosticFinding | null {
		const row = this.#db.query('SELECT * FROM diagnostic_findings WHERE id = $id')
			.get({ id }) as DiagnosticFindingRow | null;
		return row === null ? null : decodeDiagnosticFinding(row);
	}

	dismissDiagnosticFinding(id: string, updatedAt: string): DiagnosticFinding {
		return this.#settleDiagnosticFinding(id, 'dismissed', null, updatedAt);
	}

	promoteDiagnosticFinding(id: string, issueId: string, updatedAt: string): DiagnosticFinding {
		const promotedIssueId = issueId.trim();
		if (promotedIssueId.length === 0) throw new Error('promoted issueId is required');
		return this.#settleDiagnosticFinding(id, 'promoted', promotedIssueId, updatedAt);
	}

	#settleDiagnosticFinding(
		id: string,
		status: Extract<DiagnosticFindingStatus, 'dismissed' | 'promoted'>,
		promotedIssueId: string | null,
		updatedAt: string,
	): DiagnosticFinding {
		const row = this.#db.query(`
			UPDATE diagnostic_findings
			SET status = $status, promoted_issue_id = $promotedIssueId,
				status_updated_at = $updatedAt
			WHERE id = $id AND status = 'pending'
			RETURNING *
		`).get({ id, status, promotedIssueId, updatedAt }) as DiagnosticFindingRow | null;
		if (row !== null) return decodeDiagnosticFinding(row);
		const current = this.getDiagnosticFinding(id);
		if (current === null) {
			throw new DiagnosticTransitionError(
				'diagnostic-finding-not-found',
				`Achado diagnóstico ${id} não existe.`,
				404,
			);
		}
		throw new DiagnosticTransitionError(
			'diagnostic-finding-not-pending',
			`Achado diagnóstico ${id} já está ${current.status}.`,
			409,
		);
	}

	setSessionId(runId: string, sessionId: string): RunRecord {
		if (sessionId.trim().length === 0) throw new Error('sessionId is required');
		const result = this.#db.query(`
			UPDATE runs SET session_id = $sessionId WHERE id = $runId
		`).run({ runId, sessionId });
		if (result.changes !== 1) throw new Error(`run not found: ${runId}`);
		const run = this.getRun(runId);
		if (run === null) throw new Error(`updated run disappeared: ${runId}`);
		return run;
	}

	getSelectedProvider(): AgentProviderId {
		const row = this.#db.query(`
			SELECT value FROM runtime_settings WHERE key = 'provider'
		`).get() as { value: string } | null;
		return row?.value === 'codex' ? 'codex' : 'claude';
	}

	setSelectedProvider(providerId: AgentProviderId): void {
		this.#db.query(`
			INSERT INTO runtime_settings (key, value) VALUES ('provider', $providerId)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run({ providerId });
	}

	/** Off by default (GSHIP-638): autonomy never turns itself on. */
	getChainRunsEnabled(): boolean {
		const row = this.#db.query(`
			SELECT value FROM runtime_settings WHERE key = $key
		`).get({ key: CHAIN_RUNS_KEY }) as { value: string } | null;
		return row?.value === 'true';
	}

	setChainRunsEnabled(enabled: boolean): void {
		this.#db.query(`
			INSERT INTO runtime_settings (key, value) VALUES ($key, $value)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run({ key: CHAIN_RUNS_KEY, value: enabled ? 'true' : 'false' });
	}

	getDiagnosticSchedule(): DiagnosticScheduleSettings {
		const row = this.#db.query(`
			SELECT value FROM runtime_settings WHERE key = $key
		`).get({ key: DIAGNOSTIC_SCHEDULE_KEY }) as { value: string } | null;
		if (row === null) return defaultDiagnosticSchedule();
		try {
			return normalizeDiagnosticSchedule(JSON.parse(row.value) as unknown);
		} catch {
			return defaultDiagnosticSchedule();
		}
	}

	setDiagnosticSchedule(settings: DiagnosticScheduleSettings): void {
		this.#db.query(`
			INSERT INTO runtime_settings (key, value) VALUES ($key, $value)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run({
			key: DIAGNOSTIC_SCHEDULE_KEY,
			value: JSON.stringify(normalizeDiagnosticSchedule(settings)),
		});
	}

	/**
	 * The per-role model choice, kept as one JSON row beside the selected
	 * provider. A missing or corrupt row reads as the empty choice, which is the
	 * same as passing no model flag at all.
	 */
	getModelSettings(): ModelSettings {
		const row = this.#db.query(`
			SELECT value FROM runtime_settings WHERE key = $key
		`).get({ key: MODEL_SETTINGS_KEY }) as { value: string } | null;
		if (row === null) return emptyModelSettings();
		try {
			return normalizeModelSettings(JSON.parse(row.value) as unknown);
		} catch {
			// A malformed row must never block the next spawn.
			return emptyModelSettings();
		}
	}

	setModelSettings(settings: ModelSettings): void {
		this.#db.query(`
			INSERT INTO runtime_settings (key, value) VALUES ($key, $value)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run({
			key: MODEL_SETTINGS_KEY,
			value: JSON.stringify(normalizeModelSettings(settings)),
		});
	}

	/** One optional human profile beside the other process-wide runtime settings. */
	getOperatorProfile(): OperatorProfile {
		const row = this.#db.query(`
			SELECT value FROM runtime_settings WHERE key = $key
		`).get({ key: OPERATOR_PROFILE_KEY }) as { value: string } | null;
		if (row === null) return emptyOperatorProfile();
		try {
			return normalizeOperatorProfile(JSON.parse(row.value) as unknown);
		} catch {
			return emptyOperatorProfile();
		}
	}

	setOperatorProfile(profile: OperatorProfile): void {
		this.#db.query(`
			INSERT INTO runtime_settings (key, value) VALUES ($key, $value)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run({
			key: OPERATOR_PROFILE_KEY,
			value: JSON.stringify(normalizeOperatorProfile(profile)),
		});
	}

	getOrchestratorSession(providerId: AgentProviderId): string | null {
		const row = this.#db.query(`
			SELECT session_id FROM orchestrator_sessions WHERE provider_id = $providerId
		`).get({ providerId }) as { session_id: string } | null;
		return row?.session_id ?? null;
	}

	setOrchestratorSession(
		providerId: AgentProviderId,
		sessionId: string,
		updatedAt: string,
	): void {
		const normalized = sessionId.trim();
		if (normalized.length === 0) throw new Error('orchestrator sessionId is required');
		this.#db.query(`
			INSERT INTO orchestrator_sessions (provider_id, session_id, updated_at)
			VALUES ($providerId, $sessionId, $updatedAt)
			ON CONFLICT(provider_id) DO UPDATE SET
				session_id = excluded.session_id,
				updated_at = excluded.updated_at
		`).run({ providerId, sessionId: normalized, updatedAt });
	}

	/** Single shared record: a missing or corrupt row reads as the empty handoff. */
	getOrchestratorHandoff(): OrchestratorHandoff {
		const row = this.#db.query(`
			SELECT handoff_json FROM orchestrator_handoff WHERE id = 1
		`).get() as { handoff_json: string } | null;
		if (row === null) return emptyOrchestratorHandoff();
		try {
			return normalizeOrchestratorHandoff(JSON.parse(row.handoff_json) as unknown);
		} catch {
			// A malformed handoff must never block the next turn.
			return emptyOrchestratorHandoff();
		}
	}

	setOrchestratorHandoff(handoff: OrchestratorHandoff, updatedAt: string): void {
		const normalized = normalizeOrchestratorHandoff(handoff);
		this.#db.query(`
			INSERT INTO orchestrator_handoff (id, handoff_json, updated_at)
			VALUES (1, $handoffJson, $updatedAt)
			ON CONFLICT(id) DO UPDATE SET
				handoff_json = excluded.handoff_json,
				updated_at = excluded.updated_at
		`).run({ handoffJson: JSON.stringify(normalized), updatedAt });
	}

	/** Single operator-owned record: a missing or corrupt row reads as empty. */
	getProjectBrief(): ProjectBrief {
		const row = this.#db.query(`
			SELECT brief_json FROM project_brief WHERE id = 1
		`).get() as { brief_json: string } | null;
		if (row === null) return emptyProjectBrief();
		try {
			return normalizeProjectBrief(JSON.parse(row.brief_json) as unknown);
		} catch {
			// A malformed brief must never block the next turn.
			return emptyProjectBrief();
		}
	}

	setProjectBrief(brief: ProjectBrief, updatedAt: string): void {
		const normalized = normalizeProjectBrief(brief);
		this.#db.query(`
			INSERT INTO project_brief (id, brief_json, updated_at)
			VALUES (1, $briefJson, $updatedAt)
			ON CONFLICT(id) DO UPDATE SET
				brief_json = excluded.brief_json,
				updated_at = excluded.updated_at
		`).run({ briefJson: JSON.stringify(normalized), updatedAt });
	}

	appendOrchestratorMessage(input: {
		providerId: AgentProviderId;
		role: OrchestratorMessageRole;
		text: string;
		createdAt: string;
		/** Captured only for the orchestrator's own message (GSHIP-634); absent for every other role. */
		usage?: OrchestratorMessageUsage;
	}): OrchestratorMessage {
		const text = input.text.trim();
		if (text.length === 0) throw new Error('orchestrator message text is required');
		const usage = input.usage;
		const row = this.#db.query(`
			INSERT INTO orchestrator_messages (
				provider_id, role, text, created_at,
				model, effort, total_cost_usd, input_tokens, output_tokens,
				cache_creation_input_tokens, cache_read_input_tokens, thinking_tokens
			)
			VALUES (
				$providerId, $role, $text, $createdAt,
				$model, $effort, $totalCostUsd, $inputTokens, $outputTokens,
				$cacheCreationInputTokens, $cacheReadInputTokens, $thinkingTokens
			)
			RETURNING *
		`).get({
			providerId: input.providerId,
			role: input.role,
			text,
			createdAt: input.createdAt,
			model: usage?.model ?? null,
			effort: usage?.effort ?? null,
			totalCostUsd: usage?.totalCostUsd ?? null,
			inputTokens: usage?.inputTokens ?? null,
			outputTokens: usage?.outputTokens ?? null,
			cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? null,
			cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
			thinkingTokens: usage?.thinkingTokens ?? null,
		}) as OrchestratorMessageRow;
		return decodeOrchestratorMessage(row);
	}

	/** Newest bounded transcript window, returned in chronological order. */
	listOrchestratorMessages(limit = 100): OrchestratorMessage[] {
		const rows = this.#db.query(`
			SELECT * FROM (
				SELECT * FROM orchestrator_messages ORDER BY seq DESC LIMIT $limit
			) ORDER BY seq ASC
		`).all({ limit }) as OrchestratorMessageRow[];
		return rows.map(decodeOrchestratorMessage);
	}

	getRun(runId: string): RunRecord | null {
		const row = this.#db.query('SELECT * FROM runs WHERE id = $runId').get({ runId }) as RunRow | null;
		return row === null ? null : decodeRun(row);
	}

	listRuns(limit = 50): RunRecord[] {
		const rows = this.#db.query(`
			SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT $limit
		`).all({ limit }) as RunRow[];
		return rows.map(decodeRun);
	}

	listEvents(afterSeq = 0, limit = 500): RunEvent[] {
		const rows = this.#db.query(`
			SELECT * FROM run_events
			WHERE seq > $afterSeq
			ORDER BY seq ASC
			LIMIT $limit
		`).all({ afterSeq, limit }) as EventRow[];
		return rows.map(decodeEvent);
	}

	/** The newest events for one run, returned in chronological order. */
	listRunEvents(runId: string, limit = 200): RunEvent[] {
		const rows = this.#db.query(`
			SELECT * FROM (
				SELECT * FROM run_events
				WHERE run_id = $runId
				ORDER BY seq DESC
				LIMIT $limit
			) ORDER BY seq ASC
		`).all({ runId, limit }) as EventRow[];
		return rows.map(decodeEvent);
	}

	/**
	 * Every durable decision event for one run, unbounded (GSHIP-627): the class
	 * was fixed at emission, so this filters on the stored column instead of
	 * re-deriving anything from `kind`. Unlike `listRunEvents`' display window,
	 * a derived read must not silently drop a decision that falls outside the
	 * newest 200.
	 */
	listRunDecisionEvents(runId: string): RunEvent[] {
		const rows = this.#db.query(`
			SELECT * FROM run_events
			WHERE run_id = $runId AND event_class = 'decision'
			ORDER BY seq ASC
		`).all({ runId }) as EventRow[];
		return rows.map(decodeEvent);
	}

	/**
	 * The most recent chain-pause reason across every run (GSHIP-638). Always
	 * the one the latest terminal transition just recorded: chaining is
	 * evaluated synchronously at that same transition, so this can never be a
	 * stale echo from an earlier run once a later one has started.
	 */
	getLastChainPauseEvent(): RunEvent | null {
		const row = this.#db.query(`
			SELECT * FROM run_events WHERE kind = 'run.chain-paused' ORDER BY seq DESC LIMIT 1
		`).get() as EventRow | null;
		return row === null ? null : decodeEvent(row);
	}

	/**
	 * A run's total reported cost, its breakdown by role and model, and its
	 * effort/thinking totals by role (GSHIP-623, GSHIP-628), derived by summing
	 * every `provider.usage`/`review.usage` event the run has -- deliberately
	 * unbounded, unlike `listRunEvents`'s display window, so a run with more
	 * events than that limit still reports its true total instead of a
	 * silently truncated one.
	 */
	getRunCostSummary(runId: string): RunCostSummary {
		const rows = this.#db.query(`
			SELECT kind, payload_json FROM run_events
			WHERE run_id = $runId AND kind IN ('provider.usage', 'review.usage')
			ORDER BY seq ASC
		`).all({ runId }) as Array<{ kind: string; payload_json: string }>;

		let totalCostUsd: number | null = null;
		const breakdown = new Map<string, RunCostBreakdownEntry>();
		const roles = new Map<RunCostRole, RoleUsageAccumulator>();
		for (const row of rows) {
			const role = USAGE_EVENT_ROLES[row.kind];
			if (role === undefined) continue;
			const payload = decodePayload(row.payload_json);
			totalCostUsd = accumulateUsageRow(breakdown, totalCostUsd, role, payload);
			accumulateRoleUsage(roles, role, payload);
		}
		const roleUsage = [...roles.entries()]
			.map(([role, acc]) => toRoleUsage(role, acc))
			.filter((usage): usage is RunCostRoleUsage => usage !== undefined);
		return { totalCostUsd, breakdown: [...breakdown.values()], roles: roleUsage };
	}

	/**
	 * Settle every run that a crashed service left mid-operation. Work phases
	 * recover as interrupted, so they resume; a ship recovers as ready-to-ship,
	 * because the verified diff is intact and only the ship attempt was lost.
	 */
	recoverUnownedRuns(createdAt: string): RunEvent[] {
		const recovery: Readonly<Record<string, { toState: RunState; kind: string }>> = {
			queued: { toState: 'interrupted', kind: 'run.recovered-interrupted' },
			working: { toState: 'interrupted', kind: 'run.recovered-interrupted' },
			verify: { toState: 'interrupted', kind: 'run.recovered-interrupted' },
			review: { toState: 'interrupted', kind: 'run.recovered-interrupted' },
			'full-verify': { toState: 'interrupted', kind: 'run.recovered-interrupted' },
			shipping: { toState: 'ready-to-ship', kind: 'run.recovered-shippable' },
		};
		return this.listRuns(10_000)
			.flatMap((run) => {
				const target = recovery[run.state];
				if (target === undefined) return [];
				return [this.transition({
					runId: run.id,
					toState: target.toState,
					kind: target.kind,
					createdAt,
				}).event];
			});
	}

	close(): void {
		this.#db.close();
	}
}
