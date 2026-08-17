// Claude Code stream-json event classification for the web runtime.
//
// Classifies one line of Claude Code's `--output-format stream-json` NDJSON.
// Unknown or malformed input becomes an explicit event instead of terminating
// the consumer. Token-level `stream_event` messages are named but ignored
// because Gateship does not request partial messages.

/** The event vocabulary measured on 2026-08-08 (GOTCHA I), plus the
 * deliberately-ignored `stream_event` branch (GOTCHA H) and `malformed`. */
export type HeadlessStreamEventKind = 'system' | 'rate_limit_event' | 'assistant' | 'user' | 'result' | 'stream_event' | 'malformed';

/** Why a line was classified as `malformed`. */
export type HeadlessStreamMalformedReason = 'invalid-json' | 'not-an-object' | 'unrecognized-type';

/**
 * The `result` event's own `usage` object (GSHIP-623): Anthropic-style
 * snake_case on the wire, decoded here into the five counts Gateship measures.
 * A field the CLI omitted stays `undefined` -- never coerced to zero, which
 * would read as "free" -- so a consumer can tell "not reported" from "zero".
 */
export interface ClaudeResultUsage {
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	cacheCreationInputTokens: number | undefined;
	cacheReadInputTokens: number | undefined;
	thinkingTokens: number | undefined;
}

/**
 * One model's slice of `result.modelUsage` (GSHIP-623): camelCase on the
 * wire, unlike the sibling `usage` object above. `total_cost_usd` is the sum
 * of every entry's `costUsd`, including auxiliary models the operator's own
 * model settings never name -- which is why a cost display must show this
 * breakdown instead of attributing the whole total to the configured model.
 */
export interface ClaudeModelUsage {
	model: string;
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	cacheReadInputTokens: number | undefined;
	cacheCreationInputTokens: number | undefined;
	costUsd: number | undefined;
}

/** One classified NDJSON line from the headless child's stdout. */
export type HeadlessStreamEvent =
	| { kind: 'system'; subtype: string | undefined; raw: Record<string, unknown> }
	| { kind: 'rate_limit_event'; raw: Record<string, unknown> }
	| { kind: 'assistant'; raw: Record<string, unknown> }
	| { kind: 'user'; raw: Record<string, unknown> }
	| {
		kind: 'result';
		totalCostUsd: number | undefined;
		usage: ClaudeResultUsage | undefined;
		modelUsage: ClaudeModelUsage[] | undefined;
		raw: Record<string, unknown>;
	}
	| { kind: 'stream_event'; raw: Record<string, unknown> }
	| { kind: 'malformed'; reason: HeadlessStreamMalformedReason; raw: unknown };

function recordOf(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === 'number' ? value : undefined;
}

/** Tolerates a missing `usage` object and any missing field inside it. */
function parseResultUsage(raw: Record<string, unknown>): ClaudeResultUsage | undefined {
	const usage = recordOf(raw['usage']);
	if (usage === null) return undefined;
	const details = recordOf(usage['output_tokens_details']) ?? {};
	return {
		inputTokens: numberField(usage, 'input_tokens'),
		outputTokens: numberField(usage, 'output_tokens'),
		cacheCreationInputTokens: numberField(usage, 'cache_creation_input_tokens'),
		cacheReadInputTokens: numberField(usage, 'cache_read_input_tokens'),
		thinkingTokens: numberField(details, 'thinking_tokens'),
	};
}

/** Tolerates a missing `modelUsage` map and a malformed entry inside it. */
function parseModelUsage(raw: Record<string, unknown>): ClaudeModelUsage[] | undefined {
	const modelUsage = recordOf(raw['modelUsage']);
	if (modelUsage === null) return undefined;
	const entries = Object.entries(modelUsage)
		.map(([model, value]) => {
			const record = recordOf(value);
			if (record === null) return null;
			return {
				model,
				inputTokens: numberField(record, 'inputTokens'),
				outputTokens: numberField(record, 'outputTokens'),
				cacheReadInputTokens: numberField(record, 'cacheReadInputTokens'),
				cacheCreationInputTokens: numberField(record, 'cacheCreationInputTokens'),
				costUsd: numberField(record, 'costUSD'),
			};
		})
		.filter((entry): entry is ClaudeModelUsage => entry !== null);
	return entries.length === 0 ? undefined : entries;
}

/**
 * Classify one raw NDJSON line. Never throws: a `JSON.parse` failure, a
 * non-object payload, and an object whose `type` falls outside the measured
 * vocabulary all resolve to an explicit `{ kind: 'malformed', reason, raw }`
 * rather than propagating an exception to the caller.
 */
export function classifyHeadlessStreamLine(line: string): HeadlessStreamEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { kind: 'malformed', reason: 'invalid-json', raw: undefined };
	}

	if (typeof parsed !== 'object' || parsed === null) {
		return { kind: 'malformed', reason: 'not-an-object', raw: parsed };
	}

	const obj = parsed as Record<string, unknown>;

	switch (obj.type) {
		case 'system':
			return { kind: 'system', subtype: typeof obj.subtype === 'string' ? obj.subtype : undefined, raw: obj };
		case 'rate_limit_event':
			return { kind: 'rate_limit_event', raw: obj };
		case 'assistant':
			return { kind: 'assistant', raw: obj };
		case 'user':
			return { kind: 'user', raw: obj };
		case 'result':
			return {
				kind: 'result',
				totalCostUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
				usage: parseResultUsage(obj),
				modelUsage: parseModelUsage(obj),
				raw: obj,
			};
		case 'stream_event':
			// GOTCHA H: named branch, deliberately ignored. Not emitted today
			// (--include-partial-messages is never passed), but must never fall
			// through the generic `default` alongside real malformed input.
			return { kind: 'stream_event', raw: obj };
		default:
			return { kind: 'malformed', reason: 'unrecognized-type', raw: obj };
	}
}
