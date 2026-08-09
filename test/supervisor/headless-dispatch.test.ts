// test/supervisor/headless-dispatch.test.ts
//
// Tests for src/supervisor/headless-dispatch.ts (US-003, CAM-516), run
// against a REAL spawned child (test/fixtures/headless/fixture-child.ts),
// never an in-process mock: the point of this module is the real
// `Bun.spawn` boundary (real stdin FileSink, real NDJSON stdout, real
// exit/signal handling), so the test must exercise that boundary directly,
// mirroring the discipline established by
// test/interactivity/interactivity.test.ts and
// test/fixtures/dispatch-geometry/raw-echo.ts.
//
// Coverage:
//   1. End to end: writes the stream-json input message to the child's
//      stdin, consumes NDJSON stdout through the US-002 parser, appends
//      every line to the US-002 per-dispatch log, resolves with the
//      `result` event's total_cost_usd (issue AC1).
//   2. `no TTY is allocated`: Bun.spawn is invoked without `terminal`, and
//      the fixture reports non-TTY stdout back through the stream.
//   3. `idle budget`: a fixture that emits one event and then goes silent
//      is terminated once the idle budget elapses, reporting a timeout
//      outcome (never a success, never a hang).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, afterEach } from 'bun:test';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';
import { openHeadlessDispatchLog } from '../../src/supervisor/headless-log.ts';
import { runHeadlessDispatch } from '../../src/supervisor/headless-dispatch.ts';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/headless/fixture-child.ts', import.meta.url));

if (!existsSync(FIXTURE_PATH)) {
	throw new Error(`fixture-child.ts missing at ${FIXTURE_PATH} — did test/fixtures/headless/ get checked in?`);
}

/** PIDs of subprocesses spawned during a test. afterEach reaps any survivors, defense-in-depth over runHeadlessDispatch's own idle-timeout kill. */
const livePids = new Set<number>();

afterEach(() => {
	for (const pid of livePids) {
		try {
			process.kill(pid, 0);
			process.kill(pid, 'SIGKILL');
		} catch {
			// Already exited — nothing to do.
		}
	}
	livePids.clear();
});

function readLoggedLines(logPath: string): Array<Record<string, unknown>> {
	const content = readFileSync(logPath, 'utf8');
	return content
		.split('\n')
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('runHeadlessDispatch', () => {
	test('runs one dispatch end to end against a real child: stdin write, NDJSON parse, per-dispatch log, result total_cost_usd', async () => {
		const claudeDir = createTestTmpdir();
		const log = openHeadlessDispatchLog(claudeDir, 'dispatch-e2e');

		const outcome = await runHeadlessDispatch({
			argv: ['bun', FIXTURE_PATH, 'happy'],
			env: process.env,
			inputMessage: JSON.stringify({ type: 'user', message: { role: 'user', content: 'implement the story' } }),
			log,
		});

		expect(outcome.kind).toBe('completed');
		if (outcome.kind === 'completed') {
			expect(outcome.exitCode).toBe(0);
			expect(outcome.totalCostUsd).toBe(0.0456);
		}

		// Every raw stdout line was appended to the per-dispatch log, verbatim,
		// in arrival order.
		const lines = readLoggedLines(log.path);
		expect(lines.map((l) => l.type)).toEqual(['system', 'assistant', 'result']);
		expect(lines[2]?.total_cost_usd).toBe(0.0456);
	});

	test('no TTY is allocated', async () => {
		const claudeDir = createTestTmpdir();
		const log = openHeadlessDispatchLog(claudeDir, 'dispatch-no-tty');

		const outcome = await runHeadlessDispatch({
			argv: ['bun', FIXTURE_PATH, 'happy'],
			env: process.env,
			inputMessage: JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
			log,
		});

		expect(outcome.kind).toBe('completed');

		// The fixture reports process.stdout.isTTY from INSIDE the real child —
		// only true when Bun.spawn was invoked with a `terminal` option, which
		// this module never passes.
		const lines = readLoggedLines(log.path);
		const initLine = lines.find((l) => l.type === 'system' && l.subtype === 'init');
		expect(initLine?.isTTY).toBe(false);
	});

	test('idle budget', async () => {
		const claudeDir = createTestTmpdir();
		const log = openHeadlessDispatchLog(claudeDir, 'dispatch-idle');

		const outcome = await runHeadlessDispatch({
			argv: ['bun', FIXTURE_PATH, 'idle'],
			env: process.env,
			inputMessage: JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
			log,
			idleBudgetMs: 150,
		});

		// Not a success and not a hang: an explicit timeout outcome.
		expect(outcome.kind).toBe('idle-timeout');
		expect(outcome.totalCostUsd).toBeUndefined();

		// The fixture emitted exactly its one event before going silent; the
		// idle budget fired and the child was killed rather than waited out.
		const lines = readLoggedLines(log.path);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.type).toBe('system');
	});
});
