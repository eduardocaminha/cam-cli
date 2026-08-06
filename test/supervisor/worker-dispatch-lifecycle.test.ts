import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';

import {
	runSupervisor,
	type RunSupervisorOptions,
	type SpawnFn,
} from '../../src/supervisor/loop.ts';
import { makeReviewDispatch } from '../../src/supervisor/review.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import type { DispatchFailedMarker } from '../../src/supervisor/dispatch-failed-marker.ts';
import { TASK_PROMPT_FILE_STEM } from '../../src/supervisor/task-prompt-file.ts';
import type { WorkerEvent } from '../../src/supervisor/events.ts';

const IMPLEMENT_UUID = '00000000-0000-0000-0000-000000000433';
const REVIEW_UUID = '11111111-1111-1111-1111-111111111433';

function oneStory(passes: boolean, clean = false): PrdSnapshot {
	return {
		branchName: 'cam/issue-433',
		userStories: [{
			id: 'US-005',
			title: 'verified dispatch',
			description: 'test',
			acceptanceCriteria: [],
			priority: 1,
			requires: null,
			passes,
		}],
		review: clean ? { roundsCompleted: 1, lastVerdict: 'CLEAN' } : undefined,
	};
}

function makePaneIdentitySpawn(
	onCommand: (args: string[]) => { stdout?: string; stderr?: string; exitCode?: number | null } = () => ({}),
): SpawnFn {
	let panePid = 40_000;
	return (_cmd, args) => {
		if (args[2] === 'display-message' && args.includes('#{pane_pid}')) {
			return { stdout: `${panePid}\n`, stderr: '', exitCode: 0 };
		}
		const override = onCommand(args);
		const result = {
			stdout: override.stdout ?? '',
			stderr: override.stderr ?? '',
			exitCode: override.exitCode ?? 0,
		};
		if (args[2] === 'respawn-pane' && result.exitCode === 0) panePid++;
		return result;
	};
}

function promptFiles(claudeDir: string): string[] {
	return readdirSync(claudeDir).filter((name) => name.startsWith(TASK_PROMPT_FILE_STEM));
}

function baseImplementOpts(
	claudeDir: string,
	spawn: SpawnFn,
	overrides: Partial<RunSupervisorOptions> = {},
): RunSupervisorOptions {
	const configPath = join(claudeDir, 'project.toml');
	writeFileSync(configPath, '[backend]\nimplementer = "claude"\n');
	return {
		spawn,
		capturePane: () => '',
		readPrd: () => oneStory(false),
		writePrd: () => {},
		readHandoff: () => null,
		clock: () => '2026-07-27T12:00:00Z',
		genUuid: () => IMPLEMENT_UUID,
		reviewDispatch: () => ({ status: 'ok', detail: 'unused' }),
		writeSessionMarker: () => {},
		isPaneAlive: () => true,
		workerPaneId: '%5',
		prdPath: '/fake/prd.json',
		handoffPath: '/fake/handoff.json',
		claudeDir,
		permissionMode: 'bypassPermissions',
		taskPrompt: 'fallback',
		pollIntervalMs: 0,
		sleepFn: () => {},
		nowMs: () => 0,
		maxIterations: 1,
		configPath,
		...overrides,
	};
}

