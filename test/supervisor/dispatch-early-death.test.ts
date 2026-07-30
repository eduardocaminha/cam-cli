// test/supervisor/dispatch-early-death.test.ts
//
// US-002 (CAM-479): the pure early-death detector over a session transcript.
// Driven against two REAL fixtures (dead-on-first-turn, healthy-planner), not
// synthetic minimal strings, per the story's acceptance criteria. Every test
// drives an injected clock (nowFn) or explicit timestamps, never wall time.

import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
	DEFAULT_CONTAINER_WORKER_TIMEOUT_MS,
	DEFAULT_PER_WORKER_TIMEOUT_MS,
	DEFAULT_POLL_INTERVAL_MS,
	MAX_DEAD_WORKER_RETRIES,
	NO_PROGRESS_BACKOFF_MS,
	runSupervisor,
} from '../../src/supervisor/loop.ts';
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
import { makeInMemoryEventLogger } from '../../src/supervisor/events.ts';
import { makeReviewDispatch, DEFAULT_REVIEW_TIMEOUT_MS, DEFAULT_REVIEW_POLL_INTERVAL_MS } from '../../src/supervisor/review.ts';
import type { MakeReviewDispatchOptions } from '../../src/supervisor/review.ts';
import { transcriptPathForSession } from '../../src/transcript/usage.ts';
import {
	EARLY_DEATH_FLOOR_MS,
	classifyEarlyDeath,
	extractLastAssistantEntry,
	makeEarlyDeathProbe,
} from '../../src/supervisor/early-death.ts';
import type { EarlyDeathVerdict } from '../../src/supervisor/early-death.ts';
import { withVerifiedPanePid } from '../helpers/verified-pane-pid-spawn.ts';
import {
	runPlanPhase,
	DEFAULT_PLAN_TIMEOUT_MS,
	DEFAULT_PLAN_POLL_INTERVAL_MS,
	type RunPlanPhaseOptions,
} from '../../src/supervisor/plan-runner.ts';
import type { IssueEntry } from '../../src/issues/types.ts';

const FIXTURES_DIR = join(import.meta.dir, '..', 'fixtures', 'early-death');
const DEAD_JSONL = readFileSync(join(FIXTURES_DIR, 'dead-on-first-turn.jsonl'), 'utf8');
const HEALTHY_JSONL = readFileSync(join(FIXTURES_DIR, 'healthy-planner.jsonl'), 'utf8');

function withTmpDirs(fn: (cwd: string, claudeDir: string) => void): void {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-early-death-cwd-'));
	const claudeDir = mkdtempSync(join(tmpdir(), 'cam-early-death-claude-'));
	try {
		fn(cwd, claudeDir);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(claudeDir, { recursive: true, force: true });
	}
}

