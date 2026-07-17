// test/sidecar-gate-phase.test.ts
//
// Tests for wiring the operator-decision gate lifecycle into the sidecar
// loop (US-003, CAM-241/153; plan-approval gate production wiring US-003,
// CAM-241/153/312).
//
// Coverage:
//   AC1/AC2: loop.ts source-text oracle -- the awaiting-operator branch
//        guards on loopPhase === 'awaiting-operator' and precedes the
//        active!==true idle check (belt-and-suspenders on top of the PRD's
//        own grep oracle), and is a sibling of the planning/shipping branches.
//   AC2: runSidecarLoop invokes the injected runGatePhaseFn on an
//        awaiting-operator tick, guarded by an outer try/catch that logs a
//        sidecar-exit event and survives a throwing dep.
//   AC2: sidecar.ts source-text oracle -- makeProductionGatePhaseFn wires
//        pollAndResolveGate with a discriminator-keyed registry, never
//        hard-coded to a single gate kind.
//   AC5: makeWritePlanApprovalGateFn (write side) writes gate='plan-approval',
//        options=['approve','reject'], a context carrying the PRD summary,
//        and never a pre-populated `decision`.
//   AC3/AC4: end-to-end against a real tmpdir git repo + gate file --
//        `cam decide approve|reject` (runDecide) populates the decision, the
//        production runGatePhaseFn (buildGatePhaseDeps) resolves it: approve
//        fires the branch/commit deps and flips phase to implementing; reject
//        removes prd.json and flips phase to idle. Both consume the gate file.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import {
	runSidecarLoop,
	type RunSidecarLoopOptions,
	type RunSupervisorOptions,
	type SupervisorResult,
} from '../src/supervisor/loop.ts';
import { makeInMemoryEventLogger, type WorkerEvent } from '../src/supervisor/events.ts';
import { buildGatePhaseDeps, makeWritePlanApprovalGateFn, makeReadLoopPhase } from '../src/commands/sidecar.ts';
import { runDecide } from '../src/commands/decide.ts';
import { GATE_FILENAME, writeGateFile } from '../src/supervisor/gate.ts';
import type { SpawnFn } from '../src/tmux/session.ts';

// ---------------------------------------------------------------------------
// Fixtures shared by AC3/AC4/AC5: a real tmpdir git repo + a no-session fake
// tmux SpawnFn (list-panes exits nonzero -> getOrchPaneId returns null ->
// makeNotifyOrchestrator is a silent best-effort no-op; never used for the
// real git checkout/add/commit calls, which hit the real `git` binary
// against the tmpdir repo via node:child_process spawnSync directly).
// ---------------------------------------------------------------------------

function setupTmpRepo(): { cwd: string; claudeDir: string } {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-gate-phase-'));
	mkdirSync(join(cwd, 'scripts/cam'), { recursive: true });
	mkdirSync(join(cwd, '.claude'), { recursive: true });
	spawnSync('git', ['init'], { cwd, stdio: 'pipe' });
	spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd, stdio: 'pipe' });
	spawnSync('git', ['config', 'user.name', 'Test'], { cwd, stdio: 'pipe' });
	writeFileSync(join(cwd, 'README.md'), '# test\n', 'utf8');
	spawnSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
	spawnSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });
	return { cwd, claudeDir: join(cwd, '.claude') };
}

const noSessionSpawnFn: SpawnFn = (): SpawnSyncReturns<Buffer> => ({
	pid: 1,
	output: [null, Buffer.from(''), Buffer.from('')],
	stdout: Buffer.from(''),
	stderr: Buffer.from(''),
	status: 1,
	signal: null,
});

// ---------------------------------------------------------------------------
// Escape sentinel (same ESCAPE pattern as sidecar-ship-phase.test.ts)
// ---------------------------------------------------------------------------

const ESCAPE = Symbol('escape');

/** Build a minimal RunSupervisorOptions that never does any real I/O. */
function makeDummySupervisorOpts(): RunSupervisorOptions {
	return {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-07-16T00:00:00Z',
		reviewDispatch: () => ({ status: 'ok', detail: '' }),
		writeSessionMarker: () => {},
		isPaneAlive: () => true,
		workerPaneId: '%2',
		prdPath: '/fake/prd.json',
		handoffPath: '/fake/handoff.json',
		permissionMode: 'bypassPermissions',
		taskPrompt: 'test',
		sleepFn: () => {},
		nowMs: () => 0,
	};
}

