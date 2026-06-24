// test/logging/codex-guard.test.ts
//
// Unit tests for the codex-backend guard notice (US-007).
//
// The guard MUST:
//   1. Emit the exact literal string 'codex backend not yet wired (CAM-54)'.
//   2. NOT abort the spawn (emitSpawnResolution returns normally).
//
// All tests inject a fake emitNotice: no real stderr I/O.

import { test, expect, describe } from 'bun:test';
import {
	emitSpawnResolution,
	CODEX_GUARD_NOTICE,
	type SpawnResolutionEvent,
} from '../../src/logging/spawn-resolution.ts';

describe('codex backend guard', () => {
	test('emits the exact notice text when backend is codex', () => {
		const notices: string[] = [];
		emitSpawnResolution({
			phase: 'implementer',
			model: 'claude-sonnet-4-6',
			backend: 'codex',
			emitNotice: (msg) => notices.push(msg),
		});
		expect(notices).toHaveLength(1);
		expect(notices[0]).toBe('codex backend not yet wired (CAM-54)');
	});

	test('notice text matches the exported CODEX_GUARD_NOTICE constant', () => {
		const notices: string[] = [];
		emitSpawnResolution({
			phase: 'reviewer',
			model: 'claude-opus-4-8',
			backend: 'codex',
			emitNotice: (msg) => notices.push(msg),
		});
		expect(notices[0]).toBe(CODEX_GUARD_NOTICE);
	});

	test('guard does not abort the spawn (emitSpawnResolution returns normally)', () => {
		const notices: string[] = [];
		expect(() =>
			emitSpawnResolution({
				phase: 'orchestrator',
				model: 'claude-opus-4-8',
				backend: 'codex',
				emitNotice: (msg) => notices.push(msg),
			}),
		).not.toThrow();
		// The notice was still emitted (guard fired but did not abort).
		expect(notices).toHaveLength(1);
	});

	test('guard fires for all phases when backend is codex', () => {
		const phases = ['orchestrator', 'implementer', 'reviewer'] as const;
		for (const phase of phases) {
			const notices: string[] = [];
			emitSpawnResolution({
				phase,
				model: 'claude-sonnet-4-6',
				backend: 'codex',
				emitNotice: (msg) => notices.push(msg),
			});
			expect(notices).toHaveLength(1);
			expect(notices[0]).toBe(CODEX_GUARD_NOTICE);
		}
	});

	test('guard does not fire when backend is claude (not codex)', () => {
		const notices: string[] = [];
		emitSpawnResolution({
			phase: 'implementer',
			model: 'claude-sonnet-4-6',
			backend: 'claude',
			emitNotice: (msg) => notices.push(msg),
		});
		expect(notices).toHaveLength(0);
	});

	test('event is still written even when guard fires (codex backend)', () => {
		const events: SpawnResolutionEvent[] = [];
		const notices: string[] = [];
		emitSpawnResolution({
			phase: 'implementer',
			model: 'claude-sonnet-4-6',
			backend: 'codex',
			writeEvent: (e) => events.push(e),
			emitNotice: (msg) => notices.push(msg),
		});
		// Both the event and the notice are emitted.
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ phase: 'implementer', model: 'claude-sonnet-4-6', backend: 'codex' });
		expect(notices).toHaveLength(1);
		expect(notices[0]).toBe(CODEX_GUARD_NOTICE);
	});
});
