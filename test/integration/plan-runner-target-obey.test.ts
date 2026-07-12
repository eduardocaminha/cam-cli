// test/integration/plan-runner-target-obey.test.ts
//
// E2E regression (REAL tmux, private socket): drives runPlanPhase with
// selectIssueFn returning CAM-157 (NOT the top-of-queue issue), using a
// planner stub that reads the named issue id from the task prompt embedded
// in the respawn-pane shell string and echoes the numeric id into
// scripts/cam/prd.json.
//
// Oracle: resulting prd.json.issueNumber === 157 (the numeric suffix of
// CAM-157), never the top-of-queue issue id.
//
// This test proves the end-to-end chain:
//   selectIssueFn(CAM-157) -> buildPlannerTaskPrompt('CAM-157') contains
//   'CAM-157' -> planner stub extracts 157 -> prd.json.issueNumber === 157.
//
// The fakes-mentem class (CAM-55 lesson) that the existing unit tests
// missed: unit mocks return whatever the code expects, so a bug where the
// prompt did NOT include the issue id was invisible. This real-tmux test
// forces the prompt through the actual buildPlannerWorkerArgv path so the
// shell string is inspected as it would be at runtime.
//
// Pattern mirrors test/integration/plan-runner-no-prd.test.ts exactly
// (private socket, swap adapter, test.skipIf(!tmuxAvailable),
// beforeEach/afterEach, real isPaneAlive probe).

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	writeFileSync,
	readFileSync,
	existsSync,
	mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPlanPhase } from '../../src/supervisor/plan-runner.ts';
import {
	openPaneInSession,
	writeWorkerPaneMarker,
	type SpawnFn,
} from '../../src/tmux/session.ts';
import type { SpawnFn as LoopSpawnFn } from '../../src/supervisor/loop.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import {
	PLAN_VERDICT_REPORT_FILENAME,
	makeReadPlanVerdict,
} from '../../src/supervisor/plan-verdict-report.ts';

const TEST_SOCK = 'cam-it-target';
const SESSION = 'target-test';

const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

/** Run tmux on the private test socket (for setup/teardown). */
function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync('tmux', ['-L', TEST_SOCK, ...args], { stdio: 'pipe' });
}

/**
 * SpawnFn that rewrites the `-L cam` socket in all argv to the private test
 * socket. Helpers emit `['-L', 'cam', ...]`; swapping here means calls land on
 * the private server instead of the live cam session.
 */
const swapSocketSpawn: SpawnFn = (cmd, args, opts) => {
	const swapped = [...args];
	const lIdx = swapped.indexOf('-L');
	if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
	return spawnSync(cmd, swapped, { stdio: opts?.stdio ?? 'pipe' }) as ReturnType<SpawnFn>;
};

beforeEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
	tmuxRaw(['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '10']);
	Bun.sleepSync(200);
});

afterEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
});

/**
 * Probe whether a pane is alive using real tmux pane_dead check on the
 * private socket. Mirrors the isPaneAlive logic in sidecar.ts.
 */
function isPaneAlive(paneId: string): boolean {
	const r = swapSocketSpawn(
		'tmux',
		['-L', 'cam', 'display-message', '-p', '-t', paneId, '#{pane_dead}'],
		{ stdio: 'pipe' },
	);
	if ((r.status ?? 1) !== 0) return false;
	const out =
		typeof r.stdout === 'string'
			? r.stdout.trim()
			: (r.stdout as Buffer | undefined)?.toString().trim() ?? '';
	return out === '0';
}

// ---------------------------------------------------------------------------
// Issue fixtures
// ---------------------------------------------------------------------------

/** The targeted issue (NOT top-of-queue). */
const TARGET_ISSUE: IssueEntry = {
	id: 'CAM-157',
	title: 'Plan runner authoritative target',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-02T00:00:00Z',
	updatedAt: '2026-07-02T00:00:00Z',
};

/** Top-of-queue issue (must NOT appear in the prompt when CAM-157 is targeted). */
const TOP_ISSUE: IssueEntry = {
	id: 'CAM-99',
	title: 'Top-of-queue issue that must be bypassed',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-01T00:00:00Z',
	updatedAt: '2026-07-01T00:00:00Z',
};
void TOP_ISSUE; // referenced in comment only; selectIssueFn returns TARGET_ISSUE.

