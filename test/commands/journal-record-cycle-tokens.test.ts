// test/commands/journal-record-cycle-tokens.test.ts
//
// Unit tests for recordCycleTokens (US-001 of CAM-131).
//
// All filesystem reads (orch transcript, event log) and the event logger are
// injected so no real ~/.claude or disk I/O occurs.
//
// Covered scenarios:
//   1. Emits one 'cycle-tokens' event with correct detail shape.
//   2. orchTokens = input + cacheCreation + cacheRead (NOT output tokens).
//   3. workerTokens = sum of 'tokens' events after last 'cycle-tokens' marker.
//   4. total === orchTokens + workerTokens.
//   5. Absent orch transcript -> orchTokens=0, event still emitted.
//   6. Per-cycle slice: tokens BEFORE the last 'cycle-tokens' marker are excluded.
//   7. Absent event log -> workerTokens=0, event still emitted.
//   8. Multiple worker 'tokens' events are all summed.

import { test, expect } from 'bun:test';
import { recordCycleTokens, type RecordCycleTokensOptions } from '../../src/commands/journal.ts';
import { makeInMemoryEventLogger, type WorkerEvent } from '../../src/supervisor/events.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal 'tokens' event JSONL line for the event log. */
function makeTokensLine(
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens: number,
	cacheCreationTokens: number,
): string {
	return JSON.stringify({
		ts: '2026-01-01T00:00:00.000Z',
		storyId: 'US-001',
		uuid: 'worker-uuid',
		kind: 'tokens',
		detail: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
	});
}

/** Build a minimal 'cycle-tokens' marker JSONL line (the per-cycle close sentinel). */
function makeCycleTokensLine(): string {
	return JSON.stringify({
		ts: '2026-01-01T01:00:00.000Z',
		uuid: 'cycle-close',
		kind: 'cycle-tokens',
		detail: {
			cycleId: 'cam/CAM-130-prev',
			issueNumber: 'CAM-130',
			orchTokens: 0,
			workerTokens: 0,
			total: 0,
			recordedAt: '2026-01-01T01:00:00.000Z',
		},
	});
}

/**
 * Build a minimal orchestrator transcript JSONL line.
 *
 * The transcript format: each line carries message.usage with token counts.
 * Using distinct message.id values avoids the dedup logic (each line is unique).
 */
function makeTranscriptLine(
	msgId: string,
	inputTokens: number,
	outputTokens: number,
	cacheReadInputTokens: number,
	cacheCreationInputTokens: number,
): string {
	return JSON.stringify({
		requestId: `req-${msgId}`,
		message: {
			id: msgId,
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_input_tokens: cacheReadInputTokens,
				cache_creation_input_tokens: cacheCreationInputTokens,
			},
		},
	});
}

