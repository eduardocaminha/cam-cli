// test/supervisor/dispatch-failed-marker.test.ts
//
// US-002 (CAM-433): durable dispatch-failure I/O, status projection, and the
// resolved invariant that `cam stop` preserves diagnostic failure evidence.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';

import { buildStatusReport } from '../../src/commands/status.ts';
import { performStop, type SpawnSyncFn } from '../../src/commands/stop.ts';
import {
	DISPATCH_FAILED_FILENAME,
	readDispatchFailedMarker,
	removeDispatchFailedMarker,
	writeDispatchFailedMarker,
	type DispatchFailedMarker,
} from '../../src/supervisor/dispatch-failed-marker.ts';

const MARKER: DispatchFailedMarker = {
	phase: 'implement',
	paneId: '%7',
	uuid: 'dispatch-uuid',
	exitCode: 1,
	stderr: 'worker process exited 1',
	reason: 'spawn-exited',
	timestamp: '2026-07-27T12:00:00.000Z',
};

function withTmpProject(fn: (cwd: string, claudeDir: string) => void): void {
	const cwd = createTestTmpdir('cam-dispatch-failed-');
	const claudeDir = join(cwd, '.claude');
	try {
		mkdirSync(claudeDir, { recursive: true });
		fn(cwd, claudeDir);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

function tmuxUnavailable(
	_cmd: string,
	_args: string[],
	_options: { encoding: 'utf8' },
): SpawnSyncReturns<string> {
	return { pid: 1, output: ['', '', ''], stdout: '', stderr: '', status: 1, signal: null };
}

const fakeSpawn = tmuxUnavailable as unknown as SpawnSyncFn;

describe('dispatch-failed marker I/O', () => {
	test('writes and reads every required diagnostic field, including stderr', () => {
		withTmpProject((_cwd, claudeDir) => {
			const markerPath = join(claudeDir, DISPATCH_FAILED_FILENAME);
			writeDispatchFailedMarker(markerPath, MARKER);

			expect(readDispatchFailedMarker(markerPath)).toEqual(MARKER);
		});
	});

	test('read returns null for absent, malformed, array, and wrong-field payloads', () => {
		withTmpProject((_cwd, claudeDir) => {
			const markerPath = join(claudeDir, DISPATCH_FAILED_FILENAME);
			expect(readDispatchFailedMarker(markerPath)).toBeNull();

			for (const payload of ['not json', '[]', ...Object.keys(MARKER).map((key) => {
				const wrong = { ...MARKER, [key]: null };
				return JSON.stringify(wrong);
			})]) {
				writeFileSync(markerPath, payload);
				expect(readDispatchFailedMarker(markerPath)).toBeNull();
			}
		});
	});

	test('preserves the cause field through a write and read round-trip', () => {
		withTmpProject((_cwd, claudeDir) => {
			const markerPath = join(claudeDir, DISPATCH_FAILED_FILENAME);
			const withCause: DispatchFailedMarker = { ...MARKER, cause: 'API Error: 529 overloaded' };
			writeDispatchFailedMarker(markerPath, withCause);

			expect(readDispatchFailedMarker(markerPath)).toEqual(withCause);
		});
	});

	test('still parses a marker written without a cause field', () => {
		withTmpProject((_cwd, claudeDir) => {
			const markerPath = join(claudeDir, DISPATCH_FAILED_FILENAME);
			writeFileSync(markerPath, JSON.stringify(MARKER));

			expect(readDispatchFailedMarker(markerPath)).toEqual(MARKER);
		});
	});

	test('remove is idempotent and write/remove failures never throw', () => {
		withTmpProject((_cwd, claudeDir) => {
			const markerPath = join(claudeDir, DISPATCH_FAILED_FILENAME);
			writeDispatchFailedMarker(markerPath, MARKER);

			removeDispatchFailedMarker(markerPath);
			expect(existsSync(markerPath)).toBe(false);
			expect(() => removeDispatchFailedMarker(markerPath)).not.toThrow();
			expect(() =>
				writeDispatchFailedMarker(join(claudeDir, 'missing-parent', DISPATCH_FAILED_FILENAME), MARKER),
			).not.toThrow();
			expect(() =>
				removeDispatchFailedMarker(join(claudeDir, 'missing-parent', DISPATCH_FAILED_FILENAME)),
			).not.toThrow();
		});
	});
});

describe('dispatch-failed marker consumers', () => {
	test('buildStatusReport projects the durable marker from the project-local .claude dir', () => {
		withTmpProject((cwd, claudeDir) => {
			writeDispatchFailedMarker(join(claudeDir, DISPATCH_FAILED_FILENAME), MARKER);

			expect(buildStatusReport({ cwd }).dispatchFailed).toEqual(MARKER);
		});
	});

	test('performStop deliberately preserves dispatch-failure evidence', () => {
		withTmpProject((cwd, claudeDir) => {
			const markerPath = join(claudeDir, DISPATCH_FAILED_FILENAME);
			writeDispatchFailedMarker(markerPath, MARKER);

			performStop({
				cwd,
				spawnSyncFn: fakeSpawn,
				listProcessesFn: () => [],
				workerIsolationReader: () => 'host',
			});

			expect(existsSync(markerPath)).toBe(true);
			expect(readDispatchFailedMarker(markerPath)).toEqual(MARKER);
		});
	});
});