describe('CAM-433 implementer verified dispatch lifecycle', () => {
	test('non-zero respawn is an observable blocked terminal and removes its prompt', async () => {
		const root = createTestTmpdir('cam-implement-dispatch-fail-');
		const claudeDir = join(root, '.claude');
		mkdirSync(claudeDir);
		const markers: DispatchFailedMarker[] = [];
		const events: WorkerEvent[] = [];
		const notifications: string[] = [];
		try {
			const spawn = makePaneIdentitySpawn((args) =>
				args[2] === 'respawn-pane'
					? { exitCode: 17, stderr: 'invalid implement command' }
					: {},
			);
			const result = await runSupervisor(baseImplementOpts(claudeDir, spawn, {
				logEvent: (event) => events.push(event),
				writeDispatchFailedMarkerFn: (marker) => markers.push(marker),
				notifyOrchestrator: (line) => notifications.push(line),
			}));

			expect(result.status).toBe('blocked');
			expect(result.lastOutcome?.detail).toContain('dispatch-failed');
			expect(markers).toHaveLength(1);
			expect(markers[0]).toMatchObject({
				phase: 'implementer',
				reason: 'respawn-pane-exited',
				exitCode: 17,
				stderr: 'invalid implement command',
			});
			expect(events.some((event) => event.kind === 'dispatch-failed')).toBe(true);
			expect(notifications.some((line) => line.includes('implementer dispatch failed'))).toBe(true);
			expect(promptFiles(claudeDir)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('worker-report terminal removes its prompt and verified success removes a stale marker', async () => {
		const root = createTestTmpdir('cam-implement-report-cleanup-');
		const claudeDir = join(root, '.claude');
		mkdirSync(claudeDir);
		const markerPath = join(claudeDir, '.cam-dispatch-failed.json');
		writeFileSync(markerPath, '{"stale":true}');
		let prdRead = 0;
		try {
			const result = await runSupervisor(baseImplementOpts(
				claudeDir,
				makePaneIdentitySpawn(),
				{
					readPrd: () => {
						prdRead++;
						return prdRead === 1 ? oneStory(false) : oneStory(true, true);
					},
					readHandoff: () => ({ lastCompletedStory: { id: 'US-005' } }),
					readWorkerReport: () => ({
						outcome: 'DONE',
						story: 'US-005',
						gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
						notes: 'none',
					}),
					workerReportPath: '/fake/worker-report.json',
					maxIterations: 2,
					removeDispatchFailedMarkerFn: () => rmSync(markerPath, { force: true }),
				},
			));

			expect(result.status).toBe('complete');
			expect(promptFiles(claudeDir)).toEqual([]);
			expect(existsSync(markerPath)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('token-ceiling and timeout sentinel respawn failures are inspected', async () => {
		for (const terminal of ['token-ceiling', 'timeout'] as const) {
			const root = createTestTmpdir(`cam-${terminal}-checked-`);
			const claudeDir = join(root, '.claude');
			mkdirSync(claudeDir);
			const markers: DispatchFailedMarker[] = [];
			try {
				const spawn = makePaneIdentitySpawn((args) => {
					const command = args[args.length - 1] ?? '';
					return command === `echo ${terminal}`
						? { exitCode: 23, stderr: `${terminal} sentinel failed` }
						: {};
				});
				const terminalOpts: Partial<RunSupervisorOptions> = {
					writeDispatchFailedMarkerFn: (marker) => markers.push(marker),
					capturePane: () => 'no completion',
				};
				if (terminal === 'token-ceiling') {
					terminalOpts.maxWorkerTokens = 1;
					terminalOpts.readWorkerTokens = () => ({
						inputTokens: 1,
						outputTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
					});
				} else {
					terminalOpts.perWorkerTimeoutMs = 0;
				}
				await runSupervisor(baseImplementOpts(claudeDir, spawn, terminalOpts));

				expect(markers.some((marker) => (
					marker.phase === `implementer-${terminal}` &&
					marker.reason === 'respawn-pane-exited' &&
					marker.exitCode === 23
				))).toBe(true);
				expect(promptFiles(claudeDir)).toEqual([]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});
});

describe('CAM-433 reviewer verified dispatch lifecycle', () => {
	function reviewOpts(
		claudeDir: string,
		spawn: SpawnFn,
		overrides: Partial<Parameters<typeof makeReviewDispatch>[0]> = {},
	): Parameters<typeof makeReviewDispatch>[0] {
		return {
			spawn,
			capturePane: () => '<review>CLEAN</review>',
			readPrd: () => ({ userStories: [], review: { roundsCompleted: 0, maxRounds: 3 } }),
			writePrd: () => {},
			workerPaneId: '%7',
			claudeDir,
			isPaneAlive: () => true,
			sleepFn: () => {},
			permissionMode: 'bypassPermissions',
			pollIntervalMs: 0,
			timeoutMs: 1,
			now: (() => {
				let time = 0;
				return () => ++time;
			})(),
			...overrides,
		};
	}

	test('verdict cleanup and successful convergence remove stale evidence', () => {
		const root = createTestTmpdir('cam-review-verdict-cleanup-');
		const claudeDir = join(root, '.claude');
		mkdirSync(claudeDir);
		const markerPath = join(claudeDir, '.cam-dispatch-failed.json');
		writeFileSync(markerPath, '{"stale":true}');
		try {
			const result = makeReviewDispatch(reviewOpts(
				claudeDir,
				makePaneIdentitySpawn(),
				{ removeDispatchFailedMarkerFn: () => rmSync(markerPath, { force: true }) },
			))(REVIEW_UUID);

			expect(result.status).toBe('ok');
			expect(promptFiles(claudeDir)).toEqual([]);
			expect(existsSync(markerPath)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('dispatch failure and checked review-timeout both clean prompts and expose failure', () => {
		for (const terminal of ['dispatch', 'review-timeout'] as const) {
			const root = createTestTmpdir(`cam-review-${terminal}-`);
			const claudeDir = join(root, '.claude');
			mkdirSync(claudeDir);
			const markers: DispatchFailedMarker[] = [];
			const notifications: string[] = [];
			try {
				let reviewerRespawns = 0;
				const spawn = makePaneIdentitySpawn((args) => {
					const command = args[args.length - 1] ?? '';
					if (args[2] !== 'respawn-pane') return {};
					reviewerRespawns++;
					if (terminal === 'dispatch' && reviewerRespawns === 1) {
						return { exitCode: 31, stderr: 'reviewer spawn failed' };
					}
					if (terminal === 'review-timeout' && command === 'echo review-timeout') {
						return { exitCode: 32, stderr: 'review timeout sentinel failed' };
					}
					return {};
				});
				const result = makeReviewDispatch(reviewOpts(claudeDir, spawn, {
					capturePane: () => terminal === 'review-timeout' ? 'no verdict' : '<review>CLEAN</review>',
					writeDispatchFailedMarkerFn: (marker) => markers.push(marker),
					notifyFn: (line) => notifications.push(line),
				}))(REVIEW_UUID);

				expect(result.status).toBe('error');
				expect(markers.some((marker) => (
					marker.reason === 'respawn-pane-exited' &&
					marker.exitCode === (terminal === 'dispatch' ? 31 : 32)
				))).toBe(true);
				expect(notifications.length).toBeGreaterThan(0);
				expect(promptFiles(claudeDir)).toEqual([]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});
});
