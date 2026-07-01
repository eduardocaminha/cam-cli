// test/commands/sidecar-set-phase.test.ts
//
// Unit tests for makeSetPhaseFn in src/commands/sidecar.ts (US-003, CAM-151).
//
// AC2: The production flip writes phase:implementing to .claude/cam-loop.local.md
//      (which the derived active reads as true), preserving all other state-file fields.
//
// Coverage:
//   1. No existing state file: creates file with phase:implementing, active:true.
//   2. Existing state file: overwrites phase to 'implementing', preserves other fields.
//   3. Accepts any LoopPhase value (e.g. 'idle', 'planning') — not only 'implementing'.
//   4. Non-fatal on FS error: does not throw when claudeDir is unreachable.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeSetPhaseFn } from '../../src/commands/sidecar.ts';
import { parseStateFile } from '../../src/commands/status.ts';
import { renderStateFile, writeStateFile } from '../../src/commands/next.ts';

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam-set-phase-'));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function claudeDir(): string {
	return join(tmpDir, '.claude');
}

function stateFilePath(): string {
	return join(claudeDir(), 'cam-loop.local.md');
}

function readState() {
	const contents = readFileSync(stateFilePath(), 'utf8');
	return parseStateFile(contents);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeSetPhaseFn (AC2 — production phase writer)', () => {
	test('no existing state file: creates file with phase:implementing and active:true', () => {
		const setPhaseFn = makeSetPhaseFn(claudeDir(), tmpDir);
		setPhaseFn('implementing');

		expect(existsSync(stateFilePath())).toBe(true);
		const state = readState();
		expect(state?.phase).toBe('implementing');
		expect(state?.active).toBe(true);
	});

	test('existing state file: phase is overwritten to implementing, active derives to true', () => {
		// Write an initial state with phase:planning
		mkdirSync(claudeDir(), { recursive: true });
		const initial = renderStateFile({
			maxIterations: 20,
			completionPromise: 'ALL_DONE',
			startedAt: '2026-07-01T00:00:00.000Z',
			pid: 12345,
			phase: 'planning',
			iteration: 3,
		});
		writeStateFile(tmpDir, initial, { force: true });

		const setPhaseFn = makeSetPhaseFn(claudeDir(), tmpDir);
		setPhaseFn('implementing');

		const state = readState();
		expect(state?.phase).toBe('implementing');
		expect(state?.active).toBe(true);
	});

	test('existing state file: preserves max_iterations field', () => {
		mkdirSync(claudeDir(), { recursive: true });
		const initial = renderStateFile({
			maxIterations: 42,
			completionPromise: 'COMPLETE',
			startedAt: '2026-07-01T00:00:00.000Z',
			pid: 99,
			phase: 'idle',
		});
		writeStateFile(tmpDir, initial, { force: true });

		makeSetPhaseFn(claudeDir(), tmpDir)('implementing');

		const state = readState();
		expect(state?.max_iterations).toBe(42);
	});

	test('writes phase:idle (any LoopPhase is accepted)', () => {
		const setPhaseFn = makeSetPhaseFn(claudeDir(), tmpDir);
		setPhaseFn('idle');

		const state = readState();
		expect(state?.phase).toBe('idle');
		expect(state?.active).toBe(false); // idle derives to false
	});

	test('writes phase:planning (any LoopPhase is accepted)', () => {
		const setPhaseFn = makeSetPhaseFn(claudeDir(), tmpDir);
		setPhaseFn('planning');

		const state = readState();
		expect(state?.phase).toBe('planning');
		expect(state?.active).toBe(false); // planning derives to false
	});

	test('non-fatal on FS error: does not throw when claudeDir path is unwritable', () => {
		// Use a read-only path that is guaranteed to fail (non-existent AND inside /dev/null)
		const badClaude = '/dev/null/.claude';
		const setPhaseFn = makeSetPhaseFn(badClaude, '/dev/null');
		// Should not throw (non-fatal contract)
		expect(() => setPhaseFn('implementing')).not.toThrow();
	});
});
