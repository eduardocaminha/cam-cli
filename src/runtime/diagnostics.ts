import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { buildAllowlistedEnv } from './child-env.ts';
import type { DiagnosticDraft, DiagnosticFinding, DiagnosticScan } from './diagnostic-finding.ts';
import {
	type DiagnosticCadence,
	type DiagnosticScheduleStatus,
	diagnosticScheduleStatus,
} from './diagnostic-schedule.ts';
import { type CommandResult, runOwnedCommand } from './git-runtime.ts';
import type { DiagnosticFindingStats, RunStore } from './run-store.ts';
import { RUNTIME_SOURCE_REF, runtimeSourceFetchArgs } from './source-ref.ts';

const REACT_DOCTOR_VERSION = '0.9.12';
const REACT_DOCTOR_SCHEMA_VERSION = 3;
const REACT_DOCTOR_MAX_SECONDS = 60;
const DEFAULT_SCAN_TIMEOUT_MS = 75_000;
const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 10_000;
const SCHEDULE_CHECK_MS = 60_000;

export interface DiagnosticAdapterResult {
	version: string;
	coverageComplete: boolean;
	findings: DiagnosticDraft[];
}

export interface DiagnosticAdapter {
	id: string;
	label: string;
	version: string;
	description: string;
	scan(input: { cwd: string; signal: AbortSignal }): Promise<DiagnosticAdapterResult>;
}

export interface DiagnosticWorkspaceLease {
	path: string;
	sourceSha: string;
}

export type DiagnosticWorkspaceRelease =
	| { outcome: 'released' }
	| { outcome: 'preserved'; detail: string };

export interface DiagnosticWorkspace {
	prepare(scanId: string, signal: AbortSignal): Promise<DiagnosticWorkspaceLease>;
	release(
		scanId: string,
		workspacePath: string,
		sourceSha: string,
	): Promise<DiagnosticWorkspaceRelease>;
	listNotices(activePath?: string): string[];
}

export interface DiagnosticsSnapshot {
	analyzers: Array<Pick<DiagnosticAdapter, 'id' | 'label' | 'version' | 'description'>>;
	scan: DiagnosticScan | null;
	findings: DiagnosticFinding[];
	resolvedFindings: DiagnosticFinding[];
	resolvedFindingsOmittedCount: number;
	stats: DiagnosticFindingStats;
	schedule: DiagnosticScheduleStatus;
	workspaceNotices: string[];
}

export type ScheduledDiagnosticOutcome =
	| 'disabled'
	| 'not-due'
	| 'diagnostic-busy'
	| 'project-busy'
	| 'analyzer-unavailable'
	| 'started';

export class DiagnosticRuntimeError extends Error {
	constructor(readonly code: string, message: string, readonly status: number) {
		super(message);
		this.name = 'DiagnosticRuntimeError';
	}
}

type DiagnosticCommandRunner = (input: {
	cmd: string[];
	cwd: string;
	signal: AbortSignal;
	env?: Record<string, string | undefined>;
}) => Promise<CommandResult>;

function commandDetail(result: CommandResult): string {
	const output = `${result.stderr}\n${result.stdout}`.trim();
	return output.length === 0 ? `exit ${result.exitCode}` : output.slice(-2_000);
}

function safeScanSegment(scanId: string): string {
	const value = scanId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
	return value.length === 0 || value === '.' || value === '..' ? 'scan' : value;
}

/** A detached exact-SHA checkout. No branch is created and no project dependency is installed. */
export class GitDiagnosticWorkspace implements DiagnosticWorkspace {
	readonly #projectRoot: string;
	readonly #run: DiagnosticCommandRunner;

	constructor(projectRoot: string, run: DiagnosticCommandRunner = runOwnedCommand) {
		this.#projectRoot = resolve(projectRoot);
		this.#run = run;
	}

	async prepare(scanId: string, signal: AbortSignal): Promise<DiagnosticWorkspaceLease> {
		const fetched = await this.#git(this.#projectRoot, runtimeSourceFetchArgs(), signal);
		if (fetched.exitCode !== 0) {
			throw new Error(`cannot refresh ${RUNTIME_SOURCE_REF}: ${commandDetail(fetched)}`);
		}
		const source = await this.#git(
			this.#projectRoot,
			['rev-parse', '--verify', RUNTIME_SOURCE_REF],
			signal,
		);
		const sourceSha = source.stdout.trim();
		if (source.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(sourceSha)) {
			throw new Error(`cannot resolve ${RUNTIME_SOURCE_REF}: ${commandDetail(source)}`);
		}

