// test/tmux-display-message.test.ts
//
// Unit tests for src/tmux/display-message.ts (US-001, CAM-359).
//
// Strategy: inject a fake spawn function returning configurable stdout/status
// so every malformed-output case is deterministic. We do NOT spin a real tmux
// server here (that is covered by test/integration/tmux-display-geometry.test.ts).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import {
	displayMessageArgv,
	sampleCursorGeometry,
	CURSOR_GEOMETRY_FORMAT,
	type CursorGeometry,
} from '../src/tmux/display-message.ts';
import { CAM_TMUX_SOCKET, type SpawnFn } from '../src/tmux/session.ts';

function fakeSpawn(stdout: string, status: number | null): SpawnFn {
	return (_cmd, _args, _opts) => {
		const result: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(stdout), Buffer.from('')],
			stdout: Buffer.from(stdout),
			stderr: Buffer.from(''),
			status,
			signal: null,
		};
		return result;
	};
}

describe('displayMessageArgv', () => {
	test('routes through tmuxArgs (-L cam) and builds -p -t <paneId> <format>', () => {
		const argv = displayMessageArgv('%3', CURSOR_GEOMETRY_FORMAT);
		expect(argv).toEqual([
			'-L',
			CAM_TMUX_SOCKET,
			'display-message',
			'-p',
			'-t',
			'%3',
			CURSOR_GEOMETRY_FORMAT,
		]);
	});
});

describe('sampleCursorGeometry: happy path', () => {
	test('parses a well-formed 4-field reading', () => {
		const spawnFn = fakeSpawn('12;5;80;24', 0);
		const geo = sampleCursorGeometry('%3', spawnFn);
		const expected: CursorGeometry = {
			cursorX: 12,
			cursorY: 5,
			paneWidth: 80,
			paneHeight: 24,
		};
		expect(geo).toEqual(expected);
	});
});

describe('sampleCursorGeometry: fails CLOSED on malformed output', () => {
	test('empty stdout yields null, never a fabricated (0,0) coordinate', () => {
		const spawnFn = fakeSpawn('', 0);
		expect(sampleCursorGeometry('%3', spawnFn)).toBeNull();
	});

	test('non-zero exit status yields null', () => {
		const spawnFn = fakeSpawn('12;5;80;24', 1);
		expect(sampleCursorGeometry('%3', spawnFn)).toBeNull();
	});

	test('a field that is not a base-10 integer (unknown format variable expanded to empty) yields null', () => {
		// tmux replaces an unknown/missing format variable with an empty string
		// rather than erroring, so a real malformed reading looks like a blank
		// field mid-string, e.g. cursor_y expanding to nothing.
		const spawnFn = fakeSpawn('12;;80;24', 0);
		expect(sampleCursorGeometry('%3', spawnFn)).toBeNull();
	});
});
