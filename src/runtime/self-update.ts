import { spawnSync } from 'node:child_process';
import {
	accessSync,
	chmodSync,
	copyFileSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
	constants as fsConstants,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

import { RunStore } from './run-store.ts';
import { sendRemoteServiceNotification } from './remote-notifier.ts';

export const SELF_UPDATE_SETTING_KEY = 'self-update';
export const SELF_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const SCHEDULER_INTERVAL_MS = 60_000;
const RELEASES_URL = 'https://api.github.com/repos/gateship-dev/gateship/releases';
const RELEASE_BASE_URL = 'https://github.com/gateship-dev/gateship/releases/download';
const VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

export type SelfUpdateResultStatus =
	| 'success'
	| 'rollback'
	| 'failed'
	| 'check-failed'
	| 'deferred';

export interface SelfUpdateResult {
	status: SelfUpdateResultStatus;
	at: string;
	previousVersion: string;
	targetVersion: string | null;
	reason: string;
}

export interface AvailableRelease {
	version: string;
	tag: string;
	commit: string;
	asset: string;
	assetUrl: string;
	checksumsUrl: string;
}

interface StoredSelfUpdate {
	enabled: boolean;
	lastCheckedAt: string | null;
	available: AvailableRelease | null;
	result: SelfUpdateResult | null;
}

export interface NativeInstallation {
	kind: 'native';
	executable: string;
	directory: string;
	publicPaths: string[];
}

export type InstallationAvailability = NativeInstallation | {
	kind: 'container' | 'development';
	reason: string;
};

export type SelfUpdateAvailabilityView =
	| { kind: 'native' }
	| { kind: 'container' | 'development'; reason: string };

export interface SelfUpdateSnapshot extends StoredSelfUpdate {
	currentVersion: string;
	currentCommit: string | null;
	availability: SelfUpdateAvailabilityView;
	applying: boolean;
}

export interface HandoffPlan {
	oldPid: number;
	currentExecutable: string;
	candidatePaths: string[];
	publicPaths: string[];
	backupPaths: string[];
	serverArgs: string[];
	cwd: string;
	healthUrl: string;
	databasePath: string;
	previousVersion: string;
	targetVersion: string;
	targetCommit: string;
	previousCommit: string | null;
	timeoutMs: number;
}

export interface ReleaseClient {
	resolveLatest(): Promise<AvailableRelease>;
	download(url: string): Promise<Uint8Array>;
}

export interface SelfUpdateRuntimeOptions {
	store: RunStore;
	databasePath: string;
	cwd: string;
	currentVersion: string;
	currentCommit: string | null;
	port: number;
	hostname: string;
	isContainer: boolean;
	isIdle: () => boolean;
	acquireAdmission: () => (() => void) | null;
	requestShutdown?: () => void;
	now?: () => Date;
	releaseClient?: ReleaseClient;
	installation?: InstallationAvailability;
	probeVersion?: (path: string) => string;
	spawnHelper?: (executable: string, planPath: string) => void;
	executable?: string;
	serverArgs?: string[];
}

function isAvailableRelease(value: unknown): value is AvailableRelease {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return typeof row.version === 'string'
		&& typeof row.tag === 'string'
		&& typeof row.commit === 'string'
		&& typeof row.asset === 'string'
		&& typeof row.assetUrl === 'string'
		&& typeof row.checksumsUrl === 'string';
}

function isSelfUpdateResult(value: unknown): value is SelfUpdateResult {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return ['success', 'rollback', 'failed', 'check-failed', 'deferred'].includes(String(row.status))
		&& typeof row.at === 'string'
		&& typeof row.previousVersion === 'string'
		&& (row.targetVersion === null || typeof row.targetVersion === 'string')
		&& typeof row.reason === 'string';
}

function readStored(store: RunStore): StoredSelfUpdate {
	const raw = store.getRuntimeSetting(SELF_UPDATE_SETTING_KEY);
	if (raw === null) return { enabled: false, lastCheckedAt: null, available: null, result: null };
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return {
			enabled: parsed.enabled === true,
			lastCheckedAt: typeof parsed.lastCheckedAt === 'string' ? parsed.lastCheckedAt : null,
			available: isAvailableRelease(parsed.available) ? parsed.available : null,
			result: isSelfUpdateResult(parsed.result) ? parsed.result : null,
		};
	} catch {
		return { enabled: false, lastCheckedAt: null, available: null, result: null };
	}
}

