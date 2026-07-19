// test/logging/spawn-resolution.test.ts
//
// Unit tests for the spawn-resolution structured event emitter (US-007).
//
// All tests inject a fake event-writer: no real fs, no real stderr.

import { test, expect, describe } from 'bun:test';
import {
	emitSpawnResolution,
	type SpawnResolutionEvent,
} from '../../src/logging/spawn-resolution.ts';
import { runSupervisor } from '../../src/supervisor/loop.ts';
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
import { makeInMemoryEventLogger } from '../../src/supervisor/events.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';

describe('emitSpawnResolution - event shape', () => {
	test('emits a {phase, model, backend} event for the implementer phase', () => {
		const captured: SpawnResolutionEvent[] = [];
		emitSpawnResolution({
			phase: 'implementer',
			model: 'claude-sonnet-4-6',
			backend: 'claude',
			writeEvent: (e) => captured.push(e),
		});
		expect(captured).toHaveLength(1);
		expect(captured[0]).toEqual({
			phase: 'implementer',
			model: 'claude-sonnet-4-6',
			backend: 'claude',
		});
	});

	test('emits a {phase, model, backend} event for the orchestrator phase', () => {
		const captured: SpawnResolutionEvent[] = [];
		emitSpawnResolution({
			phase: 'orchestrator',
			model: 'claude-opus-4-8',
			backend: 'claude',
			writeEvent: (e) => captured.push(e),
		});
		expect(captured).toHaveLength(1);
		expect(captured[0]).toEqual({
			phase: 'orchestrator',
			model: 'claude-opus-4-8',
			backend: 'claude',
		});
	});

	test('emits a {phase, model, backend} event for the reviewer phase', () => {
		const captured: SpawnResolutionEvent[] = [];
		emitSpawnResolution({
			phase: 'reviewer',
			model: 'claude-opus-4-8',
			backend: 'claude',
			writeEvent: (e) => captured.push(e),
		});
		expect(captured).toHaveLength(1);
		expect(captured[0]).toEqual({
			phase: 'reviewer',
			model: 'claude-opus-4-8',
			backend: 'claude',
		});
	});

	test('does not throw when writeEvent is absent', () => {
		expect(() =>
			emitSpawnResolution({
				phase: 'implementer',
				model: 'claude-sonnet-4-6',
				backend: 'claude',
			}),
		).not.toThrow();
	});

	test('event object contains exactly phase, model, backend keys', () => {
		const captured: SpawnResolutionEvent[] = [];
		emitSpawnResolution({
			phase: 'implementer',
			model: 'claude-sonnet-4-6',
			backend: 'claude',
			writeEvent: (e) => captured.push(e),
		});
		const event = captured[0];
		expect(event).not.toBeNull();
		expect(event).not.toBeUndefined();
		expect(Object.keys(event!)).toEqual(['phase', 'model', 'backend']);
	});
});

// ---------------------------------------------------------------------------
// Production persistence path: runSupervisor call-site wiring (US-007)
// ---------------------------------------------------------------------------
//
// These tests assert that spawn-resolution events are actually persisted to the
// injected event logger when runSupervisor dispatches a worker. They exercise the
// CALL-SITE wiring, not emitSpawnResolution directly. A test MUST FAIL if the
// writeEvent argument is not threaded from logEvent at the call-site.

/** Minimal story-passes PRD for the implement branch. */
function makeImplPrd(): PrdSnapshot {
	return {
		userStories: [{ id: 'US-001', priority: 1, passes: false }],
	};
}

/** Pane text with DONE sentinel for US-001. */
function donePane(): string {
	return `Implemented\nCAM_IMPLEMENTER_STATUS=DONE story=US-001\n`;
}

function makeBaseOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	const spawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
	const capturePane: CapturePane = () => donePane();
	const prd = makeImplPrd();
	let called = false;
	const readPrd: ReadPrd = () => {
		// First call: return the story as pending. Subsequent calls return it done
		// so the loop sees completion after one worker pass.
		if (!called) { called = true; return prd; }
		return { userStories: [{ id: 'US-001', priority: 1, passes: true }], review: { roundsCompleted: 1, lastVerdict: 'CLEAN' } };
	};
	const writePrd: WritePrd = (_p) => {};
	const readHandoff: ReadHandoff = () => ({
		lastCompletedStory: { id: 'US-001', title: 'Story US-001' },
		branchName: 'test',
		timestamp: '2026-01-01T00:00:00Z',
	});
	const clock: ClockFn = () => '2026-06-24T00:00:00Z';
	const reviewDispatch: ReviewDispatch = (_uuid) => ({ status: 'ok', detail: 'CLEAN' });
	const writeSessionMarker: WriteSessionMarker = (_storyId, _uuid) => {};
	const isPaneAlive: IsPaneAlive = () => true;

	return {
		spawn,
		capturePane,
		readPrd,
		writePrd,
		readHandoff,
		clock,
		genUuid: () => 'test-uuid-0001',
		reviewDispatch,
		writeSessionMarker,
		isPaneAlive,
		workerPaneId: '%3',
		prdPath: '/fake/prd.json',
		handoffPath: '/fake/handoff.json',
		permissionMode: 'bypassPermissions',
		taskPrompt: 'Implement the next story.',
		sleepFn: (_ms) => {},
		nowMs: () => 0,
		...overrides,
	};
}

describe('runSupervisor - spawn-resolution event persistence (production wiring)', () => {
	test('emits a spawn-resolution event with {phase, model, backend} when logEvent is wired', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const opts = makeBaseOpts({ logEvent: logger });

		await runSupervisor(opts);

		const spawnEvents = events.filter((e) => e.kind === 'spawn-resolution');
		expect(spawnEvents.length).toBeGreaterThanOrEqual(1);

		const implEvent = spawnEvents.find((e) => (e.detail as { phase?: string }).phase === 'implementer');
		expect(implEvent).not.toBeUndefined();
		expect(implEvent?.detail).toMatchObject({ phase: 'implementer' });
		expect(typeof (implEvent?.detail as { model?: string }).model).toBe('string');
		expect(typeof (implEvent?.detail as { backend?: string }).backend).toBe('string');
	});

	test('spawn-resolution event carries correct uuid matching the worker invocation', async () => {
		const { logger, events } = makeInMemoryEventLogger();
		const opts = makeBaseOpts({ logEvent: logger });

		await runSupervisor(opts);

		const spawnEvent = events.find((e) => e.kind === 'spawn-resolution');
		expect(spawnEvent).not.toBeUndefined();
		// uuid must be a non-empty string — same uuid as the worker-start event.
		expect(typeof spawnEvent?.uuid).toBe('string');
		expect(spawnEvent?.uuid.length).toBeGreaterThan(0);

		const workerStart = events.find((e) => e.kind === 'worker-start');
		expect(workerStart).not.toBeUndefined();
		expect(spawnEvent?.uuid).toBe(workerStart?.uuid);
	});

	test('no spawn-resolution event is emitted when logEvent is absent (backward compat)', async () => {
		// Documents the no-op behaviour when logEvent is absent. The supervisor must
		// not throw; it simply drops the event.
		const opts = makeBaseOpts({ logEvent: undefined });

		const result = await runSupervisor(opts);
		// Should complete without error.
		expect(result.status).toBe('complete');
	});
});
