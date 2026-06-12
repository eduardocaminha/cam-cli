// test/supervisor/review.test.ts
//
// Unit tests for src/supervisor/review.ts.
//
// Coverage:
//   1. buildReviewerWorkerArgv: required flags present, no --permission-mode.
//   2. buildReviewerWorkerArgv: channel is shell-escaped in the wait-for chain.
//   3. buildReviewerWorkerArgv: agentName can be overridden.
//   4. parseReviewVerdict: CLEAN -> { verdict: 'CLEAN', findingsCount: 0, newStories: [] }.
//   5. parseReviewVerdict: FIXES_PENDING:3 -> { verdict: 'FIXES_PENDING', findingsCount: 3 }.
//   6. parseReviewVerdict: returns null when no <review> tag found.
//   7. parseReviewVerdict: returns last tag when multiple tags are in the pane.
//   8. parseReviewVerdict: idempotency - re-parsing the same pane returns same result.
//   9. makeReviewDispatch: CLEAN verdict updates prd.review and returns status='ok'.
//  10. makeReviewDispatch: FIXES_PENDING creates US-RX-NNN stories with passes=false.
//  11. makeReviewDispatch: FIXES_PENDING with newRound > maxRounds sets MAX_ROUNDS_DEBT.
//  12. makeReviewDispatch: no verdict tag in pane returns status='error'.
//  13. makeReviewDispatch: prd unreadable returns status='error'.
//  14. makeReviewDispatch: spawns reviewer and waits for channel signal.
//  15. US-RX story IDs use the correct round number (US-R{round}-NNN format).

import { describe, expect, test } from 'bun:test';
import {
	buildReviewerWorkerArgv,
	parseReviewVerdict,
	makeReviewDispatch,
	DEFAULT_REVIEWER_AGENT,
	REVIEWER_TASK_PROMPT,
} from '../../src/supervisor/review.ts';
import type { MakeReviewDispatchOptions } from '../../src/supervisor/review.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import type { SpawnFn, CapturePane, ReadPrd, WritePrd } from '../../src/supervisor/loop.ts';

// ---------------------------------------------------------------------------
// buildReviewerWorkerArgv tests
// ---------------------------------------------------------------------------

describe('buildReviewerWorkerArgv', () => {
	const SAMPLE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
	const SAMPLE_CHANNEL = 'cam-worker-review-a1b2c3d4';

	test('contains claude -p flag', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID, channel: SAMPLE_CHANNEL });
		expect(result).toContain('claude -p');
	});

	test('contains --session-id with the supplied uuid', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID, channel: SAMPLE_CHANNEL });
		expect(result).toContain(`--session-id ${SAMPLE_UUID}`);
	});

	test('contains --output-format text', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID, channel: SAMPLE_CHANNEL });
		expect(result).toContain('--output-format text');
	});

	test('contains --agent with the default reviewer agent name', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID, channel: SAMPLE_CHANNEL });
		expect(result).toContain(`--agent ${DEFAULT_REVIEWER_AGENT}`);
	});

	test('does NOT contain --permission-mode flag', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID, channel: SAMPLE_CHANNEL });
		expect(result).not.toContain('--permission-mode');
	});

	test('contains tmux -L cam wait-for -S chain after claude command', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID, channel: SAMPLE_CHANNEL });
		const claudeIdx = result.indexOf('claude');
		const waitIdx = result.indexOf('tmux -L cam wait-for -S');
		expect(claudeIdx).toBeGreaterThanOrEqual(0);
		expect(waitIdx).toBeGreaterThan(claudeIdx);
	});

	test('channel is present in the wait-for -S argument', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID, channel: SAMPLE_CHANNEL });
		expect(result).toContain(SAMPLE_CHANNEL);
	});

	test('channel with single quotes is shell-escaped', () => {
		const dangerousChannel = "cam-worker-review-it's'done";
		const result = buildReviewerWorkerArgv({
			uuid: SAMPLE_UUID,
			channel: dangerousChannel,
		});
		// The channel must appear escaped (single quotes handled via '\'' technique)
		expect(result).toContain("'\\''");
	});

	test('agentName can be overridden', () => {
		const customAgent = 'my-custom-reviewer';
		const result = buildReviewerWorkerArgv({
			uuid: SAMPLE_UUID,
			channel: SAMPLE_CHANNEL,
			agentName: customAgent,
		});
		expect(result).toContain(`--agent ${customAgent}`);
		expect(result).not.toContain(`--agent ${DEFAULT_REVIEWER_AGENT}`);
	});

	test('DEFAULT_REVIEWER_AGENT is subagent-reviewer', () => {
		expect(DEFAULT_REVIEWER_AGENT).toBe('subagent-reviewer');
	});

	test('outFile: tees stdout+stderr to a durable log before the wait-for (CAM-37)', () => {
		const result = buildReviewerWorkerArgv({
			uuid: SAMPLE_UUID,
			channel: SAMPLE_CHANNEL,
			outFile: '/tmp/.cam-worker-out-abc.log',
		});
		expect(result).toContain("2>&1 | tee '/tmp/.cam-worker-out-abc.log'");
		// tee comes before the wait-for chain (pipe binds tighter than `;`).
		expect(result.indexOf('| tee')).toBeLessThan(result.indexOf('wait-for'));
	});

	test('outFile omitted: no tee (legacy pane-only behaviour)', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID, channel: SAMPLE_CHANNEL });
		expect(result).not.toContain('tee');
	});
});

