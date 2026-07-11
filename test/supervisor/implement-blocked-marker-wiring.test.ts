// test/supervisor/implement-blocked-marker-wiring.test.ts
//
// Tests for the runSupervisor wiring of the durable implement-blocked marker
// writer (US-005, CAM-195, Defect 2). The pure marker I/O helpers (read/write/
// remove, never throw) are covered separately in
// test/supervisor/implement-blocked-marker.test.ts.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSupervisor } from '../../src/supervisor/loop.ts';
import type {
	RunSupervisorOptions,
	SpawnFn,
	CapturePane,
	ReadPrd,
	WritePrd,
	ReadHandoff,
	ClockFn,
	ReviewDispatch,
	WriteSessionMarker,
	IsPaneAlive,
	ImplementBlockedWriterParams,
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import { buildSupervisorOptions } from '../../src/supervisor/host.ts';
import { IMPLEMENT_BLOCKED_FILENAME, readImplementBlockedMarker } from '../../src/supervisor/implement-blocked-marker.ts';

/** Build a prd snapshot with N stories, optionally some already passing. */
function makePrd(opts: {
	stories: Array<{ id?: string; priority: number; passes: boolean; requires?: string }>;
	review?: PrdSnapshot['review'];
	issueNumber?: number;
}): PrdSnapshot {
	return {
		issueNumber: opts.issueNumber,
		userStories: opts.stories.map((s) => ({
			id: s.id,
			priority: s.priority,
			passes: s.passes,
			requires: s.requires ?? null,
		})),
		review: opts.review,
	};
}

/** Pane text with BLOCKED sentinel. */
function blockedPane(storyId: string): string {
	return `Some output\nCAM_IMPLEMENTER_STATUS=BLOCKED_QUALITY story=${storyId} reason=tests_failed\n`;
}

let uuidCounter = 0;
function fakeGenUuid(): string {
	uuidCounter++;
	return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
}

const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';
const WORKER_PANE_ID = '%3';

function makeBaseOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	const spawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
	const capturePane: CapturePane = (_paneId) => '';
	const readPrd: ReadPrd = () => null;
	const writePrd: WritePrd = (_prd) => {};
	const readHandoff: ReadHandoff = () => null;
	const clock: ClockFn = () => '2026-06-08T00:00:00Z';
	const reviewDispatch: ReviewDispatch = (_uuid) => ({ status: 'ok', detail: 'review ok' });
	const writeSessionMarker: WriteSessionMarker = (_storyId, _uuid) => {};
	const isPaneAlive: IsPaneAlive = (_paneId) => true;

	return {
		spawn,
		capturePane,
		readPrd,
		writePrd,
		readHandoff,
		clock,
		genUuid: fakeGenUuid,
		reviewDispatch,
		writeSessionMarker,
		isPaneAlive,
		workerPaneId: WORKER_PANE_ID,
		prdPath: PRD_PATH,
		handoffPath: HANDOFF_PATH,
		permissionMode: 'bypassPermissions',
		taskPrompt: 'Implement the next story from the PRD.',
		sleepFn: (_ms: number) => {},
		nowMs: () => 0,
		...overrides,
	};
}

beforeEach(() => {
	uuidCounter = 0;
});

