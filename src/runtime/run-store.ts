import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { isRunState, nextFixRounds, type RunState } from './run-state.ts';

export interface RunRecord {
	id: string;
	issueId: string;
	sessionId: string;
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

export interface CreateRunInput {
	id: string;
	issueId: string;
	sessionId: string;
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

function decodeState(value: string): RunState {
	if (!isRunState(value)) throw new Error(`invalid persisted run state: ${value}`);
	return value;
}

function decodeRun(row: RunRow): RunRecord {
	return {
		id: row.id,
		issueId: row.issue_id,
		sessionId: row.session_id ?? row.id,
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
		`);
		const columns = this.#db.query('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === 'session_id')) {
			this.#db.exec('ALTER TABLE runs ADD COLUMN session_id TEXT;');
		}
		this.#db.exec('UPDATE runs SET session_id = id WHERE session_id IS NULL;');
	}

	createRun(input: CreateRunInput): { run: RunRecord; event: RunEvent } {
		const create = this.#db.transaction(() => {
			this.#db.query(`
				INSERT INTO runs (
					id, issue_id, session_id, state, fix_rounds, created_at, updated_at
				) VALUES ($id, $issueId, $sessionId, 'queued', 0, $createdAt, $createdAt)
			`).run({
				id: input.id,
				issueId: input.issueId,
				sessionId: input.sessionId,
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

	interruptUnownedRuns(createdAt: string): RunEvent[] {
		const activeStates = new Set(['queued', 'working', 'verify', 'review']);
		return this.listRuns(10_000)
			.filter((run) => activeStates.has(run.state))
			.map((run) => this.transition({
				runId: run.id,
				toState: 'interrupted',
				kind: 'run.recovered-interrupted',
				createdAt,
			}).event);
	}

	close(): void {
		this.#db.close();
	}
}
