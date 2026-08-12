// test/supervisor/headless-route.test.ts
//
// US-005 (CAM-516): the headless-vs-tmux dispatch route is decided once
// (host.ts, GOTCHA C) and consumed as ONE branch at the implementer dispatch
// (loop.ts). These tests pin the three observable contracts of that branch:
//
//   1. 'routes implementer dispatch': headless on -> the US-003 runner is
//      called exactly once (carrying the advisory story id) and the tmux
//      path (respawn-pane) is never touched.
//   2. 'pane-liveness': headless on -> isPaneAlive (the tmux poll-loop
//      liveness check) is never reached, even when injected to throw
//      (GOTCHA E: completion is a child-exit / idle-budget signal, never a
//      pane probe).
//   3. 'tmux path unchanged': headless off -> the exact same fakes see the
//      identical respawn-pane dispatch + pane-liveness polling behavior as
//      today, and the headless runner is never invoked.

import { describe, expect, test, beforeEach } from 'bun:test';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { runSupervisor } from '../../src/supervisor/loop.ts';
import type { RunSupervisorOptions, SpawnFn, CapturePane, ReadPrd, WritePrd, ReadHandoff, ClockFn, ReviewDispatch, WriteSessionMarker, IsPaneAlive } from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import type { WorkerReport } from '../../src/supervisor/worker-report.ts';
import type { HeadlessDispatchOutcome } from '../../src/supervisor/headless-dispatch.ts';
import { DEFAULT_IMPLEMENTER_AGENT } from '../../src/supervisor/backend-adapter.ts';
import { withVerifiedPanePid } from '../helpers/verified-pane-pid-spawn.ts';

const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';
const WORKER_PANE_ID = '%3';

let uuidCounter = 0;
function fakeGenUuid(): string {
	uuidCounter++;
	return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
}

function makePrd(opts: {
	stories: Array<{ id: string; priority: number; passes: boolean; requires?: string }>;
	review?: PrdSnapshot['review'];
}): PrdSnapshot {
	return {
		userStories: opts.stories.map((s) => ({
			id: s.id,
			priority: s.priority,
			passes: s.passes,
			requires: s.requires ?? null,
		})),
		review: opts.review,
	};
}

function makeHandoff(storyId: string) {
	return {
		lastCompletedStory: { id: storyId, title: `Story ${storyId}` },
		branchName: 'cam/test',
		timestamp: '2026-06-08T00:00:00Z',
	};
}

const CONFIG_DIR = createTestTmpdir('cam-headless-route-config-');
const CONFIG_PATH = join(CONFIG_DIR, 'project.toml');
writeFileSync(CONFIG_PATH, '[backend]\nimplementer = "claude"\n');

function makeBaseOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	const spawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
	const capturePane: CapturePane = (_paneId) => '';
	const readPrd: ReadPrd = () => null;
	const writePrd: WritePrd = (_prd) => {};
	const readHandoff: ReadHandoff = () => null;
	const clock: ClockFn = () => '2026-06-08T00:00:00Z';
	const reviewDispatch: ReviewDispatch = async (_uuid) => ({ status: 'ok', detail: 'review ok' });
	const writeSessionMarker: WriteSessionMarker = (_storyId, _uuid) => {};
	const isPaneAlive: IsPaneAlive = (_paneId) => true;

	const merged: RunSupervisorOptions = {
		spawn,
		capturePane,
		readPrd,
		writePrd,
		readHandoff,
		clock,
		genUuid: fakeGenUuid,
		reviewDispatch,
		writeSessionMarker,
		isPaneAlive,
		workerPaneId: WORKER_PANE_ID,
		prdPath: PRD_PATH,
		handoffPath: HANDOFF_PATH,
		permissionMode: 'bypassPermissions',
		taskPrompt: 'Implement the next story from the PRD.',
		sleepFn: (_ms: number) => {},
		nowMs: () => 0,
		...overrides,
		configPath: 'configPath' in overrides ? overrides.configPath : CONFIG_PATH,
	};
	merged.spawn = withVerifiedPanePid(overrides.spawn ?? spawn);
	return merged;
}

