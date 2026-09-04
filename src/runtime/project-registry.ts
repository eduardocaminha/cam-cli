import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { ProjectStatus } from './project-readiness.ts';
import { resolveProjectCheckout } from './project-checkout.ts';
import type { AgentProviderId } from './agent-session.ts';
import {
	normalizeModelSettings,
	type AgentDefaults,
} from './model-settings.ts';
import {
	emptyOperatorProfile,
	normalizeOperatorProfile,
	OPERATOR_PROFILE_KEY,
	type OperatorProfile,
} from './operator-profile.ts';

export const GATESHIP_HOME_ENV_VAR = 'GATESHIP_HOME';
export const PROJECT_REGISTRY_DATABASE = 'projects.sqlite';
export const AGENT_DEFAULTS_KEY = 'agent-defaults';

export interface GateshipHomeOptions {
	env?: Record<string, string | undefined>;
	nativeHome?: string;
}

export function resolveGateshipHome(options: GateshipHomeOptions = {}): string {
	const configured = (options.env ?? process.env)[GATESHIP_HOME_ENV_VAR];
	if (configured !== undefined && configured.trim().length > 0) {
		if (!isAbsolute(configured)) {
			throw new Error(`${GATESHIP_HOME_ENV_VAR} must be an absolute path.`);
		}
		return resolve(configured);
	}
	return resolve(options.nativeHome ?? homedir(), '.gateship');
}

export interface ProjectRegistration {
	root: string;
	stateDir: string;
	readiness: ProjectStatus;
}

export interface RegisteredProject {
	id: string;
	name: string;
	root: string;
	stateDir: string;
	readiness: ProjectStatus['state'];
	repository?: string;
	current: boolean;
}

/**
 * The result of removing one registration (GSHIP-717). Not-found is a typed
 * outcome rather than a throw, so a caller reads the same shape whether the id
 * named a row or nothing at all.
 */
export type ProjectUnregistration =
	| { outcome: 'unregistered'; project: RegisteredProject }
	| { outcome: 'not-found' };

interface ProjectRow {
	id: string;
	name: string;
	root: string;
	state_dir: string;
	readiness: ProjectStatus['state'];
	repository: string | null;
}

function canonicalRoot(root: string): string {
	return realpathSync(resolve(root));
}

export class ProjectRegistry {
	readonly #db: Database;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#db = new Database(path, { create: true, strict: true });
		this.#db.exec('PRAGMA journal_mode = WAL;');
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS projects (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				root TEXT NOT NULL UNIQUE,
				state_dir TEXT NOT NULL,
				readiness TEXT NOT NULL,
				repository TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
	}

	/** Reads the one product-wide operator profile, independent of project. */
	getOperatorProfile(): OperatorProfile {
		const row = this.#db.query(`
			SELECT value FROM settings WHERE key = $key
		`).get({ key: OPERATOR_PROFILE_KEY }) as { value: string } | null;
		if (row === null) return emptyOperatorProfile();
		try {
			return normalizeOperatorProfile(JSON.parse(row.value) as unknown);
		} catch {
			return emptyOperatorProfile();
		}
	}

	/** Persists the normalized profile without touching any project database. */
	setOperatorProfile(profile: OperatorProfile): void {
		this.#db.query(`
			INSERT INTO settings (key, value) VALUES ($key, $value)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run({
			key: OPERATOR_PROFILE_KEY,
			value: JSON.stringify(normalizeOperatorProfile(profile)),
		});
	}