const COMPLETE_RESULT: SupervisorResult = {
	status: 'complete',
	iterations: 1,
	lastOutcome: null,
};

// ---------------------------------------------------------------------------
// AC1/AC2: loop.ts source-text oracle for the awaiting-operator branch
// ---------------------------------------------------------------------------

describe('AC1/AC2: loop.ts source-text oracle -- awaiting-operator branch', () => {
	const loopSrc = readFileSync(resolve(import.meta.dir, '../src/supervisor/loop.ts'), 'utf8');

	const gateIdx = loopSrc.indexOf("loopPhase === 'awaiting-operator'");
	const shippingIdx = loopSrc.indexOf("loopPhase === 'shipping'");
	const planningIdx = loopSrc.indexOf("loopPhase === 'planning'");
	const activeIdx = loopSrc.indexOf('if (active !== true)');

	test('loop.ts contains the awaiting-operator branch guard', () => {
		expect(gateIdx).toBeGreaterThan(-1);
	});

	test('the awaiting-operator branch precedes the active!==true idle check', () => {
		expect(gateIdx).toBeLessThan(activeIdx);
	});

	test('the awaiting-operator branch follows the planning and shipping branches (sibling ordering)', () => {
		expect(planningIdx).toBeGreaterThan(-1);
		expect(shippingIdx).toBeGreaterThan(-1);
		expect(gateIdx).toBeGreaterThan(planningIdx);
		expect(gateIdx).toBeGreaterThan(shippingIdx);
	});

	const gateBlock = gateIdx >= 0 ? loopSrc.slice(gateIdx, gateIdx + 800) : '';

	test('awaiting-operator branch awaits opts.runGatePhaseFn() inside a try block', () => {
		expect(gateBlock).toContain('try {');
		expect(gateBlock).toContain('await opts.runGatePhaseFn()');
	});

	test("awaiting-operator branch catch block logs reason: 'gate-phase-crash-outer'", () => {
		expect(gateBlock).toContain("'gate-phase-crash-outer'");
	});
});

// ---------------------------------------------------------------------------
// AC2: runSidecarLoop dispatches runGatePhaseFn on an awaiting-operator tick
// and survives a throwing dep.
// ---------------------------------------------------------------------------

