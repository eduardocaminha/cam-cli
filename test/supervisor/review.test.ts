// test/supervisor/review.test.ts
//
// Unit tests for src/supervisor/review.ts.
//
// Coverage:
//   1. buildReviewerWorkerArgv: required flags present, no -p, no wait-for.
//   2. buildReviewerWorkerArgv: agentName can be overridden.
//   3. buildReviewerWorkerArgv: task prompt is shell-escaped.
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
//  14. makeReviewDispatch: spawns interactive reviewer (no -p, no wait-for).
//  15. US-RX story IDs use the correct round number (US-R{round}-NNN format).
//  US-006 regression tests (CAM-75 acceptance):
//  AC1: verbatim finding text from review-report.json appears in fix-story notes (not generic).
//  AC2: missing report + FIXES_PENDING:N tag -> ok, N stories, no throw (loop not wedged).
//  AC3: findings come from review-report.json, NOT capture-pane; proved by pane having
//       rendered (markdown-stripped) text while file findings appear verbatim in fix stories.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { makeReadReviewReport } from '../../src/supervisor/host.ts';
import { REVIEW_REPORT_FILENAME } from '../../src/supervisor/review-report.ts';

// ---------------------------------------------------------------------------
// buildReviewerWorkerArgv tests
// ---------------------------------------------------------------------------

describe('buildReviewerWorkerArgv', () => {
	const SAMPLE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

	test('does NOT contain standalone -p flag', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID });
		// ' -p ' as a standalone flag must be absent; substring '-p' can appear
		// in '--permission-mode' so use a regex word-boundary check.
		expect(result).not.toMatch(/\s-p(\s|$)/);
		expect(result).not.toContain('claude -p');
	});

	test('does NOT contain wait-for', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID });
		expect(result).not.toContain('wait-for');
		expect(result).not.toContain('tmux');
	});

	test('does NOT contain --output-format', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID });
		expect(result).not.toContain('--output-format');
	});

	test('contains --session-id with the supplied uuid', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID });
		expect(result).toContain(`--session-id ${SAMPLE_UUID}`);
	});

	test('contains --agent with the default reviewer agent name', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID });
		expect(result).toContain(`--agent ${DEFAULT_REVIEWER_AGENT}`);
	});

	test('contains --permission-mode (defaults to bypassPermissions)', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID });
		expect(result).toContain('--permission-mode bypassPermissions');
	});

	test('contains --permission-mode and --session-id and --agent and prompt', () => {
		const result = buildReviewerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: REVIEWER_TASK_PROMPT,
			permissionMode: 'bypassPermissions',
		});
		expect(result).toContain(`--agent ${DEFAULT_REVIEWER_AGENT}`);
		expect(result).toContain(`--session-id ${SAMPLE_UUID}`);
		expect(result).toContain('--permission-mode bypassPermissions');
		expect(result).toContain('Review all changes on the current branch vs main');
		expect(result).toContain('<review> verdict tag on the very last line');
	});

	test('starts with the env -u prefix, then claude --permission-mode (CAM-43)', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID });
		expect(result.startsWith('env -u CLAUDECODE')).toBe(true);
		const envIdx = result.indexOf('env -u CLAUDECODE');
		const claudeIdx = result.indexOf('claude --permission-mode');
		expect(claudeIdx).toBeGreaterThan(envIdx);
	});

	test('reuses the shared WORKER_ENV_UNSET list (no duplicated literal in review.ts) (CAM-43)', async () => {
		const { WORKER_ENV_UNSET } = await import('../../src/supervisor/worker-argv.ts');
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID });
		for (const v of WORKER_ENV_UNSET) {
			expect(result).toContain(`-u ${v}`);
		}
		// Single source of truth: review.ts must not hardcode its own list.
		const reviewSrc = await Bun.file(
			new URL('../../src/supervisor/review.ts', import.meta.url),
		).text();
		expect(reviewSrc).not.toContain("'CLAUDECODE'");
		expect(reviewSrc).toContain('workerEnvPrefix');
	});

	test('agentName can be overridden', () => {
		const customAgent = 'my-custom-reviewer';
		const result = buildReviewerWorkerArgv({
			uuid: SAMPLE_UUID,
			agentName: customAgent,
		});
		expect(result).toContain(`--agent ${customAgent}`);
		expect(result).not.toContain(`--agent ${DEFAULT_REVIEWER_AGENT}`);
	});

	test('DEFAULT_REVIEWER_AGENT is subagent-reviewer', () => {
		expect(DEFAULT_REVIEWER_AGENT).toBe('subagent-reviewer');
	});

	test('task prompt is single-quote shell-escaped', () => {
		const result = buildReviewerWorkerArgv({
			uuid: SAMPLE_UUID,
			taskPrompt: "review what's on the branch",
			permissionMode: 'bypassPermissions',
		});
		expect(result).toContain("'\\''");
	});

	test('defaults the prompt to REVIEWER_TASK_PROMPT when omitted', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID });
		expect(result).toContain('<review> verdict tag on the very last line');
	});

	test('does not contain tee (TUI keeps its pty)', () => {
		const result = buildReviewerWorkerArgv({ uuid: SAMPLE_UUID });
		expect(result).not.toContain('tee');
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
		readReviewReport: overrides.readReviewReport,
		warnFn: overrides.warnFn,
		clearReviewReport: overrides.clearReviewReport,
		// US-005 / CAM-152: container isolation passthrough.
		workerIsolation: overrides.workerIsolation,
		preflightContainerFn: overrides.preflightContainerFn,
		escalateFn: overrides.escalateFn,
		capturedWrittenPrd,
		capturedSpawnArgs,
	};
}

