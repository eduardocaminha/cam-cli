// test/supervisor/orchestrator-surface.test.ts
//
// Contract test pinning the supervisor<->worker protocol shape (US-001,
// CAM-63). One fast, deterministic test file that locks the four surfaces an
// operator smoke would otherwise be the only thing catching a regression in:
//
//   (a) tmux send-keys submit form: text + Enter in ONE call, WITHOUT -l
//       (CAM-55: with -l every arg is literal, so 'Enter' types as the text
//       "Enter" and never submits).
//   (b) worker-report.json field shape: outcome / story / gates{typecheck,
//       tests} / notes (US-003 exit report protocol).
//   (c) the CAM_*_STATUS sentinel regex (parseAnySentinel / readWorkerOutcome
//       fallback path).
//   (d) the @cam_label pane lifecycle (CAM-57: a 3rd pane is only "alive"
//       when it carries a recognised worker label; the orchestrator/dashboard
//       panes are keyed on @cam_label, never on pane_current_command).
//
// Strategy: reuse the existing in-memory fake pattern (test/supervisor/
// loop.test.ts baseOptions style, test/dispatch.test.ts fake tmux spawn,
// test/tmux-session.test.ts fake list-panes spawn). No real tmux server, no
// real claude process, no new mock-worker binary.

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sendKeysVerified } from '../../src/tmux/dispatch.ts';
import type { SpawnFn as TmuxSpawnFn } from '../../src/tmux/session.ts';
import { isSessionStale, orchestratorAlive } from '../../src/tmux/session.ts';
import { makeReadWorkerReport } from '../../src/supervisor/host.ts';
import { formatWorkerReportSummary, type WorkerReport } from '../../src/supervisor/worker-report.ts';
import { parseAnySentinel, readWorkerOutcome } from '../../src/supervisor/result.ts';

// ---------------------------------------------------------------------------
// (a) tmux send-keys submit form (CAM-55)
// ---------------------------------------------------------------------------

interface TmuxCall {
	cmd: string;
	args: string[];
}

/** Records every spawn call and returns a successful, idle-looking result. */
function makeRecordingTmuxSpawn(): TmuxSpawnFn & { calls: TmuxCall[] } {
	const calls: TmuxCall[] = [];
	const fn = ((cmd: string, args: string[]) => {
		calls.push({ cmd, args: [...args] });
		const result: SpawnSyncReturns<Buffer> = {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		};
		return result;
	}) as TmuxSpawnFn & { calls: TmuxCall[] };
	fn.calls = calls;
	return fn;
}

describe('protocol contract (a): tmux send-keys submit form', () => {
	test('submits text + Enter in one call, with no -l literal flag anywhere in argv', () => {
		const spawnFn = makeRecordingTmuxSpawn();

		sendKeysVerified({
			paneId: '%3',
			text: '/cam-review',
			tmuxSpawnFn: spawnFn,
			// Pane already idle and the pushed text never appears in the tail:
			// delivered on the first attempt, no retry, no sleep needed.
			capturePaneFn: () => '> ',
		});

		const sendKeysCalls = spawnFn.calls.filter((c) => c.args.includes('send-keys'));
		expect(sendKeysCalls.length).toBe(1);

		const argv = sendKeysCalls[0]?.args ?? [];
		// Exact shape: -L cam send-keys -t <paneId> <text> Enter.
		expect(argv).toEqual(['-L', 'cam', 'send-keys', '-t', '%3', '/cam-review', 'Enter']);
		// Text and 'Enter' are discrete argv elements (atomic keystroke pair),
		// never joined into a single string.
		expect(argv).toContain('/cam-review');
		expect(argv).toContain('Enter');
	});

	test('CAM-55 regression lock: -l must never appear in a send-keys submit call', () => {
		const spawnFn = makeRecordingTmuxSpawn();

		sendKeysVerified({
			paneId: '%3',
			text: '/cam-issue create foo',
			tmuxSpawnFn: spawnFn,
			capturePaneFn: () => '> ',
		});

		const sendKeysCalls = spawnFn.calls.filter((c) => c.args.includes('send-keys'));
		for (const call of sendKeysCalls) {
			// With -l every arg becomes literal, so the trailing 'Enter' key name
			// would be typed as the text "Enter" and never submit. If a future
			// change reintroduces -l on this path, this assertion goes red.
			expect(call.args).not.toContain('-l');
		}
	});
});

