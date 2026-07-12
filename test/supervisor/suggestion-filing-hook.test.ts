// test/supervisor/suggestion-filing-hook.test.ts
//
// Unit + regression tests for the SUGGESTION follow-up hook wired into
// runSidecarLoop (US-003, CAM-189; sink redirected to the suggestions pen in
// US-003, CAM-285).
//
// Coverage (acceptance criteria):
//   AC1: loop.ts source-text oracle -- the hook lives inside runSidecarLoop,
//        strictly AFTER opts.clearActive() and BEFORE the flipActiveFn
//        auto-chain continue; no suggestion-filing code inside runSupervisor.
//   AC2: gate matrix -- complete+CLEAN fires, awaiting-operator+CLEAN fires,
//        complete+MAX_ROUNDS_DEBT fires, blocked/error statuses never fire,
//        a non-terminal verdict never fires.
//   AC3: real-path regression -- runSidecarLoop driven with the REAL
//        makeClearActive + REAL onProgress state-file writer + a REAL
//        review-report.json fixture (2 SUGGESTIONs) on disk, with injected
//        spawn/filing fakes; both SUGGESTIONs reach fileSuggestionsFn and
//        exactly one pane summary line is pushed.
//   AC6: exactly one summary line is pushed when >=1 SUGGESTION is penned
//        (reporting pen-append counts, never filed issue ids); nothing is
//        pushed when the report is null, has no SUGGESTIONs, or the batch is
//        fully deduped.
//   AC7 (outer crash-survival): a throwing fileSuggestionsFn never crashes
//        the loop; a 'sidecar-exit' event is logged with a dedicated reason.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	runSidecarLoop,
	type RunSidecarLoopOptions,
	type RunSupervisorOptions,
	type SupervisorResult,
} from '../../src/supervisor/loop.ts';
import { makeClearActive } from '../../src/commands/sidecar.ts';
import { makeOnProgress } from '../../src/supervisor/host.ts';
import { renderStateFile, writeStateFile } from '../../src/commands/next.ts';
import { parseStateFile } from '../../src/commands/status.ts';
import { makeInMemoryEventLogger, type WorkerEvent } from '../../src/supervisor/events.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import type { ReviewReport } from '../../src/supervisor/review-report.ts';
import type { FollowUpProvenance } from '../../src/supervisor/suggestion-followups.ts';

const ESCAPE = Symbol('escape');

// ---------------------------------------------------------------------------
// AC1: loop.ts source-text oracle
// ---------------------------------------------------------------------------

describe('AC1: loop.ts source-text oracle -- suggestion-filing hook placement', () => {
	const loopSrc = readFileSync(resolve(import.meta.dir, '../../src/supervisor/loop.ts'), 'utf8');

	const runSupervisorIdx = loopSrc.indexOf('export async function runSupervisor(');
	const runSidecarLoopSectionIdx = loopSrc.indexOf('// runSidecarLoop — outer active-flag gate');
	const runSidecarLoopFnIdx = loopSrc.indexOf('export async function runSidecarLoop(');
	const clearActiveIdx = loopSrc.indexOf('opts.clearActive();');
	const hookIdx = loopSrc.indexOf('// US-003 (CAM-189): file SUGGESTION follow-ups at the terminal verdict.');
	const flipActiveIdx = loopSrc.indexOf(
		'if (opts.flipActiveFn !== undefined && opts.hasPendingStories && opts.hasPendingStories()) {',
	);

	test('the hook comment exists exactly once', () => {
		expect(hookIdx).toBeGreaterThan(-1);
	});

	test('the hook lives inside runSidecarLoop, after clearActive() and before the flipActiveFn continue', () => {
		expect(hookIdx).toBeGreaterThan(runSidecarLoopFnIdx);
		expect(hookIdx).toBeGreaterThan(clearActiveIdx);
		expect(hookIdx).toBeLessThan(flipActiveIdx);
	});

	test('runSupervisor function body (before the runSidecarLoop section) contains no suggestion-filing code', () => {
		expect(runSupervisorIdx).toBeGreaterThan(-1);
		expect(runSidecarLoopSectionIdx).toBeGreaterThan(runSupervisorIdx);
		const runSupervisorBody = loopSrc.slice(runSupervisorIdx, runSidecarLoopSectionIdx);
		expect(runSupervisorBody).not.toContain('fileSuggestionsFn');
		expect(runSupervisorBody).not.toContain('readReviewReportFn');
	});
});

