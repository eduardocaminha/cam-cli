// test/status.test.ts
//
// Unit tests for `cam status`. We use bun's tmpdir as the substitute cwd
// (the PRD note says "use a tmpdir as `$HOME` substitute" but `cam status`
// reads `cwd`-relative files, not `$HOME`-relative — so cwd injection is the
// right pattern, mirroring `runNext`'s test surface).
//
// Coverage:
//   - parseStateFile: valid frontmatter, malformed, missing trailing `---`.
//   - pickCurrentStory: priority order, no pending stories, mixed pass states.
//   - formatWallClock: seconds, minutes-and-seconds, hours-and-minutes, days,
//     negative input, NaN.
//   - buildStatusReport: idle (no state file), active (state file present +
//     active:true), paused (state file present + active:false), state file
//     present but no PRD.
//   - runStatus: writes to stdout + always exits 0.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	buildStatusReport,
	formatWallClock,
	parseStateFile,
	pickCurrentStory,
	resolvePrdPath,
	runStatus,
	type StatusOptions,
} from '../src/commands/status.ts';

// --- resolvePrdPath --------------------------------------------------------

describe('resolvePrdPath', () => {
	test('prefers scripts/cam/prd.json when present (canonical)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resolve-'));
		try {
			mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });
			writeFileSync(join(dir, 'scripts', 'cam', 'prd.json'), '{}');
			writeFileSync(join(dir, 'prd.json'), '{}'); // legacy root also present
			expect(resolvePrdPath(dir)).toBe(join(dir, 'scripts', 'cam', 'prd.json'));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('falls back to root prd.json when the canonical file is absent', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resolve-'));
		try {
			writeFileSync(join(dir, 'prd.json'), '{}');
			expect(resolvePrdPath(dir)).toBe(join(dir, 'prd.json'));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('returns the legacy root path when neither exists', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-resolve-'));
		try {
			expect(resolvePrdPath(dir)).toBe(join(dir, 'prd.json'));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- parseStateFile --------------------------------------------------------

describe('parseStateFile', () => {
	test('parses a complete frontmatter block', () => {
		const body = [
			'---',
			'active: true',
			'iteration: 5',
			'max_iterations: 30',
			'completion_promise: "COMPLETE"',
			'started_at: "2026-04-28T22:00:00Z"',
			'---',
			'',
			'/cam-next',
			'',
		].join('\n');
		const out = parseStateFile(body);
		expect(out).toEqual({
			active: true,
			iteration: 5,
			max_iterations: 30,
			completion_promise: 'COMPLETE',
			started_at: '2026-04-28T22:00:00Z',
		});
	});

	test('back-compat: old state file with session_id parses without that key', () => {
		const body = [
			'---',
			'active: true',
			'iteration: 2',
			'max_iterations: 30',
			'session_id: legacy-value',
			'started_at: "2026-04-28T22:00:00Z"',
			'---',
			'',
			'/cam-next',
			'',
		].join('\n');
		const out = parseStateFile(body);
		expect(out).not.toBeNull();
		expect(out).not.toHaveProperty('session_id');
		expect(out?.active).toBe(true);
		expect(out?.iteration).toBe(2);
	});

	test('returns null when the body has no opening `---`', () => {
		expect(parseStateFile('iteration: 1\n')).toBeNull();
	});

	test('returns null when no closing `---` is found', () => {
		expect(parseStateFile('---\niteration: 1\nactive: true\n')).toBeNull();
	});

	test('returns null on malformed YAML', () => {
		expect(parseStateFile('---\niteration: [unclosed\n---\nbody\n')).toBeNull();
	});

	test('handles `completion_promise: null` distinct from omitted', () => {
		const body = ['---', 'active: true', 'completion_promise: null', '---', ''].join('\n');
		const out = parseStateFile(body);
		expect(out?.completion_promise).toBeNull();
	});

	test('drops fields with wrong types defensively', () => {
		const body = ['---', 'iteration: "not-a-number"', 'active: "yes"', '---', ''].join('\n');
		const out = parseStateFile(body);
		// Both fields had wrong types; both should be omitted from the result.
		expect(out).toEqual({});
	});
});

// --- pickCurrentStory ------------------------------------------------------

describe('pickCurrentStory', () => {
	test('returns the lowest-priority passes:false story', () => {
		const prd = {
			userStories: [
				{ id: 'US-001', title: 'one', priority: 1, passes: true },
				{ id: 'US-002', title: 'two', priority: 2, passes: false },
				{ id: 'US-003', title: 'three', priority: 3, passes: false },
			],
		};
		expect(pickCurrentStory(prd)?.id).toBe('US-002');
	});

	test('returns null when all stories pass', () => {
		const prd = {
			userStories: [
				{ id: 'US-001', title: 'one', priority: 1, passes: true },
				{ id: 'US-002', title: 'two', priority: 2, passes: true },
			],
		};
		expect(pickCurrentStory(prd)).toBeNull();
	});

	test('returns null on empty PRD', () => {
		expect(pickCurrentStory({})).toBeNull();
		expect(pickCurrentStory({ userStories: [] })).toBeNull();
	});

	test('treats stories without priority as lowest priority (latest)', () => {
		const prd = {
			userStories: [
				{ id: 'US-001', title: 'one', passes: false }, // no priority
				{ id: 'US-002', title: 'two', priority: 5, passes: false },
			],
		};
		// US-002 has priority 5, US-001 has no priority (treated as MAX_SAFE_INTEGER).
		expect(pickCurrentStory(prd)?.id).toBe('US-002');
	});
});

// --- formatWallClock -------------------------------------------------------

describe('formatWallClock', () => {
	test('seconds for sub-minute durations', () => {
		expect(formatWallClock(0)).toBe('0s');
		expect(formatWallClock(45_000)).toBe('45s');
	});

	test('minutes + seconds', () => {
		expect(formatWallClock(7 * 60_000 + 12_000)).toBe('7m 12s');
	});

	test('hours + minutes (zero-padded minutes)', () => {
		expect(formatWallClock(2 * 3600_000 + 3 * 60_000)).toBe('2h 03m');
	});

	test('days + hours (zero-padded hours)', () => {
		expect(formatWallClock(86400_000 + 4 * 3600_000)).toBe('1d 04h');
	});

	test('negative or NaN returns "unknown"', () => {
		expect(formatWallClock(-1)).toBe('unknown');
		expect(formatWallClock(Number.NaN)).toBe('unknown');
		expect(formatWallClock(Number.POSITIVE_INFINITY)).toBe('unknown');
	});
});

// --- buildStatusReport (integration) --------------------------------------

describe('buildStatusReport', () => {
	test('idle when no state file is present', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-idle-'));
		try {
			const report = buildStatusReport({ cwd: dir });
			expect(report.state).toBe('idle');
			expect(report.iteration).toBeUndefined();
			expect(report.wallClock).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('idle + surfaces next pending story when prd.json is present', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-idle-prd-'));
		try {
			writeFileSync(
				join(dir, 'prd.json'),
				JSON.stringify({
					userStories: [
						{ id: 'US-A', title: 'first', priority: 1, passes: true },
						{ id: 'US-B', title: 'second', priority: 2, passes: false },
					],
				}),
			);
			const report = buildStatusReport({ cwd: dir });
			expect(report.state).toBe('idle');
			expect(report.currentStory).toEqual({ id: 'US-B', title: 'second' });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('active state with iteration, wall-clock, and current story', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-active-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				[
					'---',
					'active: true',
					'iteration: 7',
					'max_iterations: 30',
					'completion_promise: "COMPLETE"',
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
					userStories: [
						{ id: 'US-008', title: 'status + stop', priority: 8, passes: false },
					],
				}),
			);
			// "now" = started_at + 1h 5m 20s
			const fakeNow = () => new Date('2026-04-28T23:05:20Z');
			const report = buildStatusReport({ cwd: dir, now: fakeNow });
			expect(report.state).toBe('active');
			expect(report.iteration).toEqual({ current: 7, max: 30 });
			expect(report.wallClock).toBe('1h 05m');
			expect(report.startedAt).toBe('2026-04-28T22:00:00Z');
			expect(report.currentStory).toEqual({ id: 'US-008', title: 'status + stop' });
			expect(report.completionPromise).toBe('COMPLETE');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('paused state when active:false in the frontmatter', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-paused-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				[
					'---',
					'active: false',
					'iteration: 30',
					'max_iterations: 30',
					'started_at: "2026-04-28T20:00:00Z"',
					'---',
					'',
					'/cam-next',
					'',
				].join('\n'),
			);
			const report = buildStatusReport({
				cwd: dir,
				now: () => new Date('2026-04-28T22:00:00Z'),
			});
			expect(report.state).toBe('paused');
			expect(report.iteration).toEqual({ current: 30, max: 30 });
			expect(report.wallClock).toBe('2h 00m');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('handles missing started_at gracefully', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-no-started-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				['---', 'active: true', 'iteration: 1', 'max_iterations: 30', '---', ''].join('\n'),
			);
			const report = buildStatusReport({ cwd: dir });
			expect(report.state).toBe('active');
			expect(report.wallClock).toBeUndefined();
			expect(report.startedAt).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('tokens populates from transcript when marker + transcript are present (US-004)', () => {
		const base = mkdtempSync(join(tmpdir(), 'cam-status-tokens-'));
		try {
			const cwd = join(base, 'project');
			mkdirSync(join(cwd, '.claude'), { recursive: true });

			const uuid = 'cafebabe-1111-2222-3333-444444444444';
			writeFileSync(join(cwd, '.claude', '.cam-orch-session'), uuid, 'utf8');

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

			const opts: StatusOptions = { cwd, claudeDir };
			const report = buildStatusReport(opts);

			expect(report.tokens).toBeDefined();
			expect(report.tokens!.input).toBe(1500);
			expect(report.tokens!.output).toBe(500);
			expect(report.tokens!.cacheRead).toBe(200);
			expect(report.tokens!.cacheCreation).toBe(50);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('tokens is undefined when the orch-session marker is absent (US-004)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-no-tokens-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			// No .cam-orch-session file.
			const report = buildStatusReport({ cwd: dir, claudeDir: dir });
			expect(report.tokens).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- buildStatusReport: US-002 new fields ----------------------------------

describe('buildStatusReport US-002 live-progress fields', () => {
	test('storiesDone/storiesTotal/lastActivity populate from state file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-us002-fields-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				[
					'---',
					'active: true',
					'iteration: 3',
					'max_iterations: 30',
					'started_at: "2026-04-28T22:00:00Z"',
					'stories_done: 2',
					'stories_total: 5',
					'last_activity: "2026-04-28T22:25:00Z"',
					'---',
					'',
					'/cam-next',
					'',
				].join('\n'),
			);
			const report = buildStatusReport({ cwd: dir });
			expect(report.storiesDone).toBe(2);
			expect(report.storiesTotal).toBe(5);
			expect(report.lastActivity).toBe('2026-04-28T22:25:00Z');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('storiesDone/storiesTotal/lastActivity are undefined when absent from state file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-us002-absent-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				['---', 'active: true', 'iteration: 1', 'max_iterations: 30', '---', ''].join('\n'),
			);
			const report = buildStatusReport({ cwd: dir });
			expect(report.storiesDone).toBeUndefined();
			expect(report.storiesTotal).toBeUndefined();
			expect(report.lastActivity).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- runStatus -------------------------------------------------------------

describe('runStatus', () => {
	test('exits 0 on idle and writes a `status: idle` line to stdout', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-run-idle-'));
		try {
			const original = process.stdout.write.bind(process.stdout);
			const captured: string[] = [];
			process.stdout.write = ((chunk: string | Uint8Array) => {
				captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
				return true;
			}) as typeof process.stdout.write;
			try {
				const code = runStatus({ cwd: dir });
				expect(code).toBe(0);
			} finally {
				process.stdout.write = original;
			}
			const out = captured.join('');
			// New layout: `state    ◌ idle` row under a `Loop` section.
			expect(out).toMatch(/Loop/);
			expect(out).toMatch(/idle/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('idle path renders the tokens row when marker + transcript are present (US-004 parity)', () => {
		const base = mkdtempSync(join(tmpdir(), 'cam-status-run-idle-tokens-'));
		try {
			const cwd = join(base, 'project');
			mkdirSync(join(cwd, '.claude'), { recursive: true });
			// No cam-loop.local.md, so runStatus takes the idle branch.
			const uuid = 'cafebabe-aaaa-bbbb-cccc-dddddddddddd';
			writeFileSync(join(cwd, '.claude', '.cam-orch-session'), uuid, 'utf8');
			const claudeDir = join(base, 'claude-dir');
			const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
			mkdirSync(join(claudeDir, 'projects', encoded), { recursive: true });
			writeFileSync(
				join(claudeDir, 'projects', encoded, `${uuid}.jsonl`),
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
				'utf8',
			);

			const original = process.stdout.write.bind(process.stdout);
			const captured: string[] = [];
			process.stdout.write = ((chunk: string | Uint8Array) => {
				captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
				return true;
			}) as typeof process.stdout.write;
			try {
				const code = runStatus({ cwd, claudeDir });
				expect(code).toBe(0);
			} finally {
				process.stdout.write = original;
			}
			const out = captured.join('');
			expect(out).toMatch(/idle/);
			// in = 1000 + 50 + 200 = 1250 -> "1k"; cached = 200; out = 400.
			expect(out).toMatch(/tokens/);
			expect(out).toMatch(/↑ 1k in \(200 cached\) · ↓ 400 out/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('exits 0 on active and writes story + stories rows to stdout (US-002)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-run-active-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				[
					'---',
					'active: true',
					'iteration: 3',
					'max_iterations: 30',
					'started_at: "2026-04-28T22:00:00Z"',
					'stories_done: 2',
					'stories_total: 5',
					'---',
					'',
					'/cam-next',
					'',
				].join('\n'),
			);
			writeFileSync(
				join(dir, 'prd.json'),
				JSON.stringify({
					userStories: [{ id: 'US-008', title: 'status', priority: 8, passes: false }],
				}),
			);
			const original = process.stdout.write.bind(process.stdout);
			const captured: string[] = [];
			process.stdout.write = ((chunk: string | Uint8Array) => {
				captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
				return true;
			}) as typeof process.stdout.write;
			try {
				const code = runStatus({ cwd: dir, now: () => new Date('2026-04-28T22:30:00Z') });
				expect(code).toBe(0);
			} finally {
				process.stdout.write = original;
			}
			const out = captured.join('');
			// US-002: `iter` row is gone; `stories` row shows real progress.
			expect(out).toMatch(/Loop/);
			expect(out).toMatch(/active/);
			expect(out).toMatch(/US-008/);
			// stories row replaces the old iter row
			expect(out).toMatch(/stories/);
			expect(out).toMatch(/2 \/ 5/);
			// `since` still shows wall-clock (last_activity absent, falls back to started_at)
			expect(out).toMatch(/30m/);
			// iter row must NOT appear
			expect(out).not.toMatch(/\biter\b/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- runStatus: three-fixture rendering (US-002 AC5) ----------------------
//
// The same three scenarios required by AC4 for the Ink dashboard, but for the
// print path. Asserts that the rendered output shows real per-story progress
// (stories N/total + current story id) for each state.

describe('runStatus US-002 three-fixture rendering', () => {
	function captureRunStatus(opts: Parameters<typeof runStatus>[0]): string {
		const original = process.stdout.write.bind(process.stdout);
		const chunks: string[] = [];
		process.stdout.write = ((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			runStatus(opts);
		} finally {
			process.stdout.write = original;
		}
		return chunks.join('');
	}

	test('fixture 1: no state file -> idle, shows next pending story', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-f1-'));
		try {
			writeFileSync(
				join(dir, 'prd.json'),
				JSON.stringify({
					userStories: [
						{ id: 'US-001', title: 'first', priority: 1, passes: true },
						{ id: 'US-002', title: 'second', priority: 2, passes: false },
					],
				}),
			);
			const out = captureRunStatus({ cwd: dir });
			expect(out).toMatch(/idle/);
			// Shows the "next" pending story in idle path.
			expect(out).toMatch(/US-002/);
			// No `stories` row (no state file means no state-file data).
			expect(out).not.toMatch(/\bstories\b/);
			// No `iter` row (removed in US-002).
			expect(out).not.toMatch(/\biter\b/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fixture 2: live state-file mid-run -> shows story id + stories N/total', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-f2-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				[
					'---',
					'active: true',
					'iteration: 5',
					'max_iterations: 30',
					'started_at: "2026-04-28T22:00:00Z"',
					'stories_done: 3',
					'stories_total: 8',
					'current_story: US-004',
					'---',
					'',
					'/cam-next',
					'',
				].join('\n'),
			);
			writeFileSync(
				join(dir, 'prd.json'),
				JSON.stringify({
					userStories: [{ id: 'US-004', title: 'my story', priority: 4, passes: false }],
				}),
			);
			const out = captureRunStatus({
				cwd: dir,
				now: () => new Date('2026-04-28T22:30:00Z'),
			});
			expect(out).toMatch(/active/);
			expect(out).toMatch(/US-004/);
			// stories row replaces old iter row
			expect(out).toMatch(/stories/);
			expect(out).toMatch(/3 \/ 8/);
			// since row present (falls back to started_at)
			expect(out).toMatch(/30m/);
			// No iter row
			expect(out).not.toMatch(/\biter\b/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fixture 3: state-file with active:false -> paused', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-f3-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				[
					'---',
					'active: false',
					'iteration: 10',
					'max_iterations: 30',
					'started_at: "2026-04-28T22:00:00Z"',
					'stories_done: 6',
					'stories_total: 10',
					'---',
					'',
					'/cam-next',
					'',
				].join('\n'),
			);
			const out = captureRunStatus({
				cwd: dir,
				now: () => new Date('2026-04-28T22:30:00Z'),
			});
			expect(out).toMatch(/paused/);
			// stories row still present when paused
			expect(out).toMatch(/stories/);
			expect(out).toMatch(/6 \/ 10/);
			// No iter row
			expect(out).not.toMatch(/\biter\b/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fixture 2 with last_activity: since row reflects last_activity not started_at', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-status-f2-lastact-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			writeFileSync(
				join(dir, '.claude', 'cam-loop.local.md'),
				[
					'---',
					'active: true',
					'iteration: 2',
					'max_iterations: 30',
					'started_at: "2026-04-28T22:00:00Z"',
					'stories_done: 1',
					'stories_total: 5',
					'last_activity: "2026-04-28T22:25:00Z"',
					'---',
					'',
					'/cam-next',
					'',
				].join('\n'),
			);
			const out = captureRunStatus({
				cwd: dir,
				now: () => new Date('2026-04-28T22:30:00Z'),
			});
			// since = 5m (time since last_activity), NOT 30m (time since started_at)
			expect(out).toMatch(/5m/);
			expect(out).not.toMatch(/30m 00s/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
