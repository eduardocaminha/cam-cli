// test/supervisor/plan/plan-runner-container.test.ts
//
// Unit tests for the container preflight seam in plan-runner.ts (US-006, CAM-152).
//
// Acceptance criteria proved:
//   AC1: preflightContainerFn called before BOTH the planner AND the auditor spawn.
//   AC2: worker_isolation=container + preflight ready -> shellCmd wrapped via dockerExecWrap
//        for both the planner and the auditor respawn-pane calls.
//   AC3: worker_isolation=container + preflight not-ready -> returns kind='container-preflight-failed'
//        immediately; no respawn-pane is issued; escalateFn called fire-and-forget.
//   AC4: argv-shape: respawn-pane last arg starts with 'docker exec -it cam-worker'
//        and contains 'env -u CLAUDECODE' and '--session-id' in lowercase.
//   AC5: host mode (default workerIsolation) -> respawn-pane arg NOT wrapped; existing
//        behavior identical to host-only tests.
//   AC6: auditor-phase preflight failure returns phase='auditor', planner WAS spawned.
//   AC7: escalateFn absent in container-preflight-failed path does not throw.

import { describe, expect, test } from 'bun:test';
import {
	runPlanPhase,
	type RunPlanPhaseOptions,
	type PlanMutexState,
} from '../../../src/supervisor/plan-runner.ts';
import type { SpawnFn } from '../../../src/supervisor/loop.ts';
import type { IssueEntry } from '../../../src/issues/types.ts';
import type { PreflightResult } from '../../../src/supervisor/preflight-container.ts';
import { waitForCondition } from '../../helpers/wait-for-condition.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-42',
	title: 'Container test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-03T00:00:00Z',
	updatedAt: '2026-07-03T00:00:00Z',
};

/** Fake uuid that is UPPERCASE to verify lowercase enforcement (CAM-23). */
const FAKE_UUID = 'AABBCCDD-EEFF-1122-3344-556677889900';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ContainerOpts {
	workerIsolation?: RunPlanPhaseOptions['workerIsolation'];
	preflightContainerFn?: RunPlanPhaseOptions['preflightContainerFn'];
	escalateFn?: RunPlanPhaseOptions['escalateFn'];
}

/**
 * Build opts where:
 * - preflight (plan-preflight) is always ok.
 * - selectIssueFn returns MOCK_ISSUE.
 * - mutex available.
 * - pane dies immediately (poll exits fast on both planner and auditor).
 * - auditor verdict report returns APPROVE (reaches audit-approved on happy path).
 * Container isolation props forwarded from the `container` param.
 */
function makeOpts(
	container: ContainerOpts = {},
	spawnCalls: string[][] = [],
): RunPlanPhaseOptions {
	const spawnFn: SpawnFn = (_cmd, args) => {
		spawnCalls.push([...args]);
		return { stdout: '', exitCode: 0 };
	};

	return {
		spawnFn,
		isPaneAlive: () => false, // pane dies immediately; both poll loops exit fast
		sleepFn: () => {},
		genUuid: () => FAKE_UUID,
		selectIssueFn: () => MOCK_ISSUE,
		readPlanVerdictFn: () => ({ verdict: 'APPROVE', summary: 'ok', findings: [] }),
		preflightFn: () => ({ ok: true }),
		clock: (() => { let t = 0; return () => (t += 100); })(),
		plannerPaneId: '%3',
		paneCountMutexFn: () => 'available' as PlanMutexState,
		pollIntervalMs: 1,
		plannerTimeoutMs: 999_999,
		auditorTimeoutMs: 999_999,
		// Container isolation props (may be absent = host default).
		workerIsolation: container.workerIsolation,
		preflightContainerFn: container.preflightContainerFn,
		escalateFn: container.escalateFn,
	};
}

/** Extract all respawn-pane args arrays from recorded spawn calls. */
function respawnCalls(calls: string[][]): string[][] {
	return calls.filter((a) => a[2] === 'respawn-pane');
}

// ---------------------------------------------------------------------------
// AC1: preflightContainerFn called before both spawns
// ---------------------------------------------------------------------------

