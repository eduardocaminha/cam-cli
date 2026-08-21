import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	detectNativeInstallation,
	executeSelfUpdateHandoff,
	type AvailableRelease,
	type HandoffDependencies,
	type HandoffPlan,
	type ReleaseClient,
	SELF_UPDATE_INTERVAL_MS,
	SelfUpdateRuntime,
} from '../../src/runtime/self-update.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
import {
	NTFY_URL_ENV_VAR,
	sendRemoteServiceNotification,
} from '../../src/runtime/remote-notifier.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const COMMIT = 'a'.repeat(40);
const RELEASE: AvailableRelease = {
	version: '2.0.0',
	tag: 'v2.0.0',
	commit: COMMIT,
	asset: 'gateship-darwin-arm64',
	assetUrl: 'https://release.test/binary',
	checksumsUrl: 'https://release.test/SHA256SUMS.txt',
};

function checksum(bytes: Uint8Array): string {
	const hash = new Bun.CryptoHasher('sha256');
	hash.update(bytes);
	return hash.digest('hex');
}

function fixture(options: {
	enabled?: boolean;
	idle?: () => boolean;
	now?: () => Date;
	probeVersion?: () => string;
	client?: ReleaseClient;
	acquireAdmission?: () => (() => void) | null;
} = {}) {
	const cwd = createTestTmpdir('gship-self-update-');
	const bin = join(cwd, 'bin');
	mkdirSync(bin);
	const publicPaths = [join(bin, 'gateship'), join(bin, 'gship')];
	for (const path of publicPaths) {
		writeFileSync(path, 'old', { mode: 0o700 });
		chmodSync(path, 0o700);
	}
	const bytes = new TextEncoder().encode('candidate');
	const downloads: string[] = [];
	const client = options.client ?? {
		resolveLatest: async () => RELEASE,
		download: async (url: string) => {
			downloads.push(url);
			return url === RELEASE.assetUrl
				? bytes
				: new TextEncoder().encode(`${checksum(bytes)}  ${RELEASE.asset}\n`);
		},
	};
	const store = new RunStore(':memory:');
	const plans: string[] = [];
	const runtime = new SelfUpdateRuntime({
		store,
		databasePath: join(cwd, 'runtime.sqlite'),
		cwd,
		currentVersion: '1.0.0',
		currentCommit: 'b'.repeat(40),
		port: 7777,
		hostname: '127.0.0.1',
		isContainer: false,
		isIdle: options.idle ?? (() => true),
		acquireAdmission: options.acquireAdmission ?? (() => () => {}),
		now: options.now,
		releaseClient: client,
		installation: { kind: 'native', executable: publicPaths[1]!, directory: bin, publicPaths },
		probeVersion: options.probeVersion ?? (() => 'gateship 2.0.0'),
		spawnHelper: (_executable, plan) => { plans.push(plan); },
		serverArgs: ['--port', '7777'],
	});
	if (options.enabled) runtime.setEnabled(true);
	return { runtime, store, downloads, plans };
}

