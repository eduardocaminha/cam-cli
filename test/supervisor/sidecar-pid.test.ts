// test/supervisor/sidecar-pid.test.ts
//
// Tests for the sidecarAlive() composite and the sidecar-liveness watcher pid
// helpers (US-002, CAM-207). Mirrors the existing watcherAlive()/WATCHER_PID_FILE
// pattern in src/supervisor/sidecar-pid.ts.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, test, expect } from 'bun:test';

import {
	SIDECAR_PID_FILE,
	writeSidecarPid,
	sidecarAlive,
	SIDECAR_LIVENESS_WATCHER_PID_FILE,
	writeSidecarLivenessWatcherPid,
	readSidecarLivenessWatcherPid,
	removeSidecarLivenessWatcherPid,
	removeSidecarLivenessWatcherPidIfExists,
} from '../../src/supervisor/sidecar-pid.ts';

describe('sidecarAlive() composite (US-002, CAM-207)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-sidecar-alive-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('returns false when the pid file is absent', () => {
		expect(sidecarAlive(tempDir)).toBe(false);
	});

	test('returns false when the pid file contains a non-numeric value', () => {
		writeFileSync(join(tempDir, SIDECAR_PID_FILE), 'not-a-pid', 'utf8');
		expect(sidecarAlive(tempDir)).toBe(false);
	});

	test('returns false when the pid file contains a non-positive integer', () => {
		writeFileSync(join(tempDir, SIDECAR_PID_FILE), '0', 'utf8');
		expect(sidecarAlive(tempDir)).toBe(false);
	});

	test('returns true when the pid is the current (live) process', () => {
		writeSidecarPid(tempDir, process.pid);
		expect(sidecarAlive(tempDir)).toBe(true);
	});

	test('returns false when the pid does not correspond to a live process', () => {
		// A pid extremely unlikely to be alive on any test runner.
		writeSidecarPid(tempDir, 999_999);
		expect(sidecarAlive(tempDir)).toBe(false);
	});

	test('never throws on a malformed pid file', () => {
		writeFileSync(join(tempDir, SIDECAR_PID_FILE), '', 'utf8');
		expect(() => sidecarAlive(tempDir)).not.toThrow();
	});
});

describe('sidecar-liveness watcher pid helpers (US-002, CAM-207)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-liveness-watcher-pid-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('SIDECAR_LIVENESS_WATCHER_PID_FILE is the expected literal', () => {
		expect(SIDECAR_LIVENESS_WATCHER_PID_FILE).toBe('.cam-sidecar-liveness-watcher.pid');
	});

	test('write then read round-trips the pid', () => {
		writeSidecarLivenessWatcherPid(tempDir, 4242);
		expect(readSidecarLivenessWatcherPid(tempDir)).toBe(4242);
	});

	test('read returns null when the pid file is absent', () => {
		expect(readSidecarLivenessWatcherPid(tempDir)).toBeNull();
	});

	test('read returns null for a malformed pid file', () => {
		writeFileSync(join(tempDir, SIDECAR_LIVENESS_WATCHER_PID_FILE), 'garbage', 'utf8');
		expect(readSidecarLivenessWatcherPid(tempDir)).toBeNull();
	});

	test('remove is idempotent when the file was never written', () => {
		expect(() => removeSidecarLivenessWatcherPid(tempDir)).not.toThrow();
	});

	test('removeIfExists only removes when present', () => {
		writeSidecarLivenessWatcherPid(tempDir, 1234);
		removeSidecarLivenessWatcherPidIfExists(tempDir);
		expect(readSidecarLivenessWatcherPid(tempDir)).toBeNull();
		// Calling again on an absent file must not throw.
		expect(() => removeSidecarLivenessWatcherPidIfExists(tempDir)).not.toThrow();
	});
});