// ---------------------------------------------------------------------------
// buildReviewerWorkerArgv: interactive mode (CAM-42 / US-003)
// ---------------------------------------------------------------------------

describe('buildReviewerWorkerArgv interactive (CAM-42)', () => {
	const SAMPLE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

	const interactiveArgv = () =>
		buildReviewerWorkerArgv({
			uuid: SAMPLE_UUID,
			interactive: true,
			taskPrompt: REVIEWER_TASK_PROMPT,
			permissionMode: 'bypassPermissions',
		});

	test('contains --agent, --session-id, --permission-mode, and the task prompt', () => {
		const result = interactiveArgv();
		expect(result).toContain(`--agent ${DEFAULT_REVIEWER_AGENT}`);
		expect(result).toContain(`--session-id ${SAMPLE_UUID}`);
		expect(result).toContain('--permission-mode bypassPermissions');
		expect(result).toContain('Review all changes on the current branch vs main');
		expect(result).toContain('<review> verdict tag on the very last line');
	});

	test('does NOT contain -p (headless) or wait-for', () => {
		const result = interactiveArgv();
		expect(result).not.toContain('claude -p');
		// Token-level check: ' -p ' must not appear as a standalone flag (the
		// substring '-p' alone would falsely match '--permission-mode').
		expect(result).not.toMatch(/\s-p\s/);
		expect(result).not.toContain('--output-format');
		expect(result).not.toContain('wait-for');
		expect(result).not.toContain('tmux');
	});

	test('starts with "claude --permission-mode" (interactive shape)', () => {
		const result = interactiveArgv();
		expect(result.startsWith('claude --permission-mode')).toBe(true);
	});

	test('task prompt is single-quote shell-escaped', () => {
		const result = buildReviewerWorkerArgv({
			uuid: SAMPLE_UUID,
			interactive: true,
			taskPrompt: "review what's on the branch",
			permissionMode: 'bypassPermissions',
		});
		expect(result).toContain("'\\''");
	});

	test('omits tee even when outFile is passed (TUI keeps its pty)', () => {
		const result = buildReviewerWorkerArgv({
			uuid: SAMPLE_UUID,
			interactive: true,
			taskPrompt: REVIEWER_TASK_PROMPT,
			permissionMode: 'bypassPermissions',
			outFile: '/tmp/.cam-worker-out-abc.log',
		});
		expect(result).not.toContain('tee');
	});

	test('defaults the prompt to REVIEWER_TASK_PROMPT when omitted', () => {
		const result = buildReviewerWorkerArgv({
			uuid: SAMPLE_UUID,
			interactive: true,
			permissionMode: 'bypassPermissions',
		});
		expect(result).toContain('<review> verdict tag on the very last line');
	});
});

// ---------------------------------------------------------------------------
// parseReviewVerdict tests
// ---------------------------------------------------------------------------

