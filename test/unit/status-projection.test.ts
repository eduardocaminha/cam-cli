// test/unit/status-projection.test.ts
//
// US-002 (CAM-401): buildStatusReport projects the full cycle state-machine
// position into the StatusReport model -- the six blocker/wedge/stall
// markers, the durable merge-watch position, the sidecar-stalled marker, and
// the last container-preflight event from the event log.
//
// What we cover (per acceptance criteria):
//   1. All six markers project when present, each via its own file under
//      <cwd>/.claude/.
//   2. Merge-watch position (prNumber, pollCount, lastPolledAt) + the
//      sidecar-stalled marker.
//   3. The LAST container-preflight event from cam-worker-events.jsonl (not
//      re-running preflight).
//   4. Every projected field is optional/absent when its source is missing,
//      and a malformed marker/event degrades to absent, never throws.
//   5. buildStatusReport performs no writes.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildStatusReport } from '../../src/commands/status.ts';
import {
	MERGE_WATCH_FILENAME,
	SHIP_STALLED_FILENAME,
	writeMergeWatchState,
	writeShipStalledMarker,
} from '../../src/release/merge-watch.ts';
import { GATE_FILENAME, writeGateFile } from '../../src/supervisor/gate.ts';
import { PLAN_ESCALATED_FILENAME, writePlanEscalatedMarker } from '../../src/supervisor/plan-escalation.ts';
import {
	PLAN_PREFLIGHT_FAILED_FILENAME,
	writePlanPreflightFailedMarker,
} from '../../src/supervisor/plan-preflight-marker.ts';
import {
	IMPLEMENT_BLOCKED_FILENAME,
	writeImplementBlockedMarker,
} from '../../src/supervisor/implement-blocked-marker.ts';
import {
	POST_MERGE_STALLED_FILENAME,
	writePostMergeStalledMarker,
} from '../../src/supervisor/post-merge-stalled-marker.ts';
import { SIDECAR_STALLED_FILENAME, writeSidecarStalledMarker } from '../../src/supervisor/sidecar-stalled.ts';

function withTmpCwd(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'cam-status-projection-'));
	try {
		mkdirSync(join(dir, '.claude'), { recursive: true });
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('buildStatusReport: marker/wedge/stall projection (AC1)', () => {
	test('projects all six blocker/wedge/stall markers when present', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			writeShipStalledMarker(join(claudeDir, SHIP_STALLED_FILENAME), {
				prNumber: 42,
				prUrl: 'https://github.com/x/y/pull/42',
				issueId: 'CAM-401',
				reason: 'ci-red',
				ts: '2026-07-23T00:00:00Z',
			});
			writePlanEscalatedMarker(join(claudeDir, PLAN_ESCALATED_FILENAME), {
				issueId: 'CAM-401',
				summary: 'BLOCK persisted after re-plan rounds',
				findings: [],
				roundsCompleted: 3,
				writtenAt: '2026-07-23T00:00:00Z',
			});
			writePlanPreflightFailedMarker(join(claudeDir, PLAN_PREFLIGHT_FAILED_FILENAME), {
				step: 'typecheck',
				detail: 'tsc failed',
				writtenAt: '2026-07-23T00:00:00Z',
			});
			writeImplementBlockedMarker(join(claudeDir, IMPLEMENT_BLOCKED_FILENAME), {
				issueId: 'CAM-401',
				story: 'US-003',
				reason: 'Worker reported BLOCKED_QUALITY story=US-003 reason=tests_failed',
				writtenAt: '2026-07-23T00:00:00Z',
				consecutiveCount: 1,
				keyHash: 'deadbeef',
			});
			writePostMergeStalledMarker(join(claudeDir, POST_MERGE_STALLED_FILENAME), {
				prNumber: 42,
				issueId: 'CAM-401',
				completedSteps: ['tag'],
				remainingSteps: ['branch-prune'],
				reason: 'prune failed',
				writtenAt: '2026-07-23T00:00:00Z',
			});
			writeGateFile(join(claudeDir, GATE_FILENAME), {
				gate: 'in-progress-work-conflict',
				options: ['proceed', 'abort'],
				context: 'a conflicting change was detected',
			});

			const report = buildStatusReport({ cwd: dir });

			expect(report.shipStalled?.prNumber).toBe(42);
			expect(report.shipStalled?.reason).toBe('ci-red');
			expect(report.planEscalated?.issueId).toBe('CAM-401');
			expect(report.planEscalated?.roundsCompleted).toBe(3);
			expect(report.planPreflightFailed?.step).toBe('typecheck');
			expect(report.implementBlocked?.story).toBe('US-003');
			expect(report.implementBlocked?.reason).toContain('BLOCKED_QUALITY');
			expect(report.postMergeStalled?.prNumber).toBe(42);
			expect(report.postMergeStalled?.remainingSteps).toEqual(['branch-prune']);
			expect(report.gate?.gate).toBe('in-progress-work-conflict');
			expect(report.gate?.options).toEqual(['proceed', 'abort']);
		});
	});

	test('all six marker fields are absent when no marker files exist', () => {
		withTmpCwd((dir) => {
			const report = buildStatusReport({ cwd: dir });
			expect(report.shipStalled).toBeUndefined();
			expect(report.planEscalated).toBeUndefined();
			expect(report.planPreflightFailed).toBeUndefined();
			expect(report.implementBlocked).toBeUndefined();
			expect(report.postMergeStalled).toBeUndefined();
			expect(report.gate).toBeUndefined();
		});
	});
});

