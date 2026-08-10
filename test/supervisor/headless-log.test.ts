// test/supervisor/headless-log.test.ts
//
// Unit tests for src/supervisor/headless-log.ts, run against a REAL tmpdir
// filesystem (issue AC2) via the shared test-scratch helper, never an
// in-memory fake.
//
// Coverage:
//   1. openHeadlessDispatchLog creates the dispatch's log file (keyed by
//      uuid) and writes lines verbatim, in arrival order.
//   2. `append-only`: a second writer opened against an existing dispatch log
//      preserves the earlier bytes and appends after them.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';
import { headlessDispatchLogPath, openHeadlessDispatchLog } from '../../src/supervisor/headless-log.ts';

describe('openHeadlessDispatchLog', () => {
	test('creates a log file keyed by the dispatch uuid', () => {
		const claudeDir = createTestTmpdir();
		const uuid = 'dispatch-uuid-1';

		const writer = openHeadlessDispatchLog(claudeDir, uuid);

		expect(writer.path).toBe(headlessDispatchLogPath(claudeDir, uuid));
		writer.appendLine('{"type":"system","subtype":"init"}');
		expect(existsSync(writer.path)).toBe(true);
	});

	test('writes every line verbatim, in arrival order', () => {
		const claudeDir = createTestTmpdir();
		const uuid = 'dispatch-uuid-2';
		const writer = openHeadlessDispatchLog(claudeDir, uuid);

		const lines = ['{"type":"system","subtype":"init"}', '{"type":"assistant"}', '{"type":"result","total_cost_usd":0.5}'];
		for (const line of lines) writer.appendLine(line);

		const content = readFileSync(writer.path, 'utf8');
		expect(content).toBe(`${lines.join('\n')}\n`);
	});

	test('a distinct uuid gets a distinct log file', () => {
		const claudeDir = createTestTmpdir();
		const writerA = openHeadlessDispatchLog(claudeDir, 'uuid-a');
		const writerB = openHeadlessDispatchLog(claudeDir, 'uuid-b');

		expect(writerA.path).not.toBe(writerB.path);
	});

	test('append-only', () => {
		const claudeDir = createTestTmpdir();
		const uuid = 'dispatch-uuid-append-only';

		// First writer session.
		const firstWriter = openHeadlessDispatchLog(claudeDir, uuid);
		firstWriter.appendLine('{"type":"system","subtype":"init"}');
		firstWriter.appendLine('{"type":"assistant"}');

		const afterFirstSession = readFileSync(firstWriter.path, 'utf8');

		// Second writer session opened against the SAME existing dispatch log.
		const secondWriter = openHeadlessDispatchLog(claudeDir, uuid);
		secondWriter.appendLine('{"type":"result","total_cost_usd":0.42}');

		const afterSecondSession = readFileSync(secondWriter.path, 'utf8');

		// The earlier bytes are preserved as a prefix, and the new line is
		// appended after them.
		expect(afterSecondSession.startsWith(afterFirstSession)).toBe(true);
		expect(afterSecondSession).toBe(`${afterFirstSession}{"type":"result","total_cost_usd":0.42}\n`);
	});
});