describe('classifyEarlyDeath (pure core)', () => {
	test('classifies a frozen transcript whose last assistant entry is an API error as dead-on-first-turn', () => {
		const size = Buffer.byteLength(DEAD_JSONL, 'utf8');
		const verdict = classifyEarlyDeath({
			previousSample: { size, timestamp: 0 },
			currentSample: { size, timestamp: EARLY_DEATH_FLOOR_MS + 1_000 },
			jsonl: DEAD_JSONL,
		});

		expect(verdict.verdict).toBe('dead-on-first-turn');
		if (verdict.verdict === 'dead-on-first-turn') {
			expect(verdict.cause).toContain('529 Overloaded');
		}
	});

	test('classifies a still-growing multi-entry transcript with tool_use work as still-working', () => {
		// Sanity-check the fixture itself matches the story's description before
		// trusting the classification against it (real fixture, not the dead one).
		const entryCount = HEALTHY_JSONL.split('\n').filter((l) => l.trim() !== '').length;
		const toolUseCount = (HEALTHY_JSONL.match(/"type":"tool_use"/g) ?? []).length;
		expect(entryCount).toBeGreaterThan(60);
		expect(toolUseCount).toBeGreaterThanOrEqual(16);
		expect(Buffer.byteLength(HEALTHY_JSONL, 'utf8')).toBeGreaterThan(200_000);

		const previousSize = Buffer.byteLength(HEALTHY_JSONL.slice(0, Math.floor(HEALTHY_JSONL.length / 2)), 'utf8');
		const currentSize = Buffer.byteLength(HEALTHY_JSONL, 'utf8');

		const verdict = classifyEarlyDeath({
			previousSample: { size: previousSize, timestamp: 0 },
			currentSample: { size: currentSize, timestamp: EARLY_DEATH_FLOOR_MS + 5_000 },
			jsonl: HEALTHY_JSONL,
		});

		expect(verdict).toEqual({ verdict: 'still-working' });
	});

	test('reports still-working when a frozen transcript ends in normal work, not an API error', () => {
		const size = Buffer.byteLength(HEALTHY_JSONL, 'utf8');
		const verdict = classifyEarlyDeath({
			previousSample: { size, timestamp: 0 },
			currentSample: { size, timestamp: EARLY_DEATH_FLOOR_MS + 1_000 },
			jsonl: HEALTHY_JSONL,
		});

		expect(verdict).toEqual({ verdict: 'still-working' });
	});

	test('reports still-working when frozen for less than the floor window, even with an API error', () => {
		const size = Buffer.byteLength(DEAD_JSONL, 'utf8');
		const verdict = classifyEarlyDeath({
			previousSample: { size, timestamp: 0 },
			currentSample: { size, timestamp: EARLY_DEATH_FLOOR_MS - 1_000 },
			jsonl: DEAD_JSONL,
		});

		expect(verdict).toEqual({ verdict: 'still-working' });
	});

	test('reports still-working when there is no previous sample yet', () => {
		const size = Buffer.byteLength(DEAD_JSONL, 'utf8');
		const verdict = classifyEarlyDeath({
			previousSample: null,
			currentSample: { size, timestamp: 0 },
			jsonl: DEAD_JSONL,
		});

		expect(verdict).toEqual({ verdict: 'still-working' });
	});
});

describe('extractLastAssistantEntry', () => {
	test('extracts the last assistant entry as the cause text', () => {
		const entry = extractLastAssistantEntry(DEAD_JSONL);

		expect(entry).not.toBeNull();
		expect(entry?.isApiErrorMessage).toBe(true);
		// Verbatim, not a synthesized label: the reader can see the real upstream
		// error line, exactly as it appears in the transcript's content block.
		expect(entry?.text).toBe('API Error: 529 Overloaded. This is a server-side issue, usually temporary. Please retry.');
	});

	test('extracts the last assistant entry from a healthy transcript as normal work text', () => {
		const entry = extractLastAssistantEntry(HEALTHY_JSONL);

		expect(entry).not.toBeNull();
		expect(entry?.isApiErrorMessage).toBe(false);
		expect(entry?.text).toContain('Plan drafted');
	});

	test('returns null for a transcript with no assistant entries', () => {
		const entry = extractLastAssistantEntry('{"type":"user","message":{"role":"user","content":"hi"}}\n');
		expect(entry).toBeNull();
	});
});

describe('floor window', () => {
	test('derives a floor far below both the 30-minute host cap and the 60-minute container cap', () => {
		expect(EARLY_DEATH_FLOOR_MS).toBeLessThan(DEFAULT_PER_WORKER_TIMEOUT_MS / 10);
		expect(EARLY_DEATH_FLOOR_MS).toBeLessThan(DEFAULT_CONTAINER_WORKER_TIMEOUT_MS / 10);
	});
});

