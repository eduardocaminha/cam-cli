import { randomUUID } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { RunEvent } from './run-store.ts';

/**
 * The one secret this module ever touches: a complete ntfy topic URL, read
 * from the service process's own environment or, failing that, from a
 * project-local file (GSHIP-651, GSHIP-652). Absent means the channel is off
 * -- the service starts and runs exactly as before, no error, no attempt. It
 * is never named in `child-env.ts`'s allowlists, so an agent or `gh` child
 * never inherits it, and it is never stored, returned or logged anywhere in
 * this module.
 */
export const NTFY_URL_ENV_VAR = 'GATESHIP_NTFY_URL';

/**
 * Project-relative home of the file-backed secret (GSHIP-652): `.gship/` is
 * already the project's own local-state directory, already entirely
 * `.gitignore`d, so deleting the project deletes this with it -- no residue in
 * a system vault. The operator places this file themselves (out of scope:
 * editing it from the screen); the format is one line, the bare topic URL.
 * Mode 0600 and the child environment allowlist prevent accidental disclosure;
 * they do not isolate this file from a hostile child running with the same
 * filesystem identity. That product boundary is documented explicitly.
 */
export const NTFY_URL_FILE_PATH = join('.gship', 'ntfy-url');

const DEFAULT_TIMEOUT_MS = 5_000;

/** Reasons `run.chain-paused` carries that are chaining's default-off steady state, not a stopped queue (mirrors webui/src/App.tsx's stoppedQueuePause, GSHIP-650). */
const SILENT_CHAIN_PAUSE_REASONS = new Set(['chain-disabled']);

interface RemoteNotification {
	title: string;
	body: string;
}

