import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import {
	createRemoteNotifier,
	isNtfyConfigured,
	isResendConfigured,
	NTFY_URL_ENV_VAR,
	NTFY_URL_FILE_PATH,
	remoteNotificationForRunEvent,
	RESEND_API_KEY_ENV_VAR,
	RESEND_API_KEY_FILE_PATH,
	RESEND_FIELD_LABELS,
	RESEND_FROM_ENV_VAR,
	RESEND_SETTINGS_FILE_PATH,
	RESEND_TO_ENV_VAR,
	resolveNtfyUrl,
	resolveResendApiKey,
	resolveResendMissingFields,
	resolveResendStatus,
	type ResendConfigField,
	sendNtfyTestNotification,
	sendResendTestNotification,
	writeResendApiKey,
	writeResendSettings,
} from '../../src/runtime/remote-notifier.ts';
import { RunStore, type RunEvent } from '../../src/runtime/run-store.ts';
import type { RunState } from '../../src/runtime/run-state.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

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

describe('remoteNotificationForRunEvent', () => {
	test('reports a real entry into waiting-user', () => {
		expect(remoteNotificationForRunEvent(
			event('waiting-user', 'run.waiting-user', { summary: 'Escolha o seam.' }),
		)).toEqual({ title: 'Gateship needs you', body: 'Escolha o seam.' });
	});

	test('does not alert on provider waits, recoverable failures, shipping, preserved workspaces, queue states, merges or repeated waiting-user', () => {
		expect(remoteNotificationForRunEvent(event('waiting-provider', 'run.provider-waiting'))).toBeNull();
		expect(remoteNotificationForRunEvent(event('interrupted', 'run.interrupted'))).toBeNull();
		expect(remoteNotificationForRunEvent(event('failed', 'run.verification-failed'))).toBeNull();
		expect(remoteNotificationForRunEvent(event('ready-to-ship', 'run.ship-failed'))).toBeNull();
		expect(remoteNotificationForRunEvent(event('done', 'workspace.cleanup-warning', {}, 'done'))).toBeNull();
		expect(remoteNotificationForRunEvent(event('done', 'run.chain-paused', { reason: 'operator-paused' }, 'done'))).toBeNull();
		expect(remoteNotificationForRunEvent(event('done', 'run.chain-paused', { reason: 'no-admissible-issue' }, 'done'))).toBeNull();
		expect(remoteNotificationForRunEvent(event('waiting-user', 'run.operator-guidance', {}, 'waiting-user'))).toBeNull();
		expect(remoteNotificationForRunEvent(event('review', 'run.review-started'))).toBeNull();
		expect(remoteNotificationForRunEvent(event('done', 'run.shipped'))).toBeNull();
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
		// An explicit, empty cwd -- never `process.cwd()` -- so this stays true
		// regardless of whatever `.gship/ntfy-url` an operator's own checkout
		// might carry (GSHIP-652).
		const notifier = createRemoteNotifier({ cwd: createTestTmpdir('gship-ntfy-missing-'), env: {}, fetchImpl });

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
		expect(url.searchParams.get('title')).toBe('Gateship needs you');
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
	test('does not notify when RunRuntime interrupts an actively running executor', async () => {
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

		const run = await runtime.startRun('CAM-51');
		await executorStarted;
		const cancelled = await runtime.cancelRun(run.id);
		expect(cancelled?.state).toBe('interrupted');
		expect(runtime.listEvents().at(-1)?.kind).toBe('run.interrupted');
		await flush();

		expect(calls).toHaveLength(0);

		await runtime.stop();
		runtime.close();
	});

	test('two project RunRuntimes use the same global ntfy configuration', async () => {
		const projectA = createTestTmpdir('gship-global-notify-project-a-');
		const projectB = createTestTmpdir('gship-global-notify-project-b-');
		const globalStateDir = createTestTmpdir('gship-global-notify-state-');
		const legacyStateDirA = createTestTmpdir('gship-global-notify-legacy-a-');
		const legacyStateDirB = createTestTmpdir('gship-global-notify-legacy-b-');
		const globalTopic = 'https://ntfy.sh/gateship-global-topic';
		const legacyTopicA = 'https://ntfy.sh/gateship-legacy-topic-a';
		const legacyTopicB = 'https://ntfy.sh/gateship-legacy-topic-b';
		writeFileSync(join(globalStateDir, 'ntfy-url'), `${globalTopic}\n`, { mode: 0o600 });
		writeFileSync(join(legacyStateDirA, 'ntfy-url'), `${legacyTopicA}\n`, { mode: 0o600 });
		writeFileSync(join(legacyStateDirB, 'ntfy-url'), `${legacyTopicB}\n`, { mode: 0o600 });

		const storeA = new RunStore(':memory:');
		const storeB = new RunStore(':memory:');
		const runtimeA = new RunRuntime({
			cwd: projectA,
			store: storeA,
			newId: () => 'run-global-notify-a',
			executor: { execute: async () => ({ outcome: 'waiting-user' as const, summary: 'Projeto A precisa de você.' }) },
			verifier: { verify: async () => ({ ok: true }) },
		});
		const runtimeB = new RunRuntime({
			cwd: projectB,
			store: storeB,
			newId: () => 'run-global-notify-b',
			executor: { execute: async () => ({ outcome: 'waiting-user' as const, summary: 'Projeto B precisa de você.' }) },
			verifier: { verify: async () => ({ ok: true }) },
		});
		const { fetchImpl, calls } = stubFetch();
		runtimeA.subscribe(createRemoteNotifier({ cwd: projectA, stateDir: globalStateDir, legacyStateDir: legacyStateDirA, env: {}, fetchImpl }));
		runtimeB.subscribe(createRemoteNotifier({ cwd: projectB, stateDir: globalStateDir, legacyStateDir: legacyStateDirB, env: {}, fetchImpl }));

		try {
			const runA = await runtimeA.startRun('GSHIP-735-A');
			const runB = await runtimeB.startRun('GSHIP-735-B');
			await waitFor(() => runtimeA.getRun(runA.id)?.state === 'waiting-user' && runtimeB.getRun(runB.id)?.state === 'waiting-user');
			await waitFor(() => calls.length === 2);

			expect(calls).toHaveLength(2);
			expect(calls.map(({ url }) => `${new URL(url).origin}${new URL(url).pathname}`)).toEqual([globalTopic, globalTopic]);
			expect(calls.map(({ init }) => init?.body)).toEqual(['Projeto A precisa de você.', 'Projeto B precisa de você.']);
			expect(calls.some(({ url }) => url.includes(legacyTopicA) || url.includes(legacyTopicB))).toBe(false);
		} finally {
			await runtimeA.stop();
			await runtimeB.stop();
			runtimeA.close();
			runtimeB.close();
		}
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

		const run = await runtime.startRun('CAM-52');
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

		expect(() => notifier(event('waiting-user', 'run.waiting-user', { summary: 'Escolha.' }))).not.toThrow();
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
			notifier(event('waiting-user', 'run.waiting-user', { summary: 'Escolha.' }));
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

/** What an operator's own shell command (`... > .gship/ntfy-url && chmod 600 ...`) produces. */
function writeNtfyUrlFile(cwd: string, url: string): void {
	mkdirSync(join(cwd, '.gship'), { recursive: true });
	writeFileSync(join(cwd, NTFY_URL_FILE_PATH), `${url}\n`, { mode: 0o600 });
}

describe('the project-local secret file (GSHIP-652)', () => {
	test('reads the topic URL from the project file when no environment variable is set', () => {
		const cwd = createTestTmpdir('gship-ntfy-file-');
		writeNtfyUrlFile(cwd, TOPIC_URL);

		expect(resolveNtfyUrl(cwd, {})).toBe(TOPIC_URL);
		expect(isNtfyConfigured(cwd, {})).toBe(true);
	});

	test('the environment variable takes precedence over the file, so an operator already using it is undisturbed', () => {
		const cwd = createTestTmpdir('gship-ntfy-file-');
		writeNtfyUrlFile(cwd, 'https://ntfy.sh/from-file-not-this-one');

		expect(resolveNtfyUrl(cwd, { [NTFY_URL_ENV_VAR]: TOPIC_URL })).toBe(TOPIC_URL);
		expect(isNtfyConfigured(cwd, { [NTFY_URL_ENV_VAR]: TOPIC_URL })).toBe(true);
	});

	test('the file is created with permission 600, and is read correctly at that permission', () => {
		const cwd = createTestTmpdir('gship-ntfy-file-');
		writeNtfyUrlFile(cwd, TOPIC_URL);

		expect(statSync(join(cwd, NTFY_URL_FILE_PATH)).mode & 0o777).toBe(0o600);
		expect(resolveNtfyUrl(cwd, {})).toBe(TOPIC_URL);
	});

	// GSHIP-652 review: Gateship never edits or chmods this file (editing the
	// secret from the screen is out of scope), so the 600 decision is only
	// real if the read path itself refuses a looser file rather than trusting
	// it anyway -- `readNtfyUrlFile`'s own `statSync` mode check, exercised
	// here, not just the test fixture's own `writeFileSync(..., { mode })`.
	test('a file readable or writable by group or other is refused, not trusted', () => {
		const cwd = createTestTmpdir('gship-ntfy-file-');
		mkdirSync(join(cwd, '.gship'), { recursive: true });
		writeFileSync(join(cwd, NTFY_URL_FILE_PATH), `${TOPIC_URL}\n`, { mode: 0o644 });

		expect(resolveNtfyUrl(cwd, {})).toBeNull();
		expect(isNtfyConfigured(cwd, {})).toBe(false);
	});

	test('the absence of both the environment variable and the file leaves the channel off without error', () => {
		const cwd = createTestTmpdir('gship-ntfy-file-');

		expect(() => resolveNtfyUrl(cwd, {})).not.toThrow();
		expect(resolveNtfyUrl(cwd, {})).toBeNull();
		expect(isNtfyConfigured(cwd, {})).toBe(false);

		const { fetchImpl, calls } = stubFetch();
		const notifier = createRemoteNotifier({ cwd, env: {}, fetchImpl });
		expect(() => notifier(event('waiting-user', 'run.waiting-user'))).not.toThrow();
		expect(calls).toHaveLength(0);
	});

	test('createRemoteNotifier reads the project file too, not only the environment variable', async () => {
		const cwd = createTestTmpdir('gship-ntfy-file-');
		writeNtfyUrlFile(cwd, TOPIC_URL);
		const { fetchImpl, calls } = stubFetch();
		const notifier = createRemoteNotifier({ cwd, env: {}, fetchImpl });

		notifier(event('waiting-user', 'run.waiting-user', { summary: 'Escolha o seam.' }));
		await flush();

		const call = onlyCall(calls);
		const url = new URL(call.url);
		expect(`${url.origin}${url.pathname}`).toBe(TOPIC_URL);
	});

	test('the configured check answers only a boolean, never the URL itself', () => {
		const cwd = createTestTmpdir('gship-ntfy-file-');
		writeNtfyUrlFile(cwd, TOPIC_URL);

		const configured = isNtfyConfigured(cwd, {});

		expect(configured).toBe(true);
		expect(typeof configured).toBe('boolean');
		expect(JSON.stringify(configured)).not.toContain(TOPIC_URL);
	});

	// GSHIP-652 review: a notifier built at service boot, before the file
	// existed, must still deliver once the operator follows the panel's own
	// instructions and creates it -- the whole point of moving the secret to a
	// project file was to stop it silently going dark; a subscriber that
	// baked the boot-time absence in forever would recreate exactly that.
	test('a notifier built before the file existed still delivers once the file is created, with no restart', async () => {
		const cwd = createTestTmpdir('gship-ntfy-file-');
		const { fetchImpl, calls } = stubFetch();
		const notifier = createRemoteNotifier({ cwd, env: {}, fetchImpl });

		notifier(event('waiting-user', 'run.waiting-user'));
		await flush();
		expect(calls).toHaveLength(0);

		writeNtfyUrlFile(cwd, TOPIC_URL);
		notifier(event('waiting-user', 'run.waiting-user', { summary: 'Escolha.' }));
		await flush();

		const call = onlyCall(calls);
		expect(new URL(call.url).searchParams.get('title')).toBe('Gateship needs you');
	});

	// GSHIP-652 review: one stored value must answer the same everywhere --
	// `isNtfyConfigured`, `createRemoteNotifier` and `sendNtfyTestNotification`
	// all resolve through the same parse-and-validate step, so a value that
	// fails to parse as a URL reads as off on all three, never "configurado"
	// on the boolean while the other two refuse it.
	test('a stored value that fails to parse as a URL reads as unconfigured everywhere, not just on delivery', async () => {
		const cwd = createTestTmpdir('gship-ntfy-file-');
		writeNtfyUrlFile(cwd, 'not a valid url');

		expect(isNtfyConfigured(cwd, {})).toBe(false);

		const { fetchImpl, calls } = stubFetch();
		const notifier = createRemoteNotifier({ cwd, env: {}, fetchImpl });
		notifier(event('waiting-user', 'run.waiting-user'));
		await flush();
		expect(calls).toHaveLength(0);

		const result = await sendNtfyTestNotification({ cwd, env: {}, fetchImpl });
		expect(result).toEqual({ outcome: 'not-configured' });
	});
});

describe('sendNtfyTestNotification', () => {
	test('reports not-configured without ever attempting a delivery', async () => {
		const cwd = createTestTmpdir('gship-ntfy-test-');
		const { fetchImpl, calls } = stubFetch();

		const result = await sendNtfyTestNotification({ cwd, env: {}, fetchImpl });

		expect(result).toEqual({ outcome: 'not-configured' });
		expect(calls).toHaveLength(0);
	});

	test('sends a real request to the configured topic and reports acceptance', async () => {
		const cwd = createTestTmpdir('gship-ntfy-test-');
		writeNtfyUrlFile(cwd, TOPIC_URL);
		const { fetchImpl, calls } = stubFetch();

		const result = await sendNtfyTestNotification({ cwd, env: {}, fetchImpl });

		expect(result).toEqual({ outcome: 'sent' });
		expect(onlyCall(calls).url).toContain(TOPIC_URL);
	});

	test('reports a rejection without leaking the topic URL in the result', async () => {
		const cwd = createTestTmpdir('gship-ntfy-test-');
		writeNtfyUrlFile(cwd, TOPIC_URL);
		const { fetchImpl } = stubFetch(() => Promise.resolve(new Response(null, { status: 403 })));

		const result = await sendNtfyTestNotification({ cwd, env: {}, fetchImpl });

		expect(result.outcome).toBe('rejected');
		expect(JSON.stringify(result)).not.toContain(TOPIC_URL);
	});

	test('reports unreachable, and never throws, when the delivery itself fails', async () => {
		const cwd = createTestTmpdir('gship-ntfy-test-');
		writeNtfyUrlFile(cwd, TOPIC_URL);
		const { fetchImpl } = stubFetch(() => Promise.reject(new Error(`network down: ${TOPIC_URL}`)));

		const result = await sendNtfyTestNotification({ cwd, env: {}, fetchImpl });

		expect(result.outcome).toBe('unreachable');
		expect(JSON.stringify(result)).not.toContain(TOPIC_URL);
	});
});

const RESEND_API_KEY = 'resend-secret-live-abcDEF123456';
const RESEND_FROM = 'Gateship <ops@example.com>';
const RESEND_TO = 'operator@example.com';

const RESEND_FIELD_ENV_VARS: Record<ResendConfigField, string> = {
	apiKey: RESEND_API_KEY_ENV_VAR,
	from: RESEND_FROM_ENV_VAR,
	to: RESEND_TO_ENV_VAR,
};

/** A complete Resend environment, with named fields deletable to build a partial one. */
function resendEnv(omit: readonly ResendConfigField[] = []): Record<string, string> {
	const env: Record<string, string> = {
		[RESEND_API_KEY_ENV_VAR]: RESEND_API_KEY,
		[RESEND_FROM_ENV_VAR]: RESEND_FROM,
		[RESEND_TO_ENV_VAR]: RESEND_TO,
	};
	for (const field of omit) delete env[RESEND_FIELD_ENV_VARS[field]];
	return env;
}

/** What an operator's own shell command (`... > .gship/resend-api-key && chmod 600 ...`) produces. */
function writeResendApiKeyFile(cwd: string, apiKey: string): void {
	mkdirSync(join(cwd, '.gship'), { recursive: true });
	writeFileSync(join(cwd, RESEND_API_KEY_FILE_PATH), `${apiKey}\n`, { mode: 0o600 });
}

describe('the Resend channel (GSHIP-653)', () => {
	test('a complete configuration sends, carrying the three values to the Resend HTTP API', async () => {
		const cwd = createTestTmpdir('gship-resend-');
		const { fetchImpl, calls } = stubFetch();
		const notifier = createRemoteNotifier({ cwd, env: resendEnv(), fetchImpl });

		notifier(event('waiting-user', 'run.waiting-user', { summary: 'Escolha o seam.' }));
		await flush();

		const call = onlyCall(calls);
		expect(call.url).toBe('https://api.resend.com/emails');
		expect(call.init?.method).toBe('POST');
		const headers = new Headers(call.init?.headers);
		expect(headers.get('authorization')).toBe(`Bearer ${RESEND_API_KEY}`);
		expect(headers.get('content-type')).toBe('application/json');
		expect(JSON.parse(String(call.init?.body))).toEqual({
			from: RESEND_FROM,
			to: [RESEND_TO],
			subject: 'Gateship needs you',
			text: 'Escolha o seam.',
		});
	});

	test('a partial configuration sends nothing and names exactly what is missing', async () => {
		const cwd = createTestTmpdir('gship-resend-');
		expect(isResendConfigured(cwd, resendEnv(['to']))).toBe(false);
		expect(resolveResendMissingFields(cwd, resendEnv(['to']))).toEqual(['to']);
		expect(resolveResendMissingFields(cwd, resendEnv(['apiKey', 'from']))).toEqual(['apiKey', 'from']);
		expect(resolveResendMissingFields(cwd, {})).toEqual(['apiKey', 'from', 'to']);

		const { fetchImpl, calls } = stubFetch();
		const notifier = createRemoteNotifier({ cwd, env: resendEnv(['to']), fetchImpl });
		notifier(event('waiting-user', 'run.waiting-user'));
		await flush();
		expect(calls).toHaveLength(0);

		const result = await sendResendTestNotification({ cwd, env: resendEnv(['to']), fetchImpl });
		expect(result).toEqual({ outcome: 'not-configured', detail: RESEND_FIELD_LABELS.to });
		expect(calls).toHaveLength(0);
	});

	test('a network failure is swallowed and never propagates', async () => {
		const cwd = createTestTmpdir('gship-resend-');
		const { fetchImpl, calls } = stubFetch(() => Promise.reject(new Error(`network down: ${RESEND_API_KEY}`)));
		const notifier = createRemoteNotifier({ cwd, env: resendEnv(), fetchImpl });

		expect(() => notifier(event('waiting-user', 'run.waiting-user', { summary: 'Escolha.' }))).not.toThrow();
		await flush();

		expect(calls).toHaveLength(1);
	});

	test('both channels configured at once send through both, neither depending on the other', async () => {
		const cwd = createTestTmpdir('gship-resend-');
		writeNtfyUrlFile(cwd, TOPIC_URL);
		const { fetchImpl, calls } = stubFetch();
		const notifier = createRemoteNotifier({ cwd, env: resendEnv(), fetchImpl });

		notifier(event('waiting-user', 'run.waiting-user', { summary: 'Escolha.' }));
		await flush();

		expect(calls).toHaveLength(2);
		expect(calls.some((call) => call.url.startsWith(TOPIC_URL))).toBe(true);
		expect(calls.some((call) => call.url === 'https://api.resend.com/emails')).toBe(true);
	});

	test('Resend alone -- with no ntfy topic URL anywhere -- still delivers on its own', async () => {
		const cwd = createTestTmpdir('gship-resend-');
		const { fetchImpl, calls } = stubFetch();
		const notifier = createRemoteNotifier({ cwd, env: resendEnv(), fetchImpl });

		notifier(event('waiting-user', 'run.waiting-user'));
		await flush();

		expect(onlyCall(calls).url).toBe('https://api.resend.com/emails');
	});

	describe('the API key never appears in any observable output', () => {
		afterEach(() => {
			for (const spy of installedSpies.splice(0)) spy.mockRestore();
		});
		const installedSpies: ReturnType<typeof spyOn>[] = [];

		test('a failed delivery throws nothing and logs nothing', async () => {
			const logSpy = spyOn(console, 'log');
			const warnSpy = spyOn(console, 'warn');
			const errorSpy = spyOn(console, 'error');
			installedSpies.push(logSpy, warnSpy, errorSpy);

			const cwd = createTestTmpdir('gship-resend-');
			const { fetchImpl } = stubFetch(() => Promise.reject(new Error(`network down: ${RESEND_API_KEY}`)));
			const notifier = createRemoteNotifier({ cwd, env: resendEnv(), fetchImpl });

			let thrown: unknown;
			try {
			notifier(event('waiting-user', 'run.waiting-user', { summary: 'Escolha.' }));
			} catch (error) {
				thrown = error;
			}
			await flush();

			expect(thrown).toBeUndefined();
			expect(logSpy).not.toHaveBeenCalled();
			expect(warnSpy).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();
		});

		test('the request itself carries the key in its header, but nothing returned or thrown does', async () => {
			const cwd = createTestTmpdir('gship-resend-');
			const { fetchImpl, calls } = stubFetch();
			const notifier = createRemoteNotifier({ cwd, env: resendEnv(), fetchImpl });

			const result = notifier(event('waiting-user', 'run.waiting-user'));
			await flush();

			const headers = new Headers(calls[0]?.init?.headers);
			expect(headers.get('authorization')).toContain(RESEND_API_KEY);
			expect(JSON.stringify(result ?? null)).not.toContain(RESEND_API_KEY);
		});

		test('sendResendTestNotification never leaks the key on a rejection or an unreachable network', async () => {
			const cwd = createTestTmpdir('gship-resend-');
			const rejected = await sendResendTestNotification({
				cwd,
				env: resendEnv(),
				fetchImpl: stubFetch(() => Promise.resolve(new Response(null, { status: 403 }))).fetchImpl,
			});
			expect(rejected.outcome).toBe('rejected');
			expect(JSON.stringify(rejected)).not.toContain(RESEND_API_KEY);

			const unreachable = await sendResendTestNotification({
				cwd,
				env: resendEnv(),
				fetchImpl: stubFetch(() => Promise.reject(new Error(`network down: ${RESEND_API_KEY}`))).fetchImpl,
			});
			expect(unreachable.outcome).toBe('unreachable');
			expect(JSON.stringify(unreachable)).not.toContain(RESEND_API_KEY);
		});
	});
});

describe('the project-local Resend API key file (GSHIP-653)', () => {
	test('reads the API key from the project file when no environment variable is set', () => {
		const cwd = createTestTmpdir('gship-resend-file-');
		writeResendApiKeyFile(cwd, RESEND_API_KEY);

		expect(resolveResendApiKey(cwd, {})).toBe(RESEND_API_KEY);
		expect(isResendConfigured(cwd, { [RESEND_FROM_ENV_VAR]: RESEND_FROM, [RESEND_TO_ENV_VAR]: RESEND_TO }))
			.toBe(true);
	});

	test('the environment variable takes precedence over the file, so an operator already using it is undisturbed', () => {
		const cwd = createTestTmpdir('gship-resend-file-');
		writeResendApiKeyFile(cwd, 'from-file-not-this-one');

		expect(resolveResendApiKey(cwd, { [RESEND_API_KEY_ENV_VAR]: RESEND_API_KEY })).toBe(RESEND_API_KEY);
	});

	test('the file is created with permission 600, and is read correctly at that permission', () => {
		const cwd = createTestTmpdir('gship-resend-file-');
		writeResendApiKeyFile(cwd, RESEND_API_KEY);

		expect(statSync(join(cwd, RESEND_API_KEY_FILE_PATH)).mode & 0o777).toBe(0o600);
		expect(resolveResendApiKey(cwd, {})).toBe(RESEND_API_KEY);
	});

	test('a file readable or writable by group or other is refused, not trusted', () => {
		const cwd = createTestTmpdir('gship-resend-file-');
		mkdirSync(join(cwd, '.gship'), { recursive: true });
		writeFileSync(join(cwd, RESEND_API_KEY_FILE_PATH), `${RESEND_API_KEY}\n`, { mode: 0o644 });

		expect(resolveResendApiKey(cwd, {})).toBeNull();
		expect(isResendConfigured(cwd, { [RESEND_FROM_ENV_VAR]: RESEND_FROM, [RESEND_TO_ENV_VAR]: RESEND_TO }))
			.toBe(false);
	});

	test('the absence of both the environment variable and the file leaves apiKey missing, without error', () => {
		const cwd = createTestTmpdir('gship-resend-file-');

		expect(() => resolveResendApiKey(cwd, {})).not.toThrow();
		expect(resolveResendApiKey(cwd, {})).toBeNull();
		expect(resolveResendMissingFields(cwd, { [RESEND_FROM_ENV_VAR]: RESEND_FROM, [RESEND_TO_ENV_VAR]: RESEND_TO }))
			.toEqual(['apiKey']);
	});
});

describe('browser-managed Resend files (GSHIP-688)', () => {
	test('keeps notification files in explicit state and never creates project .gship', async () => {
		const cwd = createTestTmpdir('gship-notification-project-');
		const stateDir = createTestTmpdir('gship-notification-state-');
		writeFileSync(join(stateDir, 'ntfy-url'), `${TOPIC_URL}\n`, { mode: 0o600 });
		writeResendApiKey(cwd, RESEND_API_KEY, stateDir);
		writeResendSettings(cwd, RESEND_FROM, RESEND_TO, stateDir);

		expect(isNtfyConfigured(cwd, {}, stateDir)).toBe(true);
		expect(resolveResendStatus(cwd, {}, stateDir).configured).toBe(true);
		expect(existsSync(join(cwd, '.gship'))).toBe(false);

		const { fetchImpl, calls } = stubFetch();
		createRemoteNotifier({ cwd, stateDir, env: {}, fetchImpl })(
			event('waiting-user', 'run.waiting-user'),
		);
		await waitFor(() => calls.length === 2);
	});

	test('writes and atomically replaces the key at mode 0600 without returning it', () => {
		const cwd = createTestTmpdir('gship-resend-write-');
		writeResendApiKeyFile(cwd, 'old-valid-key');

		expect(writeResendApiKey(cwd, RESEND_API_KEY)).toBeUndefined();
		expect(statSync(join(cwd, RESEND_API_KEY_FILE_PATH)).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(cwd, RESEND_API_KEY_FILE_PATH), 'utf8')).toBe(`${RESEND_API_KEY}\n`);
		expect(() => writeResendApiKey(cwd, '   ')).toThrow();
		expect(resolveResendApiKey(cwd, {})).toBe(RESEND_API_KEY);
	});

	test('persists only bounded non-secret values and resolves every field fresh with independent env precedence', () => {
		const cwd = createTestTmpdir('gship-resend-settings-');
		writeResendApiKey(cwd, RESEND_API_KEY);
		writeResendSettings(cwd, RESEND_FROM, RESEND_TO);

		expect(JSON.parse(readFileSync(join(cwd, RESEND_SETTINGS_FILE_PATH), 'utf8'))).toEqual({
			from: RESEND_FROM,
			to: RESEND_TO,
		});
		expect(readFileSync(join(cwd, RESEND_SETTINGS_FILE_PATH), 'utf8')).not.toContain(RESEND_API_KEY);
		expect(resolveResendStatus(cwd, {})).toMatchObject({
			configured: true,
			from: RESEND_FROM,
			to: RESEND_TO,
			fileCredentialExists: true,
			externallyManaged: { apiKey: false, from: false, to: false },
		});

		writeResendSettings(cwd, 'New file sender <new@example.com>', 'new@example.com');
		const status = resolveResendStatus(cwd, {
			[RESEND_FROM_ENV_VAR]: 'Environment <env@example.com>',
		});
		expect(status.from).toBe('Environment <env@example.com>');
		expect(status.to).toBe('new@example.com');
		expect(status.externallyManaged).toEqual({ apiKey: false, from: true, to: false });
	});

	test('accepts display-name senders without applying a brittle email regex', () => {
		const cwd = createTestTmpdir('gship-resend-settings-');
		expect(() => writeResendSettings(cwd, 'Operations via verified domain', 'transaction recipient')).not.toThrow();
		expect(resolveResendStatus(cwd, {}).from).toBe('Operations via verified domain');
	});
});