describe('native self update policy', () => {
	test('the handoff admission fence refuses a preserved run resume without launching work', () => {
		const store = new RunStore(':memory:');
		store.createRun({
			id: 'run-preserved',
			issueId: 'GSHIP-100',
			sessionId: 'session-preserved',
			workspacePath: '/worktrees/run-preserved',
			createdAt: '2026-08-21T00:00:00.000Z',
		});
		store.transition({
			runId: 'run-preserved',
			toState: 'working',
			kind: 'run.started',
			createdAt: '2026-08-21T00:00:01.000Z',
		});
		store.transition({
			runId: 'run-preserved',
			toState: 'interrupted',
			kind: 'run.interrupted',
			createdAt: '2026-08-21T00:00:02.000Z',
		});
		let executions = 0;
		const runtime = new RunRuntime({
			cwd: '/project',
			store,
			executor: {
				execute: async () => {
					executions += 1;
					return { outcome: 'completed' };
				},
			},
			verifier: { verify: async () => ({ ok: true }) },
		});
		const reason = 'Gateship is handing off a native update.';
		runtime.setAdmissionBlocked(reason);

		expect(() => runtime.resumeRun('run-preserved')).toThrow(reason);
		expect(executions).toBe(0);
		expect(runtime.getRun('run-preserved')?.state).toBe('interrupted');
		expect(runtime.listEvents()).toHaveLength(3);
		runtime.close();
	});

	test('is off by default and detects without downloading or applying', async () => {
		const { runtime, downloads, plans } = fixture();
		await runtime.checkIfDue();
		expect(runtime.snapshot().enabled).toBe(false);
		expect(runtime.snapshot().available?.version).toBe('2.0.0');
		expect(downloads).toEqual([]);
		expect(plans).toEqual([]);
	});

	test('checks at most daily', async () => {
		let now = new Date('2026-08-21T00:00:00.000Z');
		let checks = 0;
		const { runtime } = fixture({
			now: () => now,
			client: {
				resolveLatest: async () => { checks += 1; return RELEASE; },
				download: async () => new Uint8Array(),
			},
		});
		await runtime.checkIfDue();
		now = new Date(now.getTime() + SELF_UPDATE_INTERVAL_MS - 1);
		await runtime.checkIfDue();
		expect(checks).toBe(1);
		now = new Date(now.getTime() + 1);
		await runtime.checkIfDue();
		expect(checks).toBe(2);
	});

	test('does not download while a run or diagnostic is active', async () => {
		const { runtime, downloads } = fixture({ enabled: true, idle: () => false });
		await runtime.checkIfDue();
		expect(downloads).toEqual([]);
		expect(runtime.snapshot().result?.status).toBe('deferred');
	});

	test('rejects a checksum mismatch before probing or touching admission', async () => {
		let probed = false;
		let admitted = false;
		const { runtime } = fixture({
			enabled: true,
			client: {
				resolveLatest: async () => RELEASE,
				download: async (url) => url === RELEASE.assetUrl
					? new TextEncoder().encode('candidate')
					: new TextEncoder().encode(`${'0'.repeat(64)}  ${RELEASE.asset}\n`),
			},
			probeVersion: () => { probed = true; return 'gateship 2.0.0'; },
			acquireAdmission: () => { admitted = true; return () => {}; },
		});
		await runtime.checkIfDue();
		expect(probed).toBe(false);
		expect(admitted).toBe(false);
		expect(runtime.snapshot().result?.reason).toContain('checksum mismatch');
	});

	test('rejects a candidate whose binary identity differs from the tag', async () => {
		const { runtime, plans } = fixture({
			enabled: true,
			probeVersion: () => 'gateship 9.9.9',
		});
		await runtime.checkIfDue();
		expect(plans).toEqual([]);
		expect(runtime.snapshot().result?.reason).toContain('candidate identity mismatch');
	});

	test('closes admission, revalidates idle, and prepares same-directory handoff files', async () => {
		let idleReads = 0;
		let released = false;
		const { runtime, plans } = fixture({
			enabled: true,
			idle: () => { idleReads += 1; return true; },
			acquireAdmission: () => () => { released = true; },
		});
		await runtime.checkIfDue();
		expect(idleReads).toBe(2);
		expect(plans).toHaveLength(1);
		expect(released).toBe(false);
		expect(runtime.snapshot().applying).toBe(true);
	});

	test('reopens admission without a handoff when work races the download', async () => {
		let idleReads = 0;
		let released = false;
		const { runtime, plans } = fixture({
			enabled: true,
			idle: () => { idleReads += 1; return idleReads === 1; },
			acquireAdmission: () => () => { released = true; },
		});
		await runtime.checkIfDue();
		expect(released).toBe(true);
		expect(plans).toEqual([]);
		expect(runtime.snapshot().result?.reason).toContain('became busy');
	});

	test('container and checkout installations never apply automatically', () => {
		expect(detectNativeInstallation('/usr/bin/bun', false).kind).toBe('development');
		expect(detectNativeInstallation('/usr/local/bin/gship', true).kind).toBe('container');
	});
});

