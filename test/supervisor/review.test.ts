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
