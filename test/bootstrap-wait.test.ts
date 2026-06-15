// test/bootstrap-wait.test.ts
//
// Unit tests for the bootstrap-wait helper (US-006).
//
// What we cover:
//   - waitForOrchestrator: returns true when marker present + orch alive.
//   - waitForOrchestrator: returns false on timeout when marker never appears.
//   - waitForOrchestrator: returns false when marker present but orch not alive.
//   - waitForOrchestrator: polls repeatedly until success.
//   - ORCH_READY_MARKER: constant exported and equals '.cam-orch-ready'.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import { waitForOrchestrator, ORCH_READY_MARKER } from '../src/tmux/bootstrap-wait.ts';
import type { SpawnFn } from '../src/tmux/session.ts';

// --- Fake spawn helpers -----------------------------------------------------

/** Build a fake SpawnFn for orchestratorAlive. Returns true when orchAlive. */
function makeOrchSpawnFn(orchAlive: boolean): SpawnFn {
	return ((cmd: string, args: string[]) => {
		const subcommand = args[0] === '-L' ? args[2] : args[0];
		const base: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};
		if (subcommand === 'list-panes') {
			// orchestratorAlive queries #{pane_index}\t#{pane_current_command}
			return {
				...base,
				stdout: orchAlive ? Buffer.from('0\tclaude\n') : Buffer.from('0\tsh\n'),
			};
		}
		return base;
	}) as SpawnFn;
}

// --- ORCH_READY_MARKER constant -------------------------------------------

describe('ORCH_READY_MARKER', () => {
	test('is the expected filename', () => {
		expect(ORCH_READY_MARKER).toBe('.cam-orch-ready');
	});
});

// --- waitForOrchestrator --------------------------------------------------

describe('waitForOrchestrator', () => {
	test('returns true immediately when marker exists and orchestrator is alive', () => {
		const spawnFn = makeOrchSpawnFn(true);
		const result = waitForOrchestrator({
			claudeDir: '/fake/.claude',
			sessionName: 'cam-orch-test-abc',
			spawnFn,
			statFn: () => true, // marker always present
			sleepFn: () => {}, // no-op
			timeoutMs: 5_000,
			pollIntervalMs: 100,
		});
		expect(result).toBe(true);
	});

	test('returns false on timeout when marker never appears', () => {
		const spawnFn = makeOrchSpawnFn(true);
		let pollCount = 0;
		const result = waitForOrchestrator({
			claudeDir: '/fake/.claude',
			sessionName: 'cam-orch-test-abc',
			spawnFn,
			statFn: () => false, // marker never present
			sleepFn: () => { pollCount += 1; },
			timeoutMs: 10, // tiny budget: loop exits almost immediately
			pollIntervalMs: 5,
		});
		expect(result).toBe(false);
	});

	test('returns false when marker present but orchestrator is not alive', () => {
		const spawnFn = makeOrchSpawnFn(false); // orch NOT running claude
		const result = waitForOrchestrator({
			claudeDir: '/fake/.claude',
			sessionName: 'cam-orch-test-abc',
			spawnFn,
			statFn: () => true, // marker present
			sleepFn: () => {},
			timeoutMs: 10,
			pollIntervalMs: 5,
		});
		expect(result).toBe(false);
	});

	// US-FIX-005: liveness re-validation after seeing the marker (defense-in-depth).
	// The marker can be a stale artifact from a previous crashed orchestrator.
	// waitForOrchestrator must re-check orchestratorAlive even when the marker
	// is present, so a stale marker does not cause the thin-proxy to send-keys
	// into a pane where the agent is not running.
	test('US-FIX-005: re-validates liveness after seeing marker (stale marker does not cause proceed)', () => {
		// Marker present from the start (as if left by a crashed previous session).
		// orchestratorAlive returns false (no claude process in the pane).
		const spawnFn = makeOrchSpawnFn(false);
		const result = waitForOrchestrator({
			claudeDir: '/fake/.claude',
			sessionName: 'cam-orch-test-abc',
			spawnFn,
			statFn: () => true, // stale marker always present
			sleepFn: () => {},
			timeoutMs: 5, // tiny budget so the loop exits quickly
			pollIntervalMs: 2,
		});
		// Must return false: the liveness re-check must prevent a false positive.
		expect(result).toBe(false);
	});

	test('US-FIX-005: proceeds when marker present AND orchestrator alive (agent wrote marker after boot)', () => {
		// This is the happy path: the orchestrator agent booted, wrote the marker,
		// and is still running. The thin-proxy should get true and proceed.
		const spawnFn = makeOrchSpawnFn(true);
		const result = waitForOrchestrator({
			claudeDir: '/fake/.claude',
			sessionName: 'cam-orch-test-abc',
			spawnFn,
			statFn: () => true, // marker written by agent after boot
			sleepFn: () => {},
			timeoutMs: 5_000,
			pollIntervalMs: 100,
		});
		expect(result).toBe(true);
	});

	test('polls until marker appears then returns true', () => {
		const spawnFn = makeOrchSpawnFn(true);
		let pollCalls = 0;
		const APPEAR_AFTER = 3; // marker appears after 3 sleeps

		const result = waitForOrchestrator({
			claudeDir: '/fake/.claude',
			sessionName: 'cam-orch-test-abc',
			spawnFn,
			statFn: () => pollCalls >= APPEAR_AFTER, // marker absent initially
			sleepFn: (ms: number) => {
				// Suppress unused parameter warning
				void ms;
				pollCalls += 1;
			},
			timeoutMs: 60_000,
			pollIntervalMs: 1,
		});
		expect(result).toBe(true);
		// Should have polled at least APPEAR_AFTER times.
		expect(pollCalls).toBeGreaterThanOrEqual(APPEAR_AFTER);
	});

	test('statFn receives the correct marker path (claudeDir + ORCH_READY_MARKER)', () => {
		const spawnFn = makeOrchSpawnFn(true);
		const seenPaths: string[] = [];

		waitForOrchestrator({
			claudeDir: '/my-project/.claude',
			sessionName: 'cam-orch-test-abc',
			spawnFn,
			statFn: (path: string) => {
				seenPaths.push(path);
				return true; // found immediately
			},
			sleepFn: () => {},
			timeoutMs: 5_000,
			pollIntervalMs: 100,
		});

		expect(seenPaths.length).toBeGreaterThan(0);
		expect(seenPaths[0]).toContain(ORCH_READY_MARKER);
		expect(seenPaths[0]).toContain('/my-project/.claude');
	});
});