		const root = this.#worktreesRoot();
		const workspacePath = this.#workspacePath(scanId);
		if (existsSync(root) && !lstatSync(root).isDirectory()) {
			throw new Error('diagnostic worktrees root is not a directory');
		}
		if (!workspacePath.startsWith(`${root}${sep}`) || existsSync(workspacePath)) {
			throw new Error('diagnostic workspace path is unsafe or already exists');
		}
		mkdirSync(root, { recursive: true });
		const added = await this.#git(
			this.#projectRoot,
			['worktree', 'add', '--detach', workspacePath, sourceSha],
			signal,
		);
		if (added.exitCode !== 0) {
			throw new Error(`cannot create diagnostic workspace: ${commandDetail(added)}`);
		}
		return { path: workspacePath, sourceSha };
	}

	async release(
		scanId: string,
		workspacePath: string,
		sourceSha: string,
	): Promise<DiagnosticWorkspaceRelease> {
		const expectedPath = this.#workspacePath(scanId);
		if (resolve(workspacePath) !== expectedPath) {
			return { outcome: 'preserved', detail: 'diagnostic workspace path is not owned by this scan' };
		}
		const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
		const head = await this.#git(expectedPath, ['rev-parse', '--verify', 'HEAD'], signal);
		if (head.exitCode !== 0) {
			return { outcome: 'preserved', detail: `cannot inspect diagnostic HEAD: ${commandDetail(head)}` };
		}
		if (head.stdout.trim() !== sourceSha) {
			return { outcome: 'preserved', detail: 'diagnostic analyzer moved its isolated checkout HEAD' };
		}
		const status = await this.#git(
			expectedPath,
			['status', '--porcelain', '--untracked-files=all', '--ignored=matching'],
			signal,
		);
		if (status.exitCode !== 0) {
			return { outcome: 'preserved', detail: `cannot inspect diagnostic workspace: ${commandDetail(status)}` };
		}
		if (status.stdout.trim().length > 0) {
			return { outcome: 'preserved', detail: 'diagnostic analyzer changed its isolated workspace' };
		}
		const removed = await this.#git(
			this.#projectRoot,
			['worktree', 'remove', expectedPath],
			signal,
		);
		return removed.exitCode === 0
			? { outcome: 'released' }
			: { outcome: 'preserved', detail: `cannot release diagnostic workspace: ${commandDetail(removed)}` };
	}

	listNotices(activePath?: string): string[] {
		const root = this.#worktreesRoot();
		if (!existsSync(root)) return [];
		if (!lstatSync(root).isDirectory()) return ['Diagnostic worktrees root is not a directory.'];
		const active = activePath === undefined ? null : resolve(activePath);
		return readdirSync(root, { withFileTypes: true })
			.map((entry) => resolve(root, entry.name))
			.filter((path) => path !== active)
			.map((path) => `Preserved diagnostic workspace: ${path}`);
	}

	#worktreesRoot(): string {
		return resolve(this.#projectRoot, '.gship', 'diagnostics', 'worktrees');
	}

	#workspacePath(scanId: string): string {
		return resolve(this.#worktreesRoot(), safeScanSegment(scanId));
	}

	#git(cwd: string, args: string[], signal: AbortSignal): Promise<CommandResult> {
		return this.#run({ cmd: ['git', '-C', cwd, ...args], cwd: this.#projectRoot, signal });
	}
}

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function string(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

function safeProjectPath(reportRoot: string, projectRoot: string, filePath: string): string | null {
	if (!isAbsolute(reportRoot) || !isAbsolute(projectRoot)) return null;
	if (filePath.length === 0 || isAbsolute(filePath) || filePath.startsWith('..')) return null;
	const projectRelative = relative(reportRoot, projectRoot);
	if (projectRelative.startsWith('..') || isAbsolute(projectRelative)) return null;
	const joined = resolve('/', projectRelative, filePath).slice(1).replaceAll('\\', '/');
	return joined.length === 0 || joined.startsWith('../') ? null : joined;
}

function parseJsonObject(json: string): Record<string, unknown> {
	if (Buffer.byteLength(json) > MAX_REPORT_BYTES) throw new Error('React diagnostic report is too large.');
	try {
		const parsed = object(JSON.parse(json));
		if (parsed !== null) return parsed;
	} catch {
		// The single error below is the stable adapter failure.
	}
	throw new Error('React diagnostic report is not valid JSON.');
}

function diagnosticEvidence(diagnostic: Record<string, unknown>): string {
	return [
		string(diagnostic['title']),
		string(diagnostic['message']),
		string(diagnostic['help']),
	].filter((item, index, all) => item.length > 0 && all.indexOf(item) === index).join('\n');
}

function parseReactDiagnostic(
	value: unknown,
	reportRoot: string,
	projectRoot: string,
): DiagnosticDraft | null {
	const diagnostic = object(value);
	if (diagnostic === null) return null;
	const rule = string(diagnostic['rule']);
	const file = safeProjectPath(
		reportRoot,
		projectRoot,
		string(diagnostic['normalizedFilePath']) || string(diagnostic['filePath']),
	);
	const evidence = diagnosticEvidence(diagnostic);
	if (rule.length === 0 || file === null || evidence.length === 0) return null;
	const severityValue = diagnostic['severity'];
	const severity = severityValue === 'error' || severityValue === 'warning'
		? severityValue
		: 'info';
	const line = positiveInteger(diagnostic['line']);
	const column = positiveInteger(diagnostic['column']);
	return {
		rule,
		severity,
		file,
		evidence,
		...(line === undefined ? {} : { line }),
		...(column === undefined ? {} : { column }),
	};
}

function parseReactProject(
	value: unknown,
	reportRoot: string,
): { complete: boolean; findings: DiagnosticDraft[] } | null {
	const project = object(value);
	if (project === null) return null;
	const projectRoot = string(project['directory']);
	const diagnostics = Array.isArray(project['diagnostics']) ? project['diagnostics'] : [];
	return {
		complete: project['complete'] === true,
		findings: diagnostics
			.map((diagnostic) => parseReactDiagnostic(diagnostic, reportRoot, projectRoot))
			.filter((finding): finding is DiagnosticDraft => finding !== null),
	};
}

/** Strictly parse the pinned schema; unknown future schemas fail instead of inventing findings. */
export function parseReactDoctorReport(json: string): DiagnosticAdapterResult {
	const report = parseJsonObject(json);
	if (report['schemaVersion'] !== REACT_DOCTOR_SCHEMA_VERSION) {
		throw new Error('Unsupported React diagnostic report schema.');
	}
	if (report['ok'] !== true) {
		const failure = object(report['error']);
		throw new Error(string(failure?.['message']) || 'React diagnostics failed.');
	}
	const version = string(report['version']);
	if (version.length === 0) throw new Error('React diagnostic report omitted its version.');
	const reportRoot = string(report['directory']);
	const projects = Array.isArray(report['projects']) ? report['projects'] : [];
	const decoded = projects
		.map((project) => parseReactProject(project, reportRoot))
		.filter((project): project is NonNullable<typeof project> => project !== null);
	return {
		version,
		coverageComplete:
			decoded.length > 0
			&& decoded.length === projects.length
			&& decoded.every((project) => project.complete),
		findings: decoded.flatMap((project) => project.findings),
	};
}

/** Optional pinned adapter. Bun downloads it to Gateship state, never into the scanned checkout. */
export class ReactDoctorAdapter implements DiagnosticAdapter {
	readonly id = 'react';
	readonly label = 'React';
	readonly version = REACT_DOCTOR_VERSION;
	readonly description = 'Erros, segurança, performance e acessibilidade em projetos React.';
	readonly #cacheDir: string;
	readonly #run: DiagnosticCommandRunner;

	constructor(projectRoot: string, run: DiagnosticCommandRunner = runOwnedCommand) {
		this.#cacheDir = resolve(projectRoot, '.gship', 'diagnostics', 'cache');
		this.#run = run;
	}

	async scan(input: { cwd: string; signal: AbortSignal }): Promise<DiagnosticAdapterResult> {
		mkdirSync(this.#cacheDir, { recursive: true });
		const result = await this.#run({
			cmd: [
				'bunx', '--bun', `react-doctor@${REACT_DOCTOR_VERSION}`, '.',
				'--json', '--json-compact', '--no-telemetry', '--no-score',
				'--blocking', 'none', '--yes', '--max-duration', String(REACT_DOCTOR_MAX_SECONDS),
				'--no-dead-code', '--no-supply-chain', '--no-parallel',
			],
			cwd: input.cwd,
			signal: input.signal,
			env: {
				...buildAllowlistedEnv(process.env),
				BUN_INSTALL_CACHE_DIR: this.#cacheDir,
				REACT_DOCTOR_NO_TELEMETRY: '1',
				NO_COLOR: '1',
				CI: '1',
			},
		});
		if (result.exitCode !== 0) {
			throw new Error(`React diagnostics exited ${result.exitCode}: ${commandDetail(result)}`);
		}
		return parseReactDoctorReport(result.stdout);
	}
}