// ---------------------------------------------------------------------------
// (b) worker-report.json field shape
// ---------------------------------------------------------------------------

describe('protocol contract (b): worker-report.json field shape', () => {
	test('formatWorkerReportSummary reads outcome / story / gates.typecheck / gates.tests', () => {
		const report: WorkerReport = {
			outcome: 'DONE',
			story: 'US-001',
			gates: { typecheck: 'ok', tests: '42 pass / 0 fail' },
			notes: 'none',
		};

		expect(formatWorkerReportSummary(report)).toBe(
			'[cam] US-001 DONE: typecheck ok, 42 pass / 0 fail',
		);
	});

	test('makeReadWorkerReport accepts a report with the full field shape', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-orch-surface-'));
		const reportPath = join(dir, 'scripts', 'cam', 'worker-report.json');
		mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });
		const report: WorkerReport = {
			outcome: 'DONE',
			story: 'US-002',
			gates: { typecheck: 'ok', tests: '10 pass / 0 fail' },
			notes: 'none',
		};
		writeFileSync(reportPath, JSON.stringify(report), 'utf8');

		const readWorkerReport = makeReadWorkerReport(dir);
		const result = readWorkerReport?.();
		expect(result?.outcome).toBe('DONE');
		expect(result?.story).toBe('US-002');
		expect(result?.gates.typecheck).toBe('ok');
		expect(result?.gates.tests).toBe('10 pass / 0 fail');
		expect(result?.notes).toBe('none');
	});

	test('makeReadWorkerReport rejects a report missing the outcome or story discriminator', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-orch-surface-'));
		mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });
		const reportPath = join(dir, 'scripts', 'cam', 'worker-report.json');

		writeFileSync(reportPath, JSON.stringify({ story: 'US-003', gates: {}, notes: 'x' }), 'utf8');
		expect(makeReadWorkerReport(dir)?.()).toBeNull();

		writeFileSync(reportPath, JSON.stringify({ outcome: 'DONE', gates: {}, notes: 'x' }), 'utf8');
		expect(makeReadWorkerReport(dir)?.()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// (c) CAM_*_STATUS sentinel regex
// ---------------------------------------------------------------------------

describe('protocol contract (c): CAM_*_STATUS sentinel regex', () => {
	test('parseAnySentinel recognises CAM_IMPLEMENTER_STATUS in any status form', () => {
		expect(parseAnySentinel('...\nCAM_IMPLEMENTER_STATUS=DONE story=US-001\n')).toEqual({
			source: 'implementer',
			raw: 'CAM_IMPLEMENTER_STATUS=DONE',
		});
		expect(parseAnySentinel('...\nCAM_IMPLEMENTER_STATUS=PRD_COMPLETE\n')).toEqual({
			source: 'implementer',
			raw: 'CAM_IMPLEMENTER_STATUS=PRD_COMPLETE',
		});
		expect(parseAnySentinel('...\nCAM_IMPLEMENTER_STATUS=BLOCKED_QUALITY story=US-007\n')).toEqual({
			source: 'implementer',
			raw: 'CAM_IMPLEMENTER_STATUS=BLOCKED_QUALITY',
		});
		expect(parseAnySentinel('...\nCAM_IMPLEMENTER_STATUS=RATE_LIMIT\n')).toEqual({
			source: 'implementer',
			raw: 'CAM_IMPLEMENTER_STATUS=RATE_LIMIT',
		});
	});

	test('parseAnySentinel also recognises the reviewer <review> tag sentinel', () => {
		expect(parseAnySentinel('...\n<review>CLEAN</review>\n')).toEqual({
			source: 'review-tag',
			raw: '<review>CLEAN</review>',
		});
		expect(parseAnySentinel('...\n<review>FIXES_PENDING:3</review>\n')).toEqual({
			source: 'review-tag',
			raw: '<review>FIXES_PENDING:3</review>',
		});
	});

	test('parseAnySentinel returns null when no recognised sentinel is present', () => {
		expect(parseAnySentinel('Error: something failed\nNo sentinel here\n')).toBeNull();
	});

	test('readWorkerOutcome fallback path parses the DONE sentinel + story id from pane text', () => {
		const storyId = 'US-004';
		const result = readWorkerOutcome({
			prdPath: '/fake/prd.json',
			handoffPath: '/fake/handoff.json',
			capturedPaneText: `Implemented something\nCAM_IMPLEMENTER_STATUS=DONE story=${storyId}\n`,
			readFile: (path: string) =>
				path === '/fake/prd.json'
					? JSON.stringify({ userStories: [{ id: storyId, passes: true }] })
					: path === '/fake/handoff.json'
						? JSON.stringify({ lastCompletedStory: { id: storyId, title: 'x' } })
						: null,
		});
		expect(result.kind).toBe('pass');
		expect(result.storyId).toBe(storyId);
	});
});

// ---------------------------------------------------------------------------
// (d) @cam_label pane lifecycle
// ---------------------------------------------------------------------------

/** Fake spawn: list-panes returns the given raw stdout for any -F format. */
function labelSpawn(listPanesStdout: string, status = 0): TmuxSpawnFn {
	return ((cmd: string, args: string[], opts?: { stdio?: 'ignore' | 'inherit' | 'pipe' }) => {
		const sub = args[0] === '-L' ? args[2] : args[0];
		if (cmd === 'tmux' && sub === 'list-panes' && opts?.stdio === 'pipe') {
			return {
				pid: 1,
				output: [null, Buffer.from(listPanesStdout), Buffer.from('')],
				stdout: Buffer.from(listPanesStdout),
				stderr: Buffer.from(''),
				status,
				signal: null,
			} as SpawnSyncReturns<Buffer>;
		}
		return {
			pid: 1,
			output: [null, Buffer.from(''), Buffer.from('')],
			stdout: Buffer.from(''),
			stderr: Buffer.from(''),
			status: 0,
			signal: null,
		} as SpawnSyncReturns<Buffer>;
	}) as TmuxSpawnFn;
}

describe('protocol contract (d): @cam_label pane lifecycle', () => {
	test('canonical 2-pane layout (orchestrator + dashboard) is alive', () => {
		expect(isSessionStale('s', labelSpawn('claude;orchestrator\ncam;dashboard\n'))).toBe(false);
	});

	test('a 3rd pane labeled "implementer" or "reviewer" is alive (worker dispatched)', () => {
		expect(
			isSessionStale('s', labelSpawn('claude;orchestrator\ncam;dashboard\nclaude;implementer\n')),
		).toBe(false);
		expect(
			isSessionStale('s', labelSpawn('claude;orchestrator\ncam;dashboard\nclaude;reviewer\n')),
		).toBe(false);
	});

	test('CAM-57 regression lock: a 3rd pane with no @cam_label (dead/stray) is stale', () => {
		expect(
			isSessionStale('s', labelSpawn('claude;orchestrator\ncam;dashboard\nbash;\n')),
		).toBe(true);
	});

	test('orchestratorAlive is keyed on @cam_label, not pane_current_command', () => {
		// The orchestrator pane runs claude under a bash respawn-wrapper (CAM-23),
		// so pane_current_command is always 'bash', never 'claude'; only the
		// @cam_label list-panes format is consulted here.
		expect(orchestratorAlive('s', labelSpawn('orchestrator\ndashboard\n'))).toBe(true);
		expect(orchestratorAlive('s', labelSpawn('dashboard\nimplementer\n'))).toBe(false);
	});
});