describe('makeReviewDispatch', () => {
	const SAMPLE_UUID = '11111111-2222-3333-4444-555555555555';

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
		const result = dispatch(SAMPLE_UUID);

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
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		expect(capturedWrittenPrd.length).toBe(1);
		const written = capturedWrittenPrd[0];
		expect(written?.review?.lastVerdict).toBe('FIXES_PENDING:2');
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
		dispatch(SAMPLE_UUID);

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
		const result = dispatch(SAMPLE_UUID);

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
		const result = dispatch(SAMPLE_UUID);

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
		const result = dispatch(SAMPLE_UUID);

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
		const result = dispatch(SAMPLE_UUID);

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
		const result = dispatch(SAMPLE_UUID);

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
		dispatch(SAMPLE_UUID);

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
		expect(shellCmd).not.toMatch(/\s-p(\s|$)/);
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
		dispatch(SAMPLE_UUID);

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
		dispatch(SAMPLE_UUID);

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
		dispatch(SAMPLE_UUID);

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
			dispatch(SAMPLE_UUID);

			const written = capturedWrittenPrd[0];
			expect(written?.review?.roundsCompleted).toBe(3);
		}
	});

	// ---------------------------------------------------------------------------
	// review-report.json file-based verdict tests (US-002, CAM-75)
	// ---------------------------------------------------------------------------

	test('file-based CLEAN verdict: sourced from review-report.json, not pane tag', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		// Pane has no <review> tag -- completion comes from file only.
		const opts = makeDispatchOpts({
			paneText: 'Reviewing changes... (no tag here)',
			prd: makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => ({ verdict: 'CLEAN', findings: [] }),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		const written = capturedWrittenPrd[0];
		expect(written?.review?.lastVerdict).toBe('CLEAN');
		expect(written?.review?.roundsCompleted).toBe(1);
	});

	test('file-based FIXES_PENDING: verdict and findingsCount sourced from file', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		// Pane has no tag; file has FIXES_PENDING:2.
		const opts = makeDispatchOpts({
			paneText: 'still working...',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => ({
				verdict: 'FIXES_PENDING:2',
				findings: [
					{ severity: 'CRITICAL', file: 'src/foo.ts', line: 10, text: 'null deref' },
					{ severity: 'WARNING', text: 'missing test' },
				],
			}),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		const written = capturedWrittenPrd[0];
		expect(written?.review?.lastVerdict).toBe('FIXES_PENDING:2');
		const stories = written?.userStories ?? [];
		const fixStories = stories.filter((s) => s.id?.startsWith('US-R1-'));
		expect(fixStories.length).toBe(2);
	});

	test('file-based findings injected into fix story notes (verbatim severity/file/line/text)', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const findings = [
			{ severity: 'CRITICAL', file: 'src/foo.ts', line: 42, text: 'null deref on prd' },
			{ severity: 'WARNING', file: 'src/bar.ts', text: 'missing return type' },
			{ severity: 'SUGGESTION', text: 'consider extracting helper' },
		];
		const opts = makeDispatchOpts({
			paneText: 'no tag',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => ({ verdict: 'FIXES_PENDING:3', findings }),
		});

		const dispatch = makeReviewDispatch(opts);
		dispatch(SAMPLE_UUID);

		const written = capturedWrittenPrd[0];
		const stories = written?.userStories ?? [];

		// First story: CRITICAL with file and line.
		const s1 = stories.find((s) => s.id === 'US-R1-001');
		expect(s1?.notes).toContain('CRITICAL');
		expect(s1?.notes).toContain('src/foo.ts');
		expect(s1?.notes).toContain('42');
		expect(s1?.notes).toContain('null deref on prd');

		// Second story: WARNING with file, no line.
		const s2 = stories.find((s) => s.id === 'US-R1-002');
		expect(s2?.notes).toContain('WARNING');
		expect(s2?.notes).toContain('src/bar.ts');
		expect(s2?.notes).toContain('missing return type');

		// Third story: SUGGESTION with no file.
		const s3 = stories.find((s) => s.id === 'US-R1-003');
		expect(s3?.notes).toContain('SUGGESTION');
		expect(s3?.notes).toContain('consider extracting helper');
	});

	test('fallback: readReviewReport always null -> tag-based path used', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		// readReviewReport always returns null; pane has the tag.
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => null,
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		const written = capturedWrittenPrd[0];
		expect(written?.review?.lastVerdict).toBe('CLEAN');
	});

	test('file takes priority: when both file and tag present, file verdict wins', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		// File says CLEAN; pane says FIXES_PENDING. File should win.
		const opts = makeDispatchOpts({
			paneText: '<review>FIXES_PENDING:5</review>',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => ({ verdict: 'CLEAN', findings: [] }),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		const written = capturedWrittenPrd[0];
		// File's CLEAN verdict wins over pane's FIXES_PENDING tag.
		expect(written?.review?.lastVerdict).toBe('CLEAN');
	});

	test('FIXES_PENDING: prd.review.findings carries verbatim findings from review-report.json (US-003, CAM-75)', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const findings = [
			{ severity: 'CRITICAL', file: 'src/supervisor/review.ts', line: 100, text: 'null dereference on prd' },
			{ severity: 'WARNING', file: 'src/supervisor/decide.ts', text: 'unreachable branch' },
			{ severity: 'SUGGESTION', text: 'extract helper function' },
		];
		const opts = makeDispatchOpts({
			paneText: 'no tag here',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => ({ verdict: 'FIXES_PENDING:3', findings }),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		const written = capturedWrittenPrd[0];
		// prd.review.findings must carry the verbatim findings array from the file.
		const persistedFindings = written?.review?.findings;
		expect(persistedFindings).toBeDefined();
		expect(persistedFindings?.length).toBe(3);
		// Finding 0: CRITICAL with file and line.
		expect(persistedFindings?.[0]?.severity).toBe('CRITICAL');
		expect(persistedFindings?.[0]?.file).toBe('src/supervisor/review.ts');
		expect(persistedFindings?.[0]?.line).toBe(100);
		expect(persistedFindings?.[0]?.text).toBe('null dereference on prd');
		// Finding 1: WARNING with file, no line.
		expect(persistedFindings?.[1]?.severity).toBe('WARNING');
		expect(persistedFindings?.[1]?.file).toBe('src/supervisor/decide.ts');
		expect(persistedFindings?.[1]?.line).toBeUndefined();
		expect(persistedFindings?.[1]?.text).toBe('unreachable branch');
		// Finding 2: SUGGESTION with no file.
		expect(persistedFindings?.[2]?.severity).toBe('SUGGESTION');
		expect(persistedFindings?.[2]?.file).toBeUndefined();
		expect(persistedFindings?.[2]?.text).toBe('extract helper function');
	});

	test('FIXES_PENDING without file-based findings: prd.review.findings absent (tag-based path)', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>FIXES_PENDING:1</review>',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			// No readReviewReport -> tag-based fallback; findings absent from prd.
		});

		const dispatch = makeReviewDispatch(opts);
		dispatch(SAMPLE_UUID);

		const written = capturedWrittenPrd[0];
		// Tag-based path: no fileFindings available; prd.review.findings must not be set.
		expect(written?.review?.findings).toBeUndefined();
	});

	test('fix stories without file findings have no notes (tag fallback path)', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>FIXES_PENDING:1</review>',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			// No readReviewReport injected -> fallback path, no findings.
		});

		const dispatch = makeReviewDispatch(opts);
		dispatch(SAMPLE_UUID);

		const written = capturedWrittenPrd[0];
		const fixStory = (written?.userStories ?? []).find((s) => s.id === 'US-R1-001');
		expect(fixStory).toBeDefined();
		// No notes on tag-based path (no findings available).
		expect(fixStory?.notes).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// US-004: Graceful degradation when review-report.json is missing or malformed
