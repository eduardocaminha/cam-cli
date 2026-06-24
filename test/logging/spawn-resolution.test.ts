// test/logging/spawn-resolution.test.ts
//
// Unit tests for the spawn-resolution structured event emitter (US-007).
//
// All tests inject a fake event-writer: no real fs, no real stderr.

import { test, expect, describe } from 'bun:test';
import {
	emitSpawnResolution,
	CODEX_GUARD_NOTICE,
	type SpawnResolutionEvent,
} from '../../src/logging/spawn-resolution.ts';

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

	test('emits no notice for non-codex backend', () => {
		const notices: string[] = [];
		emitSpawnResolution({
			phase: 'implementer',
			model: 'claude-sonnet-4-6',
			backend: 'claude',
			writeEvent: () => {},
			emitNotice: (msg) => notices.push(msg),
		});
		expect(notices).toHaveLength(0);
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

	test('CODEX_GUARD_NOTICE constant matches the required exact text', () => {
		expect(CODEX_GUARD_NOTICE).toBe('codex backend not yet wired (CAM-54)');
	});
});