describe('buildStatusReport: merge-watch position + sidecar-stalled (AC2)', () => {
	test('projects prNumber, pollCount, lastPolledAt from the durable merge-watch state', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			writeMergeWatchState(join(claudeDir, MERGE_WATCH_FILENAME), {
				prNumber: 7,
				mergedBranch: 'cam/issue-401',
				pollCount: 4,
				lastPolledAt: 1_753_000_000_000,
			});

			const report = buildStatusReport({ cwd: dir });

			expect(report.mergeWatch).toEqual({ prNumber: 7, pollCount: 4, lastPolledAt: 1_753_000_000_000 });
		});
	});

	test('omits lastPolledAt when the watch has never polled (legacy/fresh seed)', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			writeFileSync(
				join(claudeDir, MERGE_WATCH_FILENAME),
				JSON.stringify({ prNumber: 7, mergedBranch: 'cam/issue-401' }),
			);

			const report = buildStatusReport({ cwd: dir });

			expect(report.mergeWatch?.prNumber).toBe(7);
			expect(report.mergeWatch?.pollCount).toBe(0);
			expect(report.mergeWatch?.lastPolledAt).toBeUndefined();
		});
	});

	test('mergeWatch is absent when no merge-watch file exists', () => {
		withTmpCwd((dir) => {
			const report = buildStatusReport({ cwd: dir });
			expect(report.mergeWatch).toBeUndefined();
		});
	});

	test('projects the sidecar-stalled marker via readSidecarStalledMarker', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			writeSidecarStalledMarker(join(claudeDir, SIDECAR_STALLED_FILENAME), {
				reason: 'firewall-init-failed',
				detail: 'iptables exited 1',
				writtenAt: '2026-07-23T00:00:00Z',
			});

			const report = buildStatusReport({ cwd: dir });

			expect(report.sidecarStalled?.reason).toBe('firewall-init-failed');
			expect(report.sidecarStalled?.detail).toBe('iptables exited 1');
		});
	});

	test('sidecarStalled is absent when no marker file exists', () => {
		withTmpCwd((dir) => {
			const report = buildStatusReport({ cwd: dir });
			expect(report.sidecarStalled).toBeUndefined();
		});
	});
});

describe('buildStatusReport: last container-preflight event (AC3)', () => {
	function writeEventLog(dir: string, lines: string[]): void {
		writeFileSync(join(dir, '.claude', 'cam-worker-events.jsonl'), `${lines.join('\n')}\n`);
	}

	test('projects the LAST container-preflight event, not an earlier one', () => {
		withTmpCwd((dir) => {
			writeEventLog(dir, [
				JSON.stringify({
					ts: '2026-07-23T00:00:00Z',
					storyId: 'US-001',
					uuid: 'a',
					kind: 'container-preflight',
					detail: { ready: false, reason: 'daemon-unreachable' },
				}),
				JSON.stringify({
					ts: '2026-07-23T00:00:00Z',
					storyId: 'US-001',
					uuid: 'a',
					kind: 'worker-start',
					detail: {},
				}),
				JSON.stringify({
					ts: '2026-07-23T01:00:00Z',
					storyId: 'US-002',
					uuid: 'b',
					kind: 'container-preflight',
					detail: { ready: true },
				}),
			]);

			const report = buildStatusReport({ cwd: dir });

			expect(report.containerPreflight?.ready).toBe(true);
			expect(report.containerPreflight?.reason).toBeUndefined();
			expect(report.containerPreflight?.ts).toBe('2026-07-23T01:00:00Z');
		});
	});

	test('containerPreflight is absent when the event log has no container-preflight line', () => {
		withTmpCwd((dir) => {
			writeEventLog(dir, [
				JSON.stringify({ ts: '2026-07-23T00:00:00Z', storyId: undefined, uuid: 'a', kind: 'worker-start', detail: {} }),
			]);
			const report = buildStatusReport({ cwd: dir });
			expect(report.containerPreflight).toBeUndefined();
		});
	});

	test('containerPreflight is absent when the event log file is absent', () => {
		withTmpCwd((dir) => {
			const report = buildStatusReport({ cwd: dir });
			expect(report.containerPreflight).toBeUndefined();
		});
	});
});

