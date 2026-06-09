// test/dashboard.test.ts
//
// Tests for `cam dashboard`. We exercise three layers:
//
//   1. Pure helpers (parseRecentProgress, snapshot composition) — fast,
//      no IO, easy to lock the format.
//   2. `readSnapshot` — full IO read against a tmpdir cwd, mirroring how
//      runStatus's tests work.
//   3. `runDashboard` integration — uses fake `reader` / `writer` shapes
//      (DashboardReader / DashboardWriter) injected via options, so the
//      test never touches real stdin/stdout. Asserts the alt-screen
//      lifecycle: enter → render → `q` keypress → exit alt-screen.
//
// The runtime loop polls every `pollIntervalMs`; we set it to 1 ms in
// tests so a `maxTicks: 2` run completes in a couple of milliseconds.

import { describe, expect, it, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import React from 'react';

import {
	CURSOR,
	DEFAULT_POLL_INTERVAL_MS,
	RECENT_ENTRIES_COUNT,
	composeDashboard,
	parseRecentProgress,
	readRecentProgress,
	readSnapshot,
	runDashboard,
	type DashboardData,
	type DashboardReader,
	type DashboardWriter,
} from '../src/commands/dashboard.ts';
import { DashboardApp, STORY_TOKENS_PLACEHOLDER } from '../src/ui/Dashboard.tsx';
import type { TranscriptUsage } from '../src/transcript/usage.ts';

// --- Fakes -----------------------------------------------------------------

function makeRecordingWriter(): DashboardWriter & { chunks: string[] } {
	const chunks: string[] = [];
	const writer: DashboardWriter & { chunks: string[] } = {
		chunks,
		write(chunk: string): boolean {
			chunks.push(chunk);
			return true;
		},
	};
	return writer;
}

interface FakeReaderHandle extends DashboardReader {
	emit(data: Buffer): void;
	listeners: Array<(data: Buffer) => void>;
}

function makeFakeReader(): FakeReaderHandle {
	const listeners: Array<(data: Buffer) => void> = [];
	const reader: FakeReaderHandle = {
		listeners,
		isTTY: false,
		on(event, listener) {
			if (event === 'data') listeners.push(listener);
		},
		off(event, listener) {
			if (event !== 'data') return;
			const idx = listeners.indexOf(listener);
			if (idx >= 0) listeners.splice(idx, 1);
		},
		emit(data: Buffer) {
			// Iterate over a snapshot — listeners may detach themselves.
			for (const l of [...listeners]) l(data);
		},
	};
	return reader;
}

// --- Constants -------------------------------------------------------------

describe('dashboard constants', () => {
	test('DEFAULT_POLL_INTERVAL_MS is 2000 (US-009 AC4: every 2s)', () => {
		expect(DEFAULT_POLL_INTERVAL_MS).toBe(2000);
	});

	test('RECENT_ENTRIES_COUNT is 5 (US-009 AC2: last 5 progress entries)', () => {
		expect(RECENT_ENTRIES_COUNT).toBe(5);
	});
});

// --- composeDashboard ------------------------------------------------------

describe('composeDashboard', () => {
	const baseData: DashboardData = {
		branchName: 'cam/test-branch',
		currentStoryId: 'US-009',
		currentStoryTitle: 'dashboard',
		iteration: 7,
		maxIterations: 30,
		startedAtMs: Date.parse('2026-04-28T22:00:00Z'),
		nowMs: Date.parse('2026-04-28T22:30:00Z'),
		paused: false,
		idle: false,
		recent: ['2026-04-28 - US-008', '2026-04-28 - US-007'],
	};

	test('first render uses CURSOR.clear; subsequent uses CURSOR.home', () => {
		const first = composeDashboard(baseData, 2000, true);
		const next = composeDashboard(baseData, 2000, false);
		expect(first.startsWith(CURSOR.clear)).toBe(true);
		expect(next.startsWith(CURSOR.home)).toBe(true);
		// Subsequent frame must NOT contain the alt-screen clear sequence.
		expect(next.includes(CURSOR.clear)).toBe(false);
	});

	test('frame includes branch, story id+title, iteration, wall-clock', () => {
		const frame = composeDashboard(baseData, 2000, true);
		expect(frame).toContain('cam/test-branch');
		expect(frame).toContain('US-009');
		expect(frame).toContain('dashboard');
		expect(frame).toContain('iter 7/30');
		// wall-clock is `30m 00s` for a 30-minute delta.
		expect(frame).toMatch(/30m/);
	});

	test('frame surfaces the recent entries (newest first)', () => {
		const frame = composeDashboard(baseData, 2000, true);
		expect(frame).toContain('2026-04-28 - US-008');
		expect(frame).toContain('2026-04-28 - US-007');
	});

	test('paused state renders the sleep banner', () => {
		const frame = composeDashboard({ ...baseData, paused: true }, 2000, true);
		expect(frame).toMatch(/loop is paused/);
	});

	test('idle (no state file) frame shows "(idle)" not the booting label', () => {
		const frame = composeDashboard(
			{
				...baseData,
				currentStoryId: '',
				currentStoryTitle: '',
				idle: true,
				startedAtMs: 0,
			},
			2000,
			true,
		);
		expect(frame).toContain('(idle)');
		// Wall-clock falls back to em-dash when no startedAt.
		expect(frame).toMatch(/elapsed —/);
	});

	test('frame includes the "press q or Ctrl+C to exit" hint', () => {
		const frame = composeDashboard(baseData, 2000, true);
		expect(frame).toMatch(/press q or Ctrl\+C/);
	});

	test('tokens row shows cached suffix when cacheRead > 0 (US-004)', () => {
		const frame = composeDashboard(
			{
				...baseData,
				tokensInput: 22_000,
				tokensOutput: 5_000,
				tokensCacheRead: 450_000,
				tokensCacheCreation: 10_000,
			},
			2000,
			true,
		);
		// in = 22000 + 10000 + 450000 = 482000 -> 482k; cached = 450k; out = 5k
		expect(frame).toContain('↑ 482k in (450k cached) · ↓ 5k out');
	});

	test('tokens row omits cached suffix when cacheRead is 0 (US-004)', () => {
		const frame = composeDashboard(
			{
				...baseData,
				tokensInput: 10_000,
				tokensOutput: 2_000,
				tokensCacheRead: 0,
				tokensCacheCreation: 5_000,
			},
			2000,
			true,
		);
		// in = 10000 + 5000 + 0 = 15k; no cached suffix; out = 2k
		expect(frame).toContain('↑ 15k in · ↓ 2k out');
		expect(frame).not.toContain('cached');
	});

	test('tokens row is absent when tokensInput is undefined (no transcript)', () => {
		// baseData has no token fields set, so the row must not appear.
		const frame = composeDashboard(baseData, 2000, true);
		expect(frame).not.toContain('tokens');
	});
});

// --- parseRecentProgress ---------------------------------------------------

describe('parseRecentProgress', () => {
	test('extracts the `## ...` header line of each section, newest first', () => {
		const body = [
			'## Codebase Patterns',
			'',
			'- some pattern.',
			'',
			'---',
			'',
			'## 2026-04-28 - US-001',
			'- did the thing',
			'---',
			'',
			'## 2026-04-28 - US-002',
			'- did another thing',
			'---',
			'',
		].join('\n');
		const out = parseRecentProgress(body);
		// Newest entries first: US-002 then US-001.
		expect(out).toEqual(['2026-04-28 - US-002', '2026-04-28 - US-001']);
	});

	test('caps at RECENT_ENTRIES_COUNT entries', () => {
		const sections: string[] = [];
		for (let i = 1; i <= 8; i += 1) {
			sections.push(`## 2026-04-28 - US-${String(i).padStart(3, '0')}`);
			sections.push('---');
		}
		const out = parseRecentProgress(sections.join('\n'));
		expect(out).toHaveLength(RECENT_ENTRIES_COUNT);
		// Newest (US-008) first.
		expect(out[0]).toBe('2026-04-28 - US-008');
	});

	test('skips non-entry sections (e.g. ## Codebase Patterns)', () => {
		const body = [
			'## Codebase Patterns',
			'',
			'- some pattern.',
			'',
			'---',
			'',
			'## 2026-04-28 - US-001',
			'- the deed',
			'---',
			'',
		].join('\n');
		const out = parseRecentProgress(body);
		// Codebase Patterns header is dropped because it doesn't match the
		// dated-entry pattern; only US-001 surfaces.
		expect(out).toEqual(['2026-04-28 - US-001']);
	});

	test('handles a missing trailing `---` (in-flight entry)', () => {
		const body = [
			'## 2026-04-28 - US-001',
			'- done',
			'---',
			'',
			'## 2026-04-28 - US-002',
			'- in flight, no closing fence yet',
		].join('\n');
		const out = parseRecentProgress(body);
		expect(out).toEqual(['2026-04-28 - US-002', '2026-04-28 - US-001']);
	});

	test('returns [] on an empty body', () => {
		expect(parseRecentProgress('')).toEqual([]);
	});
});

// --- readRecentProgress + readSnapshot (filesystem) -----------------------

describe('readRecentProgress (IO)', () => {
	test('returns [] when scripts/cam/progress.txt is absent', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-dash-no-progress-'));
		try {
			expect(readRecentProgress(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('reads from scripts/cam/progress.txt under cwd', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-dash-progress-'));
		try {
			mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });
			writeFileSync(
				join(dir, 'scripts', 'cam', 'progress.txt'),
				['## 2026-04-28 - US-Z', '- the deed', '---', ''].join('\n'),
			);
			const out = readRecentProgress(dir);
			expect(out).toEqual(['2026-04-28 - US-Z']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('readSnapshot', () => {
	test('idle when no state file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-dash-idle-'));
		try {
			const snap = readSnapshot({ cwd: dir, nowMs: Date.parse('2026-04-28T22:00:00Z') });
			expect(snap.idle).toBe(true);
			expect(snap.iteration).toBe(0);
			expect(snap.maxIterations).toBe(0);
			expect(snap.startedAtMs).toBe(0);
			expect(snap.paused).toBe(false);
			expect(snap.recent).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('active state populates iteration/maxIterations/startedAt + branchName + story', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-dash-active-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				[
					'---',
					'active: true',
					'iteration: 4',
					'max_iterations: 30',
					'started_at: "2026-04-28T22:00:00Z"',
					'---',
					'',
					'/cam-next',
					'',
				].join('\n'),
			);
			writeFileSync(
				join(dir, 'prd.json'),
				JSON.stringify({
					branchName: 'cam/feature-x',
					userStories: [{ id: 'US-009', title: 'dashboard', priority: 9, passes: false }],
				}),
			);
			const snap = readSnapshot({ cwd: dir, nowMs: Date.parse('2026-04-28T22:30:00Z') });
			expect(snap.idle).toBe(false);
			expect(snap.paused).toBe(false);
			expect(snap.iteration).toBe(4);
			expect(snap.maxIterations).toBe(30);
			expect(snap.startedAtMs).toBe(Date.parse('2026-04-28T22:00:00Z'));
			expect(snap.branchName).toBe('cam/feature-x');
			expect(snap.currentStoryId).toBe('US-009');
			expect(snap.currentStoryTitle).toBe('dashboard');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('paused state is detected when active:false', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-dash-paused-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				['---', 'active: false', 'iteration: 30', 'max_iterations: 30', '---', ''].join('\n'),
			);
			const snap = readSnapshot({ cwd: dir, nowMs: 0 });
			expect(snap.paused).toBe(true);
			expect(snap.idle).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('token fields populate when marker + transcript exist (US-003)', () => {
		const base = mkdtempSync(join(tmpdir(), 'cam-dash-tokens-'));
		try {
			// cwd — write the orch session marker.
			const cwd = join(base, 'project');
			mkdirSync(join(cwd, '.claude'), { recursive: true });
			const uuid = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
			writeFileSync(join(cwd, '.claude', '.cam-orch-session'), uuid, 'utf8');

			// claudeDir — write the fixture transcript JSONL.
			const claudeDir = join(base, 'claude-dir');
			const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
			mkdirSync(join(claudeDir, 'projects', encoded), { recursive: true });
			const jsonlLines = [
				JSON.stringify({
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 400,
							cache_read_input_tokens: 200,
							cache_creation_input_tokens: 50,
						},
					},
				}),
				JSON.stringify({
					message: {
						usage: {
							input_tokens: 500,
							output_tokens: 100,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			].join('\n');
			writeFileSync(join(claudeDir, 'projects', encoded, `${uuid}.jsonl`), jsonlLines, 'utf8');

			const snap = readSnapshot({ cwd, nowMs: 0, claudeDir });

			expect(snap.tokensInput).toBe(1500);
			expect(snap.tokensOutput).toBe(500);
			expect(snap.tokensCacheRead).toBe(200);
			expect(snap.tokensCacheCreation).toBe(50);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('token fields stay undefined when marker is absent (US-003)', () => {
		const base = mkdtempSync(join(tmpdir(), 'cam-dash-no-marker-'));
		try {
			const cwd = join(base, 'project');
			mkdirSync(join(cwd, '.claude'), { recursive: true });
			// No .cam-orch-session written.
			const claudeDir = join(base, 'claude-dir');
			mkdirSync(claudeDir, { recursive: true });

			// Should not throw.
			let snap: ReturnType<typeof readSnapshot> | undefined;
			expect(() => {
				snap = readSnapshot({ cwd, nowMs: 0, claudeDir });
			}).not.toThrow();

			expect(snap!.tokensInput).toBeUndefined();
			expect(snap!.tokensOutput).toBeUndefined();
			expect(snap!.tokensCacheRead).toBeUndefined();
			expect(snap!.tokensCacheCreation).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('per-story tokens populate from .cam-worker-<US>.session markers (US-014)', () => {
		const base = mkdtempSync(join(tmpdir(), 'cam-dash-story-tokens-'));
		try {
			const cwd = join(base, 'project');
			mkdirSync(join(cwd, '.claude'), { recursive: true });

			// prd.json: US-001 will have a marker, US-002 will not.
			writeFileSync(
				join(cwd, 'prd.json'),
				JSON.stringify({
					branchName: 'cam/feature-tokens',
					userStories: [
						{ id: 'US-001', title: 'first', priority: 1, passes: true },
						{ id: 'US-002', title: 'second', priority: 2, passes: false },
					],
				}),
			);

			// Worker session marker for US-001 only (in the project's .claude dir).
			const uuid = '11112222-3333-4444-5555-666677778888';
			writeFileSync(join(cwd, '.claude', '.cam-worker-US-001.session'), uuid, 'utf8');

			// Transcript JSONL for that uuid under the config claudeDir.
			const claudeDir = join(base, 'claude-dir');
			const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
			mkdirSync(join(claudeDir, 'projects', encoded), { recursive: true });
			writeFileSync(
				join(claudeDir, 'projects', encoded, `${uuid}.jsonl`),
				JSON.stringify({
					message: {
						usage: {
							input_tokens: 8000,
							output_tokens: 3000,
							cache_read_input_tokens: 1500,
							cache_creation_input_tokens: 500,
						},
					},
				}),
				'utf8',
			);

			const snap = readSnapshot({ cwd, nowMs: 0, claudeDir });

			expect(snap.storyTokens?.['US-001']).toEqual({
				input: 8000,
				output: 3000,
				cacheRead: 1500,
				cacheCreation: 500,
			});
			// No marker → absent from the map (the renderer shows a placeholder).
			expect(snap.storyTokens?.['US-002']).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('per-story tokens map is empty (never throws) when no markers exist (US-014)', () => {
		const base = mkdtempSync(join(tmpdir(), 'cam-dash-no-story-tokens-'));
		try {
			const cwd = join(base, 'project');
			mkdirSync(join(cwd, '.claude'), { recursive: true });
			writeFileSync(
				join(cwd, 'prd.json'),
				JSON.stringify({
					branchName: 'cam/x',
					userStories: [{ id: 'US-001', title: 'first', priority: 1, passes: false }],
				}),
			);
			const claudeDir = join(base, 'claude-dir');
			mkdirSync(claudeDir, { recursive: true });

			let snap: ReturnType<typeof readSnapshot> | undefined;
			expect(() => {
				snap = readSnapshot({ cwd, nowMs: 0, claudeDir });
			}).not.toThrow();
			expect(snap!.storyTokens).toEqual({});
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

// --- runDashboard (integration) -------------------------------------------

describe('runDashboard', () => {
	test('alt-screen lifecycle: enter → render → `q` → exit alt-screen', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-dash-run-'));
		try {
			const writer = makeRecordingWriter();
			const reader = makeFakeReader();

			// Schedule a `q` keypress shortly after the loop starts so the
			// dashboard tears down voluntarily (not via maxTicks).
			setTimeout(() => reader.emit(Buffer.from('q')), 5);

			const code = await runDashboard({
				cwd: dir,
				pollIntervalMs: 1,
				writer,
				reader,
				now: () => Date.parse('2026-04-28T22:00:00Z'),
				maxTicks: 50, // safety net — `q` should fire long before this.
			});
			expect(code).toBe(0);

			const all = writer.chunks.join('');
			// Lifecycle assertions:
			expect(all).toContain(CURSOR.enterAltScreen);
			expect(all).toContain(CURSOR.hideCursor);
			expect(all).toContain(CURSOR.clear); // first render
			// Cleanup writes show-cursor + leave-alt-screen at the end.
			expect(all).toContain(CURSOR.showCursor);
			expect(all).toContain(CURSOR.leaveAltScreen);
			// leaveAltScreen must appear after the first render's clear.
			const firstClearIdx = all.indexOf(CURSOR.clear);
			const leaveIdx = all.indexOf(CURSOR.leaveAltScreen);
			expect(leaveIdx).toBeGreaterThan(firstClearIdx);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Ctrl+C (\\x03) keypress triggers exit just like `q`', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-dash-ctrlc-'));
		try {
			const writer = makeRecordingWriter();
			const reader = makeFakeReader();
			setTimeout(() => reader.emit(Buffer.from('\x03')), 5);

			const code = await runDashboard({
				cwd: dir,
				pollIntervalMs: 1,
				writer,
				reader,
				now: () => 0,
				maxTicks: 50,
			});
			expect(code).toBe(0);
			expect(writer.chunks.join('')).toContain(CURSOR.leaveAltScreen);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('cleanup runs even when an error throws inside the loop (try/finally)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-dash-throw-'));
		try {
			// Writer throws on the FIRST render-frame call (writes 1+2 are the
			// alt-screen / hide-cursor lifecycle; write 3 is the first frame).
			// That ensures the loop's try/catch fires + sets exitCode=1, while
			// the finally still emits leaveAltScreen via the cleanup path.
			let calls = 0;
			const chunks: string[] = [];
			const writer: DashboardWriter & { chunks: string[] } = {
				chunks,
				write(chunk) {
					chunks.push(chunk);
					calls += 1;
					// Lifecycle writes are 1 (enterAltScreen) + 2 (hideCursor).
					// The first render frame is call #3 — fail there.
					if (calls === 3) {
						throw new Error('synthetic render failure');
					}
					return true;
				},
			};
			const reader = makeFakeReader();

			const code = await runDashboard({
				cwd: dir,
				pollIntervalMs: 1,
				writer,
				reader,
				now: () => 0,
				maxTicks: 50,
			});
			expect(code).toBe(1);
			// Cleanup must still emit leaveAltScreen even though one earlier
			// write threw — try/catch around cleanup writes guarantees this.
			expect(chunks.join('')).toContain(CURSOR.leaveAltScreen);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('maxTicks honoured for non-interactive mode (e.g. piped tests)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-dash-maxticks-'));
		try {
			const writer = makeRecordingWriter();
			const reader = makeFakeReader();
			const code = await runDashboard({
				cwd: dir,
				pollIntervalMs: 1,
				writer,
				reader,
				now: () => 0,
				maxTicks: 1,
			});
			expect(code).toBe(0);
			// Exactly one render frame plus the lifecycle bytes.
			const all = writer.chunks.join('');
			expect(all).toContain(CURSOR.enterAltScreen);
			expect(all).toContain(CURSOR.leaveAltScreen);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- DashboardApp Ink render: Loop section (US-002) ------------------------
//
// Three fixtures per AC4: idle (no state file), running mid-run, paused/done.
// Rendered with ink-testing-library (not a comment — we look at the real output
// per the 2026-06-05 lesson). State stays signalled by the glyph; divider color
// is never used.

describe('DashboardApp Loop section per-story progress (US-002)', () => {
	function makeData(overrides: Partial<DashboardData>): DashboardData {
		return {
			branchName: 'cam/test-branch',
			currentStoryId: '',
			currentStoryTitle: '',
			iteration: 0,
			maxIterations: 30,
			startedAtMs: 0,
			nowMs: Date.parse('2026-04-28T22:30:00Z'),
			paused: false,
			idle: false,
			recent: [],
			stories: [],
			storyTokens: {},
			...overrides,
		};
	}

	it('idle fixture: no state file shows ◌ idle', () => {
		const data = makeData({ idle: true });
		const { lastFrame, unmount } = render(
			React.createElement(DashboardApp, {
				readSnapshot: () => data,
				pollIntervalMs: 100_000,
			}),
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('◌');
		expect(frame).toContain('idle');
		// Must NOT show "running" or "paused" for idle fixture.
		expect(frame).not.toContain('running');
		expect(frame).not.toContain('paused');
		unmount();
	});

	it('running fixture: mid-run shows running US-XXX (N/total)', () => {
		const data = makeData({
			idle: false,
			paused: false,
			startedAtMs: Date.parse('2026-04-28T22:00:00Z'),
			currentStoryId: 'US-002',
			currentStoryTitle: 'second story',
			stories: [
				{ id: 'US-001', title: 'first', priority: 1, passes: true },
				{ id: 'US-002', title: 'second story', priority: 2, passes: false },
			],
		});
		const { lastFrame, unmount } = render(
			React.createElement(DashboardApp, {
				readSnapshot: () => data,
				pollIntervalMs: 100_000,
			}),
		);
		const frame = lastFrame() ?? '';
		// State indicator: "running US-002 (1/2)"
		expect(frame).toContain('running');
		expect(frame).toContain('US-002');
		expect(frame).toContain('1/2');
		unmount();
	});

	it('paused fixture: state-file with active:false shows paused', () => {
		const data = makeData({
			idle: false,
			paused: true,
			startedAtMs: Date.parse('2026-04-28T22:00:00Z'),
		});
		const { lastFrame, unmount } = render(
			React.createElement(DashboardApp, {
				readSnapshot: () => data,
				pollIntervalMs: 100_000,
			}),
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('paused');
		expect(frame).not.toContain('running');
		unmount();
	});

	it('running fixture: last_activity is used for the since row when present', () => {
		// last_activity is 5 minutes before nowMs; started_at is 30 minutes before.
		// The since row should show ~5m, not ~30m.
		const nowMs = Date.parse('2026-04-28T22:30:00Z');
		const data = makeData({
			idle: false,
			paused: false,
			startedAtMs: Date.parse('2026-04-28T22:00:00Z'), // 30m ago
			lastActivity: '2026-04-28T22:25:00Z', // 5m ago
			nowMs,
		});
		const { lastFrame, unmount } = render(
			React.createElement(DashboardApp, {
				readSnapshot: () => data,
				pollIntervalMs: 100_000,
			}),
		);
		const frame = lastFrame() ?? '';
		// Should show 5m (since last_activity), not 30m (since started_at).
		expect(frame).toMatch(/5m/);
		expect(frame).not.toMatch(/30m/);
		unmount();
	});
});

// --- DashboardApp Ink render (US-014: per-story tokens) --------------------
//
// Rendered with ink-testing-library so we assert against the ACTUAL screen,
// not a comment about it (project lesson 2026-06-05). Story state stays
// signalled by the glyph (✓/→/◌), never the divider color.

describe('DashboardApp per-story tokens (US-014)', () => {
	function snapshotWith(storyTokens: Record<string, TranscriptUsage>): DashboardData {
		return {
			branchName: 'cam/feature-tokens',
			currentStoryId: 'US-002',
			currentStoryTitle: 'second',
			iteration: 1,
			maxIterations: 30,
			startedAtMs: 0,
			nowMs: 0,
			paused: false,
			idle: false,
			recent: [],
			stories: [
				{ id: 'US-001', title: 'first', priority: 1, passes: true },
				{ id: 'US-002', title: 'second', priority: 2, passes: false },
			],
			storyTokens,
		};
	}

	it('renders a real tokens line next to a story that has a marker', () => {
		const { lastFrame, unmount } = render(
			React.createElement(DashboardApp, {
				readSnapshot: () =>
					snapshotWith({
						'US-001': { input: 12_000, output: 3_000, cacheRead: 5_000, cacheCreation: 0 },
					}),
				pollIntervalMs: 100_000,
			}),
		);
		const frame = lastFrame() ?? '';
		// Both story rows render, state shown by glyph (✓ = passed, → = current).
		expect(frame).toContain('✓');
		expect(frame).toContain('→');
		expect(frame).toContain('US-001');
		expect(frame).toContain('US-002');
		// US-001 (has a marker) shows the renderTokensLine output.
		expect(frame).toContain('17k in');
		expect(frame).toContain('5k cached');
		expect(frame).toContain('3k out');
		unmount();
	});

	it('renders the placeholder for stories with no marker (no crash)', () => {
		// No story has tokens, no Loop-panel tokens row, no recent entries — so
		// the only source of the placeholder glyph is the Stories rows.
		const { lastFrame, unmount } = render(
			React.createElement(DashboardApp, {
				readSnapshot: () => snapshotWith({}),
				pollIntervalMs: 100_000,
			}),
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('US-001');
		expect(frame).toContain('US-002');
		expect(frame).toContain(STORY_TOKENS_PLACEHOLDER);
		unmount();
	});
});
