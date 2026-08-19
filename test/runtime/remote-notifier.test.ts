import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import {
	createRemoteNotifier,
	NTFY_URL_ENV_VAR,
	remoteNotificationForRunEvent,
} from '../../src/runtime/remote-notifier.ts';
import { RunStore, type RunEvent } from '../../src/runtime/run-store.ts';
import type { RunState } from '../../src/runtime/run-state.ts';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('timed out waiting for runtime state');
		await Bun.sleep(5);
	}
}

const TOPIC_URL = 'https://ntfy.sh/gateship-operator-secret-topic';

function event(
	toState: RunState,
	kind: string,
	payload: Record<string, unknown> = {},
	fromState: RunState | null = 'working',
): RunEvent {
	return {
		seq: 1,
		runId: 'run-1',
		kind,
		fromState,
		toState,
		payload,
		createdAt: '2026-08-19T00:00:00.000Z',
		eventClass: 'decision',
	};
}

/** The chain-paused event's own from/toState equal the run's unchanged current state (GSHIP-650), same shape as `workspace.cleanup-warning`. */
function chainPaused(payload: Record<string, unknown>): RunEvent {
	return event('done', 'run.chain-paused', payload, 'done');
}

describe('remoteNotificationForRunEvent', () => {
	test('alerts on each transition that needs the operator', () => {
		expect(remoteNotificationForRunEvent(
			event('waiting-user', 'run.waiting-user', { summary: 'Escolha o seam.' }),
		)).toEqual({ title: 'Gateship precisa de você', body: 'Escolha o seam.' });

		expect(remoteNotificationForRunEvent(
			event('failed', 'run.verification-failed', { error: 'checks red' }),
		)).toEqual({ title: 'Run falhou', body: 'checks red' });

		// `run.interrupted` is what RunRuntime#interrupt actually emits on an
		// aborted signal -- see the real-RunRuntime coverage below for why
		// `run.recovered-interrupted` can never reach a subscriber.
		expect(remoteNotificationForRunEvent(
			event('interrupted', 'run.interrupted'),
		)).toEqual({ title: 'Run interrompido', body: 'O run pode ser retomado pela interface.' });

		expect(remoteNotificationForRunEvent(
			event('ready-to-ship', 'run.ship-failed', { error: 'checks red' }),
		)).toEqual({ title: 'Ship precisa de nova tentativa', body: 'checks red' });

		expect(remoteNotificationForRunEvent(
			chainPaused({ reason: 'no-admissible-issue', issueId: 'GSHIP-9' }),
		)).toEqual({ title: 'Fila parada', body: 'A fila de encadeamento parou em GSHIP-9.' });
	});

	test('does not alert on progress, a clean finish, an operator cancellation, or a disabled chain', () => {
		expect(remoteNotificationForRunEvent(event('review', 'run.review-started'))).toBeNull();
		expect(remoteNotificationForRunEvent(event('ready-to-ship', 'run.review-clean'))).toBeNull();
		// The operator's own cancellation of a run with nothing active to abort
		// (RunRuntime#cancelRun's inactive-run branch) -- already visible on the
		// screen that triggered it.
		expect(remoteNotificationForRunEvent(event('interrupted', 'run.cancelled'))).toBeNull();
		expect(remoteNotificationForRunEvent(event('done', 'run.shipped'))).toBeNull();
		expect(remoteNotificationForRunEvent(
			event('working', 'workspace.cleanup-warning', { detail: 'sujo' }, 'working'),
		)).toBeNull();
		expect(remoteNotificationForRunEvent(chainPaused({ reason: 'chain-disabled' }))).toBeNull();
	});
});

interface FetchCall {
	url: string;
	init: RequestInit | undefined;
}

function stubFetch(
	behavior: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 200 })),
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		calls.push({ url: input instanceof URL ? input.toString() : String(input), init });
		return behavior();
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** `noUncheckedIndexedAccess` makes `calls[0]` optional; a single asserted call never is. */
function onlyCall(calls: readonly FetchCall[]): FetchCall {
	expect(calls).toHaveLength(1);
	const [call] = calls;
	if (call === undefined) throw new Error('expected exactly one fetch call');
	return call;
}