function writeStored(store: RunStore, value: StoredSelfUpdate): void {
	store.setRuntimeSetting(SELF_UPDATE_SETTING_KEY, JSON.stringify(value));
}

function platformAsset(platform = process.platform, arch = process.arch): string | null {
	const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
	const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
	return os === null || cpu === null ? null : `gateship-${os}-${cpu}`;
}

export function detectNativeInstallation(
	executable = process.execPath,
	isContainer = false,
): InstallationAvailability {
	if (isContainer) {
		return { kind: 'container', reason: 'Container installations must be replaced by a host supervisor.' };
	}
	const name = basename(executable);
	if (name !== 'gship' && name !== 'gateship') {
		return { kind: 'development', reason: 'Automatic apply is available only from an installed native binary.' };
	}
	const directory = dirname(resolve(executable));
	const publicPaths = [join(directory, 'gateship'), join(directory, 'gship')];
	try {
		accessSync(directory, fsConstants.W_OK);
		for (const path of publicPaths) accessSync(path, fsConstants.R_OK | fsConstants.W_OK);
	} catch {
		return { kind: 'development', reason: 'The native Gateship installation is not complete and writable.' };
	}
	return { kind: 'native', executable: resolve(executable), directory, publicPaths };
}

function compareVersions(left: string, right: string): number {
	const a = VERSION_PATTERN.exec(`v${left}`);
	const b = VERSION_PATTERN.exec(`v${right}`);
	if (a === null || b === null) return left === right ? 0 : -1;
	for (let index = 1; index <= 3; index += 1) {
		const difference = Number(a[index]) - Number(b[index]);
		if (difference !== 0) return difference;
	}
	return 0;
}

async function checkedJson(url: string): Promise<unknown> {
	const response = await fetch(url, {
		headers: { accept: 'application/vnd.github+json', 'user-agent': 'gateship-self-update' },
	});
	if (!response.ok) throw new Error(`release metadata request failed (${response.status})`);
	return response.json();
}

async function resolveTagCommit(tag: string): Promise<string> {
	const ref = await checkedJson(`https://api.github.com/repos/gateship-dev/gateship/git/ref/tags/${tag}`);
	if (ref === null || typeof ref !== 'object') throw new Error(`tag ${tag} has no GitHub ref`);
	const object = (ref as { object?: unknown }).object;
	if (object === null || typeof object !== 'object') throw new Error(`tag ${tag} has no target`);
	let type = (object as { type?: unknown }).type;
	let sha = (object as { sha?: unknown }).sha;
	if (type === 'tag' && typeof sha === 'string') {
		const annotated = await checkedJson(`https://api.github.com/repos/gateship-dev/gateship/git/tags/${sha}`);
		const target = annotated !== null && typeof annotated === 'object'
			? (annotated as { object?: unknown }).object
			: null;
		if (target !== null && typeof target === 'object') {
			type = (target as { type?: unknown }).type;
			sha = (target as { sha?: unknown }).sha;
		}
	}
	if (type !== 'commit' || typeof sha !== 'string' || !COMMIT_PATTERN.test(sha)) {
		throw new Error(`tag ${tag} does not resolve to a commit`);
	}
	return sha;
}

export class GithubReleaseClient implements ReleaseClient {
	readonly #asset: string;

	constructor(asset = platformAsset()) {
		if (asset === null) throw new Error('this system has no published Gateship asset');
		this.#asset = asset;
	}