describe('plan-runner container: AC1 - preflight called before each spawn', () => {
	test('preflightContainerFn is called at least twice (planner + auditor) on happy path', () => {
		let callCount = 0;
		const preflightContainerFn = (): PreflightResult => {
			callCount++;
			return { ready: true };
		};

		const opts = makeOpts({ workerIsolation: 'container', preflightContainerFn });
		runPlanPhase(opts);

		// Once before planner, once before auditor.
		expect(callCount).toBeGreaterThanOrEqual(2);
	});

	test('preflightContainerFn called before planner (first call precedes planner respawn-pane)', () => {
		let callCount = 0;
		let plannerRespawnIndex = -1;
		let firstPreflightIndex = -1;
		let callIndex = 0;

		const spawnCalls: string[][] = [];
		const spawnFn: SpawnFn = (_cmd, args) => {
			spawnCalls.push([...args]);
			// Track when the planner respawn happens.
			if (args[2] === 'respawn-pane' && plannerRespawnIndex === -1) {
				plannerRespawnIndex = callIndex;
			}
			callIndex++;
			return { stdout: '', exitCode: 0 };
		};

		const preflightContainerFn = (): PreflightResult => {
			if (firstPreflightIndex === -1) firstPreflightIndex = callIndex;
			callCount++;
			return { ready: true };
		};

		const opts: RunPlanPhaseOptions = {
			...makeOpts({ workerIsolation: 'container', preflightContainerFn }, spawnCalls),
			spawnFn,
		};
		runPlanPhase(opts);

		expect(callCount).toBeGreaterThanOrEqual(1);
		// The first preflight call must precede the first respawn-pane.
		expect(firstPreflightIndex).toBeLessThan(plannerRespawnIndex);
	});
});

// ---------------------------------------------------------------------------
// AC2: dockerExecWrap applied in container mode
// ---------------------------------------------------------------------------

describe('plan-runner container: AC2 - dockerExecWrap applied to both spawns', () => {
	test('container mode + preflight ready -> planner respawn-pane cmd starts with docker exec', () => {
		const spawnCalls: string[][] = [];
		const opts = makeOpts(
			{ workerIsolation: 'container', preflightContainerFn: () => ({ ready: true }) },
			spawnCalls,
		);

		runPlanPhase(opts);

		const plannerRespawn = respawnCalls(spawnCalls)[0];
		// Last arg of respawn-pane is the shell command.
		const cmd = plannerRespawn?.[plannerRespawn.length - 1] ?? '';
		expect(cmd).toMatch(/^docker exec -it cam-worker /);
	});

	test('container mode + preflight ready -> auditor respawn-pane cmd starts with docker exec', () => {
		const spawnCalls: string[][] = [];
		const opts = makeOpts(
			{ workerIsolation: 'container', preflightContainerFn: () => ({ ready: true }) },
			spawnCalls,
		);

		runPlanPhase(opts);

		const respawns = respawnCalls(spawnCalls);
		expect(respawns.length).toBe(2); // planner + auditor
		const auditorRespawn = respawns[1];
		const cmd = auditorRespawn?.[auditorRespawn.length - 1] ?? '';
		expect(cmd).toMatch(/^docker exec -it cam-worker /);
	});
});

// ---------------------------------------------------------------------------
// AC3: fail-closed when preflight not-ready (planner phase)
// ---------------------------------------------------------------------------