interface ActiveDiagnostic {
	scanId: string;
	workspacePath?: string;
	controller: AbortController;
	promise: Promise<void>;
}

export interface DiagnosticsRuntimeOptions {
	store: RunStore;
	workspace: DiagnosticWorkspace;
	adapters: readonly DiagnosticAdapter[];
	isProjectIdle: () => boolean;
	now?: () => string;
	newId?: () => string;
	scanTimeoutMs?: number;
}

/** One in-process owner for diagnostics; it never edits, approves, starts or ships project work. */
export class DiagnosticsRuntime {
	readonly #store: RunStore;
	readonly #workspace: DiagnosticWorkspace;
	readonly #adapters: Map<string, DiagnosticAdapter>;
	readonly #isProjectIdle: () => boolean;
	readonly #now: () => string;
	readonly #newId: () => string;
	readonly #scanTimeoutMs: number;
	#active: ActiveDiagnostic | null = null;
	#scheduleTimer: ReturnType<typeof setInterval> | null = null;

	constructor(options: DiagnosticsRuntimeOptions) {
		this.#store = options.store;
		this.#workspace = options.workspace;
		this.#adapters = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));
		this.#isProjectIdle = options.isProjectIdle;
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#newId = options.newId ?? randomUUID;
		this.#scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
		this.#store.recoverDiagnosticScans(this.#now());
	}

