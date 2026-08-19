import type { RunEvent } from './run-store.ts';

/**
 * The one secret this module ever touches: a complete ntfy topic URL, read
 * once from the service process's own environment (GSHIP-651). Absent means
 * the channel is off -- the service starts and runs exactly as before, no
 * error, no attempt. It is never named in `child-env.ts`'s allowlists, so an
 * agent or `gh` child never inherits it, and it is never stored, returned or
 * logged anywhere in this module.
 */
export const NTFY_URL_ENV_VAR = 'GATESHIP_NTFY_URL';

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

export interface RemoteNotifierOptions {
	/** Defaults to `process.env`; a test supplies its own map instead of mutating the real process. */
	env?: Record<string, string | undefined>;
	/** Defaults to the global `fetch`; a test injects a stub to observe or fail a delivery. */
	fetchImpl?: typeof fetch;
	/** Short by contract (GSHIP-651): an unreachable ntfy server must never stall the event log. */
	timeoutMs?: number;
}

/**
 * Builds the event-log listener that pushes ntfy alerts (GSHIP-651). Meant to
 * be handed straight to `RunRuntime.subscribe`, the same durable event log
 * the browser's SSE stream already reads -- no separate trigger, no polling.
 * A missing or unparseable URL degrades to a no-op listener rather than an
 * error, since the channel is optional by definition; a running one still
 * never lets a delivery failure reach the caller, because an alert missing
 * its page must never be able to affect a run's own state.
 */
export function createRemoteNotifier(options: RemoteNotifierOptions = {}): (event: RunEvent) => void {
	const env = options.env ?? process.env;
	const raw = env[NTFY_URL_ENV_VAR];
	const trimmed = typeof raw === 'string' ? raw.trim() : '';
	if (trimmed.length === 0) return () => {};

	let topicUrl: URL;
	try {
		topicUrl = new URL(trimmed);
	} catch {
		return () => {};
	}

	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return (event: RunEvent) => {
		const notification = remoteNotificationForRunEvent(event);
		if (notification === null) return;
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