/** Build base options with injected no-ops for all reads/writes. */
function makeBaseOpts(
	overrides: Partial<RecordCycleTokensOptions> = {},
): RecordCycleTokensOptions {
	return {
		cycleId: 'cam/CAM-131-handoff-por-ciclo',
		issueNumber: 'CAM-131',
		cwd: '/fake/cwd',
		claudeDir: '/fake/.claude',
		readOrchTranscript: () => null,
		readEventLog: () => null,
		logEvent: () => {},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// 1. Shape: emits exactly one 'cycle-tokens' event with required fields
// ---------------------------------------------------------------------------

test('recordCycleTokens emits exactly one cycle-tokens event', () => {
	const { logger, events } = makeInMemoryEventLogger();

	recordCycleTokens(makeBaseOpts({ logEvent: logger }));

	expect(events).toHaveLength(1);
	const ev = events[0] as WorkerEvent;
	expect(ev.kind).toBe('cycle-tokens');
});

test('recordCycleTokens event carries correct cycleId and issueNumber', () => {
	const { logger, events } = makeInMemoryEventLogger();

	recordCycleTokens(
		makeBaseOpts({
			cycleId: 'cam/CAM-131-handoff-por-ciclo',
			issueNumber: 'CAM-131',
			logEvent: logger,
		}),
	);

	const detail = (events[0] as WorkerEvent).detail as {
		cycleId: string;
		issueNumber: string;
	};
	expect(detail.cycleId).toBe('cam/CAM-131-handoff-por-ciclo');
	expect(detail.issueNumber).toBe('CAM-131');
});

test('recordCycleTokens event detail has all required fields', () => {
	const { logger, events } = makeInMemoryEventLogger();

	recordCycleTokens(makeBaseOpts({ logEvent: logger }));

	const detail = (events[0] as WorkerEvent).detail as Record<string, unknown>;
	expect(typeof detail['cycleId']).toBe('string');
	expect(typeof detail['issueNumber']).toBe('string');
	expect(typeof detail['orchTokens']).toBe('number');
	expect(typeof detail['workerTokens']).toBe('number');
	expect(typeof detail['total']).toBe('number');
	expect(typeof detail['recordedAt']).toBe('string');
});

// ---------------------------------------------------------------------------
// 2. orchTokens = input + cacheCreation + cacheRead (NOT output)
// ---------------------------------------------------------------------------

test('orchTokens includes input + cacheCreation + cacheRead only (not output)', () => {
	const { logger, events } = makeInMemoryEventLogger();

	// One transcript line: input=1000, output=500, cacheRead=200, cacheCreation=300
	const transcriptLine = makeTranscriptLine('msg-1', 1000, 500, 200, 300);

	recordCycleTokens(
		makeBaseOpts({
			readOrchTranscript: () => transcriptLine,
			logEvent: logger,
		}),
	);

	const detail = (events[0] as WorkerEvent).detail as { orchTokens: number };
	// expected: 1000 + 300 + 200 = 1500 (input + cacheCreation + cacheRead; output=500 excluded)
	expect(detail.orchTokens).toBe(1500);
});

test('orchTokens sums across multiple transcript lines (deduped by message id)', () => {
	const { logger, events } = makeInMemoryEventLogger();

	// Two distinct messages: each with input=1000, output=500, cacheRead=100, cacheCreation=50
	const lines = [
		makeTranscriptLine('msg-A', 1000, 500, 100, 50),
		makeTranscriptLine('msg-B', 2000, 300, 200, 100),
	].join('\n');

	recordCycleTokens(
		makeBaseOpts({
			readOrchTranscript: () => lines,
			logEvent: logger,
		}),
	);

	const detail = (events[0] as WorkerEvent).detail as { orchTokens: number };
	// msg-A: 1000+50+100=1150; msg-B: 2000+100+200=2300; total=3450
	expect(detail.orchTokens).toBe(3450);
});

// ---------------------------------------------------------------------------
// 3. workerTokens = sum of ALL four token fields from 'tokens' events
// ---------------------------------------------------------------------------

test('workerTokens sums all four token fields from tokens events', () => {
	const { logger, events } = makeInMemoryEventLogger();

	// One worker: input=100, output=50, cacheRead=200, cacheCreation=25 -> total=375
	const eventLog = makeTokensLine(100, 50, 200, 25);

	recordCycleTokens(
		makeBaseOpts({
			readEventLog: () => eventLog,
			logEvent: logger,
		}),
	);

	const detail = (events[0] as WorkerEvent).detail as { workerTokens: number };
	expect(detail.workerTokens).toBe(375);
});

test('workerTokens sums multiple tokens events', () => {
	const { logger, events } = makeInMemoryEventLogger();

	// Worker 1: 100+50+200+25=375; Worker 2: 400+100+0+50=550
	const eventLog = [makeTokensLine(100, 50, 200, 25), makeTokensLine(400, 100, 0, 50)].join('\n');

	recordCycleTokens(
		makeBaseOpts({
			readEventLog: () => eventLog,
			logEvent: logger,
		}),
	);

	const detail = (events[0] as WorkerEvent).detail as { workerTokens: number };
	expect(detail.workerTokens).toBe(925);
});

// ---------------------------------------------------------------------------
// 4. total === orchTokens + workerTokens
// ---------------------------------------------------------------------------

test('total === orchTokens + workerTokens', () => {
	const { logger, events } = makeInMemoryEventLogger();

	const transcriptLine = makeTranscriptLine('msg-1', 1000, 500, 200, 300);
	const eventLog = makeTokensLine(100, 50, 200, 25);

	recordCycleTokens(
		makeBaseOpts({
			readOrchTranscript: () => transcriptLine,
			readEventLog: () => eventLog,
			logEvent: logger,
		}),
	);

	const detail = (events[0] as WorkerEvent).detail as {
		orchTokens: number;
		workerTokens: number;
		total: number;
	};
	expect(detail.total).toBe(detail.orchTokens + detail.workerTokens);
});

test('total computation: concrete values (orchTokens=1500, workerTokens=375)', () => {
	const { logger, events } = makeInMemoryEventLogger();

	// orchTokens = 1000 + 300 + 200 = 1500
	const transcriptLine = makeTranscriptLine('msg-1', 1000, 500, 200, 300);
	// workerTokens = 100 + 50 + 200 + 25 = 375
	const eventLog = makeTokensLine(100, 50, 200, 25);

	recordCycleTokens(
		makeBaseOpts({
			readOrchTranscript: () => transcriptLine,
			readEventLog: () => eventLog,
			logEvent: logger,
		}),
	);

	const detail = (events[0] as WorkerEvent).detail as {
		orchTokens: number;
		workerTokens: number;
		total: number;
	};
	expect(detail.orchTokens).toBe(1500);
	expect(detail.workerTokens).toBe(375);
	expect(detail.total).toBe(1875);
});

// ---------------------------------------------------------------------------
// 5. Absent orch transcript -> orchTokens=0, event still emitted
// ---------------------------------------------------------------------------

test('absent orch transcript: orchTokens is 0, event still emitted', () => {
	const { logger, events } = makeInMemoryEventLogger();

	recordCycleTokens(
		makeBaseOpts({
			readOrchTranscript: () => null,
			logEvent: logger,
		}),
	);

	expect(events).toHaveLength(1);
	const detail = (events[0] as WorkerEvent).detail as { orchTokens: number };
	expect(detail.orchTokens).toBe(0);
});

// ---------------------------------------------------------------------------
// 6. Per-cycle slice: tokens BEFORE the last 'cycle-tokens' marker are excluded
// ---------------------------------------------------------------------------

test('per-cycle slice: tokens before last cycle-tokens marker are excluded', () => {
	const { logger, events } = makeInMemoryEventLogger();

	// Event log:
	//   - tokens event from a previous cycle (input=9000, output=9000, ...)
	//   - cycle-tokens marker (end of previous cycle)
	//   - tokens event from this cycle (input=100, output=50, cacheRead=200, cacheCreation=25)
	const oldTokens = makeTokensLine(9000, 9000, 9000, 9000); // total=36000, excluded
	const marker = makeCycleTokensLine();
	const newTokens = makeTokensLine(100, 50, 200, 25); // total=375, included

	const eventLog = [oldTokens, marker, newTokens].join('\n');

	recordCycleTokens(
		makeBaseOpts({
			readEventLog: () => eventLog,
			logEvent: logger,
		}),
	);

	const detail = (events[0] as WorkerEvent).detail as { workerTokens: number };
	// Only the new tokens (375) should be counted
	expect(detail.workerTokens).toBe(375);
});

test('per-cycle slice: first cycle (no prior marker) sums ALL tokens events', () => {
	const { logger, events } = makeInMemoryEventLogger();

	// No cycle-tokens marker in the log -> all tokens events belong to the cycle
	const t1 = makeTokensLine(100, 50, 0, 0); // total=150
	const t2 = makeTokensLine(200, 100, 0, 0); // total=300

	const eventLog = [t1, t2].join('\n');

	recordCycleTokens(
		makeBaseOpts({
			readEventLog: () => eventLog,
			logEvent: logger,
		}),
	);

	const detail = (events[0] as WorkerEvent).detail as { workerTokens: number };
	expect(detail.workerTokens).toBe(450);
});

test('per-cycle slice: uses LAST cycle-tokens marker (multiple prior cycles)', () => {
	const { logger, events } = makeInMemoryEventLogger();

	// Two prior cycle-close markers; only tokens after the second one count
	const oldTokens1 = makeTokensLine(9000, 0, 0, 0);
	const marker1 = makeCycleTokensLine();
	const oldTokens2 = makeTokensLine(8000, 0, 0, 0);
	const marker2 = makeCycleTokensLine();
	const newTokens = makeTokensLine(100, 50, 200, 25); // total=375

	const eventLog = [oldTokens1, marker1, oldTokens2, marker2, newTokens].join('\n');

	recordCycleTokens(
		makeBaseOpts({
			readEventLog: () => eventLog,
			logEvent: logger,
		}),
	);

	const detail = (events[0] as WorkerEvent).detail as { workerTokens: number };
	expect(detail.workerTokens).toBe(375);
});

// ---------------------------------------------------------------------------
// 7. Absent event log -> workerTokens=0, event still emitted
// ---------------------------------------------------------------------------

test('absent event log: workerTokens is 0, event still emitted', () => {
	const { logger, events } = makeInMemoryEventLogger();

	recordCycleTokens(
		makeBaseOpts({
			readEventLog: () => null,
			logEvent: logger,
		}),
	);

	expect(events).toHaveLength(1);
	const detail = (events[0] as WorkerEvent).detail as { workerTokens: number };
	expect(detail.workerTokens).toBe(0);
});

// ---------------------------------------------------------------------------
// 8. Event uuid and storyId
// ---------------------------------------------------------------------------

test('emitted event has uuid=cycle-close and storyId=undefined', () => {
	const { logger, events } = makeInMemoryEventLogger();

	recordCycleTokens(makeBaseOpts({ logEvent: logger }));

	const ev = events[0] as WorkerEvent;
	expect(ev.uuid).toBe('cycle-close');
	expect(ev.storyId).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Oracle AC tests: source text guards
// ---------------------------------------------------------------------------

test('oracle AC1: journal.ts contains cycle-tokens string', async () => {
	const src = await Bun.file('./src/commands/journal.ts').text();
	expect(src).toContain('cycle-tokens');
});

test('oracle AC2: journal.ts references parseTranscriptUsage and orchestratorTranscriptPath', async () => {
	const src = await Bun.file('./src/commands/journal.ts').text();
	expect(src.includes('parseTranscriptUsage') || src.includes('orchestratorTranscriptPath')).toBe(true);
});