// ---------------------------------------------------------------------------
// Shared fakes for AC2/AC6/AC7
// ---------------------------------------------------------------------------

function makeDummySupervisorOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	return {
		spawn: () => ({ stdout: '', exitCode: 0 }),
		capturePane: () => '',
		readPrd: () => null,
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-07-08T00:00:00Z',
		reviewDispatch: () => ({ status: 'ok', detail: '' }),
		writeSessionMarker: () => {},
		isPaneAlive: () => true,
		workerPaneId: '%2',
		prdPath: '/fake/prd.json',
		handoffPath: '/fake/handoff.json',
		permissionMode: 'bypassPermissions',
		taskPrompt: 'test',
		sleepFn: () => {},
		nowMs: () => 0,
		...overrides,
	};
}

function makePrd(verdict: string | null, issueNumber?: number): PrdSnapshot {
	return {
		branchName: 'cam/pr-189-suggestion-followups',
		issueNumber,
		userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }],
		review: verdict === null ? undefined : { roundsCompleted: 2, lastVerdict: verdict },
	};
}

const REPORT_WITH_SUGGESTIONS: ReviewReport = {
	verdict: 'CLEAN',
	findings: [
		{ severity: 'SUGGESTION', text: 'Extract this helper.', file: 'src/a.ts', line: 1 },
		{ severity: 'SUGGESTION', text: 'Rename this variable.', file: 'src/b.ts', line: 2 },
	],
};

function statusResult(status: SupervisorResult['status']): SupervisorResult {
	return { status, iterations: 1, lastOutcome: null };
}

/** Drive one active tick of runSidecarLoop, mirroring auto-chain.test.ts's driveOneTick. */
async function driveOneTick(loopOptsPartial: Partial<RunSidecarLoopOptions> & { result: SupervisorResult }) {
	const { result, ...rest } = loopOptsPartial;
	const readActiveSeq: Array<boolean> = [true, false];
	let readIdx = 0;
	// hasPendingStories: true on the first call (bypasses the pre-dispatch
	// "active but nothing pending" early-exit so runSupervisorFn actually
	// runs), false afterwards (bypasses the flipActiveFn auto-chain re-check
	// after clearActive, matching auto-chain.test.ts's driveOneTick).
	let pendingCallCount = 0;

	const loopOpts: RunSidecarLoopOptions = {
		buildOpts: () => makeDummySupervisorOpts(),
		readActive: () => readActiveSeq[readIdx++] ?? false,
		clearActive: () => {},
		sleep: () => {
			throw ESCAPE;
		},
		hasPendingStories: () => {
			pendingCallCount++;
			return pendingCallCount <= 1;
		},
		acquireLock: () => ({ acquired: true, release: () => {} }),
		runSupervisorFn: async () => result,
		...rest,
	};

	try {
		await runSidecarLoop(loopOpts);
	} catch (e) {
		if (e !== ESCAPE) throw e;
	}
}

// ---------------------------------------------------------------------------
// AC2: gate matrix
// ---------------------------------------------------------------------------