describe('buildStatusReport: malformed markers/events degrade to absent, never throw (AC4)', () => {
	test('malformed JSON in every marker file, the merge-watch file, and the gate file never throws', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			const malformedTargets = [
				SHIP_STALLED_FILENAME,
				PLAN_ESCALATED_FILENAME,
				PLAN_PREFLIGHT_FAILED_FILENAME,
				IMPLEMENT_BLOCKED_FILENAME,
				POST_MERGE_STALLED_FILENAME,
				GATE_FILENAME,
				MERGE_WATCH_FILENAME,
				SIDECAR_STALLED_FILENAME,
			];
			for (const name of malformedTargets) {
				writeFileSync(join(claudeDir, name), 'not valid json {{{');
			}

			expect(() => buildStatusReport({ cwd: dir })).not.toThrow();
			const report = buildStatusReport({ cwd: dir });
			expect(report.shipStalled).toBeUndefined();
			expect(report.planEscalated).toBeUndefined();
			expect(report.planPreflightFailed).toBeUndefined();
			expect(report.implementBlocked).toBeUndefined();
			expect(report.postMergeStalled).toBeUndefined();
			expect(report.gate).toBeUndefined();
			expect(report.mergeWatch).toBeUndefined();
			expect(report.sidecarStalled).toBeUndefined();
		});
	});

	test('a malformed line in the event log (and a container-preflight line missing `ready`) degrades to absent', () => {
		withTmpCwd((dir) => {
			writeFileSync(
				join(dir, '.claude', 'cam-worker-events.jsonl'),
				`not valid json {{{\n${JSON.stringify({
					ts: '2026-07-23T00:00:00Z',
					storyId: undefined,
					uuid: 'a',
					kind: 'container-preflight',
					detail: { reason: 'image-missing' },
				})}\n`,
			);

			expect(() => buildStatusReport({ cwd: dir })).not.toThrow();
			const report = buildStatusReport({ cwd: dir });
			expect(report.containerPreflight).toBeUndefined();
		});
	});

	test('gate file missing a required field (options) is treated as absent, mirroring the lenient reader', () => {
		withTmpCwd((dir) => {
			writeFileSync(
				join(dir, '.claude', GATE_FILENAME),
				JSON.stringify({ gate: 'in-progress-work-conflict', context: 'no options field' }),
			);
			const report = buildStatusReport({ cwd: dir });
			expect(report.gate).toBeUndefined();
		});
	});
});

describe('buildStatusReport: no writes (AC5)', () => {
	test('does not mutate any marker file, the merge-watch file, or the event log', () => {
		withTmpCwd((dir) => {
			const claudeDir = join(dir, '.claude');
			writeShipStalledMarker(join(claudeDir, SHIP_STALLED_FILENAME), {
				prNumber: 1,
				prUrl: null,
				issueId: null,
				reason: 'timeout',
				ts: '2026-07-23T00:00:00Z',
			});
			writeMergeWatchState(join(claudeDir, MERGE_WATCH_FILENAME), {
				prNumber: 1,
				mergedBranch: 'cam/issue-401',
				pollCount: 1,
			});
			writeSidecarStalledMarker(join(claudeDir, SIDECAR_STALLED_FILENAME), {
				reason: 'sidecar-died',
				detail: 'x',
				writtenAt: '2026-07-23T00:00:00Z',
			});
			writeFileSync(
				join(claudeDir, 'cam-worker-events.jsonl'),
				`${JSON.stringify({ ts: '2026-07-23T00:00:00Z', storyId: undefined, uuid: 'a', kind: 'container-preflight', detail: { ready: true } })}\n`,
			);

			const before = {
				shipStalled: statSync(join(claudeDir, SHIP_STALLED_FILENAME)).mtimeMs,
				mergeWatch: statSync(join(claudeDir, MERGE_WATCH_FILENAME)).mtimeMs,
				sidecarStalled: statSync(join(claudeDir, SIDECAR_STALLED_FILENAME)).mtimeMs,
				events: statSync(join(claudeDir, 'cam-worker-events.jsonl')).mtimeMs,
			};

			buildStatusReport({ cwd: dir });

			expect(statSync(join(claudeDir, SHIP_STALLED_FILENAME)).mtimeMs).toBe(before.shipStalled);
			expect(statSync(join(claudeDir, MERGE_WATCH_FILENAME)).mtimeMs).toBe(before.mergeWatch);
			expect(statSync(join(claudeDir, SIDECAR_STALLED_FILENAME)).mtimeMs).toBe(before.sidecarStalled);
			expect(statSync(join(claudeDir, 'cam-worker-events.jsonl')).mtimeMs).toBe(before.events);
		});
	});
});
