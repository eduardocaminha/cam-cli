import { readFileSync, statSync } from 'node:fs';
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
	const issueId = payloadText(event, 'issueId');
	return {
		title: 'Fila parada',
		body: issueId === null
			? 'A fila de encadeamento parou e precisa de atenção.'
			: `A fila de encadeamento parou em ${issueId}.`,
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
			title: 'Gateship precisa de você',
			body: payloadText(event, 'summary') ?? 'O run aguarda uma decisão do operador.',
		};
	}
	if (event.toState === 'ready-to-ship' && event.kind === 'run.ship-failed') {
		return {
			title: 'Ship precisa de nova tentativa',
			body: payloadText(event, 'error') ?? 'O código continua preservado e pronto para retry.',
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
			title: 'Run interrompido',
			body: 'O run pode ser retomado pela interface.',
		};
	}
	if (event.toState === 'failed') {
		return {
			title: 'Run falhou',
			body: payloadText(event, 'error') ?? 'Abra o Gateship para ver o erro.',
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
 * everywhere at once -- never "configurado" on one path and refused on another.
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
 * The only shape Ajustes -- or any other caller -- is allowed to read the
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

/**
 * Builds the event-log listener that pushes ntfy alerts (GSHIP-651). Meant to
 * be handed straight to `RunRuntime.subscribe`, the same durable event log
 * the browser's SSE stream already reads -- no separate trigger, no polling.
 * The secret is resolved fresh on every qualifying event rather than once
 * here at construction time (GSHIP-652 review): `createRemoteNotifier` runs
 * once at service boot, long before an operator who just read the panel's own
 * instructions gets around to creating `.gship/ntfy-url` -- a value baked in
 * at boot would leave that operator's file permanently invisible to a
 * subscriber built before it existed, silently off until a restart nobody
 * told them to do. A missing or unparseable URL degrades to no delivery
 * attempt rather than an error, since the channel is optional by definition;
 * a running one still never lets a delivery failure reach the caller, because
 * an alert missing its page must never be able to affect a run's own state.
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
		if (topicUrl === null) return;
		const target = new URL(topicUrl);
		target.searchParams.set('title', notification.title);
		fetchImpl(target, {
			method: 'POST',
			body: notification.body,
			signal: AbortSignal.timeout(timeoutMs),
		}).catch(() => {
			// Swallowed after being counted against the request itself (a settled,
			// failed fetch) rather than left an unhandled rejection: the channel is
			// optional, so its own failure carries no further consequence.
		});
	};
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
	target.searchParams.set('title', 'Teste do Gateship');
	try {
		const response = await fetchImpl(target, {
			method: 'POST',
			body: 'Mensagem de teste enviada pelo painel de Ajustes.',
			signal: AbortSignal.timeout(timeoutMs),
		});
		return response.ok ? { outcome: 'sent' } : { outcome: 'rejected', detail: `HTTP ${response.status}` };
	} catch (error) {
		// The error's own `name` only, never its `message`: fetch's own network
		// and timeout errors sometimes embed the request URL in the message, and
		// that URL carries the secret this function must never leak.
		return { outcome: 'unreachable', detail: error instanceof Error ? error.name : 'falha de rede' };
	}
}
