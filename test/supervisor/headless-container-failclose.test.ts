// test/supervisor/headless-container-failclose.test.ts
//
// US-006 (CAM-516): headless dispatch plus container isolation must fail
// closed BEFORE any dispatch, not silently reuse the tmux `-it` docker-exec
// wrap (GOTCHA F: `-it` allocates a TTY headless must not have; ADR-0059
// also records the container + env-token credential combination as
// unmeasured). These tests pin three observable contracts:
//
//   1. headless on + workerIsolation === 'container' -> the loop blocks
//      BEFORE dispatching, with a blocked outcome whose detail names both
//      'headless' and 'container', and headlessDispatchFn is never invoked.
//   2. 'never wraps through docker exec': proof by absence at the wire --
//      the injected spawn fake records zero commands containing
//      'docker exec' (not merely an outcome-string check).
//   3. 'host mode still dispatches': the fail-close is scoped to container
//      isolation only -- headless on + host isolation still dispatches
//      normally through the US-005 seam.

import { describe, expect, test, beforeEach } from 'bun:test';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { runSupervisor } from '../../src/supervisor/loop.ts';
import type { RunSupervisorOptions, SpawnFn, CapturePane, ReadPrd, WritePrd, ReadHandoff, ClockFn, ReviewDispatch, WriteSessionMarker, IsPaneAlive } from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import type { WorkerReport } from '../../src/supervisor/worker-report.ts';
import type { HeadlessDispatchOutcome } from '../../src/supervisor/headless-dispatch.ts';
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

const CONFIG_DIR = createTestTmpdir('cam-headless-container-failclose-config-');
const CONFIG_PATH = join(CONFIG_DIR, 'project.toml');
writeFileSync(CONFIG_PATH, '[backend]\nimplementer = "claude"\n');

function makeBaseOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	const spawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
	const capturePane: CapturePane = (_paneId) => '';
	const readPrd: ReadPrd = () => null;
	const writePrd: WritePrd = (_prd) => {};
	const readHandoff: ReadHandoff = () => null;
	const clock: ClockFn = () => '2026-06-08T00:00:00Z';
	const reviewDispatch: ReviewDispatch = (_uuid) => ({ status: 'ok', detail: 'review ok' });
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

function oneStoryBase(): Partial<RunSupervisorOptions> {
	const prdImpl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
	const prdDone = makePrd({
		stories: [{ id: 'US-001', priority: 1, passes: true }],
		review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
	});
	const fakeReport: WorkerReport = {
		outcome: 'DONE',
		story: 'US-001',
		gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
		notes: 'none',
	};
	let prdCall = 0;
	return {
		readPrd: () => {
			prdCall++;
			return prdCall <= 1 ? prdImpl : prdDone;
		},
		readHandoff: () => makeHandoff('US-001'),
		readWorkerReport: () => fakeReport,
	};
}

beforeEach(() => {
	uuidCounter = 0;
});

describe('headless + container fail-close (US-006, CAM-516)', () => {
	test('blocks before dispatch with a detail naming both headless and container', async () => {
		const spawnCalls: string[][] = [];
		let headlessDispatchCalls = 0;

		const opts = makeBaseOpts({
			...oneStoryBase(),
			headless: true,
			workerIsolation: 'container',
			headlessDispatchFn: async () => {
				headlessDispatchCalls++;
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.lastOutcome?.kind).toBe('blocked');
		expect(result.lastOutcome?.detail).toContain('headless');
		expect(result.lastOutcome?.detail).toContain('container');
		expect(headlessDispatchCalls).toBe(0);
		expect(spawnCalls.length).toBe(0);
	});

	test('never wraps through docker exec', async () => {
		const spawnCalls: string[][] = [];

		const opts = makeBaseOpts({
			...oneStoryBase(),
			headless: true,
			workerIsolation: 'container',
			headlessDispatchFn: async () => {
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
			spawn: (_cmd, args) => {
				spawnCalls.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		const dockerExecCalls = spawnCalls.filter((args) => args.some((a) => a.includes('docker exec')));
		expect(dockerExecCalls.length).toBe(0);
	});

	test('host mode still dispatches', async () => {
		const headlessCalls: Array<{ uuid: string; storyId: string | undefined; taskPrompt: string; model: string }> = [];

		const opts = makeBaseOpts({
			...oneStoryBase(),
			headless: true,
			workerIsolation: 'host',
			headlessDispatchFn: async (params) => {
				headlessCalls.push(params);
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(result.lastOutcome?.kind).toBe('pass');
		expect(headlessCalls.length).toBe(1);
		expect(headlessCalls[0]?.storyId).toBe('US-001');
	});
});