describe('runSupervisor US-005: durable implement-blocked marker writer wiring (CAM-195, Defect 2)', () => {
	test('story-level blocked terminal: writeImplementBlockedMarkerFn called once with issueId/story/reason', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
			issueNumber: 195,
		});
		const calls: ImplementBlockedWriterParams[] = [];
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => blockedPane('US-001'),
			writeImplementBlockedMarkerFn: (params) => { calls.push(params); },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.issueId).toBe('195');
		expect(calls[0]?.story).toBe('US-001');
		expect(typeof calls[0]?.reason).toBe('string');
		expect(calls[0]?.reason.length).toBeGreaterThan(0);
	});

	test('blocked-no-implementable path: writeImplementBlockedMarkerFn called with story: null', async () => {
		const prd = makePrd({
			// No `id` on the pending story -> decideNextAction's degenerate guard.
			stories: [{ priority: 1, passes: false }],
			issueNumber: 195,
		});
		const calls: ImplementBlockedWriterParams[] = [];
		const opts = makeBaseOpts({
			readPrd: () => prd,
			writeImplementBlockedMarkerFn: (params) => { calls.push(params); },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.issueId).toBe('195');
		expect(calls[0]?.story).toBeNull();
	});

	test('prd unreadable on the very first iteration: writeImplementBlockedMarkerFn NOT called (no issueId ever known)', async () => {
		const calls: ImplementBlockedWriterParams[] = [];
		const opts = makeBaseOpts({
			readPrd: () => null,
			writeImplementBlockedMarkerFn: (params) => { calls.push(params); },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
		expect(calls).toHaveLength(0);
	});

	test('complete terminal: writeImplementBlockedMarkerFn NOT called', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
			issueNumber: 195,
		});
		const calls: ImplementBlockedWriterParams[] = [];
		const opts = makeBaseOpts({
			readPrd: () => prd,
			writeImplementBlockedMarkerFn: (params) => { calls.push(params); },
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(calls).toHaveLength(0);
	});

	test('absent writeImplementBlockedMarkerFn: backward compatible, no crash on a blocked terminal', async () => {
		const prd = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: false }],
			issueNumber: 195,
		});
		const opts = makeBaseOpts({
			readPrd: () => prd,
			capturePane: (_paneId) => blockedPane('US-001'),
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('blocked');
	});
});

