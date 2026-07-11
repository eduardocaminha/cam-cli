// test/supervisor/events.test.ts
//
// Unit tests for src/supervisor/events.ts (US-013) plus an end-to-end
// lifecycle test that drives runSupervisor with an in-memory event collector
// and asserts a single story produces worker-start -> worker-end -> result ->
// tokens, in order, sharing one uuid.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	buildResultDetail,
	makeFileEventLogger,
	makeInMemoryEventLogger,
	readWorkerTokens,
	validateOfficialDocsValidated,
	type HandoffSchemaWarningEventDetail,
	type PushEventDetail,
	type ReviewVerdictHandbackEventDetail,
	type WorkerEvent,
} from '../../src/supervisor/events.ts';
import { runSupervisor } from '../../src/supervisor/loop.ts';
import type { RunSupervisorOptions } from '../../src/supervisor/loop.ts';
import type { WorkerOutcome } from '../../src/supervisor/result.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';

// ---------------------------------------------------------------------------
// makeInMemoryEventLogger
// ---------------------------------------------------------------------------

describe('makeInMemoryEventLogger', () => {
	test('collects emitted events into its backing array', () => {
		const { logger, events } = makeInMemoryEventLogger();
		const ev: WorkerEvent = {
			ts: '2026-06-08T00:00:00Z',
			storyId: 'US-013',
			uuid: 'u1',
			kind: 'worker-start',
			detail: { channel: 'c1' },
		};
		logger(ev);
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(ev);
	});
});

// ---------------------------------------------------------------------------
// makeFileEventLogger
// ---------------------------------------------------------------------------

