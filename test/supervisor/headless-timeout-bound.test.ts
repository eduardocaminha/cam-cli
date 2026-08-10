// test/supervisor/headless-timeout-bound.test.ts
//
// US-R1-006 (CAM-516): headless dispatch had no spend or wall-clock bound of
// its own -- the CAM-5 per-worker token ceiling (maxWorkerTokens +
// readWorkerTokens) and perWorkerTimeoutMs both live only in the tmux poll
// loop, so a headless dispatch's only bound was the resettable 45-minute
// idle budget: a chatty runaway child (one that always emits SOME event
// before the idle budget ticks) was unbounded. These tests pin three
// observable contracts:
//
//   1. the resolved perWorkerTimeoutMs is threaded into headlessDispatchFn as
//      absoluteTimeoutMs -- the SAME wall-clock ceiling the tmux poll loop
//      enforces via `now() - startMs >= perWorkerTimeoutMs`.
//   2. a headlessOutcome of kind 'absolute-timeout' (headless-dispatch.ts's
//      new terminal state) is treated exactly like 'idle-timeout': dead-worker
//      retry/backoff (CAM-44), blocking at MAX_DEAD_WORKER_RETRIES with a
//      detail naming the specific timeout label. 'idle-timeout' itself (the
//      pre-existing US-005 code path, touched by this story's refactor) is
//      pinned alongside it so the shared branch is proven for both labels.
//   3. the configured token ceiling reuses readWorkerTokens during a headless
//      dispatch and produces the same terminal worker-token-ceiling contract
//      as tmux; no probe is wired when the ceiling or reader is absent.

