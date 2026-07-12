// test/commands/sidecar-orphan-sweep.test.ts
//
// Tests for US-002 (CAM-282): sweepOrphanedImplementBlockedMarker.
//
// Coverage:
//   AC1: a marker whose issueId corresponds to a CLOSED/shipped issue (stage
//        === 'shipped' OR status === 'abandoned') is removed.
//   AC2: a marker whose issueId is the current/OPEN issue (stage not shipped,
//        status open) is left untouched.
//   AC3 (partial, injectable-spawn proof): the sweep never calls anything
//        other than the injected BacklogSpawnFn -- no checkout/pull/stage.
//   AC5: explicit shipped-cleared vs open-not-cleared pairing.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sweepOrphanedImplementBlockedMarker } from '../../src/commands/sidecar.ts';
import { writeImplementBlockedMarker, readImplementBlockedMarker } from '../../src/supervisor/implement-blocked-marker.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import type { BacklogSpawnFn } from '../../src/issues/backlog.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cam-orphan-sweep-'));
	mkdirSync(join(dir, '.claude'), { recursive: true });
	return dir;
}

function makeEntry(overrides: Partial<IssueEntry> & { id: string }): IssueEntry {
	return {
		title: `Issue ${overrides.id}`,
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-01T00:00:00Z',
		...overrides,
	};
}

function emptyReturn(): SpawnSyncReturns<string> {
	return { stdout: '', stderr: '', status: 0, output: [], pid: 0, signal: null, error: undefined };
}

function makeBatchOutput(entries: IssueEntry[]): string {
	let output = '';
	for (const entry of entries) {
		const content = JSON.stringify(entry);
		const size = Buffer.byteLength(content, 'utf8');
		output += `deadbeef0000000000000000000000000000000000 blob ${size}\n${content}\n`;
	}
	return output;
}

/** Injectable fake spawn: serves a fixed backlog, records every call it sees (AC3 proof). */
function makeFakeSpawn(entries: IssueEntry[], calls: { cmd: string; args: string[] }[]): BacklogSpawnFn {
	return (cmd, args) => {
		calls.push({ cmd, args });
		if (args.includes('ls-tree')) {
			return {
				...emptyReturn(),
				stdout: entries.map((e) => `scripts/cam/issues/${e.id}.json`).join('\n') + '\n',
			};
		}
		return { ...emptyReturn(), stdout: makeBatchOutput(entries) };
	};
}

function writeMarker(markerPath: string, issueId: string): void {
	writeImplementBlockedMarker(markerPath, {
		issueId,
		story: 'US-001',
		reason: 'timeout',
		writtenAt: '2026-07-12T00:00:00Z',
		consecutiveCount: 1,
		keyHash: 'x',
	});
}

// ---------------------------------------------------------------------------
// AC1/AC5: shipped/abandoned issue -> marker cleared
// ---------------------------------------------------------------------------

describe('sweepOrphanedImplementBlockedMarker', () => {
	test('AC1: clears the marker when the referenced issue is stage=shipped', () => {
		const cwd = makeTmpDir();
		try {
			const markerPath = join(cwd, '.claude', 'marker.json');
			writeMarker(markerPath, '282');
			const calls: { cmd: string; args: string[] }[] = [];
			const spawn = makeFakeSpawn(
				[makeEntry({ id: 'CAM-282', stage: 'shipped', status: 'open' })],
				calls,
			);

			sweepOrphanedImplementBlockedMarker(markerPath, cwd, spawn);

			expect(existsSync(markerPath)).toBe(false);
			// AC3: only the injected spawn was used, and only for read ops.
			for (const call of calls) {
				expect(call.args).not.toContain('checkout');
				expect(call.args).not.toContain('pull');
				expect(call.args).not.toContain('add');
				expect(call.args).not.toContain('commit');
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('AC1/AC5: clears the marker when the referenced issue is status=abandoned', () => {
		const cwd = makeTmpDir();
		try {
			const markerPath = join(cwd, '.claude', 'marker.json');
			writeMarker(markerPath, '99');
			const spawn = makeFakeSpawn(
				[makeEntry({ id: 'CAM-99', stage: 'planned', status: 'abandoned' })],
				[],
			);

			sweepOrphanedImplementBlockedMarker(markerPath, cwd, spawn);

			expect(existsSync(markerPath)).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// -------------------------------------------------------------------------
	// AC2/AC5: current/open issue -> marker left untouched
	// -------------------------------------------------------------------------

	test('AC2/AC5: leaves the marker untouched when the referenced issue is open/in-flight', () => {
		const cwd = makeTmpDir();
		try {
			const markerPath = join(cwd, '.claude', 'marker.json');
			writeMarker(markerPath, '282');
			const spawn = makeFakeSpawn(
				[makeEntry({ id: 'CAM-282', stage: 'planned', status: 'open' })],
				[],
			);

			sweepOrphanedImplementBlockedMarker(markerPath, cwd, spawn);

			expect(existsSync(markerPath)).toBe(true);
			expect(readImplementBlockedMarker(markerPath)?.issueId).toBe('282');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('leaves the marker untouched when no matching backlog entry is found (best-effort)', () => {
		const cwd = makeTmpDir();
		try {
			const markerPath = join(cwd, '.claude', 'marker.json');
			writeMarker(markerPath, '282');
			const spawn = makeFakeSpawn(
				[makeEntry({ id: 'CAM-1', stage: 'shipped', status: 'open' })],
				[],
			);

			sweepOrphanedImplementBlockedMarker(markerPath, cwd, spawn);

			expect(existsSync(markerPath)).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('is a no-op (never calls spawn) when no marker is present', () => {
		const cwd = makeTmpDir();
		try {
			const markerPath = join(cwd, '.claude', 'marker.json');
			let spawnCalled = false;
			const spawn: BacklogSpawnFn = () => {
				spawnCalled = true;
				return emptyReturn();
			};

			expect(() => sweepOrphanedImplementBlockedMarker(markerPath, cwd, spawn)).not.toThrow();
			expect(spawnCalled).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
