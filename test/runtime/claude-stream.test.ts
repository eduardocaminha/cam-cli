import { describe, expect, test } from 'bun:test';

import { classifyHeadlessStreamLine } from '../../src/runtime/claude-stream.ts';

describe('classifyHeadlessStreamLine result usage (GSHIP-623)', () => {
	test('a complete result extracts the five usage counts and the per-model breakdown', () => {
		const event = classifyHeadlessStreamLine(JSON.stringify({
			type: 'result',
			is_error: false,
			result: 'done',
			total_cost_usd: 0.1234,
			usage: {
				input_tokens: 1000,
				output_tokens: 200,
				cache_creation_input_tokens: 50,
				cache_read_input_tokens: 25,
				output_tokens_details: { thinking_tokens: 40 },
			},
			modelUsage: {
				'claude-opus-4-6': {
					inputTokens: 900,
					outputTokens: 150,
					cacheReadInputTokens: 25,
					cacheCreationInputTokens: 50,
					costUSD: 0.12,
				},
				'claude-haiku-4-5': {
					inputTokens: 100,
					outputTokens: 50,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					costUSD: 0.0034,
				},
			},
		}));

		expect(event.kind).toBe('result');
		if (event.kind !== 'result') throw new Error('unreachable');
		expect(event.totalCostUsd).toBe(0.1234);
		expect(event.usage).toEqual({
			inputTokens: 1000,
			outputTokens: 200,
			cacheCreationInputTokens: 50,
			cacheReadInputTokens: 25,
			thinkingTokens: 40,
		});
		expect(event.modelUsage).toEqual([
			{
				model: 'claude-opus-4-6',
				inputTokens: 900,
				outputTokens: 150,
				cacheReadInputTokens: 25,
				cacheCreationInputTokens: 50,
				costUsd: 0.12,
			},
			{
				model: 'claude-haiku-4-5',
				inputTokens: 100,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				costUsd: 0.0034,
			},
		]);
	});

	test('a result without usage reads as undefined, never as zero', () => {
		const event = classifyHeadlessStreamLine(JSON.stringify({
			type: 'result',
			is_error: false,
			result: 'done',
			total_cost_usd: 0.05,
			modelUsage: {
				'claude-opus-4-6': { inputTokens: 10, outputTokens: 5, costUSD: 0.05 },
			},
		}));

		expect(event.kind).toBe('result');
		if (event.kind !== 'result') throw new Error('unreachable');
		expect(event.totalCostUsd).toBe(0.05);
		expect(event.usage).toBeUndefined();
		expect(event.modelUsage).toEqual([
			{
				model: 'claude-opus-4-6',
				inputTokens: 10,
				outputTokens: 5,
				cacheReadInputTokens: undefined,
				cacheCreationInputTokens: undefined,
				costUsd: 0.05,
			},
		]);
	});

	test('a result without modelUsage reads as undefined, and total_cost_usd still parses alone', () => {
		const event = classifyHeadlessStreamLine(JSON.stringify({
			type: 'result',
			is_error: false,
			result: 'done',
			total_cost_usd: 0.02,
			usage: {
				input_tokens: 40,
				output_tokens: 10,
			},
		}));

		expect(event.kind).toBe('result');
		if (event.kind !== 'result') throw new Error('unreachable');
		expect(event.totalCostUsd).toBe(0.02);
		expect(event.modelUsage).toBeUndefined();
		expect(event.usage).toEqual({
			inputTokens: 40,
			outputTokens: 10,
			cacheCreationInputTokens: undefined,
			cacheReadInputTokens: undefined,
			thinkingTokens: undefined,
		});
	});

	test('a field missing inside usage stays undefined without dropping its siblings', () => {
		const event = classifyHeadlessStreamLine(JSON.stringify({
			type: 'result',
			is_error: false,
			result: 'done',
			usage: {
				input_tokens: 7,
				// output_tokens omitted entirely.
				cache_creation_input_tokens: 'not-a-number',
				cache_read_input_tokens: 3,
				output_tokens_details: {},
			},
		}));

		expect(event.kind).toBe('result');
		if (event.kind !== 'result') throw new Error('unreachable');
		expect(event.totalCostUsd).toBeUndefined();
		expect(event.usage).toEqual({
			inputTokens: 7,
			outputTokens: undefined,
			cacheCreationInputTokens: undefined,
			cacheReadInputTokens: 3,
			thinkingTokens: undefined,
		});
	});

	test('a malformed line never throws and carries no usage', () => {
		expect(classifyHeadlessStreamLine('not json')).toEqual({
			kind: 'malformed',
			reason: 'invalid-json',
			raw: undefined,
		});
		expect(classifyHeadlessStreamLine('42')).toEqual({
			kind: 'malformed',
			reason: 'not-an-object',
			raw: 42,
		});
		// A `result` whose usage/modelUsage are the wrong shape degrades to
		// undefined instead of throwing or fabricating numbers.
		const event = classifyHeadlessStreamLine(JSON.stringify({
			type: 'result',
			is_error: false,
			result: 'done',
			total_cost_usd: 'free',
			usage: 'nope',
			modelUsage: ['not', 'a', 'map'],
		}));
		expect(event.kind).toBe('result');
		if (event.kind !== 'result') throw new Error('unreachable');
		expect(event.totalCostUsd).toBeUndefined();
		expect(event.usage).toBeUndefined();
		expect(event.modelUsage).toBeUndefined();
	});
});