describe('parseReviewVerdict', () => {
	test('CLEAN verdict: returns correct shape', () => {
		const pane =
			'## SUMMARY\n- Build: PASS\n- Overall: APPROVE\n\n<review>CLEAN</review>';
		const result = parseReviewVerdict(pane);
		expect(result).not.toBeNull();
		expect(result?.verdict).toBe('CLEAN');
		expect(result?.findingsCount).toBe(0);
		expect(result?.newStories).toEqual([]);
	});

	test('FIXES_PENDING:3 verdict: returns correct shape', () => {
		const pane =
			'## CRITICAL\n- [src/foo.ts:12] bad thing\n\n<review>FIXES_PENDING:3</review>';
		const result = parseReviewVerdict(pane);
		expect(result).not.toBeNull();
		expect(result?.verdict).toBe('FIXES_PENDING');
		expect(result?.findingsCount).toBe(3);
		expect(result?.newStories).toEqual([]);
	});

	test('FIXES_PENDING:1 verdict', () => {
		const pane = '<review>FIXES_PENDING:1</review>';
		const result = parseReviewVerdict(pane);
		expect(result?.verdict).toBe('FIXES_PENDING');
		expect(result?.findingsCount).toBe(1);
	});

	test('no <review> tag returns null', () => {
		const pane = 'Some output without a review tag.';
		const result = parseReviewVerdict(pane);
		expect(result).toBeNull();
	});

	test('empty pane returns null', () => {
		expect(parseReviewVerdict('')).toBeNull();
	});

	test('returns LAST tag when multiple <review> tags appear in pane', () => {
		// Simulate a re-run scenario where earlier output has a FIXES_PENDING
		// but the final verdict is CLEAN.
		const pane = [
			'First run output: <review>FIXES_PENDING:2</review>',
			'Some more output',
			'Final verdict: <review>CLEAN</review>',
		].join('\n');
		const result = parseReviewVerdict(pane);
		expect(result?.verdict).toBe('CLEAN');
	});

	test('idempotency: re-parsing the same pane returns same result', () => {
		const pane = 'Review complete\n<review>FIXES_PENDING:2</review>';
		const first = parseReviewVerdict(pane);
		const second = parseReviewVerdict(pane);
		expect(second?.verdict).toBe(first?.verdict);
		expect(second?.findingsCount).toBe(first?.findingsCount);
	});

	test('idempotency on CLEAN pane', () => {
		const pane = 'All good\n<review>CLEAN</review>';
		const first = parseReviewVerdict(pane);
		const second = parseReviewVerdict(pane);
		expect(second?.verdict).toBe(first?.verdict);
		expect(second?.findingsCount).toBe(first?.findingsCount);
	});
});

// ---------------------------------------------------------------------------
// makeReviewDispatch tests
// ---------------------------------------------------------------------------

/** Build a basic PrdSnapshot for testing. */
function makePrd(opts: {
	stories?: Array<{ id: string; priority: number; passes: boolean }>;
	review?: PrdSnapshot['review'];
}): PrdSnapshot {
	return {
		userStories: (opts.stories ?? []).map((s) => ({
			id: s.id,
			priority: s.priority,
			passes: s.passes,
			requires: null,
		})),
		review: opts.review,
	};
}

/** Build a MakeReviewDispatchOptions with injectable fakes (CAM-42 polling contract). */
function makeDispatchOpts(
	overrides: Partial<MakeReviewDispatchOptions> & {
		paneText?: string;
		prd?: PrdSnapshot | null;
		capturedWrittenPrd?: PrdSnapshot[];
	} = {},
): MakeReviewDispatchOptions & { capturedWrittenPrd: PrdSnapshot[]; capturedSpawnArgs: string[][] } {
	const capturedWrittenPrd: PrdSnapshot[] = overrides.capturedWrittenPrd ?? [];
	const capturedSpawnArgs: string[][] = [];

	const pane = overrides.paneText ?? '<review>CLEAN</review>';
	const prd = 'prd' in overrides ? overrides.prd : makePrd({ stories: [] });

	const spawn: SpawnFn = (_cmd, args) => {
		capturedSpawnArgs.push(args);
		return { stdout: '', exitCode: 0 };
	};
	const capturePane: CapturePane = (_paneId) => pane;
	const readPrd: ReadPrd = () => prd ?? null;
	const writePrd: WritePrd = (p) => {
		capturedWrittenPrd.push(p);
	};

	// Deterministic clock: each call advances 1s, so a small timeoutMs expires
	// after a bounded number of polls without real sleeping.
	let fakeNowMs = 0;
	const now = () => {
		fakeNowMs += 1_000;
		return fakeNowMs;
	};

	return {
		spawn: overrides.spawn ?? spawn,
		capturePane: overrides.capturePane ?? capturePane,
		readPrd: overrides.readPrd ?? readPrd,
		writePrd: overrides.writePrd ?? writePrd,
		workerPaneId: overrides.workerPaneId ?? '%7',
		isPaneAlive: overrides.isPaneAlive ?? (() => true),
		sleepFn: overrides.sleepFn ?? (() => {}),
		permissionMode: overrides.permissionMode ?? 'bypassPermissions',
		taskPrompt: overrides.taskPrompt,
		agentName: overrides.agentName,
		pollIntervalMs: overrides.pollIntervalMs ?? 1,
		timeoutMs: overrides.timeoutMs ?? 60_000,
		now: overrides.now ?? now,
		capturedWrittenPrd,
		capturedSpawnArgs,
	};
}

