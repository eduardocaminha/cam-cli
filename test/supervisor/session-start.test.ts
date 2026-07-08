// test/supervisor/session-start.test.ts
//
// Unit tests for src/supervisor/session-start.ts (US-001, dashboard
// total-session elapsed).
//
// Coverage:
//   - write/read round trip.
//   - missing file returns null (never throws).
//   - malformed JSON / wrong-shape JSON returns null.
//   - a second write (simulating a "fresh loop start" within the same
//     sidecar session) overwrites the value only when explicitly called
//     again — the module itself has no idempotency guard; stability across
//     fresh-loop-starts is a property of WHEN sidecar.ts calls it (once,
//     before the poll loop), not of this module.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	SIDECAR_SESSION_START_FILE,
	readSidecarSessionStart,
	writeSidecarSessionStart,
} from '../../src/supervisor/session-start.ts';

describe('writeSidecarSessionStart / readSidecarSessionStart', () => {
	test('round trip: write then read returns the same ISO timestamp', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-session-start-'));
		try {
			writeSidecarSessionStart(dir, '2026-07-07T12:00:00.000Z');
			expect(readSidecarSessionStart(dir)).toBe('2026-07-07T12:00:00.000Z');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('write creates the parent directory when absent', () => {
		const base = mkdtempSync(join(tmpdir(), 'cam-session-start-mkdir-'));
		try {
			const claudeDir = join(base, 'nested', '.claude');
			writeSidecarSessionStart(claudeDir, '2026-07-07T12:00:00.000Z');
			expect(readSidecarSessionStart(claudeDir)).toBe('2026-07-07T12:00:00.000Z');
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('read returns null when the file is absent', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-session-start-absent-'));
		try {
			expect(readSidecarSessionStart(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('read returns null on malformed JSON', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-session-start-malformed-'));
		try {
			writeFileSync(join(dir, SIDECAR_SESSION_START_FILE), 'not json {', 'utf8');
			expect(readSidecarSessionStart(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('read returns null when sessionStartTs field is missing or wrong type', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-session-start-wrongshape-'));
		try {
			writeFileSync(join(dir, SIDECAR_SESSION_START_FILE), JSON.stringify({ foo: 'bar' }), 'utf8');
			expect(readSidecarSessionStart(dir)).toBeNull();

			writeFileSync(
				join(dir, SIDECAR_SESSION_START_FILE),
				JSON.stringify({ sessionStartTs: 12345 }),
				'utf8',
			);
			expect(readSidecarSessionStart(dir)).toBeNull();

			writeFileSync(join(dir, SIDECAR_SESSION_START_FILE), JSON.stringify(['array']), 'utf8');
			expect(readSidecarSessionStart(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a fresh loop start within the same session does not reset the value unless writeSidecarSessionStart is called again', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-session-start-stable-'));
		try {
			writeSidecarSessionStart(dir, '2026-07-07T12:00:00.000Z');
			// Simulate other per-cycle state churn (e.g. the loop state file being
			// rewritten many times) that never touches this marker.
			expect(readSidecarSessionStart(dir)).toBe('2026-07-07T12:00:00.000Z');
			expect(readSidecarSessionStart(dir)).toBe('2026-07-07T12:00:00.000Z');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