describe('AC2: runSidecarLoop -- awaiting-operator tick dispatch + crash survival', () => {
	test('invokes the injected runGatePhaseFn on an awaiting-operator tick', async () => {
		let gatePhaseCalls = 0;
		let sleepCalls = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: (): boolean | undefined => false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				if (sleepCalls >= 2) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			readLoopPhaseFn: () => 'awaiting-operator',
			runGatePhaseFn: async (): Promise<void> => {
				gatePhaseCalls++;
			},
		};

		let caughtErr: unknown;
		try {
			await runSidecarLoop(loopOpts);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBe(ESCAPE);
		expect(gatePhaseCalls).toBeGreaterThanOrEqual(1);
	});

	test('a throwing runGatePhaseFn does not kill the loop; logs sidecar-exit', async () => {
		const { logger: logEvent, events } = makeInMemoryEventLogger();
		let gatePhaseCalls = 0;
		let sleepCalls = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: (): boolean | undefined => false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				if (sleepCalls >= 2) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			readLoopPhaseFn: () => 'awaiting-operator',
			runGatePhaseFn: async (): Promise<void> => {
				gatePhaseCalls++;
				throw new Error('injected gate-phase crash');
			},
			logEvent,
		};

		let caughtErr: unknown;
		try {
			await runSidecarLoop(loopOpts);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBe(ESCAPE);
		expect(gatePhaseCalls).toBeGreaterThanOrEqual(1);

		const crashEvents = events.filter((e: WorkerEvent) => e.kind === 'sidecar-exit');
		expect(crashEvents.length).toBeGreaterThanOrEqual(1);
		const detail = crashEvents[0]?.detail as { reason?: string };
		expect(detail.reason).toBe('gate-phase-crash-outer');
	});

	test('when runGatePhaseFn is absent, an awaiting-operator phase falls through without dispatch (zero behavior change)', async () => {
		let sleepCalls = 0;
		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: (): boolean | undefined => false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				if (sleepCalls >= 2) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			readLoopPhaseFn: () => 'awaiting-operator',
			// runGatePhaseFn intentionally omitted.
		};

		let caughtErr: unknown;
		try {
			await runSidecarLoop(loopOpts);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBe(ESCAPE);
		expect(sleepCalls).toBeGreaterThanOrEqual(2);
	});

	test('runGatePhaseFn is mutually exclusive with the idle path (active!==true) machinery', async () => {
		let gatePhaseCalls = 0;
		let idlePathCalls = 0;
		let sleepCalls = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () => makeDummySupervisorOpts(),
			readActive: (): boolean | undefined => false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				if (sleepCalls >= 2) throw ESCAPE;
			},
			hasPendingStories: () => false,
			acquireLock: () => ({ acquired: true as const, release: () => {} }),
			runSupervisorFn: async (): Promise<SupervisorResult> => COMPLETE_RESULT,
			readLoopPhaseFn: () => 'awaiting-operator',
			runGatePhaseFn: async (): Promise<void> => {
				gatePhaseCalls++;
			},
			runMergeWatchFn: async () => { idlePathCalls++; },
		};

		let caughtErr: unknown;
		try {
			await runSidecarLoop(loopOpts);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBe(ESCAPE);
		expect(gatePhaseCalls).toBeGreaterThanOrEqual(1);
		expect(idlePathCalls).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC2: sidecar.ts source-text oracle -- generic dispatch, never hard-coded
// ---------------------------------------------------------------------------

describe('AC2: sidecar.ts source-text oracle -- generic gate-kind dispatch', () => {
	const src = readFileSync(resolve(import.meta.dir, '../src/commands/sidecar.ts'), 'utf8');

	test('sidecar.ts wires pollAndResolveGate', () => {
		expect(src).toContain('pollAndResolveGate');
	});

	test('the production gate-phase registry is not hard-coded to a single gate kind', () => {
		const idx = src.indexOf('function makeProductionGatePhaseFn');
		expect(idx).toBeGreaterThan(-1);
		const block = src.slice(idx, idx + 800);
		expect(block).toContain('GateResolutionRegistry');
		expect(block).toContain('pollAndResolveGate(filePath, registry, setPhase)');
	});

	test('the registry also registers the plan-approval discriminator (never hard-coded to in-progress-conflict alone)', () => {
		const idx = src.indexOf('function makeProductionGatePhaseFn');
		expect(idx).toBeGreaterThan(-1);
		const block = src.slice(idx, idx + 800);
		expect(block).toContain('[PLAN_APPROVAL_GATE]: makePlanApprovalResolver(');
	});
});

// ---------------------------------------------------------------------------
// AC5: write side -- makeWritePlanApprovalGateFn writes the resolvable gate
// ---------------------------------------------------------------------------

describe('AC5: makeWritePlanApprovalGateFn writes gate=plan-approval + PRD summary context', () => {
	test('gate file carries gate/options/context, and never a pre-populated decision', () => {
		const { cwd, claudeDir } = setupTmpRepo();
		try {
			const prd = {
				issueNumber: 312,
				description: 'Wire the plan-approval gate',
				userStories: [
					{ id: 'US-001', title: 'a', acceptanceCriteria: ['x', 'y'] },
					{ id: 'US-002', title: 'b', acceptanceCriteria: ['z'] },
				],
			};
			writeFileSync(join(cwd, 'scripts/cam/prd.json'), JSON.stringify(prd), 'utf8');

			const { logger: logEvent } = makeInMemoryEventLogger();
			const write = makeWritePlanApprovalGateFn(cwd, claudeDir, 'test-session', noSessionSpawnFn, logEvent);
			write();

			const gatePath = join(claudeDir, GATE_FILENAME);
			expect(existsSync(gatePath)).toBe(true);
			const gate = JSON.parse(readFileSync(gatePath, 'utf8')) as {
				gate: string;
				options: string[];
				context: string;
				decision?: string;
			};
			expect(gate.gate).toBe('plan-approval');
			expect(gate.options).toEqual(['approve', 'reject']);
			expect(gate.context).toContain('Wire the plan-approval gate');
			expect(gate.context).toContain('US-001');
			expect(gate.decision).toBeUndefined();

			expect(makeReadLoopPhase(claudeDir)()).toBe('awaiting-operator');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// AC3/AC4: end-to-end -- cam decide <approve|reject> + the sidecar gate-phase
// tick resolves the real plan-approval gate against a real tmpdir git repo.
// ---------------------------------------------------------------------------

describe('AC3/AC4: plan-approval gate end-to-end via cam decide + buildGatePhaseDeps', () => {
	test('approve: branch/commit deps fire, phase flips to implementing, gate file consumed', async () => {
		const { cwd, claudeDir } = setupTmpRepo();
		try {
			writeFileSync(
				join(cwd, 'scripts/cam/prd.json'),
				JSON.stringify({ issueNumber: 999, description: 'Test' }),
				'utf8',
			);
			writeGateFile(join(claudeDir, GATE_FILENAME), {
				gate: 'plan-approval',
				options: ['approve', 'reject'],
				context: 'ctx',
			});

			expect(runDecide({ cwd, decision: 'approve' })).toBe(0);

			const { logger: logEvent } = makeInMemoryEventLogger();
			const { runGatePhaseFn } = buildGatePhaseDeps(
				{ cwd, claudeDir, prdPath: join(cwd, 'scripts/cam/prd.json'), sessionName: 'test-session', logEvent, realSpawnFn: noSessionSpawnFn },
				{},
			);
			await runGatePhaseFn?.();

			const branchResult = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
			expect(branchResult.stdout.trim()).toBe('cam/issue-999');

			const logResult = spawnSync('git', ['-C', cwd, 'log', '--oneline', '-1'], { encoding: 'utf8' });
			expect(logResult.stdout).toContain('commit audited prd.json');

			expect(existsSync(join(claudeDir, GATE_FILENAME))).toBe(false);
			expect(makeReadLoopPhase(claudeDir)()).toBe('implementing');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test(
		'approve: missing/invalid issueNumber reports failure (US-001, CAM-319) -- phase fails safe to idle ' +
			'(never implementing), no cam/* branch created, durable event logged',
		async () => {
			const { cwd, claudeDir } = setupTmpRepo();
			try {
				// No issueNumber field at all -> deriveBranchName returns null.
				writeFileSync(join(cwd, 'scripts/cam/prd.json'), JSON.stringify({ description: 'Test' }), 'utf8');
				writeGateFile(join(claudeDir, GATE_FILENAME), {
					gate: 'plan-approval',
					options: ['approve', 'reject'],
					context: 'ctx',
				});

				expect(runDecide({ cwd, decision: 'approve' })).toBe(0);

				const { logger: logEvent, events } = makeInMemoryEventLogger();
				const { runGatePhaseFn } = buildGatePhaseDeps(
					{ cwd, claudeDir, prdPath: join(cwd, 'scripts/cam/prd.json'), sessionName: 'test-session', logEvent, realSpawnFn: noSessionSpawnFn },
					{},
				);
				await runGatePhaseFn?.();

				const branchResult = spawnSync('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' });
				expect(branchResult.stdout.trim()).not.toMatch(/^cam\//);

				expect(existsSync(join(claudeDir, GATE_FILENAME))).toBe(false);
				expect(makeReadLoopPhase(claudeDir)()).toBe('idle');

				const failEvents = events.filter((e: WorkerEvent) => e.kind === 'plan-approval-branch-failed');
				expect(failEvents.length).toBeGreaterThanOrEqual(1);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	);

	test('reject: prd.json removed, phase flips to idle, gate file consumed', async () => {
		const { cwd, claudeDir } = setupTmpRepo();
		try {
			writeFileSync(join(cwd, 'scripts/cam/prd.json'), JSON.stringify({ issueNumber: 998 }), 'utf8');
			writeGateFile(join(claudeDir, GATE_FILENAME), {
				gate: 'plan-approval',
				options: ['approve', 'reject'],
				context: 'ctx',
			});

			expect(runDecide({ cwd, decision: 'reject' })).toBe(0);

			const { logger: logEvent } = makeInMemoryEventLogger();
			const { runGatePhaseFn } = buildGatePhaseDeps(
				{ cwd, claudeDir, prdPath: join(cwd, 'scripts/cam/prd.json'), sessionName: 'test-session', logEvent, realSpawnFn: noSessionSpawnFn },
				{},
			);
			await runGatePhaseFn?.();

			expect(existsSync(join(cwd, 'scripts/cam/prd.json'))).toBe(false);
			expect(existsSync(join(claudeDir, GATE_FILENAME))).toBe(false);
			expect(makeReadLoopPhase(claudeDir)()).toBe('idle');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