describe('plan-runner container: AC3 - fail-closed on planner preflight failure', () => {
	test('returns kind=container-preflight-failed when planner preflight not-ready', () => {
		const opts = makeOpts({
			workerIsolation: 'container',
			preflightContainerFn: () => ({ ready: false, reason: 'daemon-unreachable' }),
		});

		const result = runPlanPhase(opts);

		expect(result.kind).toBe('container-preflight-failed');
	});

	test('phase=planner when planner preflight fails', () => {
		const opts = makeOpts({
			workerIsolation: 'container',
			preflightContainerFn: () => ({ ready: false, reason: 'daemon-unreachable' }),
		});

		const result = runPlanPhase(opts);

		expect(result.kind).toBe('container-preflight-failed');
		if (result.kind === 'container-preflight-failed') {
			expect(result.phase).toBe('planner');
		}
	});

	test('reason propagated from PreflightResult', () => {
		const opts = makeOpts({
			workerIsolation: 'container',
			preflightContainerFn: () => ({ ready: false, reason: 'image-missing' }),
		});

		const result = runPlanPhase(opts);

		expect(result.kind).toBe('container-preflight-failed');
		if (result.kind === 'container-preflight-failed') {
			expect(result.reason).toBe('image-missing');
		}
	});

	test('no respawn-pane call when planner preflight fails (never dispatched on host)', () => {
		const spawnCalls: string[][] = [];
		const opts = makeOpts(
			{
				workerIsolation: 'container',
				preflightContainerFn: () => ({ ready: false, reason: 'daemon-unreachable' }),
			},
			spawnCalls,
		);

		runPlanPhase(opts);

		expect(respawnCalls(spawnCalls).length).toBe(0);
	});

	test('escalateFn called fire-and-forget when planner preflight fails', async () => {
		let escalateCalled = 0;
		const opts = makeOpts({
			workerIsolation: 'container',
			preflightContainerFn: () => ({ ready: false, reason: 'daemon-unreachable' }),
			escalateFn: async () => { escalateCalled++; },
		});

		runPlanPhase(opts);
		// Allow the fire-and-forget promise to settle.
		await waitForCondition(() => escalateCalled > 0);

		expect(escalateCalled).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC6: fail-closed on auditor preflight failure
// ---------------------------------------------------------------------------

describe('plan-runner container: AC6 - fail-closed on auditor preflight failure', () => {
	test('returns kind=container-preflight-failed with phase=auditor when auditor preflight fails', () => {
		let callCount = 0;
		// First call (planner) -> ready; second call (auditor) -> not-ready.
		const preflightContainerFn = (): PreflightResult => {
			callCount++;
			return callCount === 1
				? { ready: true }
				: { ready: false, reason: 'image-stale' };
		};

		const opts = makeOpts({ workerIsolation: 'container', preflightContainerFn });
		const result = runPlanPhase(opts);

		expect(result.kind).toBe('container-preflight-failed');
		if (result.kind === 'container-preflight-failed') {
			expect(result.phase).toBe('auditor');
			expect(result.reason).toBe('image-stale');
		}
	});

	test('planner WAS spawned when only auditor preflight fails', () => {
		let callCount = 0;
		const preflightContainerFn = (): PreflightResult => {
			callCount++;
			return callCount === 1
				? { ready: true }
				: { ready: false, reason: 'daemon-unreachable' };
		};
		const spawnCalls: string[][] = [];
		const opts = makeOpts(
			{ workerIsolation: 'container', preflightContainerFn },
			spawnCalls,
		);

		runPlanPhase(opts);

		// Exactly ONE respawn-pane (planner) was issued before the auditor preflight blocked.
		expect(respawnCalls(spawnCalls).length).toBe(1);
	});

	test('auditor escalateFn called fire-and-forget', async () => {
		let escalateCalled = 0;
		let callCount = 0;
		const opts = makeOpts({
			workerIsolation: 'container',
			preflightContainerFn: () => {
				callCount++;
				return callCount === 1
					? { ready: true }
					: { ready: false, reason: 'daemon-unreachable' };
			},
			escalateFn: async () => { escalateCalled++; },
		});

		runPlanPhase(opts);
		await waitForCondition(() => escalateCalled > 0);

		expect(escalateCalled).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// AC4: argv-shape for docker exec
// ---------------------------------------------------------------------------

describe('plan-runner container: AC4 - docker exec argv-shape invariants', () => {
	test('planner respawn-pane cmd contains docker exec -it cam-worker', () => {
		const spawnCalls: string[][] = [];
		const opts = makeOpts(
			{ workerIsolation: 'container', preflightContainerFn: () => ({ ready: true }) },
			spawnCalls,
		);

		runPlanPhase(opts);

		const plannerCmd = respawnCalls(spawnCalls)[0]?.slice(-1)[0] ?? '';
		expect(plannerCmd).toContain('docker exec -it cam-worker');
	});

	test('planner respawn-pane cmd contains env -u CLAUDECODE', () => {
		const spawnCalls: string[][] = [];
		const opts = makeOpts(
			{ workerIsolation: 'container', preflightContainerFn: () => ({ ready: true }) },
			spawnCalls,
		);

		runPlanPhase(opts);

		const plannerCmd = respawnCalls(spawnCalls)[0]?.slice(-1)[0] ?? '';
		expect(plannerCmd).toContain('env -u CLAUDECODE');
	});

	test('planner respawn-pane cmd contains --session-id in lowercase (CAM-23)', () => {
		const spawnCalls: string[][] = [];
		const opts = makeOpts(
			{ workerIsolation: 'container', preflightContainerFn: () => ({ ready: true }) },
			spawnCalls,
		);

		runPlanPhase(opts);

		const plannerCmd = respawnCalls(spawnCalls)[0]?.slice(-1)[0] ?? '';
		// The session-id value must be the lowercased form of FAKE_UUID.
		expect(plannerCmd).toContain('--session-id');
		expect(plannerCmd).toContain(FAKE_UUID.toLowerCase());
		expect(plannerCmd).not.toContain(FAKE_UUID.toUpperCase());
	});
});

// ---------------------------------------------------------------------------
// AC5: host mode -> unchanged behavior
// ---------------------------------------------------------------------------

describe('plan-runner container: AC5 - host mode is byte-for-byte unchanged', () => {
	test('host mode (no workerIsolation) -> respawn-pane cmd does NOT start with docker exec', () => {
		const spawnCalls: string[][] = [];
		// No workerIsolation = host default.
		const opts = makeOpts({}, spawnCalls);

		runPlanPhase(opts);

		const plannerCmd = respawnCalls(spawnCalls)[0]?.slice(-1)[0] ?? '';
		expect(plannerCmd).not.toMatch(/^docker exec/);
	});

	test('host mode with not-ready preflight -> does NOT block (preflight ignored in host mode)', () => {
		// Even with preflightContainerFn returning not-ready, host mode should not block.
		const opts = makeOpts({
			workerIsolation: 'host',
			preflightContainerFn: () => ({ ready: false, reason: 'daemon-unreachable' }),
		});

		const result = runPlanPhase(opts);

		// Should NOT return container-preflight-failed in host mode.
		expect(result.kind).not.toBe('container-preflight-failed');
	});

	test('US-001 (CAM-242): host prefix diverges from the container inner string by exactly the -u CLAUDE_CODE_OAUTH_TOKEN token', () => {
		const hostSpawnCalls: string[][] = [];
		const hostOpts = makeOpts({ workerIsolation: 'host' }, hostSpawnCalls);
		runPlanPhase(hostOpts);
		const hostCmd = respawnCalls(hostSpawnCalls)[0]?.slice(-1)[0] ?? '';

		const containerSpawnCalls: string[][] = [];
		const containerOpts = makeOpts(
			{ workerIsolation: 'container', preflightContainerFn: () => ({ ready: true }) },
			containerSpawnCalls,
		);
		runPlanPhase(containerOpts);
		const containerFullCmd = respawnCalls(containerSpawnCalls)[0]?.slice(-1)[0] ?? '';
		const containerInner = containerFullCmd.replace(/^docker exec -it cam-worker /, '');

		expect(hostCmd).toContain('-u CLAUDE_CODE_OAUTH_TOKEN');
		expect(containerInner).not.toContain('-u CLAUDE_CODE_OAUTH_TOKEN');
		expect(hostCmd).not.toEqual(containerInner);
		expect(hostCmd.replace('-u CLAUDE_CODE_OAUTH_TOKEN ', '')).toEqual(containerInner);
	});

	test('absent preflightContainerFn in container mode -> no block (backward compat)', () => {
		// Without preflightContainerFn, even container mode does not block.
		// The dockerExecWrap IS applied (workerIsolation=container), but no preflight blocks.
		const spawnCalls: string[][] = [];
		const opts = makeOpts(
			{ workerIsolation: 'container' /* no preflightContainerFn */ },
			spawnCalls,
		);

		const result = runPlanPhase(opts);

		// Dispatch proceeds; result is auditor-timeout (pane dies, no verdict, report absent).
		expect(result.kind).not.toBe('container-preflight-failed');
		// Shell IS wrapped because workerIsolation=container.
		const plannerCmd = respawnCalls(spawnCalls)[0]?.slice(-1)[0] ?? '';
		expect(plannerCmd).toMatch(/^docker exec -it cam-worker /);
	});
});

// ---------------------------------------------------------------------------
// AC7: escalateFn absent does not throw
// ---------------------------------------------------------------------------

describe('plan-runner container: AC7 - absent escalateFn is safe', () => {
	test('container preflight failure with no escalateFn does not throw', () => {
		const opts = makeOpts({
			workerIsolation: 'container',
			preflightContainerFn: () => ({ ready: false, reason: 'image-missing' }),
			// escalateFn intentionally absent.
		});

		expect(() => runPlanPhase(opts)).not.toThrow();
	});
});