// ---------------------------------------------------------------------------

describe('makeReviewDispatch: graceful degradation (US-004)', () => {
	const SAMPLE_UUID = '11111111-2222-3333-4444-555555555555';

	test('missing report file: falls back to tag verdict, returns status=ok, warning logged', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const warnings: string[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => null, // simulates missing file
			warnFn: (msg) => warnings.push(msg),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		// Must not throw; must complete successfully.
		expect(result.status).toBe('ok');
		expect(capturedWrittenPrd[0]?.review?.lastVerdict).toBe('CLEAN');
		// Warning must be logged when file is absent.
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain('missing or malformed');
	});

	test('malformed JSON report: falls back to tag verdict, returns status=ok, warning logged', () => {
		// From dispatch perspective, malformed JSON and missing file both return null
		// from readReviewReport. The dispatch must not throw in either case.
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const warnings: string[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>FIXES_PENDING:2</review>',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => null, // simulates malformed JSON (reader returns null)
			warnFn: (msg) => warnings.push(msg),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain('missing or malformed');
	});

	test('loop not wedged: missing report + FIXES_PENDING:N creates N fix stories and returns ok', () => {
		// AC5: with missing report and FIXES_PENDING:3 tag, dispatch returns 'ok' and
		// creates exactly 3 fix stories (count reconciled to the tag's N).
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const warnings: string[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>FIXES_PENDING:3</review>',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => null, // simulates missing report file
			warnFn: (msg) => warnings.push(msg),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		// Dispatch must not throw or block; status must be 'ok'.
		expect(result.status).toBe('ok');

		// Must create exactly N=3 fix stories reconciled to the tag's count.
		const written = capturedWrittenPrd[0];
		const fixStories = (written?.userStories ?? []).filter((s) => s.id?.startsWith('US-R1-'));
		expect(fixStories.length).toBe(3);
		fixStories.forEach((s) => {
			expect(s.passes).toBe(false);
		});

		// Warning logged because readReviewReport was provided but returned null.
		expect(warnings.length).toBeGreaterThan(0);
	});

	test('no warning when readReviewReport is absent (pure tag-based path, no file expected)', () => {
		// When readReviewReport is not injected at all, the dispatch uses the pure
		// tag-based path by design. No warning should be emitted.
		const warnings: string[] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			warnFn: (msg) => warnings.push(msg),
			// readReviewReport NOT injected -> pure tag-based path, no warning expected.
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		// No warning when the caller never expected a report file.
		expect(warnings.length).toBe(0);
	});

	test('warning emitted exactly once per dispatch invocation (not once per poll)', () => {
		// Even though the poll loop runs multiple iterations, the warning is logged
		// only once (at verdict-resolution time, not at each failed file check).
		const warnings: string[] = [];
		let polls = 0;
		const opts = makeDispatchOpts({
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturePane: (_paneId: string) => {
				polls += 1;
				// Tag appears on the 3rd poll to force multiple iterations.
				return polls < 3 ? 'still working...' : '<review>CLEAN</review>';
			},
			readReviewReport: () => null, // file always absent
			warnFn: (msg) => warnings.push(msg),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		expect(polls).toBeGreaterThanOrEqual(3);
		// Warning logged exactly once, not on every failed file check.
		expect(warnings.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// US-R1-001 regression: clearReviewReport is called before respawn-pane
//
// Proves that a stale review-report.json from a prior round cannot be read on
// the first poll tick of a new dispatch. The fix mirrors the clearWorkerReport
// call in loop.ts (line ~658): erase before respawn so the poll loop never
// sees an artifact from a previous round.
//
// The test verifies ordering: clearReviewReport must fire BEFORE the
// 'respawn-pane' tmux call, confirmed by recording the event sequence.
// ---------------------------------------------------------------------------

describe('makeReviewDispatch: US-R1-001 regression - clearReviewReport called before respawn-pane', () => {
	const SAMPLE_UUID = 'cc112233-4455-6677-8899-aabbccddeeff';

	test('clearReviewReport is invoked before respawn-pane when injected', () => {
		const events: string[] = [];

		// Record every clearReviewReport call.
		const clearReviewReport = () => {
			events.push('clear');
		};

		// Record every spawn call and note the respawn-pane call.
		const spawn: SpawnFn = (_cmd, args) => {
			if (args.includes('respawn-pane')) {
				events.push('respawn-pane');
			}
			return { stdout: '', exitCode: 0 };
		};

		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			spawn,
			clearReviewReport,
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');

		// Both events must have fired.
		expect(events).toContain('clear');
		expect(events).toContain('respawn-pane');

		// clear must come BEFORE respawn-pane.
		const clearIdx = events.indexOf('clear');
		const respawnIdx = events.indexOf('respawn-pane');
		expect(clearIdx).toBeLessThan(respawnIdx);
	});

	test('dispatch works correctly when clearReviewReport is absent (backward compat)', () => {
		// No clearReviewReport injected: dispatch must still complete without error.
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			// clearReviewReport intentionally omitted.
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
	});
});

// ---------------------------------------------------------------------------
// US-006 regression: findings source proof (AC3 for CAM-75)
//
// Proves that the findings injected into fix-story notes come exclusively from
// review-report.json, NOT from capture-pane text.
//
// The key property: tmux capture-pane returns what the TUI renderer printed.
// Ink renders "## CRITICAL" headings and "- [src/foo.ts:42]" bullets as plain
// text - the markdown syntax is consumed by the renderer and does not survive
// in the captured pane output. Any code that tried to parse structured findings
// from the pane would silently lose the "[file:line]" structure.
//
// This test verifies the invariant by supplying:
//   - a capturePane fake that returns "rendered" text (bullets stripped, brackets
//     absent) so any regex-based pane parsing would recover degraded content, and
//   - a review-report.json fake with DIFFERENT distinctive text than what the
//     pane shows.
// Then it asserts the fix-story notes carry the FILE's exact content (not the
// pane's degraded content), proving the file is the source.
// ---------------------------------------------------------------------------

describe('makeReviewDispatch: US-006 regression - findings come from file, not pane', () => {
	const SAMPLE_UUID = 'aabbccdd-1122-3344-5566-778899aabbcc';

	test('AC3: capturePane returns rendered markdown (bullets stripped); fix-story notes carry verbatim file findings, not pane text', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];

		// Simulate the pane after Ink/tmux rendering: the reviewer wrote markdown
		// with "## CRITICAL" headings and "- [src/supervisor/review.ts:99]" bullets,
		// but capture-pane captures the rendered output. The "[file:line]" bracket
		// structure is lost; only the flavor text survives in a degraded form.
		//
		// Critically, the text fragments below differ from the file findings to make
		// it unambiguous which source the notes came from.
		const simulatedRenderedPaneText = [
			'CRITICAL FINDING',
			'src supervisor review ts 99',  // rendered "[src/supervisor/review.ts:99]" - brackets/colon lost
			'some finding about dispatch',  // pane-side flavor text (different from file)
			'',
			'WARNING FINDING',
			'src supervisor decide ts',     // rendered "[src/supervisor/decide.ts]" - brackets/colon lost
			'some finding about verdict',   // pane-side flavor text (different from file)
			// No <review> tag - file is the primary completion signal.
		].join('\n');

		// The review-report.json carries the EXACT structured findings with distinctive
		// text that does NOT appear anywhere in the simulated rendered pane above.
		const fileFindings = [
			{
				severity: 'CRITICAL',
				file: 'src/supervisor/review.ts',
				line: 99,
				text: 'unreachable null dereference in reviewDispatch resolution path',
			},
			{
				severity: 'WARNING',
				file: 'src/supervisor/decide.ts',
				text: 'stale verdict check bypasses MAX_ROUNDS_DEBT guard',
			},
			{
				severity: 'SUGGESTION',
				text: 'extract buildFixStories result mapping into a named helper',
			},
		];

		const opts = makeDispatchOpts({
			paneText: simulatedRenderedPaneText,
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => ({ verdict: 'FIXES_PENDING:3', findings: fileFindings }),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');

		const written = capturedWrittenPrd[0];
		const stories = written?.userStories ?? [];

		// Story 1: CRITICAL finding with file + line.
		// Notes must carry the file's exact content, not anything reconstructed from the pane.
		const s1 = stories.find((s) => s.id === 'US-R1-001');
		expect(s1).toBeDefined();
		expect(s1?.notes).toContain('CRITICAL');
		expect(s1?.notes).toContain('src/supervisor/review.ts');   // verbatim file path
		expect(s1?.notes).toContain('99');                          // verbatim line number
		expect(s1?.notes).toContain('unreachable null dereference in reviewDispatch resolution path'); // verbatim file text

		// Negative: the pane-side degraded fragments must NOT appear in the notes.
		// If they did, it would prove the code is parsing the pane instead of the file.
		expect(s1?.notes).not.toContain('src supervisor review ts'); // pane's degraded form
		expect(s1?.notes).not.toContain('some finding about dispatch'); // pane-only flavor text

		// Story 2: WARNING finding with file, no line.
		const s2 = stories.find((s) => s.id === 'US-R1-002');
		expect(s2).toBeDefined();
		expect(s2?.notes).toContain('WARNING');
		expect(s2?.notes).toContain('src/supervisor/decide.ts');    // verbatim file path
		expect(s2?.notes).toContain('stale verdict check bypasses MAX_ROUNDS_DEBT guard'); // verbatim file text
		expect(s2?.notes).not.toContain('src supervisor decide ts'); // pane's degraded form
		expect(s2?.notes).not.toContain('some finding about verdict'); // pane-only flavor text

		// Story 3: SUGGESTION with no file or line.
		const s3 = stories.find((s) => s.id === 'US-R1-003');
		expect(s3).toBeDefined();
		expect(s3?.notes).toContain('SUGGESTION');
		expect(s3?.notes).toContain('extract buildFixStories result mapping into a named helper'); // verbatim file text
	});
});

// ---------------------------------------------------------------------------
// US-R2-001 regression: makeReadReviewReport verdict shape guard
//
// A valid-JSON-but-wrong-shape review-report.json (missing `verdict`, top-level
// array, extra-only keys) must return null from makeReadReviewReport so that
// makeReviewDispatch falls back to the <review>-tag verdict.
//
// Previously, makeReadReviewReport only checked `typeof parsed === 'object'`,
// so { "foo": "bar" } was returned as a bogus ReviewReport. makeReviewDispatch
// then called /^FIXES_PENDING:(\d+)$/.exec(undefined), derived FIXES_PENDING:0,
// and created a contentless placeholder fix story even when the pane had a valid
// <review>CLEAN</review> tag.
// ---------------------------------------------------------------------------

describe('makeReadReviewReport: verdict shape guard (US-R2-001 regression)', () => {
	const tmpDirs: string[] = [];

	afterEach(() => {
		for (const d of tmpDirs) {
			rmSync(d, { recursive: true, force: true });
		}
		tmpDirs.length = 0;
	});

	function makeTmpWithReport(json: unknown): string {
		const dir = mkdtempSync(join(tmpdir(), 'cam-review-report-shape-'));
		tmpDirs.push(dir);
		mkdirSync(join(dir, 'scripts', 'cam'), { recursive: true });
		writeFileSync(join(dir, REVIEW_REPORT_FILENAME), JSON.stringify(json));
		return dir;
	}

	test('returns null for a wrong-shape object missing the verdict field', () => {
		const dir = makeTmpWithReport({ foo: 'bar', findings: [] });
		const reader = makeReadReviewReport(dir);
		expect(reader()).toBeNull();
	});

	test('returns null for a top-level array (Array.isArray guard)', () => {
		const dir = makeTmpWithReport([{ verdict: 'CLEAN', findings: [] }]);
		const reader = makeReadReviewReport(dir);
		expect(reader()).toBeNull();
	});

	test('returns null when verdict is not a string (numeric)', () => {
		const dir = makeTmpWithReport({ verdict: 42, findings: [] });
		const reader = makeReadReviewReport(dir);
		expect(reader()).toBeNull();
	});

	test('returns the report when verdict is a string (well-formed)', () => {
		const dir = makeTmpWithReport({ verdict: 'CLEAN', findings: [] });
		const reader = makeReadReviewReport(dir);
		expect(reader()).toEqual({ verdict: 'CLEAN', findings: [] });
	});

	test('dispatch: wrong-shape file + CLEAN tag -> tag fallback, CLEAN verdict, warning logged', () => {
		// End-to-end regression: a wrong-shape file on disk (missing verdict) must not
		// override a valid <review>CLEAN</review> tag in the pane. The real production
		// reader makeReadReviewReport must return null, dispatch must warn and use tag.
		const dir = makeTmpWithReport({ notAVerdict: true, findings: [] });
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const warnings: string[] = [];

		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: makeReadReviewReport(dir),
			warnFn: (msg) => warnings.push(msg),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

		// Dispatch must not throw and must use the tag-based CLEAN verdict.
		expect(result.status).toBe('ok');
		expect(capturedWrittenPrd[0]?.review?.lastVerdict).toBe('CLEAN');
		// Warning must be logged because the reader was provided but returned null.
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain('missing or malformed');
	});
});

// ---------------------------------------------------------------------------
// US-005: behavioral-gate FAIL as a hard-constraint FAIL producing FIXES_PENDING
//
// Proves that a CRITICAL behavioral-gate finding in review-report.json routes
// through the existing FIXES_PENDING plumbing in makeReviewDispatch:
//   - readReviewReport returns { verdict: 'FIXES_PENDING:N', findings: [CRITICAL gate-fail] }
//   - dispatch returns status='ok', lastVerdict='FIXES_PENDING:N', N fix stories created
//   - each fix story carries the gate-fail finding text in its notes
//   - CLEAN when gate passed is unaffected: lastVerdict='CLEAN', no fix stories
//
// No new verdict enum or parallel gate-verdict field on prd.review is needed
// (AC4): the behavioral-gate FAIL is just a CRITICAL ReviewFinding that travels
// through the ordinary file-based findings channel.
// ---------------------------------------------------------------------------

describe('makeReviewDispatch: behavioral gate FAIL as hard-constraint (US-005)', () => {
	const SAMPLE_UUID = 'bbbbcccc-dddd-eeee-ffff-000011112222';

	test('CRITICAL behavioral-gate finding in review-report.json -> FIXES_PENDING:1 + fix story created', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const gateFinding = {
			severity: 'CRITICAL',
			text: 'Layer B behavioral gate FAIL: oracle [bun test] exited non-zero (3 tests failed)',
		};
		const opts = makeDispatchOpts({
			paneText: 'Reviewing... (no <review> tag before file arrives)',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => ({
				verdict: 'FIXES_PENDING:1',
				findings: [gateFinding],
			}),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		// Gate fail drives FIXES_PENDING via the normal findings channel.
		expect(result.status).toBe('ok');
		const written = capturedWrittenPrd[0];
		expect(written?.review?.lastVerdict).toBe('FIXES_PENDING:1');
		expect(written?.review?.roundsCompleted).toBe(1);

		// Fix story created carrying the behavioral-gate finding in notes.
		const stories = written?.userStories ?? [];
		const fixStory = stories.find((s) => s.id === 'US-R1-001');
		expect(fixStory).toBeDefined();
		expect(fixStory?.passes).toBe(false);
		expect(fixStory?.notes).toContain('CRITICAL');
		expect(fixStory?.notes).toContain('Layer B behavioral gate FAIL');
	});

	test('CRITICAL behavioral-gate finding with oracle name included in notes', () => {
		// Proves that the specific oracle command name reaches the fix-story notes,
		// so the implementer worker knows which oracle to re-run.
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const gateFinding = {
			severity: 'CRITICAL',
			text: "Layer B behavioral gate FAIL: oracle [file-assert grep -qi 'behavioral gate' .claude/agents/subagent-reviewer.md] exited non-zero",
		};
		const opts = makeDispatchOpts({
			paneText: 'no tag',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => ({
				verdict: 'FIXES_PENDING:1',
				findings: [gateFinding],
			}),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		const written = capturedWrittenPrd[0];
		expect(written?.review?.lastVerdict).toBe('FIXES_PENDING:1');

		const fixStory = (written?.userStories ?? []).find((s) => s.id === 'US-R1-001');
		expect(fixStory?.notes).toContain('file-assert');
		expect(fixStory?.notes).toContain('behavioral gate');
	});

	test('multiple gate failures -> FIXES_PENDING:N with one fix story per failing oracle', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const findings = [
			{
				severity: 'CRITICAL',
				text: 'Layer B behavioral gate FAIL: oracle [bun run typecheck] exited non-zero',
			},
			{
				severity: 'CRITICAL',
				text: 'Layer B behavioral gate FAIL: oracle [bun test] produced 2 failures',
			},
		];
		const opts = makeDispatchOpts({
			paneText: 'no tag',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => ({
				verdict: 'FIXES_PENDING:2',
				findings,
			}),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		const written = capturedWrittenPrd[0];
		expect(written?.review?.lastVerdict).toBe('FIXES_PENDING:2');

		const fixStories = (written?.userStories ?? []).filter((s) => s.id?.startsWith('US-R1-'));
		expect(fixStories.length).toBe(2);
		expect(fixStories[0]?.notes).toContain('bun run typecheck');
		expect(fixStories[1]?.notes).toContain('bun test');
	});

	test('CLEAN verdict when gate passed: lastVerdict=CLEAN, no fix stories, unaffected (AC3)', () => {
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const opts = makeDispatchOpts({
			paneText: 'no tag',
			prd: makePrd({
				stories: [{ id: 'US-001', priority: 1, passes: true }],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			// Gate passed: CLEAN with no findings.
			readReviewReport: () => ({
				verdict: 'CLEAN',
				findings: [],
			}),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		const written = capturedWrittenPrd[0];
		expect(written?.review?.lastVerdict).toBe('CLEAN');
		expect(written?.review?.roundsCompleted).toBe(1);

		// No fix stories created when gate passes.
		const fixStories = (written?.userStories ?? []).filter((s) => s.id?.startsWith('US-R'));
		expect(fixStories.length).toBe(0);

		// Original story preserved unchanged.
		const existingStory = written?.userStories?.find((s) => s.id === 'US-001');
		expect(existingStory).toBeDefined();
	});

	test('prd.review.findings carries the gate-fail finding (AC2: prd write assertion)', () => {
		// Verifies the complete end-to-end prd write contract:
		//   review-report.json with a behavioral-gate CRITICAL finding
		//   -> prd.review.lastVerdict='FIXES_PENDING:N'
		//   -> prd.review.findings carries the verbatim gate-fail finding
		const capturedWrittenPrd: PrdSnapshot[] = [];
		const gateFinding = {
			severity: 'CRITICAL',
			text: 'Layer B behavioral gate FAIL: oracle [bun run check:all] exited non-zero',
		};
		const opts = makeDispatchOpts({
			paneText: 'no tag',
			prd: makePrd({
				stories: [],
				review: { roundsCompleted: 0, maxRounds: 3 },
			}),
			capturedWrittenPrd,
			readReviewReport: () => ({
				verdict: 'FIXES_PENDING:1',
				findings: [gateFinding],
			}),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');
		const written = capturedWrittenPrd[0];

		// lastVerdict set correctly.
		expect(written?.review?.lastVerdict).toBe('FIXES_PENDING:1');

		// prd.review.findings carries the verbatim gate-fail finding.
		const persistedFindings = written?.review?.findings;
		expect(persistedFindings).toBeDefined();
		expect(persistedFindings?.length).toBe(1);
		expect(persistedFindings?.[0]?.severity).toBe('CRITICAL');
		expect(persistedFindings?.[0]?.text).toBe(
			'Layer B behavioral gate FAIL: oracle [bun run check:all] exited non-zero',
		);
	});
});

// ---------------------------------------------------------------------------
// US-005: reviewer container mode dispatch (CAM-152)
//
// AC1: container mode wraps shellCmd via dockerExecWrap before respawn-pane.
//      argv-shape: 'docker exec -it cam-worker env -u CLAUDECODE ... claude ...
//                   --session-id <lower-uuid>'.
// AC2: container preflight not-ready -> status='error', detail contains
//      'container-not-ready', no un-wrapped host respawn-pane is issued.
// AC3: container mode + preflight ready -> shellCmd IS wrapped and
//      respawn-pane IS called with the wrapped cmd.
// AC4: host mode (default) -> shellCmd unchanged, existing tests pass.
// AC5: escalateFn called fire-and-forget when preflight fails in container mode.
// AC6: absent preflightContainerFn -> no behavior change (backward compat).
// ---------------------------------------------------------------------------

describe('makeReviewDispatch: US-005 container mode dispatch', () => {
	const SAMPLE_UUID = 'cafebabe-dead-beef-0000-111122223333';

	test('AC1: container mode wraps shellCmd with docker exec argv-shape', () => {
		const capturedSpawnArgs: string[][] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({ stories: [], review: { roundsCompleted: 0, maxRounds: 3 } }),
			spawn: (_cmd, args) => {
				capturedSpawnArgs.push(args);
				return { stdout: '', exitCode: 0 };
			},
			workerIsolation: 'container',
			preflightContainerFn: () => ({ ready: true }),
		});

		const dispatch = makeReviewDispatch(opts);
		dispatch(SAMPLE_UUID);

		// First spawn call is the respawn-pane dispatch.
		const firstCall = capturedSpawnArgs[0] ?? [];
		expect(firstCall).toContain('respawn-pane');
		const shellCmd = firstCall[firstCall.length - 1] ?? '';

		// Must start with 'docker exec -it cam-worker' (dockerExecWrap prefix).
		expect(shellCmd).toMatch(/^docker exec -it cam-worker /);
		// Inner command must still contain the claude argv.
		expect(shellCmd).toContain('env -u CLAUDECODE');
		expect(shellCmd).toContain('claude');
		expect(shellCmd).toContain(`--session-id ${SAMPLE_UUID}`);
	});

	test('AC2: container mode + preflight not-ready -> status=error, container-not-ready detail, no wrapped respawn', () => {
		const capturedSpawnArgs: string[][] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({ stories: [], review: { roundsCompleted: 0, maxRounds: 3 } }),
			spawn: (_cmd, args) => {
				capturedSpawnArgs.push(args);
				return { stdout: '', exitCode: 0 };
			},
			workerIsolation: 'container',
			preflightContainerFn: () => ({ ready: false, reason: 'daemon-unreachable' }),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		// Must return error with container-not-ready detail.
		expect(result.status).toBe('error');
		expect(result.detail).toContain('container-not-ready');
		expect(result.detail).toContain('daemon-unreachable');

		// No respawn-pane with the reviewer shellCmd must have been dispatched.
		// The only spawn that may occur is a potential no-op; but critically, no
		// respawn-pane call with a 'claude' command should appear.
		const anyReviewerRespawn = capturedSpawnArgs.some(
			(args) => args.includes('respawn-pane') && (args[args.length - 1] ?? '').includes('claude'),
		);
		expect(anyReviewerRespawn).toBe(false);
	});

	test('AC3: container mode + preflight ready -> respawn-pane called with dockerExecWrap-wrapped cmd', () => {
		const capturedSpawnArgs: string[][] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({ stories: [], review: { roundsCompleted: 0, maxRounds: 3 } }),
			spawn: (_cmd, args) => {
				capturedSpawnArgs.push(args);
				return { stdout: '', exitCode: 0 };
			},
			workerIsolation: 'container',
			preflightContainerFn: () => ({ ready: true }),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('ok');

		// A respawn-pane call with a docker exec prefix must have been issued.
		const reviewerRespawn = capturedSpawnArgs.find(
			(args) => args.includes('respawn-pane') && (args[args.length - 1] ?? '').startsWith('docker exec -it'),
		);
		expect(reviewerRespawn).toBeDefined();
	});

	test('AC4: host mode (default/no workerIsolation) -> shellCmd unchanged, behavior identical to existing tests', () => {
		const capturedSpawnArgs: string[][] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({ stories: [], review: { roundsCompleted: 0, maxRounds: 3 } }),
			spawn: (_cmd, args) => {
				capturedSpawnArgs.push(args);
				return { stdout: '', exitCode: 0 };
			},
			// workerIsolation intentionally absent -> defaults to 'host'.
			preflightContainerFn: () => ({ ready: false, reason: 'daemon-unreachable' }),
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		// In host mode, preflight result is ignored (observe-only) and dispatch proceeds.
		expect(result.status).toBe('ok');

		// The respawn-pane shellCmd must NOT be wrapped with docker exec.
		const firstCall = capturedSpawnArgs[0] ?? [];
		const shellCmd = firstCall[firstCall.length - 1] ?? '';
		expect(shellCmd).not.toMatch(/^docker exec/);
		expect(shellCmd).toContain('claude');
	});

	test('AC5: escalateFn called fire-and-forget when preflight fails in container mode', async () => {
		let escalateCalled = false;
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({ stories: [], review: { roundsCompleted: 0, maxRounds: 3 } }),
			workerIsolation: 'container',
			preflightContainerFn: () => ({ ready: false, reason: 'image-missing' }),
			escalateFn: async () => {
				escalateCalled = true;
			},
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		expect(result.status).toBe('error');
		expect(result.detail).toContain('container-not-ready');

		// escalateFn is fire-and-forget; allow the microtask to flush.
		await new Promise((r) => setTimeout(r, 10));
		expect(escalateCalled).toBe(true);
	});

	test('AC6: absent preflightContainerFn -> no behavior change (backward compat)', () => {
		const capturedSpawnArgs: string[][] = [];
		const opts = makeDispatchOpts({
			paneText: '<review>CLEAN</review>',
			prd: makePrd({ stories: [], review: { roundsCompleted: 0, maxRounds: 3 } }),
			spawn: (_cmd, args) => {
				capturedSpawnArgs.push(args);
				return { stdout: '', exitCode: 0 };
			},
			workerIsolation: 'container',
			// preflightContainerFn intentionally absent.
		});

		const dispatch = makeReviewDispatch(opts);
		const result = dispatch(SAMPLE_UUID);

		// Without preflight, dispatch succeeds even in container mode.
		// (No wrapping either: if preflight is absent the feature is not enabled.)
		// Actually with absent preflight but container mode, the dispatchCmd IS
		// wrapped via dockerExecWrap since workerIsolation === 'container'.
		// The key is: no error is returned even though no preflight ran.
		expect(result.status).toBe('ok');
	});
});
