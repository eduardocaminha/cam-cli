// test/notify/resend.test.ts
//
// Oracle tests for US-007: best-effort Resend escalation client + loop wiring.
//
// AC1: sendEscalation sends via {data,error} shape and NEVER throws or crashes;
//      a Resend failure is swallowed and returned as { sent:false, error:... }.
// AC2: Non-convergence terminal fires escalateFn; a forced escalateFn failure
//      does NOT crash the pipeline (returns 'complete').

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, beforeEach } from 'bun:test';
import { sendEscalation, type ResendSendFn } from '../../src/notify/resend.ts';
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
} from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';

// ---------------------------------------------------------------------------
// AC1 — sendEscalation unit tests
// ---------------------------------------------------------------------------

describe('sendEscalation (AC1)', () => {
	test('success: returns { sent: true } when sendFn returns { data: { id }, error: null }', async () => {
		const fakeSend: ResendSendFn = async (_params) => ({
			data: { id: 'abc123' },
			error: null,
		});
		const result = await sendEscalation({
			apiKey: 'fake-key',
			recipient: 'ops@example.com',
			subject: '[cam] non-convergence alert',
			html: '<p>The pipeline did not converge.</p>',
			sendFn: fakeSend,
		});
		expect(result.sent).toBe(true);
		expect(result.error).toBeUndefined();
	});

	test('api error: returns { sent: false, error: "..." } when sendFn returns { data: null, error: "..." }', async () => {
		const fakeSend: ResendSendFn = async (_params) => ({
			data: null,
			error: 'invalid_api_key',
		});
		const result = await sendEscalation({
			apiKey: 'bad-key',
			recipient: 'ops@example.com',
			subject: 'subject',
			html: '<p>body</p>',
			sendFn: fakeSend,
		});
		expect(result.sent).toBe(false);
		expect(typeof result.error).toBe('string');
		expect(result.error).toContain('invalid_api_key');
	});

	test('network error: returns { sent: false, error: "..." } when sendFn throws; NEVER re-throws', async () => {
		const fakeSend: ResendSendFn = async (_params) => {
			throw new Error('ECONNREFUSED');
		};
		// Should NOT throw — the promise resolves to an error result.
		const result = await sendEscalation({
			apiKey: 'any-key',
			recipient: 'ops@example.com',
			subject: 'subject',
			html: '<p>body</p>',
			sendFn: fakeSend,
		});
		expect(result.sent).toBe(false);
		expect(result.error).toContain('ECONNREFUSED');
	});

	test('sendFn receives the correct params', async () => {
		const captured: Parameters<ResendSendFn>[0][] = [];
		const fakeSend: ResendSendFn = async (params) => {
			captured.push(params);
			return { data: { id: 'x' }, error: null };
		};
		await sendEscalation({
			apiKey: 'k',
			recipient: 'dest@example.com',
			subject: 'Alert: MAX_ROUNDS_DEBT',
			html: '<p>alert</p>',
			from: 'cam <cam@example.com>',
			sendFn: fakeSend,
		});
		expect(captured).toHaveLength(1);
		expect(captured[0]?.to).toBe('dest@example.com');
		expect(captured[0]?.subject).toBe('Alert: MAX_ROUNDS_DEBT');
		expect(captured[0]?.from).toBe('cam <cam@example.com>');
	});

	test('uses default from address when from is omitted', async () => {
		const captured: Parameters<ResendSendFn>[0][] = [];
		const fakeSend: ResendSendFn = async (params) => {
			captured.push(params);
			return { data: { id: 'y' }, error: null };
		};
		await sendEscalation({
			apiKey: 'k',
			recipient: 'r@example.com',
			subject: 's',
			html: '<p>h</p>',
			sendFn: fakeSend,
		});
		expect(captured[0]?.from).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// AC2 — loop wiring tests
// ---------------------------------------------------------------------------

function makePrd(opts: {
	stories: Array<{ id: string; priority: number; passes: boolean }>;
	review?: PrdSnapshot['review'];
}): PrdSnapshot {
	return {
		userStories: opts.stories.map((s) => ({
			id: s.id,
			priority: s.priority,
			passes: s.passes,
			requires: null,
		})),
		review: opts.review,
	};
}

const WORKER_PANE_ID = '%3';
let uuidCounter = 0;
function fakeGenUuid(): string {
	uuidCounter++;
	return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
}

function makeBaseOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	const spawn: SpawnFn = (_cmd, _args) => ({ stdout: '', exitCode: 0 });
	const capturePane: CapturePane = (_paneId) => '';
	const readPrd: ReadPrd = () => null;
	const writePrd: WritePrd = (_prd) => {};
	const readHandoff: ReadHandoff = () => null;
	const clock: ClockFn = () => '2026-06-27T00:00:00Z';
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
		prdPath: '/fake/prd.json',
		handoffPath: '/fake/handoff.json',
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

describe('non-convergence escalation wiring (AC2)', () => {
	test('escalateFn is called when MAX_ROUNDS_DEBT terminal is triggered', async () => {
		// PRD: all stories pass; review at maxRounds-1.
		const prd_reviewNeeded = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 2, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		});
		// After review: maxRounds hit, still FIXES_PENDING.
		const prd_maxRoundsHit = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		});

		const prds: (PrdSnapshot | null)[] = [prd_reviewNeeded, prd_maxRoundsHit];
		let prdCall = 0;

		let escalateCalled = 0;
		const escalateFn = async (): Promise<void> => {
			escalateCalled++;
		};

		const opts = makeBaseOpts({
			readPrd: () => prds[prdCall++] ?? null,
			escalateFn,
		});

		const result = await runSupervisor(opts);

		// Terminal status is returned.
		expect(result.status).toBe('complete');
		// escalateFn was called exactly once on the MAX_ROUNDS_DEBT terminal.
		expect(escalateCalled).toBe(1);
	});

	test('forced escalateFn failure does NOT crash the pipeline (best-effort)', async () => {
		const prd_reviewNeeded = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 2, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		});
		const prd_maxRoundsHit = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		});

		const prds: (PrdSnapshot | null)[] = [prd_reviewNeeded, prd_maxRoundsHit];
		let prdCall = 0;

		// This escalateFn throws — the pipeline must still return 'complete'.
		const escalateFn = async (): Promise<void> => {
			throw new Error('Simulated Resend failure');
		};

		const opts = makeBaseOpts({
			readPrd: () => prds[prdCall++] ?? null,
			escalateFn,
		});

		// Must NOT throw even though escalateFn throws.
		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');
	});

	test('loop returns complete when escalateFn is absent (backward compat)', async () => {
		const prd_reviewNeeded = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 2, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		});
		const prd_maxRoundsHit = makePrd({
			stories: [{ id: 'US-001', priority: 1, passes: true }],
			review: { roundsCompleted: 3, maxRounds: 3, lastVerdict: 'FIXES_PENDING:1' },
		});

		const prds: (PrdSnapshot | null)[] = [prd_reviewNeeded, prd_maxRoundsHit];
		let prdCall = 0;

		// No escalateFn injected — backward compat.
		const opts = makeBaseOpts({
			readPrd: () => prds[prdCall++] ?? null,
		});

		const result = await runSupervisor(opts);
		expect(result.status).toBe('complete');
	});
});