describe('makeEarlyDeathProbe (stateful)', () => {
	test('resolves the transcript under an injected claudeDir that is not the homedir default', () => {
		withTmpDirs((cwd, claudeDir) => {
			// Prove the injected claudeDir is neither the homedir default nor
			// whatever CLAUDE_CONFIG_DIR happens to be set to live in THIS
			// environment (measured, not assumed absent).
			const homedirDefault = join(homedir(), '.claude');
			expect(claudeDir).not.toBe(homedirDefault);
			const liveConfigDir = process.env['CLAUDE_CONFIG_DIR'];
			if (liveConfigDir !== undefined) {
				expect(claudeDir).not.toBe(liveConfigDir);
			}

			const uuid = 'probe-uuid-0001';
			const expectedPath = transcriptPathForSession(uuid, cwd, claudeDir);
			mkdirSync(dirname(expectedPath), { recursive: true });
			writeFileSync(expectedPath, DEAD_JSONL, 'utf8');

			// Two probe calls, frozen past the floor window: the ONLY way this
			// can resolve to dead-on-first-turn is if the real file at the
			// injected (non-homedir) claudeDir path was actually read both
			// times. A resolver bug reading a permanently-stale/absent homedir
			// path would report still-working forever instead.
			let clock = 0;
			const probe = makeEarlyDeathProbe({ cwd, claudeDir, nowFn: () => clock });
			expect(probe(uuid)).toEqual({ verdict: 'still-working' });
			clock += EARLY_DEATH_FLOOR_MS + 1_000;

			const verdict = probe(uuid);
			expect(verdict.verdict).toBe('dead-on-first-turn');
			if (verdict.verdict === 'dead-on-first-turn') {
				expect(verdict.cause).toContain('529 Overloaded');
			}
		});
	});

	test('reports still-working when the transcript is absent or unreadable', () => {
		withTmpDirs((cwd, claudeDir) => {
			// No file at all was ever written under this claudeDir/cwd pair.
			let clock = 0;
			const probe = makeEarlyDeathProbe({ cwd, claudeDir, nowFn: () => clock });
			const uuid = 'missing-uuid';

			expect(probe(uuid)).toEqual({ verdict: 'still-working' });
			clock += EARLY_DEATH_FLOOR_MS + 1_000;
			// Still absent after the floor window elapses: never fabricates a death.
			expect(probe(uuid)).toEqual({ verdict: 'still-working' });
		});
	});

	test('reports still-working when the injected reader throws (unreadable transcript)', () => {
		withTmpDirs((cwd, claudeDir) => {
			let clock = 0;
			const probe = makeEarlyDeathProbe({
				cwd,
				claudeDir,
				nowFn: () => clock,
				readFileFn: () => {
					throw new Error('EACCES: permission denied');
				},
			});
			const uuid = 'unreadable-uuid';

			expect(probe(uuid)).toEqual({ verdict: 'still-working' });
			clock += EARLY_DEATH_FLOOR_MS + 1_000;
			expect(probe(uuid)).toEqual({ verdict: 'still-working' });
		});
	});

	test('tracks samples independently per session uuid', () => {
		withTmpDirs((cwd, claudeDir) => {
			const deadUuid = 'session-dead';
			const healthyUuid = 'session-healthy';
			const deadPath = transcriptPathForSession(deadUuid, cwd, claudeDir);
			const healthyPath = transcriptPathForSession(healthyUuid, cwd, claudeDir);
			mkdirSync(dirname(deadPath), { recursive: true });
			writeFileSync(deadPath, DEAD_JSONL, 'utf8');
			writeFileSync(healthyPath, HEALTHY_JSONL, 'utf8');

			let clock = 0;
			const probe = makeEarlyDeathProbe({ cwd, claudeDir, nowFn: () => clock });
			probe(deadUuid);
			probe(healthyUuid);
			clock += EARLY_DEATH_FLOOR_MS + 1_000;
			// Healthy session grows between samples; the dead one stays frozen.
			writeFileSync(healthyPath, `${HEALTHY_JSONL}\n${HEALTHY_JSONL.split('\n').at(-2)}`, 'utf8');

			expect(probe(deadUuid).verdict).toBe('dead-on-first-turn');
			expect(probe(healthyUuid)).toEqual({ verdict: 'still-working' });
		});
	});

	test('regression (US-R2-001): a frozen dead-on-first-turn transcript still fires across many production-cadence poll ticks', () => {
		withTmpDirs((cwd, claudeDir) => {
			const uuid = 'production-cadence-uuid';
			const path = transcriptPathForSession(uuid, cwd, claudeDir);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, DEAD_JSONL, 'utf8');

			let clock = 0;
			const probe = makeEarlyDeathProbe({ cwd, claudeDir, nowFn: () => clock });

			// Drive the probe at the REAL production poll cadence (5s ticks, the
			// same as DEFAULT_POLL_INTERVAL_MS / DEFAULT_REVIEW_POLL_INTERVAL_MS /
			// DEFAULT_PLAN_POLL_INTERVAL_MS) for 40 simulated minutes (480 ticks)
			// against a permanently-frozen dead transcript. Before the
			// freeze-anchor fix, samples.set ran unconditionally on every call, so
			// the stored "previous" sample was always exactly one tick (5s) old
			// and elapsedMs never reached the 60s floor -- this never fired. With
			// the fix (only replace the stored sample when the byte size
			// changes), the anchor's timestamp stays pinned at tick 0 while the
			// size stays flat, so the frozen window accumulates across ticks.
			let fired = false;
			for (let tick = 0; tick < 480; tick++) {
				clock += 5_000;
				const verdict = probe(uuid);
				if (verdict.verdict === 'dead-on-first-turn') {
					fired = true;
					break;
				}
			}

			expect(fired).toBe(true);
		});
	});
});