describe('makeFileEventLogger', () => {
	test('appends one JSON line per event, creating the parent dir', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-events-'));
		try {
			const path = join(dir, 'nested', 'cam-worker-events.jsonl');
			const logger = makeFileEventLogger(path);
			logger({ ts: 't1', storyId: 'US-001', uuid: 'u1', kind: 'worker-start', detail: { a: 1 } });
			logger({ ts: 't2', storyId: 'US-001', uuid: 'u1', kind: 'worker-end', detail: { b: 2 } });

			const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
			expect(lines).toHaveLength(2);
			const first = JSON.parse(lines[0] ?? '') as WorkerEvent;
			const second = JSON.parse(lines[1] ?? '') as WorkerEvent;
			expect(first.kind).toBe('worker-start');
			expect(second.kind).toBe('worker-end');
			expect(first.uuid).toBe('u1');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 'pushed' event kind (US-002)
// ---------------------------------------------------------------------------

describe("'pushed' event kind", () => {
	const pushDetail: PushEventDetail = {
		sha: 'abc1234',
		pushed: true,
		ok: true,
		detail: 'pushed to origin/cam-test',
	};

	test('makeInMemoryEventLogger captures a pushed event', () => {
		const { logger, events } = makeInMemoryEventLogger();
		const ev: WorkerEvent = {
			ts: '2026-06-09T00:00:00Z',
			storyId: 'US-002',
			uuid: 'u1',
			kind: 'pushed',
			detail: pushDetail,
		};
		logger(ev);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('pushed');
		expect(events[0]?.detail).toEqual(pushDetail);
	});

	test('makeFileEventLogger appends the pushed event as a single JSON line', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-events-pushed-'));
		try {
			const path = join(dir, 'cam-worker-events.jsonl');
			const logger = makeFileEventLogger(path);
			logger({ ts: 't1', storyId: 'US-002', uuid: 'u1', kind: 'pushed', detail: pushDetail });

			const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
			expect(lines).toHaveLength(1);
			const parsed = JSON.parse(lines[0] ?? '') as WorkerEvent;
			expect(parsed.kind).toBe('pushed');
			expect(parsed.detail).toEqual(pushDetail);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// buildResultDetail
// ---------------------------------------------------------------------------

describe('buildResultDetail', () => {
	test('pass outcome: gates pass, files merged, docs mapped', () => {
		const outcome: WorkerOutcome = { kind: 'pass', storyId: 'US-001', detail: 'ok' };
		const detail = buildResultDetail(outcome, {
			createdFiles: ['src/a.ts'],
			modifiedFiles: ['src/b.ts'],
			officialDocsValidated: [{ lib: 'ink', status: 'aligned', url: 'https://ink' }],
		});
		expect(detail.outcome).toBe('pass');
		expect(detail.filesChanged).toEqual(['src/a.ts', 'src/b.ts']);
		expect(detail.gates).toEqual({ typecheck: 'pass', tests: 'pass' });
		expect(detail.docsValidated).toEqual([{ lib: 'ink', status: 'aligned', url: 'https://ink' }]);
	});

	test('non-pass outcome with null handoff: gates unknown, empty files/docs', () => {
		const outcome: WorkerOutcome = { kind: 'blocked', storyId: undefined, detail: 'timeout' };
		const detail = buildResultDetail(outcome, null);
		expect(detail.outcome).toBe('blocked');
		expect(detail.filesChanged).toEqual([]);
		expect(detail.gates).toEqual({ typecheck: 'unknown', tests: 'unknown' });
		expect(detail.docsValidated).toEqual([]);
	});

	test('docs entry without url omits the url key', () => {
		const outcome: WorkerOutcome = { kind: 'pass', storyId: 'US-001', detail: 'ok' };
		const detail = buildResultDetail(outcome, {
			officialDocsValidated: [{ lib: 'none', status: 'no_external_lib_touched' }],
		});
		expect(detail.docsValidated).toEqual([{ lib: 'none', status: 'no_external_lib_touched' }]);
		expect(detail.docsValidated[0]).not.toHaveProperty('url');
	});
});

// ---------------------------------------------------------------------------
// validateOfficialDocsValidated (US-002)
// ---------------------------------------------------------------------------

describe('validateOfficialDocsValidated', () => {
	test('conformant entries produce no warnings', () => {
		const warnings = validateOfficialDocsValidated([
			{ lib: 'ink', status: 'aligned', url: 'https://ink' },
			{ lib: 'none', status: 'no_external_lib_touched' },
		]);
		expect(warnings).toEqual([]);
	});

	test('a bad status AND an extra key on one entry collapse into exactly one warning', () => {
		const warnings = validateOfficialDocsValidated([
			{ lib: 'js-yaml', status: 'not-a-real-status', version: '4.1.0' },
		]);
		expect(warnings).toHaveLength(1);
		const warning = warnings[0] as HandoffSchemaWarningEventDetail;
		expect(warning.field).toBe('officialDocsValidated');
		expect(warning.index).toBe(0);
		expect(warning.issues.some((i) => i.includes('invalid status'))).toBe(true);
		expect(warning.issues.some((i) => i.includes('unknown key: version'))).toBe(true);
	});

	test('one warning per offending entry when multiple entries are invalid', () => {
		const warnings = validateOfficialDocsValidated([
			{ lib: 'ok', status: 'aligned' },
			{ lib: 'bad', status: 'bogus' },
			{ lib: 'also-bad', status: 'aligned', version: '1.0.0' },
		]);
		expect(warnings).toHaveLength(2);
		expect(warnings.map((w) => w.index)).toEqual([1, 2]);
	});

	test('absent entries produce no warnings', () => {
		expect(validateOfficialDocsValidated(undefined)).toEqual([]);
	});

	test('non-array input produces no warnings', () => {
		expect(validateOfficialDocsValidated({ lib: 'x' })).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// readWorkerTokens
// ---------------------------------------------------------------------------

describe('readWorkerTokens', () => {
	const JSONL =
		'{"message":{"id":"m1","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":20,"cache_creation_input_tokens":10}}}';

	test('sums usage from the resolved transcript', () => {
		const tokens = readWorkerTokens('u1', '/proj', '/home/.claude', () => JSONL);
		expect(tokens).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 10 });
	});

	test('passes the resolved transcript path to readFile', () => {
		let seen = '';
		readWorkerTokens('abc', '/proj', '/home/.claude', (p) => {
			seen = p;
			return JSONL;
		});
		// transcriptPathForSession = <claudeDir>/projects/<encode(cwd)>/<uuid>.jsonl
		// (only cwd is encoded; claudeDir is used verbatim).
		expect(seen).toBe('/home/.claude/projects/-proj/abc.jsonl');
	});

	test('returns null when the transcript is absent', () => {
		const tokens = readWorkerTokens('u1', '/proj', '/home/.claude', () => null);
		expect(tokens).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Full lifecycle through runSupervisor (AC#5)
// ---------------------------------------------------------------------------

describe('runSupervisor emits a full per-story lifecycle', () => {
	const PRD_PATH = '/fake/prd.json';
	const HANDOFF_PATH = '/fake/handoff.json';
	const FIXED_UUID = '00000000-0000-0000-0000-000000000001';

	function prd(passes: boolean, review?: PrdSnapshot['review']): PrdSnapshot {
		return {
			userStories: [{ id: 'US-001', priority: 1, passes, requires: null }],
			review,
		};
	}

	test('worker-start -> worker-end -> result -> tokens, one uuid', async () => {
		const { logger, events } = makeInMemoryEventLogger();

		// readPrd call order:
		//   call 0 (iter1 top, decideNextAction)        -> US-001 passes:false -> implement
		//   call 1 (readWorkerOutcome fileReader)        -> US-001 passes:true  -> outcome pass
		//   call 2 (iter2 top, decideNextAction)         -> passes:true + CLEAN -> complete
		const prdReturns: PrdSnapshot[] = [
			prd(false),
			prd(true),
			prd(true, { roundsCompleted: 1, lastVerdict: 'CLEAN' }),
		];
		let prdCall = 0;
		const readPrd: RunSupervisorOptions['readPrd'] = () => prdReturns[prdCall++] ?? null;

		const handoff = {
			lastCompletedStory: { id: 'US-001', title: 'Story US-001' },
			createdFiles: ['src/a.ts'],
			modifiedFiles: ['src/b.ts'],
			officialDocsValidated: [{ lib: 'ink', status: 'aligned', url: 'https://ink' }],
		};

		const opts: RunSupervisorOptions = {
			spawn: () => ({ stdout: '', exitCode: 0 }),
			capturePane: () => 'done\nCAM_IMPLEMENTER_STATUS=DONE story=US-001\n',
			readPrd,
			writePrd: () => {},
			readHandoff: () => handoff,
			clock: () => '2026-06-08T00:00:00Z',
			genUuid: () => FIXED_UUID,
			reviewDispatch: () => ({ status: 'ok', detail: 'review ok' }),
			writeSessionMarker: () => {},
			isPaneAlive: () => true,
			workerPaneId: '%3',
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			permissionMode: 'bypassPermissions',
			taskPrompt: 'Implement the next story.',
			sleepFn: (_ms) => {},
			nowMs: () => 0,
			logEvent: logger,
			readWorkerTokens: () => ({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 10 }),
		};

		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');

		expect(events.map((e) => e.kind)).toEqual(['spawn-resolution', 'worker-start', 'worker-end', 'result', 'tokens', 'outcome-source', 'sidecar-exit']);
		// Every per-worker lifecycle event shares the single worker uuid. The
		// terminal 'sidecar-exit' (US-004 / CAM-195) is loop-level, not tied to a
		// worker session, and carries its own fixed 'supervisor' uuid.
		expect(new Set(events.map((e) => e.uuid))).toEqual(new Set([FIXED_UUID, 'supervisor']));
		// storyId resolves to the actual completed story (spawn-resolution carries
		// advisory storyId; the terminal sidecar-exit carries no story, since the
		// 'complete' action kind has no associated story).
		expect(
			events.filter((e) => e.kind !== 'spawn-resolution' && e.kind !== 'sidecar-exit').every((e) => e.storyId === 'US-001'),
		).toBe(true);

		const resultEvent = events.find((e) => e.kind === 'result');
		expect(resultEvent?.detail).toEqual({
			outcome: 'pass',
			filesChanged: ['src/a.ts', 'src/b.ts'],
			gates: { typecheck: 'pass', tests: 'pass' },
			docsValidated: [{ lib: 'ink', status: 'aligned', url: 'https://ink' }],
		});

		const tokensEvent = events.find((e) => e.kind === 'tokens');
		expect(tokensEvent?.detail).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 10 });
	});

	// ---------------------------------------------------------------------------
	// review-verdict-handback event (US-004)
	// ---------------------------------------------------------------------------

	test("emits 'review-verdict-handback' for CLEAN verdict with correct round", async () => {
		const { logger, events } = makeInMemoryEventLogger();

		// Scenario: all stories already pass -> supervisor goes straight to review.
		// readPrd call order:
		//   call 0 (iter 1 top, decideNextAction): all pass, no verdict -> review
		//   call 1 (review branch, re-read after reviewDispatch): CLEAN, round 1
		//   call 2 (iter 2 top, decideNextAction): CLEAN -> complete
		const REVIEW_UUID = '00000000-0000-0000-0000-review000001';
		const prdReturns: PrdSnapshot[] = [
			{ userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }], review: undefined },
			{ userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }], review: { roundsCompleted: 1, lastVerdict: 'CLEAN' } },
			{ userStories: [{ id: 'US-001', priority: 1, passes: true, requires: null }], review: { roundsCompleted: 1, lastVerdict: 'CLEAN' } },
		];
		let prdCall = 0;

		const opts: RunSupervisorOptions = {
			spawn: () => ({ stdout: '', exitCode: 0 }),
			capturePane: () => '',
			readPrd: () => prdReturns[prdCall++] ?? null,
			writePrd: () => {},
			readHandoff: () => null,
			clock: () => '2026-06-23T00:00:00Z',
			genUuid: () => REVIEW_UUID,
			reviewDispatch: () => ({ status: 'ok', detail: 'review ok' }),
			writeSessionMarker: () => {},
			isPaneAlive: () => true,
			workerPaneId: '%3',
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			permissionMode: 'bypassPermissions',
			taskPrompt: 'Implement the next story.',
			sleepFn: (_ms) => {},
			nowMs: () => 0,
			logEvent: logger,
		};

		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');

		const handbackEvent = events.find((e) => e.kind === 'review-verdict-handback');
		expect(handbackEvent).toBeDefined();
		const detail = handbackEvent?.detail as ReviewVerdictHandbackEventDetail;
		expect(detail.verdict).toBe('CLEAN');
		expect(detail.round).toBe(1);
		expect(handbackEvent?.uuid).toBe(REVIEW_UUID);
		expect(handbackEvent?.storyId).toBeUndefined();
	});

	test("emits 'review-verdict-handback' for FIXES_PENDING verdict with round", async () => {
		const { logger, events } = makeInMemoryEventLogger();

		// Scenario: all stories pass -> review returns FIXES_PENDING:2, then CLEAN.
		// readPrd call order:
		//   call 0 (iter 1, decideNextAction): all pass, no verdict -> review
		//   call 1 (review branch re-read): FIXES_PENDING:2, round 1
		//   call 2 (iter 2, decideNextAction): FIXES_PENDING -> review again
		//   call 3 (review branch re-read): CLEAN, round 2
		//   call 4 (iter 3, decideNextAction): CLEAN -> complete
		const prdBase = { id: 'US-001', priority: 1, passes: true, requires: null };
		const prdReturns: PrdSnapshot[] = [
			{ userStories: [prdBase], review: undefined },
			{ userStories: [prdBase], review: { roundsCompleted: 1, lastVerdict: 'FIXES_PENDING:2' } },
			{ userStories: [prdBase], review: { roundsCompleted: 1, lastVerdict: 'FIXES_PENDING:2' } },
			{ userStories: [prdBase], review: { roundsCompleted: 2, lastVerdict: 'CLEAN' } },
			{ userStories: [prdBase], review: { roundsCompleted: 2, lastVerdict: 'CLEAN' } },
		];
		let prdCall = 0;

		const opts: RunSupervisorOptions = {
			spawn: () => ({ stdout: '', exitCode: 0 }),
			capturePane: () => '',
			readPrd: () => prdReturns[prdCall++] ?? null,
			writePrd: () => {},
			readHandoff: () => null,
			clock: () => '2026-06-23T00:00:00Z',
			genUuid: () => '00000000-0000-0000-0000-review000002',
			reviewDispatch: () => ({ status: 'ok', detail: 'review ok' }),
			writeSessionMarker: () => {},
			isPaneAlive: () => true,
			workerPaneId: '%3',
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			permissionMode: 'bypassPermissions',
			taskPrompt: 'Implement the next story.',
			sleepFn: (_ms) => {},
			nowMs: () => 0,
			logEvent: logger,
		};

		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');

		const handbackEvents = events.filter((e) => e.kind === 'review-verdict-handback');
		expect(handbackEvents).toHaveLength(2);

		// First event: FIXES_PENDING round 1.
		const first = handbackEvents[0] as WorkerEvent;
		const firstDetail = first.detail as ReviewVerdictHandbackEventDetail;
		expect(firstDetail.verdict).toBe('FIXES_PENDING:2');
		expect(firstDetail.round).toBe(1);

		// Second event: CLEAN round 2.
		const second = handbackEvents[1] as WorkerEvent;
		const secondDetail = second.detail as ReviewVerdictHandbackEventDetail;
		expect(secondDetail.verdict).toBe('CLEAN');
		expect(secondDetail.round).toBe(2);
	});

	// ---------------------------------------------------------------------------
	// 'handoff-schema-warning' event (US-002)
	// ---------------------------------------------------------------------------

	test("emits exactly one 'handoff-schema-warning' for a schema-invalid officialDocsValidated entry, and still completes", async () => {
		const { logger, events } = makeInMemoryEventLogger();

		const prdReturns: PrdSnapshot[] = [
			prd(false),
			prd(true),
			prd(true, { roundsCompleted: 1, lastVerdict: 'CLEAN' }),
		];
		let prdCall = 0;

		const handoff = {
			lastCompletedStory: { id: 'US-001', title: 'Story US-001' },
			officialDocsValidated: [{ lib: 'js-yaml', status: 'not-a-real-status', version: '4.1.0' }],
		};

		const opts: RunSupervisorOptions = {
			spawn: () => ({ stdout: '', exitCode: 0 }),
			capturePane: () => 'done\nCAM_IMPLEMENTER_STATUS=DONE story=US-001\n',
			readPrd: () => prdReturns[prdCall++] ?? null,
			writePrd: () => {},
			readHandoff: () => handoff,
			clock: () => '2026-07-09T00:00:00Z',
			genUuid: () => FIXED_UUID,
			reviewDispatch: () => ({ status: 'ok', detail: 'review ok' }),
			writeSessionMarker: () => {},
			isPaneAlive: () => true,
			workerPaneId: '%3',
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			permissionMode: 'bypassPermissions',
			taskPrompt: 'Implement the next story.',
			sleepFn: (_ms) => {},
			nowMs: () => 0,
			logEvent: logger,
		};

		// The guard must never halt an otherwise-healthy loop.
		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');

		const warnings = events.filter((e) => e.kind === 'handoff-schema-warning');
		expect(warnings).toHaveLength(1);
		const detail = warnings[0]?.detail as HandoffSchemaWarningEventDetail;
		expect(detail.field).toBe('officialDocsValidated');
		expect(detail.index).toBe(0);
		expect(detail.issues.length).toBeGreaterThanOrEqual(2);
	});

	test('no events emitted when logEvent is absent (zero behavior change)', async () => {
		const prdReturns: PrdSnapshot[] = [
			prd(false),
			prd(true),
			prd(true, { roundsCompleted: 1, lastVerdict: 'CLEAN' }),
		];
		let prdCall = 0;

		const opts: RunSupervisorOptions = {
			spawn: () => ({ stdout: '', exitCode: 0 }),
			capturePane: () => 'done\nCAM_IMPLEMENTER_STATUS=DONE story=US-001\n',
			readPrd: () => prdReturns[prdCall++] ?? null,
			writePrd: () => {},
			readHandoff: () => ({ lastCompletedStory: { id: 'US-001', title: 'Story US-001' } }),
			clock: () => '2026-06-08T00:00:00Z',
			genUuid: () => FIXED_UUID,
			reviewDispatch: () => ({ status: 'ok', detail: 'review ok' }),
			writeSessionMarker: () => {},
			isPaneAlive: () => true,
			workerPaneId: '%3',
			prdPath: PRD_PATH,
			handoffPath: HANDOFF_PATH,
			permissionMode: 'bypassPermissions',
			taskPrompt: 'Implement the next story.',
			sleepFn: (_ms) => {},
			nowMs: () => 0,
		};

		// Without logEvent the loop must still reach 'complete' and not throw.
		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');
	});
});