describe('createRemoteNotifier', () => {
	test('a missing topic URL sends nothing and never throws', async () => {
		const { fetchImpl, calls } = stubFetch();
		const notifier = createRemoteNotifier({ env: {}, fetchImpl });

		expect(() => notifier(event('waiting-user', 'run.waiting-user'))).not.toThrow();
		await flush();

		expect(calls).toHaveLength(0);
	});

	test('sends exactly one request per qualifying transition, carrying the title and body', async () => {
		const { fetchImpl, calls } = stubFetch();
		const notifier = createRemoteNotifier({ env: { [NTFY_URL_ENV_VAR]: TOPIC_URL }, fetchImpl });

		notifier(event('waiting-user', 'run.waiting-user', { summary: 'Escolha o seam.' }));
		await flush();

		const call = onlyCall(calls);
		const url = new URL(call.url);
		expect(`${url.origin}${url.pathname}`).toBe(TOPIC_URL);
		expect(url.searchParams.get('title')).toBe('Gateship precisa de você');
		expect(call.init?.method).toBe('POST');
		expect(call.init?.body).toBe('Escolha o seam.');
	});

	test('a transition that does not need attention sends nothing', async () => {
		const { fetchImpl, calls } = stubFetch();
		const notifier = createRemoteNotifier({ env: { [NTFY_URL_ENV_VAR]: TOPIC_URL }, fetchImpl });

		notifier(event('review', 'run.review-started'));
		notifier(event('done', 'run.shipped'));
		notifier(event('interrupted', 'run.cancelled'));
		await flush();

		expect(calls).toHaveLength(0);
	});

	/**
	 * Synthesized events above exercise the pure function; these two drive a
	 * real `RunRuntime` so the subscriber sees exactly the shape production
	 * ever emits (GSHIP-651 review) -- `run.recovered-interrupted` never
	 * reaches a subscriber, because `RunStore.recoverUnownedRuns` runs and its
	 * result is discarded inside the `RunRuntime` constructor, before
	 * `subscribe` can be called on the instance it returns.
	 */
	test('notifies once when RunRuntime interrupts an actively running executor', async () => {
		const store = new RunStore(':memory:');
		let markStarted = (): void => {};
		const executorStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-notify-interrupted',
			executor: {
				execute: ({ signal }) => new Promise((_resolve, reject) => {
					markStarted();
					signal.addEventListener('abort', () => {
						reject(new DOMException('cancelled', 'AbortError'));
					}, { once: true });
				}),
			},
			verifier: { verify: async () => ({ ok: true }) },
		});

		const { fetchImpl, calls } = stubFetch();
		runtime.subscribe(createRemoteNotifier({ env: { [NTFY_URL_ENV_VAR]: TOPIC_URL }, fetchImpl }));

		const run = runtime.startRun('CAM-51');
		await executorStarted;
		const cancelled = await runtime.cancelRun(run.id);
		expect(cancelled?.state).toBe('interrupted');
		expect(runtime.listEvents().at(-1)?.kind).toBe('run.interrupted');
		await flush();

		const call = onlyCall(calls);
		expect(new URL(call.url).searchParams.get('title')).toBe('Run interrompido');
		expect(call.init?.body).toBe('O run pode ser retomado pela interface.');

		await runtime.stop();
		runtime.close();
	});

	test('does not notify RunRuntime.cancelRun recording the operator\'s own cancellation', async () => {
		const store = new RunStore(':memory:');
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			newId: () => 'run-notify-cancelled',
			executor: {
				execute: async () => ({ outcome: 'waiting-user' as const, summary: 'Escolha o seam.' }),
			},
			verifier: { verify: async () => ({ ok: true }) },
		});

		const run = runtime.startRun('CAM-52');
		await waitFor(() => runtime.getRun(run.id)?.state === 'waiting-user');

		// Subscribed only once the run is parked, so this asserts on the
		// cancellation alone, not on the waiting-user alert already covered above.
		const { fetchImpl, calls } = stubFetch();
		runtime.subscribe(createRemoteNotifier({ env: { [NTFY_URL_ENV_VAR]: TOPIC_URL }, fetchImpl }));

		const cancelled = await runtime.cancelRun(run.id);
		expect(cancelled?.state).toBe('interrupted');
		expect(runtime.listEvents().at(-1)?.kind).toBe('run.cancelled');
		await flush();

		expect(calls).toHaveLength(0);

		await runtime.stop();
		runtime.close();
	});

	test('a network failure is swallowed and never reaches the caller', async () => {
		const { fetchImpl, calls } = stubFetch(() => Promise.reject(new Error(`network down: ${TOPIC_URL}`)));
		const notifier = createRemoteNotifier({ env: { [NTFY_URL_ENV_VAR]: TOPIC_URL }, fetchImpl });

		expect(() => notifier(event('failed', 'run.verification-failed', { error: 'boom' }))).not.toThrow();
		await flush();

		expect(calls).toHaveLength(1);
	});

	describe('the topic URL never appears in any observable output', () => {
		afterEach(() => {
			for (const spy of installedSpies.splice(0)) spy.mockRestore();
		});
		const installedSpies: ReturnType<typeof spyOn>[] = [];

		test('a failed delivery throws nothing and logs nothing', async () => {
			const logSpy = spyOn(console, 'log');
			const warnSpy = spyOn(console, 'warn');
			const errorSpy = spyOn(console, 'error');
			installedSpies.push(logSpy, warnSpy, errorSpy);

			const { fetchImpl } = stubFetch(() => Promise.reject(new Error(`network down: ${TOPIC_URL}`)));
			const notifier = createRemoteNotifier({ env: { [NTFY_URL_ENV_VAR]: TOPIC_URL }, fetchImpl });

			let thrown: unknown;
			try {
				notifier(event('failed', 'run.verification-failed', { error: 'boom' }));
			} catch (error) {
				thrown = error;
			}
			await flush();

			expect(thrown).toBeUndefined();
			expect(logSpy).not.toHaveBeenCalled();
			expect(warnSpy).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();
		});

		test('the fetch call itself carries the URL, but nothing returned or thrown does', async () => {
			const { fetchImpl, calls } = stubFetch();
			const notifier = createRemoteNotifier({ env: { [NTFY_URL_ENV_VAR]: TOPIC_URL }, fetchImpl });

			const result = notifier(event('waiting-user', 'run.waiting-user'));
			await flush();

			expect(calls[0]?.url).toContain(TOPIC_URL);
			expect(JSON.stringify(result ?? null)).not.toContain(TOPIC_URL);
		});
	});
});