describe('makeReviewDispatch', () => {
	const SAMPLE_UUID = '11111111-2222-3333-4444-555555555555';
	const SAMPLE_CHANNEL = 'cam-worker-review-11111111';

	test('CLEAN verdict: updates prd.review and returns status=ok', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

		expect(result.status).toBe('ok');
		expect(capturedWrittenPrd.length).toBe(1);
		const written = capturedWrittenPrd[0];
		expect(written?.review?.lastVerdict).toBe('CLEAN');
		expect(written?.review?.roundsCompleted).toBe(1);
	});

	test('FIXES_PENDING: creates US-RX-NNN stories with passes=false', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>FIXES_PENDING:2</review>',
			prd: makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

		expect(result.status).toBe('ok');
		expect(capturedWrittenPrd.length).toBe(1);
		const written = capturedWrittenPrd[0];
		expect(written?.review?.lastVerdict).toBe('FIXES_PENDING');
		expect(written?.review?.roundsCompleted).toBe(1);

		// Should have prepended 2 new US-R1-NNN stories.
		const stories = written?.userStories ?? [];
		const fixStories = stories.filter((s) => s.id?.startsWith('US-R1-'));
		expect(fixStories.length).toBe(2);
		fixStories.forEach((s) => {
			expect(s.passes).toBe(false);
		});
	});

	test('US-RX story IDs use the correct round number', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>FIXES_PENDING:1</review>',
			prd: makePrd({
				stories: [],
				// Round 1 already completed; this will be round 2.
				review: { roundsCompleted: 1, maxRounds: 3 },
			}),
			capturedWrittenPrd,
		});

		const dispatch = makeReviewDispatch(opts);
		dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

		const written = capturedWrittenPrd[0];
		const stories = written?.userStories ?? [];
		expect(stories.length).toBe(1);
		expect(stories[0]?.id).toBe('US-R2-001');
	});

	test('FIXES_PENDING with newRound > maxRounds sets MAX_ROUNDS_DEBT', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>FIXES_PENDING:2</review>',
			prd: makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				// roundsCompleted=3, maxRounds=3 -> newRound=4 > maxRounds
				review: { roundsCompleted: 3, maxRounds: 3 },
			}),
			capturedWrittenPrd,
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

		expect(result.status).toBe('ok');
		const written = capturedWrittenPrd[0];
		expect(written?.review?.lastVerdict).toBe('MAX_ROUNDS_DEBT');
		// Should NOT have created new stories when debt cap is hit.
		const stories = written?.userStories ?? [];
		const fixStories = stories.filter((s) => s.id?.startsWith('US-R'));
		expect(fixStories.length).toBe(0);
	});

	test('no <review> tag ever: times out and returns status=error', () => {
		const opts = makeDispatchOpts({
			paneText: 'No verdict tag here at all.',
			timeoutMs: 3_000, // fake clock ticks 1s per poll -> bounded loop
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

		expect(result.status).toBe('error');
		expect(result.detail).toContain('timed out');
		// On timeout the stuck reviewer pane is respawned (killed).
		const lastSpawn = opts.capturedSpawnArgs[opts.capturedSpawnArgs.length - 1] ?? [];
		expect(lastSpawn).toContain('respawn-pane');
		expect(lastSpawn[lastSpawn.length - 1]).toBe('echo review-timeout');
	});

	test('pane dies before a verdict: returns status=error (CAM-42 polling)', () => {
		const opts = makeDispatchOpts({
			paneText: 'still working...',
			isPaneAlive: () => false,
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

		expect(result.status).toBe('error');
		expect(result.detail).toContain('died');
	});

	test('verdict appearing after a few polls is picked up', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		let polls = 0;
		const opts = makeDispatchOpts({
			prd: makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			capturePane: (_paneId: string) => {
				polls += 1;
				return polls < 3 ? 'TUI frame, still reviewing...' : 'done\n<review>CLEAN</review>';
			},
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

		expect(result.status).toBe('ok');
		expect(polls).toBeGreaterThanOrEqual(3);
		expect(capturedWrittenPrd[0]?.review?.lastVerdict).toBe('CLEAN');
	});

	test('prd unreadable returns status=error', () => {
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: null,
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

		expect(result.status).toBe('error');
		expect(result.detail).toContain('prd.json');
	});

	test('spawns an interactive reviewer with prompt and permission mode (CAM-42)', () => {
		const capturedSpawnArgs: string[][] = [];

		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			spawn: (_cmd, args) => {
				capturedSpawnArgs.push(args);
				return { stdout: '', exitCode: 0 };
			},
		});

		const dispatch = makeReviewDispatch(opts);
		dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

		// spawn called with respawn-pane arguments.
		expect(capturedSpawnArgs.length).toBeGreaterThan(0);
		const firstSpawnCall = capturedSpawnArgs[0] ?? [];
		expect(firstSpawnCall).toContain('respawn-pane');

		// The reviewer shell command is interactive: prompt + permission mode,
		// no headless -p, no wait-for chain.
		const shellCmd = firstSpawnCall[firstSpawnCall.length - 1] ?? '';
		expect(shellCmd).toContain(`--session-id ${SAMPLE_UUID}`);
		expect(shellCmd).toContain('--permission-mode bypassPermissions');
		expect(shellCmd).toContain(`--agent ${DEFAULT_REVIEWER_AGENT}`);
		expect(shellCmd).toContain('Review all changes on the current branch vs main');
		expect(shellCmd).not.toContain('claude -p');
		expect(shellCmd).not.toContain('wait-for');
	});

	test('FIXES_PENDING stories are prepended before existing stories', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>FIXES_PENDING:1</review>',
			prd: makePrd({
				stories: [{ id: 'US-005', priority: 5, passes: true }],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
		});

		const dispatch = makeReviewDispatch(opts);
		dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

		const written = capturedWrittenPrd[0];
		const stories = written?.userStories ?? [];
		// First story should be the fix story (US-R1-001).
		expect(stories[0]?.id).toBe('US-R1-001');
		// Existing story should still be present.
		const existingStory = stories.find((s) => s.id === 'US-005');
		expect(existingStory).toBeDefined();
	});

	test('FIXES_PENDING with 0 count still creates 1 story (minimum 1)', () => {
		// FIXES_PENDING:0 is unusual but the system should handle it gracefully.
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>FIXES_PENDING:0</review>',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
		});

		const dispatch = makeReviewDispatch(opts);
		dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

		const written = capturedWrittenPrd[0];
		const stories = written?.userStories ?? [];
		// Minimum 1 story created even if findingsCount=0.
		expect(stories.length).toBeGreaterThanOrEqual(1);
	});

	test('CLEAN does not create new stories', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
		});

		const dispatch = makeReviewDispatch(opts);
		dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

		const written = capturedWrittenPrd[0];
		const stories = written?.userStories ?? [];
		// Only the original story, no fix stories.
		expect(stories.length).toBe(1);
		expect(stories[0]?.id).toBe('US-001');
	});

	test('roundsCompleted increments by 1 regardless of verdict', () => {
		for (const paneText of ['<review>CLEAN</review>', '<review>FIXES_PENDING:1</review>']) {
			const capturedWrittenPrd: PrdSnapshot[] = [];
			const opts = makeDispatchOpts({
				paneText,
				prd: makePrd({
					stories: [],
					review: { roundsCompleted: 2, maxRounds: 5 },
				}),
				capturedWrittenPrd,
			});

			const dispatch = makeReviewDispatch(opts);
			dispatch(SAMPLE_UUID, SAMPLE_CHANNEL);

			const written = capturedWrittenPrd[0];
			expect(written?.review?.roundsCompleted).toBe(3);
		}
	});
});
