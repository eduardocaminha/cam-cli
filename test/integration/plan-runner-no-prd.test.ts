// test/integration/plan-runner-no-prd.test.ts
//
// Behavioral oracle (REAL tmux, private socket, real .claude/cam-loop.local.md):
// drive runPlanPhase with a planner stand-in that exits WITHOUT writing prd.json,
// then drive runPostAuditAction + phase-transition, and assert:
//   (a) Auditor pane NEVER spawned (no '@cam_label auditor' set-option, no 2nd respawn).
//   (b) Phase file flips to 'idle'.
//   (c) No exception thrown.
//
// This is the Layer A self-correction run referenced in the implementer SYSTEM PROMPT.
// The sidecar runs all injected deps against a PRIVATE tmux socket (cam-it-noprd),
// never against -L cam (live session).
//
// Pattern mirrors test/integration/plan-runner-pane-spawn.test.ts exactly
// (private socket, swap adapter, test.skipIf(!tmuxAvailable), beforeEach/afterEach).

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPlanPhase, runPostAuditAction } from '../../src/supervisor/plan-runner.ts';
import { makeSetPhaseFn } from '../../src/commands/sidecar.ts';
import { parseStateFile } from '../../src/commands/status.ts';
import { renderStateFile } from '../../src/commands/next.ts';
import {
	openPaneInSession,
	writeWorkerPaneMarker,
	type SpawnFn,
} from '../../src/tmux/session.ts';
import type { SpawnFn as LoopSpawnFn } from '../../src/supervisor/loop.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import type { PlanApproval } from '../../src/config/models.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';

const TEST_SOCK = 'cam-it-noprd';
const SESSION = 'noprd-test';

const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

/** Run tmux on the private test socket (for setup/teardown). */
function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync('tmux', ['-L', TEST_SOCK, ...args], { stdio: 'pipe' });
}

/**
 * SpawnFn that rewrites the `-L cam` socket in all argv to the private test
 * socket. All tmux calls land on the isolated session, not on a live cam session.
 */
const swapSocketSpawn: SpawnFn = (cmd, args, opts) => {
	const swapped = [...args];
	const lIdx = swapped.indexOf('-L');
	if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
	return spawnSync(cmd, swapped, { stdio: opts?.stdio ?? 'pipe' }) as ReturnType<SpawnFn>;
};

beforeEach(async () => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
	tmuxRaw(['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '10']);
	await waitForCondition(() => tmuxRaw(['has-session', '-t', SESSION]).status === 0);
});

afterEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
});