// ---------------------------------------------------------------------------
// US-003 (CAM-479): the implementer and reviewer poll loops consult the
// early-death detector and terminate at the floor, cause-bearing, instead of
// waiting out the full timeout cap.
// ---------------------------------------------------------------------------

/** Cause text lifted from the real dead-on-first-turn fixture (not a synthesized string). */
const DEAD_ON_FIRST_TURN_CAUSE = extractLastAssistantEntry(DEAD_JSONL)?.text ?? '';

/** An earlyDeathProbeFn fake that reports dead-on-first-turn on every call. */
function alwaysDeadOnFirstTurn(_uuid: string): EarlyDeathVerdict {
	return { verdict: 'dead-on-first-turn', cause: DEAD_ON_FIRST_TURN_CAUSE };
}

/** Pane text with no recognizable sentinel (the pane is alive but the session is frozen). */
const FROZEN_PANE = 'Thinking...\n';

const IMPLEMENTER_PRD_PATH = '/fake/prd.json';
const IMPLEMENTER_HANDOFF_PATH = '/fake/handoff.json';
const IMPLEMENTER_WORKER_PANE_ID = '%3';

/** Build a prd snapshot with a single not-yet-passing story. */
function makeSingleStoryPrd(): PrdSnapshot {
	return {
		userStories: [{ id: 'US-001', priority: 1, passes: false, requires: null }],
		review: { roundsCompleted: 0, maxRounds: 3 },
	};
}

// Isolate implementer-backend/model resolution from the repo's live
// scripts/cam/project.toml, mirroring loop.test.ts's GENERIC_SUPERVISOR_CONFIG_PATH.
const GENERIC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cam-early-death-config-'));
const GENERIC_CONFIG_PATH = join(GENERIC_CONFIG_DIR, 'project.toml');
writeFileSync(GENERIC_CONFIG_PATH, '[backend]\nimplementer = "claude"\nreviewer = "claude"\n');

/** Build a RunSupervisorOptions fixture with injectable fakes for the poll-loop tests. */
function makeSupervisorOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	const spawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
	const capturePane: CapturePane = (_paneId) => FROZEN_PANE;
	const prd = makeSingleStoryPrd();
	const readPrd: ReadPrd = () => prd;
	const writePrd: WritePrd = (_prd) => {};
	const readHandoff: ReadHandoff = () => null;
	const clock: ClockFn = () => '2026-07-30T00:00:00Z';
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
		genUuid: () => '00000000-0000-0000-0000-000000000001',
		reviewDispatch,
		writeSessionMarker,
		isPaneAlive,
		workerPaneId: IMPLEMENTER_WORKER_PANE_ID,
		prdPath: IMPLEMENTER_PRD_PATH,
		handoffPath: IMPLEMENTER_HANDOFF_PATH,
		permissionMode: 'bypassPermissions',
		taskPrompt: 'Implement the next story from the PRD.',
		sleepFn: (_ms: number) => {},
		nowMs: () => 0,
		configPath: GENERIC_CONFIG_PATH,
		...overrides,
	};
	merged.spawn = withVerifiedPanePid(overrides.spawn ?? spawn);
	return merged;
}

