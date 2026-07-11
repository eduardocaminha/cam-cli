// test/commands/sidecar-clear-active.test.ts
//
// Unit tests for makeClearActive in src/commands/sidecar.ts (US-001, CAM-195,
// Defect 3 fix).
//
// AC2: clearActive no longer collapses phase to idle: after clearActive runs
//      over a phase:implementing file, the file still carries
//      phase:implementing.
//
// Coverage:
//   1. Existing phase:implementing file: clearActive preserves phase:implementing.
//   2. Existing phase:shipping file: clearActive preserves phase:shipping
//      (mirrors the CAM-191 ship-phase-survival scenario at the unit level).
//   3. No existing state file: clearActive creates one with phase:idle.
//   4. Unparseable existing state file: clearActive rewrites to phase:idle.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeClearActive } from '../../src/commands/sidecar.ts';
import { parseStateFile } from '../../src/commands/status.ts';
import { renderStateFile, writeStateFile } from '../../src/commands/next.ts';

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam-clear-active-'));
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

describe('makeClearActive (AC2 — phase-preserving, US-001 CAM-195)', () => {
	test('existing phase:implementing file: clearActive preserves phase:implementing', () => {
		mkdirSync(claudeDir(), { recursive: true });
		const initial = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-07-01T00:00:00.000Z',
			pid: 111,
			phase: 'implementing',
			iteration: 5,
		});
		writeStateFile(tmpDir, initial, { force: true });

		makeClearActive(claudeDir(), tmpDir)();

		const state = readState();
		expect(state?.phase).toBe('implementing');
		expect(state?.active).toBe(true);
		expect(state?.iteration).toBe(5);
	});

	test('existing phase:shipping file: clearActive preserves phase:shipping', () => {
		mkdirSync(claudeDir(), { recursive: true });
		const initial = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-07-01T00:00:00.000Z',
			pid: 222,
			phase: 'shipping',
		});
		writeStateFile(tmpDir, initial, { force: true });

		makeClearActive(claudeDir(), tmpDir)();

		const state = readState();
		expect(state?.phase).toBe('shipping');
	});

	test('no existing state file: clearActive creates one with phase:idle', () => {
		makeClearActive(claudeDir(), tmpDir)();

		expect(existsSync(stateFilePath())).toBe(true);
		const state = readState();
		expect(state?.phase).toBe('idle');
		expect(state?.active).toBe(false);
	});

	test('unparseable existing state file: clearActive rewrites to phase:idle', () => {
		mkdirSync(claudeDir(), { recursive: true });
		writeFileSync(stateFilePath(), 'not a valid state file', 'utf8');

		makeClearActive(claudeDir(), tmpDir)();

		const state = readState();
		expect(state?.phase).toBe('idle');
		expect(state?.active).toBe(false);
	});
});