import { describe, expect, test, beforeEach } from 'bun:test';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { runSupervisor, MAX_DEAD_WORKER_RETRIES } from '../../src/supervisor/loop.ts';
import type {
	RunSupervisorOptions,
	SpawnFn,
	CapturePane,
	ReadPrd,
	WritePrd,
	ReadHandoff,
	ClockFn,
	ReviewDispatch,
	WriteSessionMarker,
	IsPaneAlive,
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import type { WorkerReport } from '../../src/supervisor/worker-report.ts';
import type { HeadlessDispatchOutcome } from '../../src/supervisor/headless-dispatch.ts';
import type { WorkerEvent } from '../../src/supervisor/events.ts';
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

const CONFIG_DIR = createTestTmpdir('cam-headless-timeout-bound-config-');
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
		headless: true,
		workerIsolation: 'host',
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

describe('headless absolute wall-clock bound (US-R1-006, CAM-516)', () => {
	test('threads the resolved perWorkerTimeoutMs into headlessDispatchFn as absoluteTimeoutMs', async () => {
		const seenTimeouts: number[] = [];

		const opts = makeBaseOpts({
			...oneStoryBase(),
			perWorkerTimeoutMs: 12_345,
			headlessDispatchFn: async (params) => {
				seenTimeouts.push(params.absoluteTimeoutMs);
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(seenTimeouts).toEqual([12_345]);
	});

	test('threads the isolation-aware DEFAULT_PER_WORKER_TIMEOUT_MS when perWorkerTimeoutMs is not overridden', async () => {
		const seenTimeouts: number[] = [];

		const opts = makeBaseOpts({
			...oneStoryBase(),
			// perWorkerTimeoutMs intentionally omitted: loop.ts resolves the
			// isolation-aware default (workerIsolation: 'host' -> 30 min).
			headlessDispatchFn: async (params) => {
				seenTimeouts.push(params.absoluteTimeoutMs);
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(seenTimeouts).toEqual([30 * 60 * 1000]);
	});

	test.each(['idle-timeout', 'absolute-timeout'] as const)(
		"a persistent '%s' outcome blocks at the dead-worker cap with escalating backoff, never reaching max-iterations",
		async (timeoutKind) => {
			const prd = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
			const sleeps: number[] = [];
			const events: WorkerEvent[] = [];

			const opts = makeBaseOpts({
				readPrd: () => prd,
				readHandoff: () => makeHandoff('US-001'),
				maxIterations: 50,
				sleepFn: (ms) => {
					if (ms > 0) sleeps.push(ms);
				},
				// Pin randomFn so jitter is zero (r=0.5 -> multiplier 1.0), matching
				// the tmux dead-worker-cap tests' deterministic backoff pattern.
				randomFn: () => 0.5,
				logEvent: (e) => events.push(e),
				headlessDispatchFn: async () => {
					const outcome: HeadlessDispatchOutcome = { kind: timeoutKind, totalCostUsd: undefined };
					return outcome;
				},
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('blocked');
			expect(result.iterations).toBe(MAX_DEAD_WORKER_RETRIES);
			const retryEvents = events.filter((e) => e.kind === 'pane-died-retry');
			expect(retryEvents).toHaveLength(MAX_DEAD_WORKER_RETRIES - 1);
			expect(retryEvents[0]?.detail).toMatchObject({ attempt: 1, pollOutcome: timeoutKind });
			expect(result.lastOutcome?.detail).toContain('dead-worker');
			expect(result.lastOutcome?.detail).toContain(`headless ${timeoutKind}`);
		},
	);

	test("a single 'absolute-timeout' does not block: the run recovers on the next dispatch (streak resets)", async () => {
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
		let dispatchCall = 0;

		const opts = makeBaseOpts({
			readPrd: () => {
				prdCall++;
				return prdCall <= 2 ? prdImpl : prdDone;
			},
			readHandoff: () => makeHandoff('US-001'),
			readWorkerReport: () => (dispatchCall >= 2 ? fakeReport : null),
			sleepFn: (_ms: number) => {},
			headlessDispatchFn: async () => {
				dispatchCall++;
				const outcome: HeadlessDispatchOutcome =
					dispatchCall === 1
						? { kind: 'absolute-timeout', totalCostUsd: undefined }
						: { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(dispatchCall).toBe(2);
	});
});

describe('headless worker token ceiling (CAM-516)', () => {
	test('interrupts and blocks when the configured ceiling is crossed', async () => {
		const events: WorkerEvent[] = [];
		const tokenReaderUuids: string[] = [];
		const dispatchUuids: string[] = [];

		const opts = makeBaseOpts({
			...oneStoryBase(),
			genUuid: () => 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
			maxWorkerTokens: 100_000,
			readWorkerTokens: (uuid) => {
				tokenReaderUuids.push(uuid);
				return {
					inputTokens: 90_000,
					outputTokens: 0,
					cacheReadTokens: 15_000,
					cacheCreationTokens: 0,
				};
			},
			logEvent: (e) => events.push(e),
			headlessDispatchFn: async (params) => {
				dispatchUuids.push(params.uuid);
				const tokenSpend = params.tokenCeilingProbe?.();
				if (tokenSpend !== undefined) {
					return { kind: 'token-ceiling', tokenSpend, totalCostUsd: undefined };
				}
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(result.lastOutcome?.detail).toContain('worker-token-ceiling: spend 105000 >= ceiling 100000');
		expect(dispatchUuids).toEqual(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
		expect(tokenReaderUuids).toEqual(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
		const unavailableEvents = events.filter((e) => e.kind === 'worker-token-ceiling-unavailable');
		expect(unavailableEvents).toHaveLength(0);
		const ceilingEvents = events.filter((e) => e.kind === 'worker-token-ceiling');
		expect(ceilingEvents).toHaveLength(1);
		expect(ceilingEvents[0]?.detail).toMatchObject({ spend: 105_000, ceiling: 100_000, mode: 'headless' });
	});

	test('does not wire a token probe when no ceiling is configured (maxWorkerTokens 0)', async () => {
		const events: WorkerEvent[] = [];
		const probeWasWired: boolean[] = [];

		const opts = makeBaseOpts({
			...oneStoryBase(),
			maxWorkerTokens: 0,
			readWorkerTokens: (_uuid) => ({
				inputTokens: 999_999,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
			}),
			logEvent: (e) => events.push(e),
			headlessDispatchFn: async (params) => {
				probeWasWired.push(params.tokenCeilingProbe !== undefined);
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(probeWasWired).toEqual([false]);
		expect(events.filter((e) => e.kind === 'worker-token-ceiling')).toHaveLength(0);
	});

	test('does not wire a token probe when no readWorkerTokens reader is wired', async () => {
		const events: WorkerEvent[] = [];
		const probeWasWired: boolean[] = [];

		const opts = makeBaseOpts({
			...oneStoryBase(),
			maxWorkerTokens: 100_000,
			readWorkerTokens: undefined,
			logEvent: (e) => events.push(e),
			headlessDispatchFn: async (params) => {
				probeWasWired.push(params.tokenCeilingProbe !== undefined);
				const outcome: HeadlessDispatchOutcome = { kind: 'completed', exitCode: 0, totalCostUsd: undefined };
				return outcome;
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(probeWasWired).toEqual([false]);
		expect(events.filter((e) => e.kind === 'worker-token-ceiling')).toHaveLength(0);
	});
});