describe('US-003 (CAM-479): implementer poll loop consults the early-death probe', () => {
	test('the implementer poll loop ends an early-death wait far below its timeout cap', async () => {
		const sleeps: number[] = [];
		const opts = makeSupervisorOpts({
			pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
			// A single dispatch attempt is enough to prove the POLL LOOP itself
			// (not the dead-worker retry chain) exits far below the cap.
			maxIterations: 1,
			randomFn: () => 0.5,
			sleepFn: (ms) => sleeps.push(ms),
			earlyDeathProbeFn: alwaysDeadOnFirstTurn,
		});

		await runSupervisor(opts);

		// Exactly one poll tick elapsed before the probe fired (not dozens/hundreds
		// of ticks approaching the real cap).
		const pollTicks = sleeps.filter((ms) => ms === DEFAULT_POLL_INTERVAL_MS);
		expect(pollTicks).toHaveLength(1);
		const totalElapsedMs = sleeps.reduce((sum, ms) => sum + ms, 0);
		expect(totalElapsedMs).toBeLessThan(DEFAULT_PER_WORKER_TIMEOUT_MS * 0.1);
	});

	test('an early-death implementer terminal carries session-died-early and the transcript cause in event, marker, and notification', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const markers: Array<{ reason: string; cause?: string }> = [];
		const notifications: string[] = [];
		const opts = makeSupervisorOpts({
			pollIntervalMs: 0,
			maxIterations: 1,
			randomFn: () => 0.5,
			sleepFn: (_ms) => {},
			earlyDeathProbeFn: alwaysDeadOnFirstTurn,
			logEvent: logger,
			writeDispatchFailedMarkerFn: (marker) => markers.push(marker),
			notifyOrchestrator: (line) => notifications.push(line),
		});

		await runSupervisor(opts);

		const dispatchFailedEvent = events.find((e) => e.kind === 'dispatch-failed');
		expect(dispatchFailedEvent).toBeDefined();
		expect(dispatchFailedEvent?.detail).toMatchObject({
			reason: 'session-died-early',
			cause: DEAD_ON_FIRST_TURN_CAUSE,
		});

		const marker = markers.find((m) => m.reason === 'session-died-early');
		expect(marker).toBeDefined();
		expect(marker?.cause).toBe(DEAD_ON_FIRST_TURN_CAUSE);

		const notification = notifications.find((n) => n.includes('session-died-early'));
		expect(notification).toBeDefined();
		expect(notification).toContain(DEAD_ON_FIRST_TURN_CAUSE);
	});

	test("a container implementer's longer cap does not change the early-death floor", async () => {
		const sleeps: number[] = [];
		const opts = makeSupervisorOpts({
			workerIsolation: 'container',
			pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
			maxIterations: 1,
			randomFn: () => 0.5,
			sleepFn: (ms) => sleeps.push(ms),
			earlyDeathProbeFn: alwaysDeadOnFirstTurn,
		});
		// Sanity: the container fallback ceiling really is the larger one, so a
		// pass here proves the floor, not merely a small configured cap.
		expect(opts.perWorkerTimeoutMs ?? DEFAULT_CONTAINER_WORKER_TIMEOUT_MS).not.toBe(DEFAULT_PER_WORKER_TIMEOUT_MS);

		await runSupervisor(opts);

		const pollTicks = sleeps.filter((ms) => ms === DEFAULT_POLL_INTERVAL_MS);
		expect(pollTicks).toHaveLength(1);
		const totalElapsedMs = sleeps.reduce((sum, ms) => sum + ms, 0);
		expect(totalElapsedMs).toBeLessThan(DEFAULT_CONTAINER_WORKER_TIMEOUT_MS * 0.1);
	});

	test('an early-death outcome feeds the existing dead-worker streak and adds no new retry mechanism', async () => {
		const sleeps: number[] = [];
		const { logger, events } = makeInMemoryEventLogger();
		const opts = makeSupervisorOpts({
			pollIntervalMs: 0,
			maxIterations: 50,
			randomFn: () => 0.5,
			sleepFn: (ms) => {
				if (ms > 0) sleeps.push(ms);
			},
			earlyDeathProbeFn: alwaysDeadOnFirstTurn,
			logEvent: logger,
		});

		const result = await runSupervisor(opts);

		// Same terminal shape as the pre-existing pane-died/timeout dead-worker
		// tests (loop.test.ts): blocks exactly at MAX_DEAD_WORKER_RETRIES, with
		// the SAME escalating backoff sequence -- no second retry mechanism.
		expect(result.status).toBe('blocked');
		expect(result.iterations).toBe(MAX_DEAD_WORKER_RETRIES);
		expect(sleeps).toEqual([NO_PROGRESS_BACKOFF_MS * 1, NO_PROGRESS_BACKOFF_MS * 2, NO_PROGRESS_BACKOFF_MS * 4]);
		const retryEvents = events.filter((e) => e.kind === 'pane-died-retry');
		expect(retryEvents).toHaveLength(MAX_DEAD_WORKER_RETRIES - 1);
		expect(retryEvents[0]?.detail).toMatchObject({ attempt: 1, pollOutcome: 'session-died-early' });
		expect(result.lastOutcome?.detail).toContain('dead-worker');
	});
});