	async resolveLatest(): Promise<AvailableRelease> {
		const payload = await checkedJson(RELEASES_URL);
		if (!Array.isArray(payload)) throw new Error('release metadata is not a list');
		const releases = payload.filter((item) => {
			if (item === null || typeof item !== 'object') return false;
			const row = item as Record<string, unknown>;
			return row.draft !== true && typeof row.tag_name === 'string' && VERSION_PATTERN.test(row.tag_name);
		}) as Record<string, unknown>[];
		releases.sort((left, right) => compareVersions(
			String(right.tag_name).slice(1),
			String(left.tag_name).slice(1),
		));
		const release = releases[0];
		if (release === undefined) throw new Error('no semantic Gateship release is published');
		const tag = String(release.tag_name);
		const version = tag.slice(1);
		const assets = Array.isArray(release.assets) ? release.assets : [];
		const assetNames = new Set(assets.flatMap((item) => item !== null && typeof item === 'object'
			&& typeof (item as Record<string, unknown>).name === 'string'
			? [String((item as Record<string, unknown>).name)] : []));
		if (!assetNames.has(this.#asset) || !assetNames.has('SHA256SUMS.txt')) {
			throw new Error(`release ${tag} is missing ${this.#asset} or SHA256SUMS.txt`);
		}
		return {
			version,
			tag,
			commit: await resolveTagCommit(tag),
			asset: this.#asset,
			assetUrl: `${RELEASE_BASE_URL}/${tag}/${this.#asset}`,
			checksumsUrl: `${RELEASE_BASE_URL}/${tag}/SHA256SUMS.txt`,
		};
	}

	async download(url: string): Promise<Uint8Array> {
		const response = await fetch(url, { cache: 'no-store' });
		if (!response.ok) throw new Error(`release download failed (${response.status})`);
		return new Uint8Array(await response.arrayBuffer());
	}
}

function expectedChecksum(manifest: Uint8Array, asset: string): string {
	const text = new TextDecoder().decode(manifest);
	for (const line of text.split('\n')) {
		const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
		if (match?.[2] === asset) return match[1]!.toLowerCase();
	}
	throw new Error(`SHA256SUMS.txt has no entry for ${asset}`);
}

function actualChecksum(bytes: Uint8Array): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(bytes);
	return hasher.digest('hex');
}

function defaultProbeVersion(path: string): string {
	const result = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 10_000 });
	if (result.status !== 0) throw new Error(`candidate --version exited ${result.status ?? 'without status'}`);
	return (result.stdout ?? '').trim();
}

function defaultSpawnHelper(executable: string, planPath: string): void {
	const child = Bun.spawn([executable, '__self-update-handoff', planPath], {
		cwd: dirname(planPath),
		stdin: 'ignore',
		stdout: 'inherit',
		stderr: 'inherit',
	});
	child.unref();
}

export class SelfUpdateRuntime {
	readonly #options: SelfUpdateRuntimeOptions;
	readonly #client: ReleaseClient;
	readonly #installation: InstallationAvailability;
	readonly #now: () => Date;
	readonly #probeVersion: (path: string) => string;
	readonly #spawnHelper: (executable: string, planPath: string) => void;
	#timer: ReturnType<typeof setInterval> | null = null;
	#checking: Promise<void> | null = null;
	#applying = false;

	constructor(options: SelfUpdateRuntimeOptions) {
		this.#options = options;
		this.#client = options.releaseClient ?? new GithubReleaseClient();
		this.#installation = options.installation
			?? detectNativeInstallation(options.executable, options.isContainer);
		this.#now = options.now ?? (() => new Date());
		this.#probeVersion = options.probeVersion ?? defaultProbeVersion;
		this.#spawnHelper = options.spawnHelper ?? defaultSpawnHelper;
	}