	/** Copies the legacy boot value only while the global setting is absent. */
	initializeOperatorProfile(legacyProfile: OperatorProfile): void {
		const row = this.#db.query(
			'SELECT 1 FROM settings WHERE key = $key',
		).get({ key: OPERATOR_PROFILE_KEY });
		if (row !== null) return;
		const profile = normalizeOperatorProfile(legacyProfile);
		if (profile.name === '' && profile.timezone === '') return;
		this.setOperatorProfile(profile);
	}

	/** The product-wide agent defaults. A missing record deliberately means CLI defaults. */
	getAgentDefaults(): AgentDefaults {
		const row = this.#db.query('SELECT value FROM settings WHERE key = $key')
			.get({ key: AGENT_DEFAULTS_KEY }) as { value: string } | null;
		if (row === null) return {};
		try {
			const value = JSON.parse(row.value) as Record<string, unknown>;
			if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
			return {
				...(value.provider === 'claude' || value.provider === 'codex'
					? { provider: value.provider as AgentProviderId } : {}),
				...(Object.hasOwn(value, 'modelSettings')
					? { modelSettings: normalizeModelSettings(value.modelSettings) } : {}),
			};
		} catch {
			return {};
		}
	}

	setAgentDefaults(defaults: AgentDefaults): void {
		const value = {
			...(defaults.provider === undefined ? {} : { provider: defaults.provider }),
			...(defaults.modelSettings === undefined
				? {}
				: { modelSettings: normalizeModelSettings(defaults.modelSettings) }),
		};
		this.#db.query(`
			INSERT INTO settings (key, value) VALUES ($key, $value)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run({ key: AGENT_DEFAULTS_KEY, value: JSON.stringify(value) });
	}

	/** Imports boot-project legacy rows once; an empty record durably marks that import complete. */
	initializeAgentDefaults(legacy: AgentDefaults): void {
		const row = this.#db.query('SELECT 1 FROM settings WHERE key = $key')
			.get({ key: AGENT_DEFAULTS_KEY });
		if (row !== null) return;
		this.setAgentDefaults(legacy);
	}

	reconcile(input: ProjectRegistration): RegisteredProject {
		const checkout = resolveProjectCheckout(input.root);
		const root = checkout?.primaryRoot ?? canonicalRoot(input.root);
		const requestedStateDir = resolve(input.stateDir);
		const stateDir = checkout?.linked && requestedStateDir === join(checkout.root, '.gship')
			? join(root, '.gship')
			: requestedStateDir;
		const now = new Date().toISOString();
		const repository = input.readiness.state === 'ready' ? input.readiness.repository : null;
		this.#db.query(`
			INSERT INTO projects (
				id, name, root, state_dir, readiness, repository, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(root) DO UPDATE SET
				name = excluded.name,
				state_dir = excluded.state_dir,
				readiness = excluded.readiness,
				repository = excluded.repository,
				updated_at = excluded.updated_at
		`).run(
			randomUUID(), basename(root), root, stateDir, input.readiness.state,
			repository, now, now,
		);
		this.removeLinkedWorktreeRows(root);
		return this.list(root).find((project) => project.current)!;
	}

	/** Drops only obsolete registry metadata for linked worktrees of this checkout. */
	private removeLinkedWorktreeRows(primaryRoot: string): void {
		const rows = this.#db.query('SELECT id, root FROM projects WHERE root != $root')
			.all({ root: primaryRoot }) as Array<Pick<ProjectRow, 'id' | 'root'>>;
		for (const row of rows) {
			try {
				const checkout = resolveProjectCheckout(row.root);
				if (checkout?.linked && checkout.primaryRoot === primaryRoot) {
					this.#db.query('DELETE FROM projects WHERE id = $id').run({ id: row.id });
				}
			} catch {
				// A stale or inaccessible path is not evidence that its row is a worktree.
			}
		}
	}

	list(currentRoot?: string): RegisteredProject[] {
		const canonicalCurrent = currentRoot === undefined ? undefined : canonicalRoot(currentRoot);
		const rows = this.#db.query(`
			SELECT id, name, root, state_dir, readiness, repository
			FROM projects
			ORDER BY name COLLATE NOCASE, root
		`).all() as ProjectRow[];
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			root: row.root,
			stateDir: row.state_dir,
			readiness: row.readiness,
			...(row.repository === null ? {} : { repository: row.repository }),
			current: row.root === canonicalCurrent,
		}));
	}

	get(projectId: string, currentRoot?: string): RegisteredProject | null {
		const canonicalCurrent = currentRoot === undefined ? undefined : canonicalRoot(currentRoot);
		const row = this.#db.query(`
			SELECT id, name, root, state_dir, readiness, repository
			FROM projects
			WHERE id = $projectId
		`).get({ projectId }) as ProjectRow | null;
		if (row === null) return null;
		return {
			id: row.id,
			name: row.name,
			root: row.root,
			stateDir: row.state_dir,
			readiness: row.readiness,
			...(row.repository === null ? {} : { repository: row.repository }),
			current: row.root === canonicalCurrent,
		};
	}

	/**
	 * Remove one registration by id. Deleting the row is the whole operation:
	 * the checkout, its `.gship` state directory, its runtime database and its
	 * Git metadata are never read, moved or removed, so the same path can be
	 * registered again later and come back with its history intact.
	 */
	unregister(projectId: string): ProjectUnregistration {
		const project = this.get(projectId);
		if (project === null) return { outcome: 'not-found' };
		this.#db.query('DELETE FROM projects WHERE id = $projectId').run({ projectId });
		return { outcome: 'unregistered', project };
	}

	close(): void {
		this.#db.close();
	}
}

export function openProjectRegistry(home: string): ProjectRegistry {
	return new ProjectRegistry(join(home, PROJECT_REGISTRY_DATABASE));
}