describe('US-003 (CAM-479): reviewer poll loop consults the early-death probe', () => {
	const GENERIC_REVIEW_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cam-early-death-review-config-'));
	const GENERIC_REVIEW_CONFIG_PATH = join(GENERIC_REVIEW_CONFIG_DIR, 'project.toml');
	writeFileSync(GENERIC_REVIEW_CONFIG_PATH, '[backend]\nreviewer = "claude"\n');

	function makePrdWithReview(): PrdSnapshot {
		return { userStories: [], review: { roundsCompleted: 0, maxRounds: 3 } };
	}

	function makeReviewOpts(overrides: Partial<MakeReviewDispatchOptions> = {}): MakeReviewDispatchOptions {
		const spawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
		const capturePane: CapturePane = (_paneId) => FROZEN_PANE;
		const readPrd: ReadPrd = () => makePrdWithReview();
		const writePrd: WritePrd = (_prd) => {};

		return {
			spawn: withVerifiedPanePid(overrides.spawn ?? spawn),
			capturePane: overrides.capturePane ?? capturePane,
			readPrd: overrides.readPrd ?? readPrd,
			writePrd: overrides.writePrd ?? writePrd,
			workerPaneId: overrides.workerPaneId ?? '%7',
			isPaneAlive: overrides.isPaneAlive ?? (() => true),
			sleepFn: overrides.sleepFn ?? (() => {}),
			permissionMode: overrides.permissionMode ?? 'bypassPermissions',
			pollIntervalMs: overrides.pollIntervalMs ?? DEFAULT_REVIEW_POLL_INTERVAL_MS,
			timeoutMs: overrides.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
			now: overrides.now,
			configPath: GENERIC_REVIEW_CONFIG_PATH,
			...overrides,
		};
	}

	test('the reviewer poll loop ends an early-death wait far below its timeout cap', () => {
		const sleeps: number[] = [];
		const opts = makeReviewOpts({
			sleepFn: (ms) => sleeps.push(ms),
			earlyDeathProbeFn: alwaysDeadOnFirstTurn,
		});
		const dispatch = makeReviewDispatch(opts);

		const result = dispatch('11111111-2222-3333-4444-555555555555');

		expect(result.status).toBe('error');
		expect(result.detail).toContain('session-died-early');
		const pollTicks = sleeps.filter((ms) => ms === DEFAULT_REVIEW_POLL_INTERVAL_MS);
		expect(pollTicks).toHaveLength(1);
		const totalElapsedMs = sleeps.reduce((sum, ms) => sum + ms, 0);
		expect(totalElapsedMs).toBeLessThan(DEFAULT_REVIEW_TIMEOUT_MS * 0.1);
	});
});