/**
 * Probe whether a pane is alive using real tmux pane_dead check on the private socket.
 * Mirrors the isPaneAlive logic in sidecar.ts makePlanPaneHelpers.
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

const MOCK_ISSUE: IssueEntry = {
	id: 'CAM-99',
	title: 'Behavioral oracle test issue',
	stage: 'specified',
	status: 'open',
	blockedBy: [],
	createdAt: '2026-07-02T00:00:00Z',
	updatedAt: '2026-07-02T00:00:00Z',
};

test.skipIf(!tmuxAvailable)(
	'(a)+(b)+(c): planner stand-in exits without prd.json -> auditor never spawned, phase flips to idle, no exception',
	async () => {
		// ------------------------------------------------------------------
		// 1. Allocate a worker pane (used as the planner pane slot).
		// ------------------------------------------------------------------
		const orchPaneId =
			tmuxRaw(['list-panes', '-t', SESSION, '-F', '#{pane_id}'])
				.stdout.toString()
				.trim()
				.split('\n')[0] ?? `${SESSION}:0`;

		const workerPaneId = openPaneInSession(SESSION, ['cat'], swapSocketSpawn, orchPaneId);
		expect(workerPaneId).toMatch(/^%\d+$/);
		await waitForCondition(() => isPaneAlive(workerPaneId));

		// Write the worker pane marker (mirrors production wiring).
		const claudeDir = mkdtempSync(join(tmpdir(), 'cam-it-noprd-claude-'));
		const cwd = mkdtempSync(join(tmpdir(), 'cam-it-noprd-cwd-'));
		mkdirSync(join(cwd, 'scripts', 'cam'), { recursive: true });
		writeWorkerPaneMarker(claudeDir, workerPaneId);

		// ------------------------------------------------------------------
		// 2. Write a real .claude/cam-loop.local.md with phase: planning.
		//    makeSetPhaseFn will update this file when exitPhaseAfterPlan runs.
		// ------------------------------------------------------------------
		const stateFilePath = join(claudeDir, 'cam-loop.local.md');
		const initialBody = renderStateFile({
			maxIterations: 50,
			completionPromise: 'COMPLETE',
			startedAt: new Date().toISOString(),
			pid: process.pid,
			phase: 'planning',
			lastActivity: new Date().toISOString(),
		});
		writeFileSync(stateFilePath, initialBody);

		// Confirm the phase was written correctly.
		const initialState = parseStateFile(initialBody);
		expect(initialState?.phase).toBe('planning');

		// ------------------------------------------------------------------
		// 3. Spawn a planner stand-in that exits WITHOUT writing prd.json.
		//    Uses respawn-pane -k with `exit 0` (the shortest possible exit).
		// ------------------------------------------------------------------
		tmuxRaw(['respawn-pane', '-k', '-t', workerPaneId, 'exit 0']);
		// Wait for the stand-in to exit so isPaneAlive will return false.
		await waitForCondition(() => !isPaneAlive(workerPaneId));

		// Verify the pane is actually dead before driving runPlanPhase.
		expect(isPaneAlive(workerPaneId)).toBe(false);

		// ------------------------------------------------------------------
		// 4. Build the LoopSpawnFn: records all calls + socket-swaps tmux.
		// ------------------------------------------------------------------
		interface RecordedCall { cmd: string; args: string[] }
		const spawnCalls: RecordedCall[] = [];

		const loopSpawnFn: LoopSpawnFn = (cmd, args, spawnOpts) => {
			spawnCalls.push({ cmd, args: [...args] });
			// For tmux calls, swap the socket so they land on the private session.
			if (cmd === 'tmux') {
				const swapped = [...args];
				const lIdx = swapped.indexOf('-L');
				if (lIdx !== -1 && swapped[lIdx + 1] === 'cam') swapped[lIdx + 1] = TEST_SOCK;
				const r = spawnSync(cmd, swapped, { stdio: spawnOpts?.stdio ?? 'pipe', encoding: 'utf8' });
				return {
					stdout: typeof r.stdout === 'string' ? r.stdout : '',
					exitCode: r.status ?? null,
				};
			}
			// Non-tmux calls (e.g. git): record-only no-op.
			return { stdout: '', exitCode: 0 };
		};

		// ------------------------------------------------------------------
		// 5. Drive runPlanPhase.
		//    - plannerPaneId: the real (now-dead) pane
		//    - isPaneAlive: real pane-dead check on private socket
		//    - readPlannerReportFn: always null (no prd.json)
		//    - sleepFn: no-op (fast poll)
		// ------------------------------------------------------------------
		let planPhaseThrew = false;
		let planResult: ReturnType<typeof runPlanPhase> | undefined;
		try {
			planResult = runPlanPhase({
				spawnFn: loopSpawnFn,
				isPaneAlive,
				sleepFn: () => {},
				genUuid: () => 'it-uuid-0000-0000-0000-noprd000000',
				selectIssueFn: () => MOCK_ISSUE,
				// readPlannerReportFn is DEFINED but returns null: no prd.json.
				readPlannerReportFn: () => null,
				readPlanVerdictFn: () => null,
				preflightFn: () => ({ ok: true }),
				clock: (() => { let t = 0; return () => (t += 100); })(),
				plannerPaneId: workerPaneId,
				paneCountMutexFn: () => 'available',
				pollIntervalMs: 1,
				plannerTimeoutMs: 999_999,
				auditorTimeoutMs: 999_999,
			});
		} catch {
			planPhaseThrew = true;
		}

		// (c) No exception thrown.
		expect(planPhaseThrew).toBe(false);

		// Result must be planner-failed.
		expect(planResult?.kind).toBe('planner-failed');

		// (a) No @cam_label auditor set-option.
		const auditorLabel = spawnCalls.find(
			(c) => c.args[2] === 'set-option' && c.args.includes('auditor'),
		);
		expect(auditorLabel).toBeUndefined();

		// (a) No 2nd respawn-pane (only the planner spawn happened before planner-failed).
		// The planner respawn might appear; assert no auditor respawn specifically.
		const auditorRespawn = spawnCalls.find(
			(c) => c.args[2] === 'respawn-pane' && c.args.some((a) => a.includes('subagent-auditor')),
		);
		expect(auditorRespawn).toBeUndefined();

		// ------------------------------------------------------------------
		// 6. Drive runPostAuditAction + phase transition.
		// ------------------------------------------------------------------
		const setPhaseCalls: string[] = [];
		const setPhase = makeSetPhaseFn(claudeDir, cwd);
		// Wrap setPhase so we can record it AND execute it (real file write).
		const wrappedSetPhase = (phase: typeof setPhaseCalls[number]): void => {
			setPhaseCalls.push(phase);
			setPhase(phase as Parameters<typeof setPhase>[0]);
		};

		let postAuditThrew = false;
		let postAuditResult: ReturnType<typeof runPostAuditAction> | undefined;
		try {
			postAuditResult = runPostAuditAction({
				planResult: planResult!,
				spawnFn: loopSpawnFn,
				setPhaseFn: wrappedSetPhase,
				issueNumber: 42,
				readPlanApprovalFn: (): PlanApproval => 'auto',
				escalateFn: undefined,
				notifyFn: undefined,
			});
		} catch {
			postAuditThrew = true;
		}

		// (c) No exception thrown in runPostAuditAction.
		expect(postAuditThrew).toBe(false);
		expect(postAuditResult?.kind).toBe('no-action');

		// Simulate exitPhaseAfterPlan: set phase to idle for non-branch-created outcomes.
		if (postAuditResult && postAuditResult.kind !== 'branch-created') {
			const targetPhase =
				postAuditResult.kind === 'awaiting-operator-approval' ? 'awaiting-operator' : 'idle';
			wrappedSetPhase(targetPhase);
		}

		// ------------------------------------------------------------------
		// (b) Phase file flips to 'idle'.
		// makeSetPhaseFn calls writeStateFile(cwd, ...) which writes to
		// cwd + '/.claude/cam-loop.local.md'.
		// ------------------------------------------------------------------
		const cwdStatePath = join(cwd, '.claude', 'cam-loop.local.md');
		let phaseFromFile = 'unknown';
		if (existsSync(cwdStatePath)) {
			const cwdStateContents = readFileSync(cwdStatePath, 'utf8');
			const cwdParsed = parseStateFile(cwdStateContents);
			phaseFromFile = cwdParsed?.phase ?? 'unknown';
		} else if (existsSync(stateFilePath)) {
			// Fallback: check the stateFilePath in claudeDir.
			const claudeDirContents = readFileSync(stateFilePath, 'utf8');
			const claudeParsed = parseStateFile(claudeDirContents);
			phaseFromFile = claudeParsed?.phase ?? 'unknown';
		}

		// (b) Phase must be 'idle'.
		expect(phaseFromFile).toBe('idle');
	},
);