	start(analyzerId = 'react'): DiagnosticScan {
		if (this.#active !== null) {
			throw new DiagnosticRuntimeError('diagnostic-busy', 'Um diagnóstico já está em execução.', 409);
		}
		if (!this.#isProjectIdle()) {
			throw new DiagnosticRuntimeError(
				'project-busy',
				'Conclua ou interrompa a run ativa antes de diagnosticar o mesmo projeto.',
				409,
			);
		}
		const adapter = this.#adapters.get(analyzerId);
		if (adapter === undefined) {
			throw new DiagnosticRuntimeError('analyzer-not-found', `Analyzer desconhecido: ${analyzerId}.`, 404);
		}
		const scan = this.#store.createDiagnosticScan({
			id: this.#newId(),
			analyzer: adapter.id,
			createdAt: this.#now(),
		});
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.#scanTimeoutMs);
		const active: ActiveDiagnostic = {
			scanId: scan.id,
			controller,
			promise: Promise.resolve(),
		};
		active.promise = Promise.resolve()
			.then(() => this.#drive(scan, adapter, active, () => timedOut))
			.finally(() => {
				clearTimeout(timer);
				if (this.#active?.scanId === scan.id) this.#active = null;
			});
		this.#active = active;
		return scan;
	}

	async cancel(scanId: string): Promise<DiagnosticScan> {
		if (this.#active?.scanId !== scanId) {
			throw new DiagnosticRuntimeError(
				'diagnostic-not-active',
				`O diagnóstico ${scanId} não está em execução.`,
				409,
			);
		}
		this.#active.controller.abort();
		await this.#active.promise;
		const scan = this.#store.getDiagnosticScan(scanId);
		if (scan === null) throw new Error(`cancelled diagnostic disappeared: ${scanId}`);
		return scan;
	}

	snapshot(): DiagnosticsSnapshot {
		const resolved = this.#store.listResolvedDiagnosticFindings();
		return {
			analyzers: [...this.#adapters.values()].map(({ id, label, version, description }) => ({
				id,
				label,
				version,
				description,
			})),
			scan: this.#store.listDiagnosticScans(1)[0] ?? null,
			findings: this.#store.listPendingDiagnosticFindings(),
			resolvedFindings: resolved.findings,
			resolvedFindingsOmittedCount: resolved.omittedCount,
			stats: this.#store.getDiagnosticFindingStats(),
			schedule: this.getSchedule(),
			workspaceNotices: this.#workspace.listNotices(this.#active?.workspacePath),
		};
	}

	getSchedule(): DiagnosticScheduleStatus {
		const latest = this.#store.listDiagnosticScans(1)[0];
		return diagnosticScheduleStatus(
			this.#store.getDiagnosticSchedule(),
			latest?.createdAt ?? null,
			this.#now(),
		);
	}

	setSchedule(input: { enabled: boolean; cadence: DiagnosticCadence }): DiagnosticScheduleStatus {
		const current = this.#store.getDiagnosticSchedule();
		this.#store.setDiagnosticSchedule({
			enabled: input.enabled,
			cadence: input.cadence,
			analyzer: current.analyzer,
		});
		return this.getSchedule();
	}

	/** One due scan at most; a created scan immediately advances the next due instant. */
	runScheduledIfDue(): ScheduledDiagnosticOutcome {
		const schedule = this.getSchedule();
		if (!schedule.enabled) return 'disabled';
		if (!schedule.overdue) return 'not-due';
		if (this.#active !== null) return 'diagnostic-busy';
		if (!this.#isProjectIdle()) return 'project-busy';
		if (!this.#adapters.has(schedule.analyzer)) return 'analyzer-unavailable';
		this.start(schedule.analyzer);
		return 'started';
	}

	/** The existing process owns the cadence; no host cron or second lifecycle owner. */
	startScheduler(): void {
		if (this.#scheduleTimer !== null) return;
		this.runScheduledIfDue();
		this.#scheduleTimer = setInterval(() => this.runScheduledIfDue(), SCHEDULE_CHECK_MS);
	}

	getFinding(id: string): DiagnosticFinding | null {
		return this.#store.getDiagnosticFinding(id);
	}

	dismissFinding(id: string): DiagnosticFinding {
		return this.#store.dismissDiagnosticFinding(id, this.#now());
	}

	promoteFinding(id: string, issueId: string): DiagnosticFinding {
		return this.#store.promoteDiagnosticFinding(id, issueId, this.#now());
	}

	async stop(): Promise<void> {
		if (this.#scheduleTimer !== null) {
			clearInterval(this.#scheduleTimer);
			this.#scheduleTimer = null;
		}
		if (this.#active === null) return;
		this.#active.controller.abort();
		await this.#active.promise;
	}

	close(): void {
		if (this.#scheduleTimer !== null) throw new Error('cannot close diagnostics while scheduler is active');
		if (this.#active !== null) throw new Error('cannot close diagnostics while a scan is active');
		this.#store.close();
	}

	async #drive(
		scan: DiagnosticScan,
		adapter: DiagnosticAdapter,
		active: ActiveDiagnostic,
		timedOut: () => boolean,
	): Promise<void> {
		let workspacePath: string | undefined;
		let workspaceSourceSha: string | undefined;
		try {
			const lease = await this.#workspace.prepare(scan.id, active.controller.signal);
			workspacePath = lease.path;
			workspaceSourceSha = lease.sourceSha;
			active.workspacePath = lease.path;
			this.#store.beginDiagnosticScan({
				id: scan.id,
				analyzerVersion: adapter.version,
				sourceSha: lease.sourceSha,
				updatedAt: this.#now(),
			});
			const result = await adapter.scan({ cwd: lease.path, signal: active.controller.signal });
			const release = await this.#workspace.release(scan.id, lease.path, lease.sourceSha);
			workspacePath = undefined;
			workspaceSourceSha = undefined;
			if (release.outcome === 'preserved') throw new Error(release.detail);
			this.#store.completeDiagnosticScan({
				id: scan.id,
				analyzerVersion: result.version,
				sourceSha: lease.sourceSha,
				coverageComplete: result.coverageComplete,
				findings: result.findings,
				updatedAt: this.#now(),
			});
		} catch (error) {
			await this.#recordFailure(
				scan.id,
				workspacePath,
				workspaceSourceSha,
				active,
				timedOut,
				error,
			);
		}
	}

	async #recordFailure(
		scanId: string,
		workspacePath: string | undefined,
		workspaceSourceSha: string | undefined,
		active: ActiveDiagnostic,
		timedOut: () => boolean,
		error: unknown,
	): Promise<void> {
		let detail = this.#failureDetail(active, timedOut, error);
		if (workspacePath !== undefined && workspaceSourceSha !== undefined) {
			detail += await this.#cleanupDetail(scanId, workspacePath, workspaceSourceSha);
		}
		const current = this.#store.getDiagnosticScan(scanId);
		if (current?.state !== 'queued' && current?.state !== 'running') return;
		this.#store.finishDiagnosticScan(
			scanId,
			active.controller.signal.aborted && !timedOut() ? 'cancelled' : 'failed',
			detail,
			this.#now(),
		);
	}

	#failureDetail(active: ActiveDiagnostic, timedOut: () => boolean, error: unknown): string {
		if (timedOut()) return `Diagnóstico excedeu ${Math.ceil(this.#scanTimeoutMs / 1_000)} segundos.`;
		if (active.controller.signal.aborted) return 'Diagnóstico cancelado.';
		return error instanceof Error ? error.message : String(error);
	}

	async #cleanupDetail(
		scanId: string,
		workspacePath: string,
		workspaceSourceSha: string,
	): Promise<string> {
		try {
			const cleanup = await this.#workspace.release(scanId, workspacePath, workspaceSourceSha);
			return cleanup.outcome === 'preserved' ? ` ${cleanup.detail}` : '';
		} catch (error) {
			return ` Cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}