// ---------------------------------------------------------------------------
// US-005 (CAM-479): the planner and auditor poll loops (plan-runner.ts) also
// consult the early-death probe, so all four dispatch poll loops share the
// same detector.
// ---------------------------------------------------------------------------

const MOCK_PLAN_ISSUE: IssueEntry = {
	id: 'CAM-479',
	title: 'Test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-01T00:00:00Z',
	updatedAt: '2026-07-01T00:00:00Z',
};

const GENERIC_PLAN_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cam-dispatch-early-death-plan-config-'));
const GENERIC_PLAN_CONFIG_PATH = join(GENERIC_PLAN_CONFIG_DIR, 'project.toml');
writeFileSync(GENERIC_PLAN_CONFIG_PATH, '[backend]\nplanner = "claude"\nauditor = "claude"\n');

/** Minimal spawnFn: respawn-pane/display-message/etc succeed by default. */
function makePlanSpawn(): SpawnFn {
	return (_cmd, _args) => ({ stdout: '', exitCode: 0 });
}

function makePlanOpts(overrides: Partial<RunPlanPhaseOptions> = {}): RunPlanPhaseOptions {
	return {
		spawnFn: withVerifiedPanePid(makePlanSpawn()),
		isPaneAlive: () => true,
		sleepFn: () => {},
		genUuid: () => 'test-uuid-dispatch-early-death',
		selectIssueFn: () => MOCK_PLAN_ISSUE,
		readPlanVerdictFn: () => null,
		preflightFn: () => ({ ok: true }),
		clock: (() => {
			let t = 0;
			return () => (t += 100);
		})(),
		plannerPaneId: '%3',
		paneCountMutexFn: () => 'available',
		pollIntervalMs: DEFAULT_PLAN_POLL_INTERVAL_MS,
		plannerTimeoutMs: DEFAULT_PLAN_TIMEOUT_MS,
		auditorTimeoutMs: DEFAULT_PLAN_TIMEOUT_MS,
		configPath: GENERIC_PLAN_CONFIG_PATH,
		...overrides,
	};
}

describe('US-005 (CAM-479): planner poll loop consults the early-death probe', () => {
	test('the planner poll loop ends an early-death wait far below its timeout cap', () => {
		const sleeps: number[] = [];
		const opts = makePlanOpts({
			sleepFn: (ms) => sleeps.push(ms),
			readPlannerReportFn: () => null, // never completes normally
			earlyDeathProbeFn: alwaysDeadOnFirstTurn,
		});

		const result = runPlanPhase(opts);

		expect(result.kind).toBe('planner-failed');
		const pollTicks = sleeps.filter((ms) => ms === DEFAULT_PLAN_POLL_INTERVAL_MS);
		expect(pollTicks).toHaveLength(1);
		const totalElapsedMs = sleeps.reduce((sum, ms) => sum + ms, 0);
		expect(totalElapsedMs).toBeLessThan(DEFAULT_PLAN_TIMEOUT_MS * 0.1);
	});
});

describe('US-005 (CAM-479): auditor poll loop consults the early-death probe', () => {
	test('the auditor poll loop ends an early-death wait far below its timeout cap', () => {
		const sleeps: number[] = [];
		const opts = makePlanOpts({
			sleepFn: (ms) => sleeps.push(ms),
			readPlannerReportFn: () => ({ written: true }), // planner completes immediately
			readPlanVerdictFn: () => null, // auditor never writes a verdict
			earlyDeathProbeFn: alwaysDeadOnFirstTurn,
		});

		const result = runPlanPhase(opts);

		expect(result.kind).toBe('auditor-timeout');
		const pollTicks = sleeps.filter((ms) => ms === DEFAULT_PLAN_POLL_INTERVAL_MS);
		// One tick to resolve the planner's completion signal, one more for the
		// auditor's own early-death check.
		expect(pollTicks).toHaveLength(2);
		const totalElapsedMs = sleeps.reduce((sum, ms) => sum + ms, 0);
		expect(totalElapsedMs).toBeLessThan(DEFAULT_PLAN_TIMEOUT_MS * 0.1);
	});
});