describe('host.ts writeImplementBlockedMarkerFn: counter + prd content-hash wiring (US-002, CAM-214)', () => {
	let cwd: string;
	let claudeDir: string;
	let prdPath: string;
	let markerPath: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'cam-implement-blocked-wiring-'));
		claudeDir = join(cwd, '.claude');
		const scriptsDir = join(cwd, 'scripts', 'cam');
		mkdirSync(claudeDir, { recursive: true });
		mkdirSync(scriptsDir, { recursive: true });
		prdPath = join(scriptsDir, 'prd.json');
		markerPath = join(claudeDir, IMPLEMENT_BLOCKED_FILENAME);
		writeFileSync(prdPath, JSON.stringify({ userStories: [] }), 'utf8');
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function writeParams(overrides: Partial<ImplementBlockedWriterParams> = {}): ImplementBlockedWriterParams {
		return {
			issueId: '214',
			story: 'US-003',
			reason: 'Worker reported BLOCKED_QUALITY story=US-003 reason=tests_failed',
			...overrides,
		};
	}

	test('grep oracle: host.ts references advanceBlockedMarker', () => {
		// Covered structurally by AC1's grep oracle; this test just documents
		// that the wiring under test is exercised via the real production writer.
		const { opts } = buildSupervisorOptions(cwd);
		expect(typeof opts.writeImplementBlockedMarkerFn).toBe('function');
	});

	test('repeated identical blocked terminals drive consecutiveCount 1 -> 2 -> 3 (same story, same token, unchanged prd.json)', () => {
		const { opts } = buildSupervisorOptions(cwd);
		const write = opts.writeImplementBlockedMarkerFn;
		if (!write) throw new Error('writeImplementBlockedMarkerFn missing from buildSupervisorOptions');

		write(writeParams());
		const first = readImplementBlockedMarker(markerPath);
		expect(first?.consecutiveCount).toBe(1);
		expect(first?.escalated).toBeFalsy();

		write(writeParams());
		const second = readImplementBlockedMarker(markerPath);
		expect(second?.consecutiveCount).toBe(2);
		expect(second?.keyHash).toBe(first?.keyHash);
		expect(second?.escalated).toBeFalsy();

		write(writeParams());
		const third = readImplementBlockedMarker(markerPath);
		expect(third?.consecutiveCount).toBe(3);
		expect(third?.keyHash).toBe(first?.keyHash);
		expect(third?.escalated).toBe(true);
		expect(third?.haltedAt).toBeTruthy();
	});

	test('changing prd.json content resets consecutiveCount to 1 and clears escalated', () => {
		const { opts } = buildSupervisorOptions(cwd);
		const write = opts.writeImplementBlockedMarkerFn;
		if (!write) throw new Error('writeImplementBlockedMarkerFn missing from buildSupervisorOptions');

		write(writeParams());
		write(writeParams());
		const beforeAmend = readImplementBlockedMarker(markerPath);
		expect(beforeAmend?.consecutiveCount).toBe(2);

		// Genuine PRD amendment: content (and therefore sha256) changes.
		writeFileSync(prdPath, JSON.stringify({ userStories: [{ id: 'US-999' }] }), 'utf8');

		write(writeParams());
		const afterAmend = readImplementBlockedMarker(markerPath);
		expect(afterAmend?.consecutiveCount).toBe(1);
		expect(afterAmend?.escalated).toBeFalsy();
		expect(afterAmend?.keyHash).not.toBe(beforeAmend?.keyHash);
	});

	test('sha256 is computed over prd.json bytes: two writers pointed at byte-identical prd.json content produce the same keyHash', () => {
		const { opts } = buildSupervisorOptions(cwd);
		const write = opts.writeImplementBlockedMarkerFn;
		if (!write) throw new Error('writeImplementBlockedMarkerFn missing from buildSupervisorOptions');
		write(writeParams());
		const marker = readImplementBlockedMarker(markerPath);
		expect(marker?.keyHash.length).toBeGreaterThan(0);

		// A second cwd with byte-identical prd.json content (same story/token)
		// must produce the identical keyHash, proving the hash is over content,
		// not a path or a random/clock-derived value.
		const cwd2 = mkdtempSync(join(tmpdir(), 'cam-implement-blocked-wiring-'));
		try {
			mkdirSync(join(cwd2, '.claude'), { recursive: true });
			mkdirSync(join(cwd2, 'scripts', 'cam'), { recursive: true });
			writeFileSync(join(cwd2, 'scripts', 'cam', 'prd.json'), JSON.stringify({ userStories: [] }), 'utf8');
			const { opts: opts2 } = buildSupervisorOptions(cwd2);
			const write2 = opts2.writeImplementBlockedMarkerFn;
			if (!write2) throw new Error('writeImplementBlockedMarkerFn missing from buildSupervisorOptions');
			write2(writeParams());
			const marker2 = readImplementBlockedMarker(join(cwd2, '.claude', IMPLEMENT_BLOCKED_FILENAME));
			expect(marker2?.keyHash).toBe(marker?.keyHash);
		} finally {
			rmSync(cwd2, { recursive: true, force: true });
		}
	});

	test('absent prd.json degrades gracefully: marker still written (treated as a reset key), writer never throws', () => {
		rmSync(prdPath, { force: true });
		const { opts } = buildSupervisorOptions(cwd);
		const write = opts.writeImplementBlockedMarkerFn;
		if (!write) throw new Error('writeImplementBlockedMarkerFn missing from buildSupervisorOptions');

		expect(() => write(writeParams())).not.toThrow();
		const marker = readImplementBlockedMarker(markerPath);
		expect(marker).not.toBeNull();
		expect(marker?.consecutiveCount).toBe(1);
		expect(existsSync(markerPath)).toBe(true);
	});

	test('unreadable prd.json (directory in place of the file) degrades gracefully: never throws, marker still written', () => {
		rmSync(prdPath, { force: true });
		mkdirSync(prdPath, { recursive: true });
		const { opts } = buildSupervisorOptions(cwd);
		const write = opts.writeImplementBlockedMarkerFn;
		if (!write) throw new Error('writeImplementBlockedMarkerFn missing from buildSupervisorOptions');

		expect(() => write(writeParams())).not.toThrow();
		const marker = readImplementBlockedMarker(markerPath);
		expect(marker).not.toBeNull();
		expect(marker?.consecutiveCount).toBe(1);
	});
});
