// test/supervisor/headless-stream.test.ts
//
// Unit tests for src/supervisor/headless-stream.ts.
//
// Coverage:
//   1. Each event kind measured on 2026-08-08 (GOTCHA I): system (+ init
//      subtype), rate_limit_event, assistant, user, result (+ total_cost_usd).
//   2. `stream_event` gets its own named branch (GOTCHA H), not a generic
//      fallback shared with malformed input.
//   3. Malformed lines (invalid JSON, non-object JSON, unrecognized type) are
//      classified explicitly, never thrown.

import { describe, expect, test } from 'bun:test';
import { classifyHeadlessStreamLine } from '../../src/supervisor/headless-stream.ts';

describe('classifyHeadlessStreamLine', () => {
	test('system (init subtype)', () => {
		const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123', apiKeySource: 'none' });
		const event = classifyHeadlessStreamLine(line);
		expect(event.kind).toBe('system');
		if (event.kind === 'system') {
			expect(event.subtype).toBe('init');
		}
	});

	test('system (no subtype)', () => {
		const line = JSON.stringify({ type: 'system' });
		const event = classifyHeadlessStreamLine(line);
		expect(event.kind).toBe('system');
		if (event.kind === 'system') {
			expect(event.subtype).toBeUndefined();
		}
	});

	test('rate_limit_event', () => {
		const line = JSON.stringify({ type: 'rate_limit_event', rate_limit: { status: 'allowed', unified_rate_limit_fallback_available: true } });
		const event = classifyHeadlessStreamLine(line);
		expect(event.kind).toBe('rate_limit_event');
	});

	test('assistant', () => {
		const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
		const event = classifyHeadlessStreamLine(line);
		expect(event.kind).toBe('assistant');
	});

	test('user', () => {
		const line = JSON.stringify({ type: 'user', message: { content: [] } });
		const event = classifyHeadlessStreamLine(line);
		expect(event.kind).toBe('user');
	});

	test('result reads total_cost_usd', () => {
		const line = JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.1234, session_id: 'abc-123' });
		const event = classifyHeadlessStreamLine(line);
		expect(event.kind).toBe('result');
		if (event.kind === 'result') {
			expect(event.totalCostUsd).toBe(0.1234);
		}
	});

	test('result with a non-numeric total_cost_usd leaves totalCostUsd undefined', () => {
		const line = JSON.stringify({ type: 'result', total_cost_usd: 'not-a-number' });
		const event = classifyHeadlessStreamLine(line);
		expect(event.kind).toBe('result');
		if (event.kind === 'result') {
			expect(event.totalCostUsd).toBeUndefined();
		}
	});

	test('stream_event', () => {
		const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'partial' } } });
		const event = classifyHeadlessStreamLine(line);
		expect(event.kind).toBe('stream_event');
	});

	test('malformed: invalid JSON is classified explicitly, never thrown', () => {
		expect(() => classifyHeadlessStreamLine('{not valid json')).not.toThrow();
		const event = classifyHeadlessStreamLine('{not valid json');
		expect(event.kind).toBe('malformed');
		if (event.kind === 'malformed') {
			expect(event.reason).toBe('invalid-json');
		}
	});

	test('malformed: non-object JSON', () => {
		const event = classifyHeadlessStreamLine('42');
		expect(event.kind).toBe('malformed');
		if (event.kind === 'malformed') {
			expect(event.reason).toBe('not-an-object');
		}
	});

	test('malformed: unrecognized type', () => {
		const event = classifyHeadlessStreamLine(JSON.stringify({ type: 'some_future_event' }));
		expect(event.kind).toBe('malformed');
		if (event.kind === 'malformed') {
			expect(event.reason).toBe('unrecognized-type');
		}
	});
});