describe('US-005 (CAM-479): every dispatch poll loop consults the early-death probe', () => {
	test('every dispatch poll loop ends an early-death wait far below its timeout cap', async () => {
		// Implementer (loop.ts runSupervisor).
		const implementerSleeps: number[] = [];
		const implementerOpts = makeSupervisorOpts({
			pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
			maxIterations: 1,
			randomFn: () => 0.5,
			sleepFn: (ms) => implementerSleeps.push(ms),
			earlyDeathProbeFn: alwaysDeadOnFirstTurn,
		});

		// Reviewer (review.ts makeReviewDispatch).
		const reviewerSleeps: number[] = [];
		const reviewerSpawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
		const reviewerOpts: MakeReviewDispatchOptions = {
			spawn: withVerifiedPanePid(reviewerSpawn),
			capturePane: (_paneId) => FROZEN_PANE,
			readPrd: () => ({ userStories: [], review: { roundsCompleted: 0, maxRounds: 3 } }),
			writePrd: (_prd) => {},
			workerPaneId: '%7',
			isPaneAlive: () => true,
			sleepFn: (ms) => reviewerSleeps.push(ms),
			permissionMode: 'bypassPermissions',
			pollIntervalMs: DEFAULT_REVIEW_POLL_INTERVAL_MS,
			timeoutMs: DEFAULT_REVIEW_TIMEOUT_MS,
			configPath: GENERIC_CONFIG_PATH,
			earlyDeathProbeFn: alwaysDeadOnFirstTurn,
		};

		// Planner (plan-runner.ts runPlanPhase).
		const plannerSleeps: number[] = [];
		const plannerOpts = makePlanOpts({
			sleepFn: (ms) => plannerSleeps.push(ms),
			readPlannerReportFn: () => null,
			earlyDeathProbeFn: alwaysDeadOnFirstTurn,
		});

		// Auditor (plan-runner.ts runPlanPhase, planner completes instantly).
		const auditorSleeps: number[] = [];
		const auditorOpts = makePlanOpts({
			sleepFn: (ms) => auditorSleeps.push(ms),
			readPlannerReportFn: () => ({ written: true }),
			readPlanVerdictFn: () => null,
			earlyDeathProbeFn: alwaysDeadOnFirstTurn,
		});

		await runSupervisor(implementerOpts);
		const implementerElapsedMs = implementerSleeps.reduce((sum, ms) => sum + ms, 0);
		expect(implementerElapsedMs).toBeLessThan(DEFAULT_PER_WORKER_TIMEOUT_MS * 0.1);

		const reviewerResult = makeReviewDispatch(reviewerOpts)('22222222-3333-4444-5555-666666666666');
		expect(reviewerResult.status).toBe('error');
		const reviewerElapsedMs = reviewerSleeps.reduce((sum, ms) => sum + ms, 0);
		expect(reviewerElapsedMs).toBeLessThan(DEFAULT_REVIEW_TIMEOUT_MS * 0.1);

		const plannerResult = runPlanPhase(plannerOpts);
		expect(plannerResult.kind).toBe('planner-failed');
		const plannerElapsedMs = plannerSleeps.reduce((sum, ms) => sum + ms, 0);
		expect(plannerElapsedMs).toBeLessThan(DEFAULT_PLAN_TIMEOUT_MS * 0.1);

		const auditorResult = runPlanPhase(auditorOpts);
		expect(auditorResult.kind).toBe('auditor-timeout');
		const auditorElapsedMs = auditorSleeps.reduce((sum, ms) => sum + ms, 0);
		expect(auditorElapsedMs).toBeLessThan(DEFAULT_PLAN_TIMEOUT_MS * 0.1);
	});
});