describe('AC2: suggestion-filing hook gate matrix', () => {
	test('complete + CLEAN -> fires', async () => {
		let readCalls = 0;
		await driveOneTick({
			result: statusResult('complete'),
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => makePrd('CLEAN') }),
			readReviewReportFn: () => {
				readCalls++;
				return null;
			},
			fileSuggestionsFn: () => ({ penned: 0, dupSkipped: 0 }),
		});
		expect(readCalls).toBe(1);
	});

	test('awaiting-operator + CLEAN -> fires', async () => {
		let readCalls = 0;
		await driveOneTick({
			result: statusResult('awaiting-operator'),
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => makePrd('CLEAN') }),
			readReviewReportFn: () => {
				readCalls++;
				return null;
			},
			fileSuggestionsFn: () => ({ penned: 0, dupSkipped: 0 }),
		});
		expect(readCalls).toBe(1);
	});

	test('complete + MAX_ROUNDS_DEBT -> fires', async () => {
		let readCalls = 0;
		await driveOneTick({
			result: statusResult('complete'),
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => makePrd('MAX_ROUNDS_DEBT') }),
			readReviewReportFn: () => {
				readCalls++;
				return null;
			},
			fileSuggestionsFn: () => ({ penned: 0, dupSkipped: 0 }),
		});
		expect(readCalls).toBe(1);
	});

	test('blocked status -> never fires', async () => {
		let readCalls = 0;
		await driveOneTick({
			result: statusResult('blocked'),
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => makePrd('CLEAN') }),
			readReviewReportFn: () => {
				readCalls++;
				return null;
			},
			fileSuggestionsFn: () => ({ penned: 0, dupSkipped: 0 }),
		});
		expect(readCalls).toBe(0);
	});

	test('max-iterations status -> never fires', async () => {
		let readCalls = 0;
		await driveOneTick({
			result: statusResult('max-iterations'),
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => makePrd('CLEAN') }),
			readReviewReportFn: () => {
				readCalls++;
				return null;
			},
			fileSuggestionsFn: () => ({ penned: 0, dupSkipped: 0 }),
		});
		expect(readCalls).toBe(0);
	});

	test('complete + non-terminal verdict (FIXES_PENDING:1) -> never fires', async () => {
		let readCalls = 0;
		await driveOneTick({
			result: statusResult('complete'),
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => makePrd('FIXES_PENDING:1') }),
			readReviewReportFn: () => {
				readCalls++;
				return null;
			},
			fileSuggestionsFn: () => ({ penned: 0, dupSkipped: 0 }),
		});
		expect(readCalls).toBe(0);
	});

	test('complete + null verdict -> never fires', async () => {
		let readCalls = 0;
		await driveOneTick({
			result: statusResult('complete'),
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => makePrd(null) }),
			readReviewReportFn: () => {
				readCalls++;
				return null;
			},
			fileSuggestionsFn: () => ({ penned: 0, dupSkipped: 0 }),
		});
		expect(readCalls).toBe(0);
	});

	test('readReviewReportFn/fileSuggestionsFn absent -> hook is fully inert (no throw)', async () => {
		let caught: unknown;
		try {
			await driveOneTick({
				result: statusResult('complete'),
				buildOpts: () => makeDummySupervisorOpts({ readPrd: () => makePrd('CLEAN') }),
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// AC6: notify summary rules
// ---------------------------------------------------------------------------

describe('AC6: exactly one pane summary line, only when something was penned', () => {
	test('penned non-zero -> exactly one notify call reporting pen-append counts, not filed issue ids', async () => {
		const notified: string[] = [];
		await driveOneTick({
			result: statusResult('complete'),
			buildOpts: () =>
				makeDummySupervisorOpts({
					readPrd: () => makePrd('CLEAN'),
					notifyOrchestrator: (line) => notified.push(line),
				}),
			readReviewReportFn: () => REPORT_WITH_SUGGESTIONS,
			fileSuggestionsFn: () => ({ penned: 2, dupSkipped: 1 }),
		});
		expect(notified).toHaveLength(1);
		expect(notified[0]).toContain('2');
		expect(notified[0]).toContain('dup-skipped');
		expect(notified[0]).not.toContain('CAM-');
	});

	test('readReviewReportFn returns null -> fileSuggestionsFn never called, nothing pushed', async () => {
		const notified: string[] = [];
		let fileCalls = 0;
		await driveOneTick({
			result: statusResult('complete'),
			buildOpts: () =>
				makeDummySupervisorOpts({
					readPrd: () => makePrd('CLEAN'),
					notifyOrchestrator: (line) => notified.push(line),
				}),
			readReviewReportFn: () => null,
			fileSuggestionsFn: () => {
				fileCalls++;
				return { penned: 0, dupSkipped: 0 };
			},
		});
		expect(fileCalls).toBe(0);
		expect(notified).toHaveLength(0);
	});

	test('all-deduped batch (penned 0) -> nothing pushed', async () => {
		const notified: string[] = [];
		await driveOneTick({
			result: statusResult('complete'),
			buildOpts: () =>
				makeDummySupervisorOpts({
					readPrd: () => makePrd('CLEAN'),
					notifyOrchestrator: (line) => notified.push(line),
				}),
			readReviewReportFn: () => REPORT_WITH_SUGGESTIONS,
			fileSuggestionsFn: () => ({ penned: 0, dupSkipped: 2 }),
		});
		expect(notified).toHaveLength(0);
	});

	test('zero-SUGGESTION report -> nothing pushed', async () => {
		const notified: string[] = [];
		await driveOneTick({
			result: statusResult('complete'),
			buildOpts: () =>
				makeDummySupervisorOpts({
					readPrd: () => makePrd('CLEAN'),
					notifyOrchestrator: (line) => notified.push(line),
				}),
			readReviewReportFn: () => ({ verdict: 'CLEAN', findings: [] }),
			fileSuggestionsFn: () => ({ penned: 0, dupSkipped: 0 }),
		});
		expect(notified).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC7 (US-001, CAM-263): parentIssue reaches FollowUpProvenance from the prd snapshot
// ---------------------------------------------------------------------------

describe('AC7 (US-001, CAM-263): prd.issueNumber reaches FollowUpProvenance.parentIssue', () => {
	test('provenance.parentIssue equals the prd snapshot issueNumber', async () => {
		let capturedProvenance: FollowUpProvenance | undefined;
		await driveOneTick({
			result: statusResult('complete'),
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => makePrd('CLEAN', 263) }),
			readReviewReportFn: () => REPORT_WITH_SUGGESTIONS,
			fileSuggestionsFn: (_report, provenance) => {
				capturedProvenance = provenance;
				return { penned: 0, dupSkipped: 0 };
			},
		});
		expect(capturedProvenance?.parentIssue).toBe(263);
	});

	test('prd snapshot with no issueNumber -> provenance.parentIssue is undefined', async () => {
		let capturedProvenance: FollowUpProvenance | undefined;
		await driveOneTick({
			result: statusResult('complete'),
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => makePrd('CLEAN') }),
			readReviewReportFn: () => REPORT_WITH_SUGGESTIONS,
			fileSuggestionsFn: (_report, provenance) => {
				capturedProvenance = provenance;
				return { penned: 0, dupSkipped: 0 };
			},
		});
		expect(capturedProvenance?.parentIssue).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// AC5: idempotent re-fire across two terminal ticks
// ---------------------------------------------------------------------------

describe('AC5: idempotent re-fire -- a later complete terminal after an awaiting-operator terminal appends 0 and pushes nothing', () => {
	test('round 2 (complete) re-fires against the same report but appends 0 and pushes no summary', async () => {
		const notified: string[] = [];
		let fileCallCount = 0;
		const readActiveSeq: Array<boolean> = [true, true, false];
		let readIdx = 0;
		let sleepCalls = 0;

		// Round 1: 'awaiting-operator' terminal, nothing filed yet -> both findings
		// filed. Round 2: 'complete' terminal, same report -> the (fake) dedup
		// mechanism recognizes both findings are already filed -> 0.
		const resultSeq: SupervisorResult[] = [statusResult('awaiting-operator'), statusResult('complete')];
		let resultIdx = 0;

		const loopOpts: RunSidecarLoopOptions = {
			buildOpts: () =>
				makeDummySupervisorOpts({
					readPrd: () => makePrd('CLEAN'),
					notifyOrchestrator: (line) => notified.push(line),
				}),
			readActive: () => readActiveSeq[readIdx++] ?? false,
			clearActive: () => {},
			sleep: () => {
				sleepCalls++;
				if (sleepCalls >= 2) throw ESCAPE;
			},
			hasPendingStories: () => true,
			acquireLock: () => ({ acquired: true, release: () => {} }),
			runSupervisorFn: async () => resultSeq[resultIdx++] ?? statusResult('blocked'),
			readReviewReportFn: () => REPORT_WITH_SUGGESTIONS,
			fileSuggestionsFn: () => {
				fileCallCount++;
				return fileCallCount === 1
					? { penned: 2, dupSkipped: 0 }
					: { penned: 0, dupSkipped: 2 };
			},
		};

		let caught: unknown;
		try {
			await runSidecarLoop(loopOpts);
		} catch (e) {
			caught = e;
		}

		expect(caught).toBe(ESCAPE);
		expect(fileCallCount).toBe(2);
		// Only round 1 (the first, non-deduped fire) pushes a summary line.
		expect(notified).toHaveLength(1);
		expect(notified[0]).toContain('2');
	});
});

// ---------------------------------------------------------------------------
// AC7 (outer crash-survival): a throwing fileSuggestionsFn never crashes the loop
// ---------------------------------------------------------------------------

describe('AC7: a throwing fileSuggestionsFn is caught and logged, never crashes the loop', () => {
	test('throwing fileSuggestionsFn logs a sidecar-exit event and the loop continues to idle', async () => {
		const { logger: logEvent, events } = makeInMemoryEventLogger();
		await driveOneTick({
			result: statusResult('complete'),
			buildOpts: () => makeDummySupervisorOpts({ readPrd: () => makePrd('CLEAN') }),
			readReviewReportFn: () => REPORT_WITH_SUGGESTIONS,
			fileSuggestionsFn: () => {
				throw new Error('injected filing crash');
			},
			logEvent,
		});

		const crashEvents = events.filter((e: WorkerEvent) => e.kind === 'sidecar-exit');
		expect(crashEvents.length).toBeGreaterThanOrEqual(1);
		const detail = crashEvents[crashEvents.length - 1]?.detail as { reason?: string };
		expect(detail.reason).toBe('suggestion-filing-crash-outer');
	});
});

// ---------------------------------------------------------------------------
// AC3: real-path regression -- runSidecarLoop with real state-file writers
// ---------------------------------------------------------------------------

describe('AC3: real-path regression -- real clearActive + real onProgress + real review-report.json fixture', () => {
	test('both SUGGESTIONs reach fileSuggestionsFn and exactly one pane summary line is pushed', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-suggestion-filing-real-'));
		try {
			const claudeDir = join(cwd, '.claude');
			const scriptsDir = join(cwd, 'scripts', 'cam');
			mkdirSync(claudeDir, { recursive: true });
			mkdirSync(scriptsDir, { recursive: true });

			const prdPath = join(scriptsDir, 'prd.json');
			const reviewReportPath = join(scriptsDir, 'review-report.json');
			const stateFilePath = join(claudeDir, 'cam-loop.local.md');

			const cleanPrd: PrdSnapshot = {
				branchName: 'cam/pr-189-suggestion-followups',
				userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }],
				review: { roundsCompleted: 1, maxRounds: 3, lastVerdict: 'CLEAN' },
			};
			writeFileSync(prdPath, `${JSON.stringify(cleanPrd, null, 2)}\n`, 'utf8');
			writeFileSync(reviewReportPath, `${JSON.stringify(REPORT_WITH_SUGGESTIONS, null, 2)}\n`, 'utf8');

			const seedBody = renderStateFile({
				maxIterations: 50,
				completionPromise: 'COMPLETE',
				startedAt: new Date().toISOString(),
				pid: 1,
				phase: 'implementing',
			});
			writeStateFile(cwd, seedBody, { force: true });

			const realClearActive = makeClearActive(claudeDir, cwd);
			const realOnProgress = makeOnProgress(stateFilePath, {
				maxIterations: 50,
				completionPromise: 'COMPLETE',
				startedAt: new Date().toISOString(),
				pid: 1,
			});

			const readPrd = (): PrdSnapshot | null => {
				try {
					return JSON.parse(readFileSync(prdPath, 'utf8')) as PrdSnapshot;
				} catch {
					return null;
				}
			};
			const writePrd = (prd: PrdSnapshot): void => {
				writeFileSync(prdPath, `${JSON.stringify(prd, null, 2)}\n`, 'utf8');
			};

			// Reads the SAME review-report.json fixture path a real
			// makeReadReviewReport(cwd) would read (mirrors host.ts's
			// REVIEW_REPORT_FILENAME join), without importing the production
			// factory here (keeps the fixture path assertion self-contained).
			const realReadReviewReportFn = (): ReviewReport | null => {
				try {
					return JSON.parse(readFileSync(reviewReportPath, 'utf8')) as ReviewReport;
				} catch {
					return null;
				}
			};

			const notified: string[] = [];
			const filingCalls: Array<{ report: ReviewReport; provenance: FollowUpProvenance }> = [];

			const supervisorOpts: RunSupervisorOptions = {
				spawn: () => ({ stdout: '', exitCode: 0 }),
				capturePane: () => '',
				readPrd,
				writePrd,
				readHandoff: () => null,
				clock: () => '2026-07-08T21:00:00Z',
				reviewDispatch: () => ({ status: 'ok', detail: '' }),
				writeSessionMarker: () => {},
				isPaneAlive: () => true,
				workerPaneId: '%2',
				prdPath,
				handoffPath: join(scriptsDir, 'handoff.json'),
				permissionMode: 'bypassPermissions',
				taskPrompt: 'test',
				sleepFn: () => {},
				nowMs: () => 0,
				onProgress: realOnProgress,
				notifyOrchestrator: (line) => notified.push(line),
			};

			let sleepCalls = 0;
			let activeCallCount = 0;
			// True on the first call (bypasses the pre-dispatch "active but
			// nothing pending" early-exit so runSupervisorFn actually runs),
			// false afterwards (bypasses the flipActiveFn auto-chain re-check).
			let pendingCallCount = 0;

			const loopOpts: RunSidecarLoopOptions = {
				buildOpts: () => supervisorOpts,
				readActive: () => {
					activeCallCount++;
					return activeCallCount === 1;
				},
				clearActive: realClearActive,
				sleep: () => {
					sleepCalls++;
					if (sleepCalls >= 1) throw ESCAPE;
				},
				hasPendingStories: () => {
					pendingCallCount++;
					return pendingCallCount <= 1;
				},
				acquireLock: () => ({ acquired: true as const, release: () => {} }),
				// runSupervisorFn deliberately omitted: runSidecarLoop defaults it to
				// the REAL runSupervisor, which resolves 'complete' on the very first
				// tick (no worker dispatch) because cleanPrd already has all stories
				// passing and review.lastVerdict CLEAN. This is what actually invokes
				// the real onProgress unlink-on-complete write below (a canned
				// SupervisorResult from a fake runSupervisorFn never touches
				// onProgress at all, since onProgress is called by runSupervisor
				// itself, not by the outer loop).
				readReviewReportFn: realReadReviewReportFn,
				fileSuggestionsFn: (report, provenance) => {
					filingCalls.push({ report, provenance });
					return { penned: 2, dupSkipped: 0 };
				},
			};

			let caughtErr: unknown;
			try {
				await runSidecarLoop(loopOpts);
			} catch (err) {
				caughtErr = err;
			}

			expect(caughtErr).toBe(ESCAPE);

			// The real onProgress unlink-on-complete ran inside runSupervisor, and
			// the real clearActive's implicit phase:idle rewrite ran after it (same
			// ADR-0013 ordering the auto-ship regression proves): the state file no
			// longer carries the seeded 'implementing' phase. The hook still fired
			// against the real prd.json + fixture despite this rewrite chain.
			expect(existsSync(stateFilePath)).toBe(true);
			const finalStateContents = readFileSync(stateFilePath, 'utf8');
			expect(parseStateFile(finalStateContents)?.phase).toBe('idle');

			expect(filingCalls).toHaveLength(1);
			expect(filingCalls[0]?.report.findings).toHaveLength(2);
			expect(filingCalls[0]?.provenance.source).toBe('cam/pr-189-suggestion-followups');
			expect(filingCalls[0]?.provenance.round).toBe(1);

			expect(notified).toHaveLength(1);
			expect(notified[0]).toContain('2');
			expect(notified[0]).toContain('penned');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
