// test/unit/status-render.test.ts
//
// US-004 (CAM-401): `runStatus` renders the projected marker/merge-watch
// state and the closed why-not-moving diagnostic (US-002/US-003) in its
// human-readable print path.
//
// What we cover (per acceptance criteria):
//   1. Projected blocker/wedge/stall markers + merge-watch position
//      (prNumber, pollCount) render using the shared screen.ts helpers.
//   2. A dedicated "Diagnostic" section shows the fixed message + suggested
//      next command.
//   3. Sparse output when no markers are set and the cycle is progressing:
//      no empty "Markers" section, still shows the progressing diagnostic.
//   4. runStatus stays read-only and always exits 0.
// AC5 (glyph vocabulary vs. divider color) is reviewer-judgment; not covered
// by an oracle here.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStatus } from '../../src/commands/status.ts';
import {
	MERGE_WATCH_FILENAME,
	SHIP_STALLED_FILENAME,
	writeMergeWatchState,
	writeShipStalledMarker,
} from '../../src/release/merge-watch.ts';
import { GATE_FILENAME, writeGateFile } from '../../src/supervisor/gate.ts';
import { IMPLEMENT_BLOCKED_FILENAME, writeImplementBlockedMarker } from '../../src/supervisor/implement-blocked-marker.ts';

function withTmpCwd(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'cam-status-render-'));
	try {
		mkdirSync(join(dir, '.claude'), { recursive: true });
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function captureRunStatus(opts: Parameters<typeof runStatus>[0]): { out: string; code: number } {
	const original = process.stdout.write.bind(process.stdout);
	const chunks: string[] = [];
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stdout.write;
	let code: number;
	try {
		code = runStatus(opts);
	} finally {
		process.stdout.write = original;
	}
	return { out: chunks.join(''), code };
}

describe('runStatus: Markers section (AC1)', () => {
	test('renders a projected blocker marker + the merge-watch position (prNumber, pollCount)', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			writeShipStalledMarker(join(claudeDir, SHIP_STALLED_FILENAME), {
				prNumber: 42,
				prUrl: null,
				issueId: 'CAM-401',
				reason: 'ci-red',
				ts: '2026-07-23T00:00:00Z',
			});
			writeMergeWatchState(join(claudeDir, MERGE_WATCH_FILENAME), {
				prNumber: 42,
				mergedBranch: 'cam/issue-401',
				pollCount: 3,
			});

			const { out, code } = captureRunStatus({ cwd: dir });
			expect(code).toBe(0);
			expect(out).toMatch(/Markers/);
			expect(out).toMatch(/ship-stalled/);
			expect(out).toMatch(/#42/);
			expect(out).toMatch(/ci-red/);
			expect(out).toMatch(/merge-watch/);
			expect(out).toMatch(/poll 3/);
		});
	});

	test('renders every present marker (implement-blocked + gate), one row each', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			writeImplementBlockedMarker(join(claudeDir, IMPLEMENT_BLOCKED_FILENAME), {
				issueId: 'CAM-401',
				story: 'US-004',
				reason: 'Worker reported BLOCKED_QUALITY story=US-004 reason=tests_failed',
				writtenAt: '2026-07-23T00:00:00Z',
				consecutiveCount: 1,
				keyHash: 'deadbeef',
			});
			writeGateFile(join(claudeDir, GATE_FILENAME), {
				gate: 'in-progress-work-conflict',
				options: ['proceed', 'abort'],
				context: 'a conflicting change was detected',
			});

			const { out } = captureRunStatus({ cwd: dir });
			expect(out).toMatch(/Markers/);
			expect(out).toMatch(/implement-blocked/);
			expect(out).toMatch(/US-004/);
			expect(out).toMatch(/gate/);
			expect(out).toMatch(/in-progress-work-conflict/);
		});
	});
});

describe('runStatus: Diagnostic section (AC2)', () => {
	test('shows the fixed why-not-moving message + suggested next command for a blocking marker', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			writeShipStalledMarker(join(claudeDir, SHIP_STALLED_FILENAME), {
				prNumber: 7,
				prUrl: null,
				issueId: null,
				reason: 'timeout',
				ts: '2026-07-23T00:00:00Z',
			});

			const { out } = captureRunStatus({ cwd: dir });
			expect(out).toMatch(/Diagnostic/);
			expect(out).toMatch(/Ship phase is stalled/);
			expect(out).toMatch(/next: cam ship --finalize/);
		});
	});
});

describe('runStatus: sparse output when progressing (AC3)', () => {
	test('idle, no markers, no merge-watch -> no "Markers" section, still shows the progressing diagnostic', () => {
		withTmpCwd((dir) => {
			const { out, code } = captureRunStatus({ cwd: dir });
			expect(code).toBe(0);
			expect(out).not.toMatch(/Markers/);
			expect(out).toMatch(/Diagnostic/);
			expect(out).toMatch(/Nothing blocking: the cycle is progressing normally\./);
			expect(out).toMatch(/next: cam status/);
		});
	});

	test('active loop, no markers, no merge-watch -> no "Markers" section, still shows the progressing diagnostic', () => {
		withTmpCwd((dir) => {
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				['---', 'active: true', 'iteration: 3', 'max_iterations: 30', '---', ''].join('\n'),
			);

			const { out, code } = captureRunStatus({ cwd: dir });
			expect(code).toBe(0);
			expect(out).not.toMatch(/Markers/);
			expect(out).toMatch(/Diagnostic/);
			expect(out).toMatch(/Nothing blocking: the cycle is progressing normally\./);
		});
	});
});

describe('runStatus: read-only, always exits 0 (AC4)', () => {
	test('exits 0 even with every marker + merge-watch present, and never writes any file', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			writeShipStalledMarker(join(claudeDir, SHIP_STALLED_FILENAME), {
				prNumber: 1,
				prUrl: null,
				issueId: null,
				reason: 'x',
				ts: '2026-07-23T00:00:00Z',
			});
			writeMergeWatchState(join(claudeDir, MERGE_WATCH_FILENAME), {
				prNumber: 1,
				mergedBranch: 'cam/issue-401',
				pollCount: 0,
			});

			const { code } = captureRunStatus({ cwd: dir });
			expect(code).toBe(0);
		});
	});
});