// ---------------------------------------------------------------------------
// E2E test
// ---------------------------------------------------------------------------

test.skipIf(!tmuxAvailable)(
	'E2E: runPlanPhase with CAM-157 target -> prd.json.issueNumber === 157, not top-of-queue id',
	() => {
		// ------------------------------------------------------------------
		// 1. Set up a cwd directory tree (mimics the repo root).
		// ------------------------------------------------------------------
		const cwd = mkdtempSync(join(tmpdir(), 'cam-it-target-cwd-'));
		mkdirSync(join(cwd, 'scripts', 'cam'), { recursive: true });

		const prdPath = join(cwd, 'scripts', 'cam', 'prd.json');
		const verdictPath = join(cwd, PLAN_VERDICT_REPORT_FILENAME);

		// ------------------------------------------------------------------
		// 2. Allocate a worker pane in the private session.
		// ------------------------------------------------------------------
		const orchPaneId =
			tmuxRaw(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])
				.stdout.toString()
				.trim()
				.split('\n')[0] ?? `${SESSION}:0`;

		const workerPaneId = openPaneInSession(SESSION, ['cat'], swapSocketSpawn, orchPaneId);
		Bun.sleepSync(100);
		expect(workerPaneId).toMatch(/^%\d+$/);

		const claudeDir = mkdtempSync(join(tmpdir(), 'cam-it-target-claude-'));
		writeWorkerPaneMarker(claudeDir, workerPaneId);

		// ------------------------------------------------------------------
		// 3. Build the loopSpawnFn that intercepts respawn-pane calls.
		//
		// When the planner respawn-pane is intercepted:
		//   a. Extract the issue id from the shell string (looks for the
		//      "Plan issue CAM-NNN" pattern from buildPlannerTaskPrompt).
		//   b. Derive the numeric id suffix (split on '-', take last part).
		//   c. Write prd.json with { issueNumber: <numeric>, userStories: [] }
		//      in cwd -- this is the signal that readPlannerReportFn picks up.
		//   d. Run respawn-pane with 'exit 0' (stand-in exits immediately).
		//
		// When the auditor respawn-pane is intercepted:
		//   Write a minimal APPROVE verdict report so runPlanPhase can complete
		//   via the audit-approved path (not auditor-timeout).
		// ------------------------------------------------------------------
		let plannerShellStr = '';
		let plannerRespawnCount = 0;
		let auditorRespawnCount = 0;

		const loopSpawnFn: LoopSpawnFn = (cmd, args, spawnOpts) => {
			if (cmd === 'tmux') {
				const isRespawn = args.includes('respawn-pane');

				if (isRespawn) {
					const shellStr = args[args.length - 1] ?? '';

					if (plannerRespawnCount === 0) {
						// First respawn = planner spawn.
						plannerRespawnCount++;
						plannerShellStr = shellStr;

						// Extract issue id from the prompt.
						// buildPlannerTaskPrompt produces: "Plan issue CAM-NNN specifically ..."
						const idMatch = /Plan issue (CAM-\d+)/.exec(shellStr);
						const issueId = idMatch?.[1];
						const numericStr = issueId?.split('-').at(-1);
						const numericId = numericStr !== undefined ? Number(numericStr) : null;

						if (numericId !== null && !Number.isNaN(numericId)) {
							// Write prd.json: the planner's completion signal.
							writeFileSync(
								prdPath,
								JSON.stringify({
									issueNumber: numericId,
									branchName: `cam/CAM-${numericId}-test`,
									userStories: [],
									review: {},
								}),
							);
						}

						// Run respawn-pane with 'exit 0' so the pane dies.
						const swapped = [...args];
						const lIdx = swapped.indexOf('-L');
						if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
						swapped[swapped.length - 1] = 'exit 0';
						const r = spawnSync(cmd, swapped, {
							stdio: spawnOpts?.stdio ?? 'pipe',
							encoding: 'utf8',
						});
						return { stdout: '', exitCode: r.status ?? null };
					}

					// Second respawn = auditor spawn.
					auditorRespawnCount++;
					// Write the verdict report so the auditor poll resolves.
					writeFileSync(
						verdictPath,
						JSON.stringify({
							verdict: 'APPROVE',
							summary: 'E2E stub approval',
							findings: [],
						}),
					);
					// Run respawn-pane with 'exit 0'.
					const swapped = [...args];
					const lIdx = swapped.indexOf('-L');
					if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
					swapped[swapped.length - 1] = 'exit 0';
					const r = spawnSync(cmd, swapped, {
						stdio: spawnOpts?.stdio ?? 'pipe',
						encoding: 'utf8',
					});
					return { stdout: '', exitCode: r.status ?? null };
				}

				// Non-respawn tmux call: swap socket and run.
				const swapped = [...args];
				const lIdx = swapped.indexOf('-L');
				if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
				const r = spawnSync(cmd, swapped, {
					stdio: spawnOpts?.stdio ?? 'pipe',
					encoding: 'utf8',
				});
				return {
					stdout: typeof r.stdout === 'string' ? r.stdout : '',
					exitCode: r.status ?? null,
				};
			}
			// Non-tmux calls: record-only no-op.
			return { stdout: '', exitCode: 0 };
		};

		// ------------------------------------------------------------------
		// 4. Wire readPlannerReportFn: reads prd.json from cwd (present = planner done).
		// ------------------------------------------------------------------
		const readPlannerReportFn = (): unknown | null => {
			if (!existsSync(prdPath)) return null;
			try {
				return JSON.parse(readFileSync(prdPath, 'utf8')) as unknown;
			} catch {
				return null;
			}
		};

		// ------------------------------------------------------------------
		// 5. Wire readPlanVerdictFn: reads plan-verdict-report.json from cwd.
		// ------------------------------------------------------------------
		const readPlanVerdictFn = makeReadPlanVerdict(cwd);

		// ------------------------------------------------------------------
		// 6. Drive runPlanPhase.
		//    - selectIssueFn returns TARGET_ISSUE (CAM-157), NOT top-of-queue.
		// ------------------------------------------------------------------
		let planResult: ReturnType<typeof runPlanPhase> | undefined;
		let threw = false;
		try {
			planResult = runPlanPhase({
				spawnFn: loopSpawnFn,
				isPaneAlive,
				sleepFn: () => {},
				genUuid: () => 'e2e-uuid-0000-0000-0000-target00157',
				selectIssueFn: () => TARGET_ISSUE,
				readPlannerReportFn,
				readPlanVerdictFn,
				preflightFn: () => ({ ok: true }),
				clock: (() => { let t = 0; return () => (t += 100); })(),
				plannerPaneId: workerPaneId,
				paneCountMutexFn: () => 'available',
				pollIntervalMs: 1,
				plannerTimeoutMs: 999_999,
				auditorTimeoutMs: 999_999,
			});
		} catch {
			threw = true;
		}

		// (c) No exception thrown.
		expect(threw).toBe(false);

		// ------------------------------------------------------------------
		// 7. Assertions.
		// ------------------------------------------------------------------

		// The planner was spawned (at least one respawn-pane call happened).
		expect(plannerRespawnCount).toBeGreaterThanOrEqual(1);

		// Primary oracle (AC2, AC4 in the story): prd.json exists and
		// issueNumber === 157 (derived from CAM-157 id in the prompt).
		expect(existsSync(prdPath)).toBe(true);
		const prdContent = JSON.parse(readFileSync(prdPath, 'utf8')) as {
			issueNumber?: unknown;
		};
		expect(prdContent.issueNumber).toBe(157);

		// The prompt sent to the planner must contain 'CAM-157'.
		expect(plannerShellStr).toContain('CAM-157');

		// The prompt must NOT contain the top-of-queue issue id.
		expect(plannerShellStr).not.toContain('CAM-99');

		// planResult must be a recognized kind (not an exception).
		// The result is audit-approved when the auditor wrote the verdict.
		if (planResult !== undefined) {
			expect(['audit-approved', 'audit-blocked', 'auditor-timeout']).toContain(planResult.kind);
		}
	},
);