// ---------------------------------------------------------------------------
// AC3 — Production wiring oracle: escalateFn is wired in sidecar.ts
//
// Unit tests that inject escalateFn directly into runSupervisor/runSidecarLoop
// cannot detect a missing wire in the outer production caller (sidecar.ts).
// This oracle reads the sidecar.ts source text and asserts the dep fields are
// present, so the gap can never silently re-emerge.
// ---------------------------------------------------------------------------

describe('sidecar.ts production wiring oracle - escalateFn (AC3)', () => {
	const sidecarPath = resolve(import.meta.dir, '..', '..', 'src', 'commands', 'sidecar.ts');
	const source = readFileSync(sidecarPath, 'utf8');

	test('sidecar.ts imports readResendConfig', () => {
		expect(source).toContain('readResendConfig');
	});

	test('sidecar.ts imports sendEscalation', () => {
		expect(source).toContain('sendEscalation');
	});

	test('sidecar.ts passes escalateFn to the sidecar loop call', () => {
		// The loop is now called via loopFn (injectable for tests); match the
		// call block which must include escalateFn regardless of the fn name.
		const callMatch = source.match(/await loopFn\(\{[\s\S]*?\}\)/);
		expect(callMatch).not.toBeNull();
		expect(callMatch?.[0]).toContain('escalateFn');
	});

	test('loop.ts threads escalateFn into supervisorOpts', () => {
		const loopPath = resolve(import.meta.dir, '..', '..', 'src', 'supervisor', 'loop.ts');
		const loopSource = readFileSync(loopPath, 'utf8');
		// The threading block assigns supervisorOpts.escalateFn from opts.escalateFn.
		expect(loopSource).toContain('supervisorOpts.escalateFn = opts.escalateFn');
	});
});
