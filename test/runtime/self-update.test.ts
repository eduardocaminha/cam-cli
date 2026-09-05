import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveWebInvocation } from '../../index.ts';
import {
	detectNativeInstallation,
	executeSelfUpdateHandoff,
	type AvailableRelease,
	type HandoffDependencies,
	type HandoffPlan,
	type ReleaseClient,
	SELF_UPDATE_INTERVAL_MS,
	SELF_UPDATE_SETTING_KEY,
	SelfUpdateRuntime,
} from '../../src/runtime/self-update.ts';
import { RunRuntime } from '../../src/runtime/run-runtime.ts';
import { RunStore } from '../../src/runtime/run-store.ts';
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
	stateDir?: string;
	serverArgs?: string[];
	handoffEnv?: Record<string, string | undefined>;
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
	const spawnedHelperEnvs: Array<Record<string, string | undefined>> = [];
	const runtime = new SelfUpdateRuntime({
		store,
		databasePath: join(cwd, 'runtime.sqlite'),
		cwd,
		stateDir: options.stateDir,
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
		spawnHelper: (_executable, plan, handoffEnv) => { plans.push(plan); spawnedHelperEnvs.push(handoffEnv); },
		serverArgs: options.serverArgs ?? ['--port', '7777'],
		handoffEnv: options.handoffEnv,
	});
	if (options.enabled) runtime.setEnabled(true);
	return { runtime, store, downloads, plans, spawnedHelperEnvs };
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

	test('projects only stored releases newer than the current binary', async () => {
		for (const [version, expected] of [
			['0.9.0', null],
			['1.0.0', null],
			['1.1.0', '1.1.0'],
		] as const) {
			const release = { ...RELEASE, version, tag: `v${version}` };
			const { runtime, store } = fixture({
				client: {
					resolveLatest: async () => release,
					download: async () => new Uint8Array(),
				},
			});

			await runtime.checkIfDue();

			expect(runtime.snapshot().available?.version ?? null).toBe(expected);
			const stored = JSON.parse(store.getRuntimeSetting(SELF_UPDATE_SETTING_KEY) ?? '{}') as {
				available?: AvailableRelease;
			};
			expect(stored.available?.version).toBe(version);
		}
	});

	test('changing policy cannot resurrect a stale stored release', async () => {
		const staleRelease = { ...RELEASE, version: '1.0.0', tag: 'v1.0.0' };
		const { runtime } = fixture({
			client: {
				resolveLatest: async () => staleRelease,
				download: async () => new Uint8Array(),
			},
		});
		await runtime.checkIfDue();

		const snapshot = runtime.setEnabled(true);

		expect(snapshot.enabled).toBe(true);
		expect(snapshot.available).toBeNull();
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

	// GSHIP-704: a dedicated Claude credential provisioned at boot must survive
	// the handoff to a native update -- forwarded to the helper explicitly,
	// never written into the handoff plan file this test also inspects.
	test('forwards a boot-captured credential snapshot to the spawned helper, never into the handoff plan', async () => {
		const { runtime, plans, spawnedHelperEnvs } = fixture({
			enabled: true,
			handoffEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-handoff' },
		});
		await runtime.checkIfDue();
		expect(spawnedHelperEnvs).toEqual([{ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-handoff' }]);
		const written = JSON.parse(await Bun.file(plans[0]!).text()) as Record<string, unknown>;
		expect(JSON.stringify(written)).not.toContain('sk-ant-oat01-handoff');
		expect(written).not.toHaveProperty('handoffEnv');
	});

	test('forwards an empty snapshot when no dedicated credential was ever provisioned', async () => {
		const { runtime, spawnedHelperEnvs } = fixture({ enabled: true });
		await runtime.checkIfDue();
		expect(spawnedHelperEnvs).toEqual([{}]);
	});

	test('writes handoff state only beneath an explicit project state directory', async () => {
		const stateDir = createTestTmpdir('gship-self-update-state-');
		const { runtime, plans } = fixture({ enabled: true, stateDir });

		await runtime.checkIfDue();

		expect(plans).toHaveLength(1);
		expect(plans[0]?.startsWith(join(stateDir, 'self-update'))).toBe(true);
		const written = JSON.parse(await Bun.file(plans[0]!).text()) as HandoffPlan;
		expect(written.stateDir).toBe(stateDir);
		expect(existsSync(join(stateDir, 'self-update'))).toBe(true);
	});

	test('keeps wrapper-launched web arguments canonical across two update plans', async () => {
		const stateDir = createTestTmpdir('gship-self-update-state-');
		const webArgs = ['--port', '7777'];
		const firstInvocation = resolveWebInvocation([
			'node', 'gship', '__self-update-serve', stateDir, ...webArgs,
		]);
		expect(firstInvocation).toEqual({ kind: 'web', stateDir, serverArgs: webArgs });
		if (firstInvocation.kind !== 'web') throw new Error('wrapper invocation did not resolve to web');

		const first = fixture({ enabled: true, stateDir, serverArgs: firstInvocation.serverArgs });
		await first.runtime.checkIfDue();
		const firstPlan = JSON.parse(await Bun.file(first.plans[0]!).text()) as HandoffPlan;

		const secondInvocation = resolveWebInvocation([
			'node', 'gship', '__self-update-serve', stateDir, ...firstPlan.serverArgs,
		]);
		if (secondInvocation.kind !== 'web') throw new Error('second wrapper invocation did not resolve to web');
		const second = fixture({ enabled: true, stateDir, serverArgs: secondInvocation.serverArgs });
		await second.runtime.checkIfDue();
		const secondPlan = JSON.parse(await Bun.file(second.plans[0]!).text()) as HandoffPlan;

		expect(firstPlan.serverArgs).toEqual(webArgs);
		expect(secondPlan.serverArgs).toEqual(webArgs);
		expect(secondPlan.serverArgs).not.toContain('__self-update-serve');
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
		serverArgs: ['--port', '7777'],
		cwd: '/project',
		stateDir: '/state/project',
		healthUrl: 'http://127.0.0.1:7777/api/snapshot',
		databasePath: '/state/project/runtime.sqlite',
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
	starts: Array<{ executable: string; args: string[]; cwd: string; env: Record<string, string | undefined> }>;
	stops: number[];
	results: string[];
} {
	const swaps: string[] = [];
	const starts: Array<{ executable: string; args: string[]; cwd: string; env: Record<string, string | undefined> }> = [];
	const stops: number[] = [];
	const results: string[] = [];
	return {
		swaps,
		starts,
		stops,
		results,
		deps: {
			waitForExit: async () => true,
			swap: (from, to) => { swaps.push(`${from}->${to}`); },
			start: (executable, args, cwd, env) => {
				const pid = starts.length + 1;
				starts.push({ executable, args, cwd, env });
				return { pid, stop: () => stops.push(pid), unref: () => {} };
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
		expect(fixture.starts).toEqual([{
			executable: '/bin/gship',
			args: ['__self-update-serve', '/state/project', '--port', '7777'],
			cwd: '/project',
			env: {},
		}]);
	});

	// GSHIP-704: the helper -> successor server leg of the handoff. The
	// helper (this function, as the CLI's own `__self-update-handoff` runs
	// it) received `handoffEnv` from its own boot environment, never from the
	// plan; it must transmit that same snapshot, unmodified, to the successor
	// server it starts, so the successor's own boot can capture and clear it
	// exactly the way the very first server process already does.
	test('transmits the handoff credential snapshot to the successor server it starts', async () => {
		const fixture = handoffFixture([true]);
		const handoffEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-successor' };
		const result = await executeSelfUpdateHandoff(plan(), fixture.deps, handoffEnv);
		expect(result.status).toBe('success');
		expect(fixture.starts).toEqual([{
			executable: '/bin/gship',
			args: ['__self-update-serve', '/state/project', '--port', '7777'],
			cwd: '/project',
			env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-successor' },
		}]);
		// Never in the disk-persisted handoff plan itself.
		expect(JSON.stringify(plan())).not.toContain('sk-ant-oat01-successor');
	});

	test('also transmits the handoff credential snapshot to a restored previous binary on rollback', async () => {
		const fixture = handoffFixture([false, true]);
		const handoffEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-rollback' };
		const result = await executeSelfUpdateHandoff(plan(), fixture.deps, handoffEnv);
		expect(result.status).toBe('rollback');
		expect(fixture.starts.map((start) => start.env)).toEqual([
			{ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-rollback' },
			{ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-rollback' },
		]);
	});

	test('derives candidate state from the database path for a legacy plan', async () => {
		const legacyPlan = plan();
		delete legacyPlan.stateDir;
		legacyPlan.databasePath = '/legacy/project/.gship/runtime.sqlite';
		const fixture = handoffFixture([true]);

		const result = await executeSelfUpdateHandoff(legacyPlan, fixture.deps);

		expect(result.status).toBe('success');
		expect(fixture.starts[0]?.args).toEqual([
			'__self-update-serve',
			'/legacy/project/.gship',
			'--port',
			'7777',
		]);
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

	test('persists a verified update outcome without a remote notification', async () => {
		const fixture = handoffFixture([true]);
		fixture.deps.persist = async (_plan, result) => {
			fixture.results.push(result.status);
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
		expect(fixture.starts.map((start) => start.args)).toEqual([
			['__self-update-serve', '/state/project', '--port', '7777'],
			['__self-update-serve', '/state/project', '--port', '7777'],
		]);
	});

	test('restores a legacy binary with only its original server arguments', async () => {
		const legacyPlan = plan();
		delete legacyPlan.stateDir;
		legacyPlan.databasePath = '/legacy/project/.gship/runtime.sqlite';
		const fixture = handoffFixture([false, true]);

		const result = await executeSelfUpdateHandoff(legacyPlan, fixture.deps);

		expect(result.status).toBe('rollback');
		expect(fixture.starts.map((start) => start.args)).toEqual([
			['__self-update-serve', '/legacy/project/.gship', '--port', '7777'],
			['--port', '7777'],
		]);
	});

	test('records an explicit failure when rollback identity cannot be verified', async () => {
		const fixture = handoffFixture([false, false]);
		const result = await executeSelfUpdateHandoff(plan(), fixture.deps);
		expect(result.status).toBe('failed');
		expect(result.reason).toContain('Rollback failed');
		expect(fixture.results).toEqual(['failed']);
	});
});