// ---------------------------------------------------------------------------
// Bare-selection path (AC4): when selectIssueFn returns top-of-queue, that
// issue's id is threaded into the prompt and prd.json.issueNumber matches it.
// ---------------------------------------------------------------------------

test.skipIf(!tmuxAvailable)(
	'E2E bare-selection: selectIssueFn top-of-queue (CAM-99) -> prd.json.issueNumber === 99',
	() => {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-it-target-bare-'));
		mkdirSync(join(cwd, 'scripts', 'cam'), { recursive: true });

		const prdPath = join(cwd, 'scripts', 'cam', 'prd.json');
		const verdictPath = join(cwd, PLAN_VERDICT_REPORT_FILENAME);

		const orchPaneId =
			tmuxRaw(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])
				.stdout.toString()
				.trim()
				.split('\n')[0] ?? `${SESSION}:0`;

		const workerPaneId = openPaneInSession(SESSION, ['cat'], swapSocketSpawn, orchPaneId);
		Bun.sleepSync(100);

		let plannerShellStr = '';
		let plannerRespawnCount = 0;

		const loopSpawnFn: LoopSpawnFn = (cmd, args, spawnOpts) => {
			if (cmd === 'tmux') {
				const isRespawn = args.includes('respawn-pane');

				if (isRespawn) {
					const shellStr = args[args.length - 1] ?? '';

					if (plannerRespawnCount === 0) {
						plannerRespawnCount++;
						plannerShellStr = shellStr;

						const idMatch = /Plan issue (CAM-\d+)/.exec(shellStr);
						const issueId = idMatch?.[1];
						const numericStr = issueId?.split('-').at(-1);
						const numericId = numericStr !== undefined ? Number(numericStr) : null;

						if (numericId !== null && !Number.isNaN(numericId)) {
							writeFileSync(
								prdPath,
								JSON.stringify({
									issueNumber: numericId,
									branchName: `cam/CAM-${numericId}-test`,
									userStories: [],
									review: {},
								}),
							);
						}
						writeFileSync(
							verdictPath,
							JSON.stringify({ verdict: 'APPROVE', summary: 'bare selection stub', findings: [] }),
						);

						const swapped = [...args];
						const lIdx = swapped.indexOf('-L');
						if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
						swapped[swapped.length - 1] = 'exit 0';
						const r = spawnSync(cmd, swapped, { stdio: 'pipe', encoding: 'utf8' });
						return { stdout: '', exitCode: r.status ?? null };
					}

					// Auditor spawn: exit immediately.
					const swapped = [...args];
					const lIdx = swapped.indexOf('-L');
					if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
					swapped[swapped.length - 1] = 'exit 0';
					const r = spawnSync(cmd, swapped, { stdio: 'pipe', encoding: 'utf8' });
					return { stdout: '', exitCode: r.status ?? null };
				}

				const swapped = [...args];
				const lIdx = swapped.indexOf('-L');
				if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
				const r = spawnSync(cmd, swapped, { stdio: spawnOpts?.stdio ?? 'pipe', encoding: 'utf8' });
				return {
					stdout: typeof r.stdout === 'string' ? r.stdout : '',
					exitCode: r.status ?? null,
				};
			}
			return { stdout: '', exitCode: 0 };
		};

		const readPlannerReportFn = (): unknown | null => {
			if (!existsSync(prdPath)) return null;
			try {
				return JSON.parse(readFileSync(prdPath, 'utf8')) as unknown;
			} catch {
				return null;
			}
		};

		const readPlanVerdictFn = makeReadPlanVerdict(cwd);

		runPlanPhase({
			spawnFn: loopSpawnFn,
			isPaneAlive,
			sleepFn: () => {},
			genUuid: () => 'e2e-uuid-0000-0000-0000-target00099',
			// Returns top-of-queue issue (CAM-99).
			selectIssueFn: () => TOP_ISSUE,
			readPlannerReportFn,
			readPlanVerdictFn,
			preflightFn: () => ({ ok: true }),
			clock: (() => { let t = 0; return () => (t += 100); })(),
			plannerPaneId: workerPaneId,
			paneCountMutexFn: () => 'available',
			pollIntervalMs: 1,
			plannerTimeoutMs: 999_999,
			auditorTimeoutMs: 999_999,
		});

		// prd.json must exist with issueNumber === 99.
		expect(existsSync(prdPath)).toBe(true);
		const prdContent = JSON.parse(readFileSync(prdPath, 'utf8')) as {
			issueNumber?: unknown;
		};
		expect(prdContent.issueNumber).toBe(99);

		// Prompt must contain CAM-99.
		expect(plannerShellStr).toContain('CAM-99');
		// Prompt must NOT contain CAM-157.
		expect(plannerShellStr).not.toContain('CAM-157');
	},
);