beforeEach(() => {
	uuidCounter = 0;
});

describe('headless route decision (US-005, CAM-516)', () => {
	test('routes implementer dispatch', async () => {
		const prdImpl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prdDone = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		let prdCall = 0;

		const fakeReport: WorkerReport = {
			outcome: 'DONE',
			story: 'US-001',
			gates: { typecheck: 'ok', tests: '5 pass / 0 fail' },
			notes: 'none',
		};

		const spawnCalls: string[][] = [];
		const headlessCalls: Array<{
			uuid: string;
			storyId: string | undefined;
			taskPrompt: string;
			model: string;
			agentName: string;
			permissionMode: string;
		}> = [];

		const opts = makeBaseOpts({
			headless: true,
			headlessDispatchFn: async (params) => {
				headlessCalls.push(params);
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prdImpl : prdDone;
			},
			readHandoff: () => makeHandoff('US-001'),
			readWorkerReport: () => fakeReport,
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.lastOutcome?.kind).toBe('pass');
		expect(spawnCalls.filter((a) => a.includes('respawn-pane')).length).toBe(0);
		expect(headlessCalls.length).toBe(1);
		expect(headlessCalls[0]?.storyId).toBe('US-001');
		// US-R1-001 (CRITICAL regression fix): the headless dispatch carries the
		// same implementer agent name the tmux path resolves, so the spawned
		// child has an AGENT.md and the implementer protocol applies.
		expect(headlessCalls[0]?.agentName).toBe(DEFAULT_IMPLEMENTER_AGENT);
		// US-R1-002 (CRITICAL regression fix): the headless dispatch carries the
		// same opts.permissionMode the tmux path resolves, so a tool-use attempt
		// does not abort the headless run.
		expect(headlessCalls[0]?.permissionMode).toBe('bypassPermissions');
	});

	test('pane-liveness', async () => {
		const prdImpl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prdDone = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		let prdCall = 0;

		const fakeReport: WorkerReport = {
			outcome: 'DONE',
			story: 'US-001',
			gates: { typecheck: 'ok', tests: '5 pass / 0 fail' },
			notes: 'none',
		};

		let isPaneAliveCalls = 0;

		const opts = makeBaseOpts({
			headless: true,
			headlessDispatchFn: async () => {
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prdImpl : prdDone;
			},
			readHandoff: () => makeHandoff('US-001'),
			readWorkerReport: () => fakeReport,
			isPaneAlive: (_paneId) => {
				isPaneAliveCalls++;
				throw new Error('isPaneAlive must never be called in headless mode');
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.lastOutcome?.kind).toBe('pass');
		expect(isPaneAliveCalls).toBe(0);
	});

	test('tmux path unchanged', async () => {
		const prdImpl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
		const prdDone = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
		});
		let prdCall = 0;

		const fakeReport: WorkerReport = {
			outcome: 'DONE',
			story: 'US-001',
			gates: { typecheck: 'ok', tests: '5 pass / 0 fail' },
			notes: 'none',
		};

		const spawnCalls: string[][] = [];
		const headlessCalls: unknown[] = [];
		let isPaneAliveCalls = 0;

		const opts = makeBaseOpts({
			headless: false,
			headlessDispatchFn: async (params) => {
				headlessCalls.push(params);
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
			readPrd: () => {
				prdCall++;
				return prdCall <= 1 ? prdImpl : prdDone;
			},
			readHandoff: () => makeHandoff('US-001'),
			readWorkerReport: () => fakeReport,
			isPaneAlive: (_paneId) => {
				isPaneAliveCalls++;
				return true;
			},
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.lastOutcome?.kind).toBe('pass');
		expect(spawnCalls.some((a) => a.includes('respawn-pane'))).toBe(true);
		expect(isPaneAliveCalls).toBeGreaterThan(0);
		expect(headlessCalls.length).toBe(0);
	});
});