	snapshot(): SelfUpdateSnapshot {
		const availability: SelfUpdateAvailabilityView = this.#installation.kind === 'native'
			? { kind: 'native' }
			: this.#installation;
		const stored = readStored(this.#options.store);
		const available = stored.available !== null
			&& compareVersions(stored.available.version, this.#options.currentVersion) > 0
			? stored.available
			: null;
		return {
			...stored,
			available,
			currentVersion: this.#options.currentVersion,
			currentCommit: this.#options.currentCommit,
			availability,
			applying: this.#applying,
		};
	}

	setEnabled(enabled: boolean): SelfUpdateSnapshot {
		const stored = readStored(this.#options.store);
		writeStored(this.#options.store, { ...stored, enabled });
		return this.snapshot();
	}

	startScheduler(): void {
		if (this.#timer !== null) return;
		this.#timer = setInterval(() => void this.checkIfDue(), SCHEDULER_INTERVAL_MS);
	}

	async stop(): Promise<void> {
		if (this.#timer !== null) clearInterval(this.#timer);
		this.#timer = null;
		await this.#checking;
	}

	close(): void {
		if (this.#timer !== null || this.#checking !== null) {
			throw new Error('cannot close self updater while its scheduler is active');
		}
		this.#options.store.close();
	}

	async checkIfDue(): Promise<void> {
		if (this.#checking !== null || this.#applying) return this.#checking ?? Promise.resolve();
		const stored = readStored(this.#options.store);
		const last = stored.lastCheckedAt === null ? Number.NaN : Date.parse(stored.lastCheckedAt);
		if (Number.isFinite(last) && this.#now().getTime() - last < SELF_UPDATE_INTERVAL_MS) return;
		this.#checking = this.#check(stored).finally(() => { this.#checking = null; });
		return this.#checking;
	}

	async #check(stored: StoredSelfUpdate): Promise<void> {
		const at = this.#now().toISOString();
		let release: AvailableRelease;
		try {
			release = await this.#client.resolveLatest();
		} catch (error) {
			writeStored(this.#options.store, {
				...stored,
				lastCheckedAt: at,
				result: this.#result('check-failed', null, error),
			});
			return;
		}
		const checked = { ...stored, lastCheckedAt: at, available: release };
		writeStored(this.#options.store, checked);
		if (!stored.enabled || compareVersions(release.version, this.#options.currentVersion) <= 0) return;
		if (this.#installation.kind !== 'native') {
			writeStored(this.#options.store, {
				...checked,
				result: this.#result('deferred', release.version, this.#installation.reason),
			});
			return;
		}
		if (!this.#options.isIdle()) {
			writeStored(this.#options.store, {
				...checked,
				result: this.#result('deferred', release.version, 'A run or diagnostic is active; no binary was downloaded.'),
			});
			return;
		}

		let releaseAdmission: (() => void) | null = null;
		try {
			const candidateBytes = await this.#client.download(release.assetUrl);
			const manifestBytes = await this.#client.download(release.checksumsUrl);
			const expected = expectedChecksum(manifestBytes, release.asset);
			const actual = actualChecksum(candidateBytes);
			if (expected !== actual) throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`);

			const candidateProbe = join(this.#installation.directory, `.gateship-update-${randomUUID()}.probe`);
			writeFileSync(candidateProbe, candidateBytes, { mode: 0o700, flag: 'wx' });
			try {
				chmodSync(candidateProbe, 0o700);
				const actualVersion = this.#probeVersion(candidateProbe);
				if (actualVersion !== `gateship ${release.version}`) {
					throw new Error(`candidate identity mismatch: expected gateship ${release.version}, got ${actualVersion}`);
				}
			} finally {
				rmSync(candidateProbe, { force: true });
			}

			releaseAdmission = this.#options.acquireAdmission();
			if (releaseAdmission === null || !this.#options.isIdle()) {
				releaseAdmission?.();
				releaseAdmission = null;
				throw new Error('The project became busy before the update handoff; the current process was preserved.');
			}
			const plan = this.#preparePlan(candidateBytes, release);
			this.#applying = true;
			this.#spawnHelper(this.#installation.executable, plan.path);
			this.#options.requestShutdown?.();
			// The fence intentionally stays closed until this process exits. The new
			// process reconstructs ordinary admission from durable run state.
			releaseAdmission = null;
		} catch (error) {
			releaseAdmission?.();
			writeStored(this.#options.store, {
				...checked,
				result: this.#result('failed', release.version, error),
			});
		}
	}

	#preparePlan(candidate: Uint8Array, release: AvailableRelease): { path: string; plan: HandoffPlan } {
		if (this.#installation.kind !== 'native') throw new Error('native installation required');
		const nonce = randomUUID();
		const candidatePaths: string[] = [];
		const backupPaths: string[] = [];
		try {
			for (const publicPath of this.#installation.publicPaths) {
				const suffix = basename(publicPath);
				const candidatePath = join(this.#installation.directory, `.${suffix}.${nonce}.candidate`);
				const backupPath = join(this.#installation.directory, `.${suffix}.${nonce}.backup`);
				writeFileSync(candidatePath, candidate, { mode: 0o700, flag: 'wx' });
				candidatePaths.push(candidatePath);
				chmodSync(candidatePath, 0o700);
				copyFileSync(publicPath, backupPath, fsConstants.COPYFILE_EXCL);
				backupPaths.push(backupPath);
				chmodSync(backupPath, 0o700);
			}
			const stateDirectory = join(this.#options.cwd, '.gship', 'self-update');
			mkdirSync(stateDirectory, { recursive: true });
			const plan: HandoffPlan = {
				oldPid: process.pid,
				currentExecutable: this.#installation.executable,
				candidatePaths,
				publicPaths: this.#installation.publicPaths,
				backupPaths,
				serverArgs: this.#options.serverArgs ?? process.argv.slice(2),
				cwd: this.#options.cwd,
				healthUrl: `http://${this.#options.hostname}:${this.#options.port}/api/snapshot`,
				databasePath: this.#options.databasePath,
				previousVersion: this.#options.currentVersion,
				targetVersion: release.version,
				targetCommit: release.commit,
				previousCommit: this.#options.currentCommit,
				timeoutMs: 30_000,
			};
			const path = join(stateDirectory, `${nonce}.json`);
			writeFileSync(path, `${JSON.stringify(plan)}\n`, { mode: 0o600, flag: 'wx' });
			return { path, plan };
		} catch (error) {
			for (const path of [...candidatePaths, ...backupPaths]) rmSync(path, { force: true });
			throw error;
		}
	}

	#result(status: SelfUpdateResultStatus, targetVersion: string | null, reason: unknown): SelfUpdateResult {
		return {
			status,
			at: this.#now().toISOString(),
			previousVersion: this.#options.currentVersion,
			targetVersion,
			reason: reason instanceof Error ? reason.message : String(reason),
		};
	}
}

export interface HandoffDependencies {
	waitForExit: (pid: number, timeoutMs: number) => Promise<boolean>;
	swap: (from: string, to: string) => void;
	start: (executable: string, args: string[], cwd: string) => { pid: number; stop: () => void; unref: () => void };
	probe: (url: string, version: string, commit: string | null, timeoutMs: number) => Promise<boolean>;
	persist: (plan: HandoffPlan, result: SelfUpdateResult) => Promise<void>;
	cleanup: (path: string) => void;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try { process.kill(pid, 0); } catch { return true; }
		await Bun.sleep(100);
	}
	return false;
}

function startServer(executable: string, args: string[], cwd: string) {
	const child = Bun.spawn([executable, ...args], { cwd, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
	return {
		pid: child.pid,
		stop: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } },
		unref: () => child.unref(),
	};
}

async function healthProbe(url: string, version: string, commit: string | null, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	const expected = commit === null ? version : `${version}+${commit}`;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) {
				const payload = await response.json() as { version?: unknown };
				if (payload.version === expected) return true;
			}
		} catch { /* server has not bound yet */ }
		await Bun.sleep(200);
	}
	return false;
}

async function persistHandoff(plan: HandoffPlan, result: SelfUpdateResult): Promise<void> {
	const store = new RunStore(plan.databasePath);
	try {
		const stored = readStored(store);
		writeStored(store, { ...stored, result });
	} finally {
		store.close();
	}
	const title = result.status === 'success'
		? 'Gateship updated'
		: result.status === 'rollback' ? 'Gateship update rolled back' : 'Gateship update failed';
	await sendRemoteServiceNotification(plan.cwd, title, result.reason);
}

const DEFAULT_HANDOFF_DEPENDENCIES: HandoffDependencies = {
	waitForExit,
	swap: renameSync,
	start: startServer,
	probe: healthProbe,
	persist: persistHandoff,
	cleanup: (path) => rmSync(path, { force: true }),
};

function handoffResult(
	plan: HandoffPlan,
	status: SelfUpdateResultStatus,
	reason: string,
): SelfUpdateResult {
	return {
		status,
		at: new Date().toISOString(),
		previousVersion: plan.previousVersion,
		targetVersion: plan.targetVersion,
		reason,
	};
}

async function persistResult(
	plan: HandoffPlan,
	dependencies: HandoffDependencies,
	status: SelfUpdateResultStatus,
	reason: string,
): Promise<SelfUpdateResult> {
	const result = handoffResult(plan, status, reason);
	await dependencies.persist(plan, result);
	return result;
}

function cleanupPreparedHandoff(plan: HandoffPlan, dependencies: HandoffDependencies): void {
	for (const path of [...plan.candidatePaths, ...plan.backupPaths]) dependencies.cleanup(path);
}

function installCandidate(
	plan: HandoffPlan,
	dependencies: HandoffDependencies,
	progress: { backedUp: number },
): void {
	for (let index = 0; index < plan.publicPaths.length; index += 1) {
		dependencies.swap(plan.publicPaths[index]!, plan.backupPaths[index]!);
		progress.backedUp += 1;
		dependencies.swap(plan.candidatePaths[index]!, plan.publicPaths[index]!);
	}
}

async function restorePrevious(
	plan: HandoffPlan,
	dependencies: HandoffDependencies,
	backedUp: number,
): Promise<void> {
	for (let index = backedUp - 1; index >= 0; index -= 1) {
		dependencies.cleanup(plan.publicPaths[index]!);
		dependencies.swap(plan.backupPaths[index]!, plan.publicPaths[index]!);
	}
	const previous = dependencies.start(plan.currentExecutable, plan.serverArgs, plan.cwd);
	if (await dependencies.probe(plan.healthUrl, plan.previousVersion, plan.previousCommit, plan.timeoutMs)) {
		previous.unref();
		return;
	}
	previous.stop();
	throw new Error('The restored process did not return its previous identity.');
}

async function runInstalledCandidate(
	plan: HandoffPlan,
	dependencies: HandoffDependencies,
): Promise<SelfUpdateResult> {
	const candidate = dependencies.start(plan.currentExecutable, plan.serverArgs, plan.cwd);
	if (!await dependencies.probe(plan.healthUrl, plan.targetVersion, plan.targetCommit, plan.timeoutMs)) {
		candidate.stop();
		await dependencies.waitForExit(candidate.pid, plan.timeoutMs);
		throw new Error('The candidate did not return the expected version and commit.');
	}
	let result: SelfUpdateResult;
	try {
		result = await persistResult(
			plan,
			dependencies,
			'success',
			`Updated from ${plan.previousVersion} to ${plan.targetVersion}.`,
		);
	} catch (error) {
		candidate.stop();
		await dependencies.waitForExit(candidate.pid, plan.timeoutMs);
		throw error;
	}
	candidate.unref();
	for (const backup of plan.backupPaths) dependencies.cleanup(backup);
	return result;
}

async function rollbackResult(
	plan: HandoffPlan,
	dependencies: HandoffDependencies,
	backedUp: number,
	cause: unknown,
): Promise<SelfUpdateResult> {
	const causeText = cause instanceof Error ? cause.message : String(cause);
	try {
		await restorePrevious(plan, dependencies, backedUp);
		return await persistResult(
			plan,
			dependencies,
			'rollback',
			`${causeText} The previous version was restored and verified.`,
		);
	} catch (rollbackError) {
		const rollbackText = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
		return await persistResult(
			plan,
			dependencies,
			'failed',
			`${causeText} Rollback failed: ${rollbackText}`,
		);
	}
}

export async function executeSelfUpdateHandoff(
	plan: HandoffPlan,
	dependencies: HandoffDependencies = DEFAULT_HANDOFF_DEPENDENCIES,
): Promise<SelfUpdateResult> {
	if (!await dependencies.waitForExit(plan.oldPid, plan.timeoutMs)) {
		cleanupPreparedHandoff(plan, dependencies);
		return persistResult(
			plan,
			dependencies,
			'failed',
			'The previous Gateship process did not exit before the handoff deadline.',
		);
	}
	const progress = { backedUp: 0 };
	try {
		installCandidate(plan, dependencies, progress);
		return await runInstalledCandidate(plan, dependencies);
	} catch (error) {
		return rollbackResult(plan, dependencies, progress.backedUp, error);
	} finally {
		for (const candidate of plan.candidatePaths) dependencies.cleanup(candidate);
	}
}