function plan(): HandoffPlan {
	return {
		oldPid: 123,
		currentExecutable: '/bin/gship',
		candidatePaths: ['/bin/.gateship.candidate', '/bin/.gship.candidate'],
		publicPaths: ['/bin/gateship', '/bin/gship'],
		backupPaths: ['/bin/.gateship.backup', '/bin/.gship.backup'],
		serverArgs: [],
		cwd: '/project',
		healthUrl: 'http://127.0.0.1:7777/api/snapshot',
		databasePath: '/project/.gship/runtime.sqlite',
		previousVersion: '1.0.0',
		targetVersion: '2.0.0',
		targetCommit: COMMIT,
		previousCommit: 'b'.repeat(40),
		timeoutMs: 100,
	};
}

function handoffFixture(probes: boolean[]): {
	deps: HandoffDependencies;
	swaps: string[];
	stops: number[];
	results: string[];
} {
	const swaps: string[] = [];
	const stops: number[] = [];
	const results: string[] = [];
	let starts = 0;
	return {
		swaps,
		stops,
		results,
		deps: {
			waitForExit: async () => true,
			swap: (from, to) => { swaps.push(`${from}->${to}`); },
			start: () => {
				starts += 1;
				return { pid: starts, stop: () => stops.push(starts), unref: () => {} };
			},
			probe: async () => probes.shift() ?? false,
			persist: async (_plan, result) => { results.push(result.status); },
			cleanup: () => {},
		},
	};
}

describe('transient update handoff', () => {
	test('swaps both names and records success only after exact health identity', async () => {
		const fixture = handoffFixture([true]);
		const result = await executeSelfUpdateHandoff(plan(), fixture.deps);
		expect(result.status).toBe('success');
		expect(fixture.swaps).toHaveLength(4);
		expect(fixture.results).toEqual(['success']);
	});

	test('does not let the helper finish before final delivery settles', async () => {
		const fixture = handoffFixture([true]);
		let finishDelivery = (): void => {};
		const delivery = new Promise<void>((resolve) => { finishDelivery = resolve; });
		let deliveryStarted = (): void => {};
		const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
		fixture.deps.persist = async (_plan, result) => {
			fixture.results.push(result.status);
			deliveryStarted();
			await delivery;
		};
		let settled = false;
		const handoff = executeSelfUpdateHandoff(plan(), fixture.deps).then((result) => {
			settled = true;
			return result;
		});

		await started;
		expect(settled).toBe(false);
		finishDelivery();
		expect((await handoff).status).toBe('success');
		expect(fixture.results).toEqual(['success']);
	});

	test('an unavailable final channel does not change a verified update outcome', async () => {
		const fixture = handoffFixture([true]);
		fixture.deps.persist = async (_plan, result) => {
			fixture.results.push(result.status);
			await sendRemoteServiceNotification('/project', 'Gateship updated', result.reason, {
				env: { [NTFY_URL_ENV_VAR]: 'https://ntfy.test/topic' },
				fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
			});
		};

		const result = await executeSelfUpdateHandoff(plan(), fixture.deps);
		expect(result.status).toBe('success');
		expect(fixture.results).toEqual(['success']);
	});

	test('stops a bad candidate, restores both names, and verifies rollback', async () => {
		const fixture = handoffFixture([false, true]);
		const result = await executeSelfUpdateHandoff(plan(), fixture.deps);
		expect(result.status).toBe('rollback');
		expect(fixture.stops).toHaveLength(1);
		expect(fixture.swaps).toHaveLength(6);
		expect(fixture.results).toEqual(['rollback']);
	});

	test('records an explicit failure when rollback identity cannot be verified', async () => {
		const fixture = handoffFixture([false, false]);
		const result = await executeSelfUpdateHandoff(plan(), fixture.deps);
		expect(result.status).toBe('failed');
		expect(result.reason).toContain('Rollback failed');
		expect(fixture.results).toEqual(['failed']);
	});
});