function payloadText(event: RunEvent, key: string): string | null {
	const value = event.payload[key];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Split out of `remoteNotificationForRunEvent` to keep its own branching under the complexity budget. */
function chainPauseNotification(event: RunEvent): RemoteNotification | null {
	const reason = event.payload['reason'];
	if (typeof reason !== 'string' || SILENT_CHAIN_PAUSE_REASONS.has(reason)) return null;
	if (reason === 'no-admissible-issue') {
		return {
			title: 'Queue complete',
			body: 'The run queue is complete. No eligible work remains.',
		};
	}
	const issueId = payloadText(event, 'issueId');
	return {
		title: 'Queue stopped',
		body: issueId === null
			? 'The run queue stopped and needs attention.'
			: `The run queue stopped at ${issueId}.`,
	};
}

/**
 * The durable transitions worth waking someone up for (GSHIP-651): an
 * operator decision, a failure, an interruption nobody asked for, a ship
 * that needs a retry, and a stopped chain queue. Deliberately narrower than
 * the browser's own `notificationForRunEvent`: a clean `done` and a
 * preserved-workspace warning already read fine at the next glance and are
 * not worth a page in the middle of the night. `run.chain-paused` is decided
 * before the transition guard below because the runtime emits it on the
 * state the run already holds (GSHIP-650), same as the browser's
 * `workspace.cleanup-warning`.
 */
export function remoteNotificationForRunEvent(event: RunEvent): RemoteNotification | null {
	if (event.kind === 'run.chain-paused') return chainPauseNotification(event);
	if (event.fromState === event.toState) return null;

	if (event.toState === 'waiting-user') {
		return {
			title: 'Gateship needs you',
			body: payloadText(event, 'summary') ?? 'The run is waiting for an operator decision.',
		};
	}
	if (event.toState === 'waiting-provider') {
		return {
			title: 'Provider temporarily unavailable',
			body: payloadText(event, 'message') ?? 'The run was preserved and can be resumed later.',
		};
	}
	if (event.toState === 'ready-to-ship' && event.kind === 'run.ship-failed') {
		return {
			title: 'Shipping needs another attempt',
			body: payloadText(event, 'error') ?? 'The code remains preserved and ready to retry.',
		};
	}
	// `run.cancelled` (RunRuntime#cancelRun on a run with nothing active to
	// abort) is the operator's own action, already visible on the screen that
	// triggered it. Every other path to `interrupted` goes through
	// RunRuntime#interrupt on an aborted signal -- an active run's `cancelRun`
	// and RunRuntime#stop both abort that same signal -- and kind
	// `run.recovered-interrupted` (run-store.ts's own startup recovery) can
	// never reach a subscriber: it is produced and discarded inside the
	// RunRuntime constructor, before `subscribe` can ever be called on the
	// instance it returns. `run.interrupted` is therefore the one kind an
	// operator genuinely was not watching happen, which is what this alert
	// exists for.
	if (event.toState === 'interrupted' && event.kind !== 'run.cancelled') {
		return {
			title: 'Run interrupted',
			body: 'The run can be resumed from Gateship.',
		};
	}
	if (event.toState === 'failed') {
		return {
			title: 'Run failed',
			body: payloadText(event, 'error') ?? 'Open Gateship to inspect the error.',
		};
	}
	return null;
}

/**
 * A file that does not exist, is empty, or is readable/writable by anyone but
 * its owner reads the same as no file at all -- never an error. The looser-
 * than-600 case enforces the one property GSHIP-652 actually requires of this
 * file: Gateship never edits or chmods it (out of scope), so the only lever
 * left to honor that decision is refusing to trust a file that arrived more
 * permissive than the contract, the same posture SSH takes on a private key.
 */
function readNtfyUrlFile(cwd: string): string | null {
	const path = join(cwd, NTFY_URL_FILE_PATH);
	try {
		if ((statSync(path).mode & 0o077) !== 0) return null;
		const raw = readFileSync(path, 'utf8').trim();
		return raw.length === 0 ? null : raw;
	} catch {
		return null;
	}
}

/**
 * The env var wins over the project file (GSHIP-652), so an operator already
 * running with `GATESHIP_NTFY_URL` set sees no change. Neither present reads
 * as `null`, the channel's ordinary off state, never an error.
 */
export function resolveNtfyUrl(cwd: string, env: Record<string, string | undefined> = process.env): string | null {
	const fromEnv = env[NTFY_URL_ENV_VAR];
	const trimmedEnv = typeof fromEnv === 'string' ? fromEnv.trim() : '';
	if (trimmedEnv.length > 0) return trimmedEnv;
	return readNtfyUrlFile(cwd);
}

/**
 * The one place "is this usable" is decided: resolved *and* a URL the rest of
 * this module could actually POST to. `isNtfyConfigured`, `createRemoteNotifier`
 * and `sendNtfyTestNotification` all call this instead of each re-parsing the
 * raw value their own way, so a value that fails to parse reads as off
 * everywhere at once -- never "configured" on one path and refused on another.
 */
function resolveNtfyTopicUrl(cwd: string, env: Record<string, string | undefined>): URL | null {
	const raw = resolveNtfyUrl(cwd, env);
	if (raw === null) return null;
	try {
		return new URL(raw);
	} catch {
		return null;
	}
}

/**
 * The only shape Settings -- or any other caller -- is allowed to read the
 * secret's presence through: a boolean, never the value it resolved (GSHIP-652).
 */
export function isNtfyConfigured(cwd: string, env: Record<string, string | undefined> = process.env): boolean {
	return resolveNtfyTopicUrl(cwd, env) !== null;
}

export interface RemoteNotifierOptions {
	/** Defaults to `process.env`; a test supplies its own map instead of mutating the real process. */
	env?: Record<string, string | undefined>;
	/** Defaults to the global `fetch`; a test injects a stub to observe or fail a delivery. */
	fetchImpl?: typeof fetch;
	/** Short by contract (GSHIP-651): an unreachable ntfy server must never stall the event log. */
	timeoutMs?: number;
	/** Project root the file-backed secret is read from (GSHIP-652); defaults to `process.cwd()`. */
	cwd?: string;
}

/** One ntfy delivery; swallowed after being counted against the request itself (a settled, failed fetch) rather than left an unhandled rejection -- the channel is optional, so its own failure carries no further consequence. */
async function sendNtfyDelivery(
	topicUrl: URL,
	notification: RemoteNotification,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<void> {
	const target = new URL(topicUrl);
	target.searchParams.set('title', notification.title);
	try {
		await fetchImpl(target, {
			method: 'POST',
			body: notification.body,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch {
		// Swallowed after being counted against the request itself (a settled,
		// failed fetch) rather than left an unhandled rejection: the channel is
		// optional, so its own failure carries no further consequence.
	}
}

/**
 * Builds the event-log listener that pushes remote alerts through every
 * configured channel (GSHIP-651, GSHIP-653). Meant to be handed straight to
 * `RunRuntime.subscribe`, the same durable event log the browser's SSE stream
 * already reads -- no separate trigger, no polling. Each channel's own
 * configuration is resolved fresh on every qualifying event rather than once
 * here at construction time (GSHIP-652 review): this function runs once at
 * service boot, long before an operator who just read the panel's own
 * instructions gets around to creating `.gship/ntfy-url` or
 * `.gship/resend-api-key` -- a value baked in at boot would leave that
 * operator's file permanently invisible to a subscriber built before it
 * existed, silently off until a restart nobody told them to do. A missing or
 * incomplete configuration degrades to no delivery attempt rather than an
 * error, since each channel is optional by definition; ntfy and Resend are
 * resolved and fired independently, so either, both or neither can be on at
 * once and neither's delivery (or failure) touches the other's. A running
 * channel still never lets a delivery failure reach the caller, because an
 * alert missing its page must never be able to affect a run's own state.
 */
export function createRemoteNotifier(options: RemoteNotifierOptions = {}): (event: RunEvent) => void {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return (event: RunEvent) => {
		const notification = remoteNotificationForRunEvent(event);
		if (notification === null) return;

		const topicUrl = resolveNtfyTopicUrl(cwd, env);
		if (topicUrl !== null) void sendNtfyDelivery(topicUrl, notification, fetchImpl, timeoutMs);

		const { config } = resolveResendConfig(cwd, env);
		if (config !== null) void sendResendDelivery(config, notification, fetchImpl, timeoutMs);
	};
}

/**
 * Final service-lifecycle outcomes use the same optional server-side channels
 * as run alerts. The caller supplies only public result text; channel secrets
 * remain resolved here and never enter SQLite, a browser response, or a child
 * environment assembled for an agent.
 */
export async function sendRemoteServiceNotification(
	cwd: string,
	title: string,
	body: string,
	options: Omit<RemoteNotifierOptions, 'cwd'> = {},
): Promise<void> {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const notification = { title, body };
	const deliveries: Promise<void>[] = [];
	const topicUrl = resolveNtfyTopicUrl(cwd, env);
	if (topicUrl !== null) deliveries.push(sendNtfyDelivery(topicUrl, notification, fetchImpl, timeoutMs));
	const { config } = resolveResendConfig(cwd, env);
	if (config !== null) deliveries.push(sendResendDelivery(config, notification, fetchImpl, timeoutMs));
	await Promise.all(deliveries);
}

/** What Ajustes' "send test" button reports; `detail` never carries the topic URL, only the delivery's own outcome. */
export type NtfyTestOutcome = 'sent' | 'not-configured' | 'rejected' | 'unreachable';

export interface NtfyTestResult {
	outcome: NtfyTestOutcome;
	/** The delivery endpoint's own status or the network failure's message; absent when `sent`. */
	detail?: string;
}

export interface NtfyTestOptions {
	cwd: string;
	/** Defaults to `process.env`; a test supplies its own map instead of mutating the real process. */
	env?: Record<string, string | undefined>;
	/** Defaults to the global `fetch`; a test injects a stub to observe or fail a delivery. */
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/**
 * Fires one real ntfy delivery so Ajustes can report whether the channel
 * actually accepts a message, not just whether a URL is present (GSHIP-652).
 * The result never carries the topic URL, on any outcome.
 */
export async function sendNtfyTestNotification(options: NtfyTestOptions): Promise<NtfyTestResult> {
	const env = options.env ?? process.env;
	const topicUrl = resolveNtfyTopicUrl(options.cwd, env);
	if (topicUrl === null) return { outcome: 'not-configured' };

	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const target = new URL(topicUrl);
	target.searchParams.set('title', 'Gateship test');
	try {
		const response = await fetchImpl(target, {
			method: 'POST',
			body: 'Test message sent from the Settings panel.',
			signal: AbortSignal.timeout(timeoutMs),
		});
		return response.ok ? { outcome: 'sent' } : { outcome: 'rejected', detail: `HTTP ${response.status}` };
	} catch (error) {
		// The error's own `name` only, never its `message`: fetch's own network
		// and timeout errors sometimes embed the request URL in the message, and
		// that URL carries the secret this function must never leak.
		return { outcome: 'unreachable', detail: error instanceof Error ? error.name : 'network failure' };
	}
}

/**
 * Resend as a second, independent remote channel (GSHIP-653): unlike ntfy's
 * single topic URL, delivery needs three values at once -- the API key, a
 * sender on a verified domain, and a recipient. Neither remote channel
 * depends on the other; each resolves and fires on its own configuration,
 * and both can be on at the same time. The API key is the "segredo forte"
 * here (whoever holds it can send mail as the domain), so it follows the
 * exact same rules as ntfy's topic URL: an env var that wins over a project
 * file requiring mode 600, never SQLite, never a browser response, never a
 * log line, and never named in `child-env.ts`'s allowlists so a spawned
 * agent or `gh` child never inherits it. This is an inheritance boundary, not
 * filesystem isolation from a hostile same-identity child. `from` and `to`
 * are ordinary configuration, not secrets, and can also live in the small
 * project-local settings file below.
 */
export const RESEND_API_KEY_ENV_VAR = 'GATESHIP_RESEND_API_KEY';

/** Project-relative home of the file-backed API key, mirroring `NTFY_URL_FILE_PATH`. */
export const RESEND_API_KEY_FILE_PATH = join('.gship', 'resend-api-key');

/** Non-secret sender and recipient selected in Settings. */
export const RESEND_SETTINGS_FILE_PATH = join('.gship', 'resend-settings.json');

/** Generous enough for a display-name sender while keeping local input bounded. */
export const RESEND_SETTING_MAX_LENGTH = 512;

export const RESEND_FROM_ENV_VAR = 'GATESHIP_RESEND_FROM';
export const RESEND_TO_ENV_VAR = 'GATESHIP_RESEND_TO';

const RESEND_API_URL = 'https://api.resend.com/emails';

interface ResendConfig {
	apiKey: string;
	from: string;
	to: string;
}

/** The three values Resend needs. Ajustes names a missing one by this field, never by the value itself. */
export type ResendConfigField = 'apiKey' | 'from' | 'to';

export const RESEND_FIELD_LABELS: Readonly<Record<ResendConfigField, string>> = {
	apiKey: 'API key',
	from: 'sender',
	to: 'recipient',
};

/** Same refusal as `readNtfyUrlFile`: absent, empty, or looser than 600 all read as no file. */
function readResendApiKeyFile(cwd: string): string | null {
	const path = join(cwd, RESEND_API_KEY_FILE_PATH);
	try {
		if ((statSync(path).mode & 0o077) !== 0) return null;
		const raw = readFileSync(path, 'utf8').trim();
		return raw.length === 0 ? null : raw;
	} catch {
		return null;
	}
}

interface ResendFileSettings {
	from: string | null;
	to: string | null;
}

function boundedSetting(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= RESEND_SETTING_MAX_LENGTH ? trimmed : null;
}

function readResendFileSettings(cwd: string): ResendFileSettings {
	try {
		const parsed = JSON.parse(readFileSync(join(cwd, RESEND_SETTINGS_FILE_PATH), 'utf8')) as unknown;
		if (parsed === null || typeof parsed !== 'object') return { from: null, to: null };
		const record = parsed as Record<string, unknown>;
		return { from: boundedSetting(record.from), to: boundedSetting(record.to) };
	} catch {
		return { from: null, to: null };
	}
}

function atomicWrite(cwd: string, relativePath: string, contents: string, mode: number): void {
	const directory = join(cwd, '.gship');
	mkdirSync(directory, { recursive: true });
	const target = join(cwd, relativePath);
	const temporary = join(directory, `.${relativePath.split('/').at(-1)}.${randomUUID()}.tmp`);
	let descriptor: number | null = null;
	try {
		descriptor = openSync(temporary, 'wx', mode);
		// Do not rely on the process umask to establish the credential boundary.
		chmodSync(temporary, mode);
		writeFileSync(descriptor, contents, 'utf8');
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = null;
		renameSync(temporary, target);
	} catch (error) {
		if (descriptor !== null) closeSync(descriptor);
		try { unlinkSync(temporary); } catch { /* Nothing was prepared. */ }
		throw error;
	}
}

/** Writes a replacement key without exposing it through any return value. */
export function writeResendApiKey(cwd: string, apiKey: string): void {
	const trimmed = apiKey.trim();
	if (trimmed.length === 0) throw new Error('A non-empty API key is required.');
	atomicWrite(cwd, RESEND_API_KEY_FILE_PATH, `${trimmed}\n`, 0o600);
}

/** Persists only the two non-secret fields. */
export function writeResendSettings(cwd: string, from: string, to: string): void {
	const normalizedFrom = boundedSetting(from);
	const normalizedTo = boundedSetting(to);
	if (normalizedFrom === null || normalizedTo === null) {
		throw new Error('Sender and recipient must be non-empty bounded strings.');
	}
	atomicWrite(
		cwd,
		RESEND_SETTINGS_FILE_PATH,
		`${JSON.stringify({ from: normalizedFrom, to: normalizedTo }, null, 2)}\n`,
		0o600,
	);
}

export function removeResendApiKey(cwd: string): boolean {
	try {
		unlinkSync(join(cwd, RESEND_API_KEY_FILE_PATH));
		return true;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
		throw error;
	}
}

/** The env var wins over the project file, the same precedence `resolveNtfyUrl` gives ntfy. */
export function resolveResendApiKey(
	cwd: string,
	env: Record<string, string | undefined> = process.env,
): string | null {
	const fromEnv = env[RESEND_API_KEY_ENV_VAR];
	const trimmedEnv = typeof fromEnv === 'string' ? fromEnv.trim() : '';
	if (trimmedEnv.length > 0) return trimmedEnv;
	return readResendApiKeyFile(cwd);
}

function trimmedEnvValue(env: Record<string, string | undefined>, key: string): string | null {
	const raw = env[key];
	const trimmed = typeof raw === 'string' ? raw.trim() : '';
	return trimmed.length > 0 ? trimmed : null;
}

export interface ResendStatus {
	configured: boolean;
	missing: ResendConfigField[];
	from: string | null;
	to: string | null;
	fileCredentialExists: boolean;
	externallyManaged: Readonly<Record<ResendConfigField, boolean>>;
}

/** Safe browser-facing status: effective non-secrets and key presence, never the key. */
export function resolveResendStatus(
	cwd: string,
	env: Record<string, string | undefined> = process.env,
): ResendStatus {
	const file = readResendFileSettings(cwd);
	const envFrom = trimmedEnvValue(env, RESEND_FROM_ENV_VAR);
	const envTo = trimmedEnvValue(env, RESEND_TO_ENV_VAR);
	const externallyManaged = {
		apiKey: trimmedEnvValue(env, RESEND_API_KEY_ENV_VAR) !== null,
		from: envFrom !== null,
		to: envTo !== null,
	};
	const from = envFrom ?? file.from;
	const to = envTo ?? file.to;
	const apiKey = resolveResendApiKey(cwd, env);
	const missing: ResendConfigField[] = [];
	if (apiKey === null) missing.push('apiKey');
	if (from === null) missing.push('from');
	if (to === null) missing.push('to');
	return {
		configured: missing.length === 0,
		missing,
		from,
		to,
		fileCredentialExists: existsSync(join(cwd, RESEND_API_KEY_FILE_PATH)),
		externallyManaged,
	};
}

/**
 * The one place "is Resend usable" is decided, the same role
 * `resolveNtfyTopicUrl` plays for ntfy: every other Resend function below
 * reads through this instead of re-checking the three values its own way, so
 * a config missing any one of them reads the same everywhere -- off, and
 * naming exactly what is missing.
 */
function resolveResendConfig(
	cwd: string,
	env: Record<string, string | undefined>,
): { config: ResendConfig | null; missing: ResendConfigField[] } {
	const status = resolveResendStatus(cwd, env);
	const apiKey = resolveResendApiKey(cwd, env);
	const { from, to, missing } = status;
	if (apiKey === null || from === null || to === null) return { config: null, missing };
	return { config: { apiKey, from, to }, missing: [] };
}

/** Never the three values -- only whether Resend resolved all of them (GSHIP-653). */
export function isResendConfigured(cwd: string, env: Record<string, string | undefined> = process.env): boolean {
	return resolveResendConfig(cwd, env).config !== null;
}

/** What Ajustes names, by field, when Resend is off because of a partial configuration. */
export function resolveResendMissingFields(
	cwd: string,
	env: Record<string, string | undefined> = process.env,
): ResendConfigField[] {
	return resolveResendConfig(cwd, env).missing;
}

/** One Resend HTTP API delivery; swallowed exactly like ntfy's own -- the channel is optional, so its failure carries no further consequence. */
async function sendResendDelivery(
	config: ResendConfig,
	notification: RemoteNotification,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<void> {
	try {
		await fetchImpl(RESEND_API_URL, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${config.apiKey}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				from: config.from,
				to: [config.to],
				subject: notification.title,
				text: notification.body,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch {
		// Swallowed for the same reason as ntfy's own delivery above.
	}
}

/** What Ajustes' "send test" button reports for Resend; never carries the API key, on any outcome. */
export type ResendTestOutcome = 'sent' | 'not-configured' | 'rejected' | 'unreachable';

export interface ResendTestResult {
	outcome: ResendTestOutcome;
	/**
	 * The missing fields joined by name (`not-configured`), the endpoint's own
	 * status (`rejected`), or the network failure's name (`unreachable`);
	 * absent when `sent`.
	 */
	detail?: string;
}

export interface ResendTestOptions {
	cwd: string;
	/** Defaults to `process.env`; a test supplies its own map instead of mutating the real process. */
	env?: Record<string, string | undefined>;
	/** Defaults to the global `fetch`; a test injects a stub to observe or fail a delivery. */
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/**
 * Fires one real Resend delivery so Ajustes can report whether the channel
 * actually accepts a message, not just whether it is configured -- mirrors
 * `sendNtfyTestNotification`. A partial configuration reports which values
 * are missing by name instead of attempting a delivery; the result never
 * carries the API key, the sender, or the recipient, on any outcome.
 */
export async function sendResendTestNotification(options: ResendTestOptions): Promise<ResendTestResult> {
	const env = options.env ?? process.env;
	const { config, missing } = resolveResendConfig(options.cwd, env);
	if (config === null) {
		return { outcome: 'not-configured', detail: missing.map((field) => RESEND_FIELD_LABELS[field]).join(', ') };
	}

	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	try {
		const response = await fetchImpl(RESEND_API_URL, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${config.apiKey}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				from: config.from,
				to: [config.to],
				subject: 'Gateship test',
				text: 'Test message sent from the Settings panel.',
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		return response.ok ? { outcome: 'sent' } : { outcome: 'rejected', detail: `HTTP ${response.status}` };
	} catch (error) {
		// The error's own `name` only, never its `message`, mirroring
		// `sendNtfyTestNotification`'s own rationale.
		return { outcome: 'unreachable', detail: error instanceof Error ? error.name : 'network failure' };
	}
}
