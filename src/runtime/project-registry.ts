import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { ProjectStatus } from './project-readiness.ts';

export const GATESHIP_HOME_ENV_VAR = 'GATESHIP_HOME';
export const PROJECT_REGISTRY_DATABASE = 'projects.sqlite';

export interface GateshipHomeOptions {
	env?: Record<string, string | undefined>;
	nativeHome?: string;
	/** The existing project state volume is also the product home in today's container composition. */
	containerStateDir?: string;
}

export function resolveGateshipHome(options: GateshipHomeOptions = {}): string {
	const configured = (options.env ?? process.env)[GATESHIP_HOME_ENV_VAR];
	if (configured !== undefined && configured.trim().length > 0) {
		if (!isAbsolute(configured)) {
			throw new Error(`${GATESHIP_HOME_ENV_VAR} must be an absolute path.`);
		}
		return resolve(configured);
	}
	if (options.containerStateDir !== undefined) return resolve(options.containerStateDir);
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
	}

	reconcile(input: ProjectRegistration): RegisteredProject {
		const root = canonicalRoot(input.root);
		const stateDir = resolve(input.stateDir);
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
		return this.list(root).find((project) => project.current)!;
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

	close(): void {
		this.#db.close();
	}
}

export function openProjectRegistry(home: string): ProjectRegistry {
	return new ProjectRegistry(join(home, PROJECT_REGISTRY_DATABASE));
}
