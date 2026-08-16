import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AgentProviderId } from './agent-session.ts';
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

export interface RunEvent {
	seq: number;
	runId: string;
	kind: string;
	fromState: RunState | null;
	toState: RunState;
	payload: Record<string, unknown>;
	createdAt: string;
}

export type OrchestratorMessageRole = 'operator' | 'orchestrator' | 'system';

/** Durable public transcript shared across orchestrator provider sessions. */
export interface OrchestratorMessage {
	seq: number;
	providerId: AgentProviderId;
	role: OrchestratorMessageRole;
	text: string;
	createdAt: string;
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
}

interface OrchestratorMessageRow {
	seq: number;
	provider_id: string;
	role: string;
	text: string;
	created_at: string;
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

function decodeEvent(row: EventRow): RunEvent {
	return {
		seq: row.seq,
		runId: row.run_id,
		kind: row.kind,
		fromState: row.from_state === null ? null : decodeState(row.from_state),
		toState: decodeState(row.to_state),
		payload: decodePayload(row.payload_json),
		createdAt: row.created_at,
	};
}

function decodeOrchestratorMessage(row: OrchestratorMessageRow): OrchestratorMessage {
	const role = row.role === 'orchestrator' || row.role === 'system'
		? row.role
		: 'operator';
	return {
		seq: row.seq,
		providerId: row.provider_id === 'codex' ? 'codex' : 'claude',
		role,
		text: row.text,
		createdAt: row.created_at,
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
				created_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS run_events_run_seq ON run_events(run_id, seq);
			CREATE TABLE IF NOT EXISTS runtime_settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS orchestrator_sessions (
				provider_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS orchestrator_messages (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				provider_id TEXT NOT NULL,
				role TEXT NOT NULL,
				text TEXT NOT NULL,
				created_at TEXT NOT NULL
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
					run_id, kind, from_state, to_state, payload_json, created_at
				) VALUES ($runId, 'run.created', NULL, 'queued', '{}', $createdAt)
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
					run_id, kind, from_state, to_state, payload_json, created_at
				) VALUES ($runId, $kind, $fromState, $toState, $payloadJson, $createdAt)
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
				run_id, kind, from_state, to_state, payload_json, created_at
			) VALUES ($runId, $kind, $state, $state, $payloadJson, $createdAt)
			RETURNING *
		`).get({
			runId: input.runId,
			kind: input.kind,
			state: current.state,
			payloadJson: JSON.stringify(input.payload ?? {}),
			createdAt: input.createdAt,
		}) as EventRow;
		return decodeEvent(row);
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

	appendOrchestratorMessage(input: {
		providerId: AgentProviderId;
		role: OrchestratorMessageRole;
		text: string;
		createdAt: string;
	}): OrchestratorMessage {
		const text = input.text.trim();
		if (text.length === 0) throw new Error('orchestrator message text is required');
		const row = this.#db.query(`
			INSERT INTO orchestrator_messages (provider_id, role, text, created_at)
			VALUES ($providerId, $role, $text, $createdAt)
			RETURNING *
		`).get({ ...input, text }) as OrchestratorMessageRow;
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
