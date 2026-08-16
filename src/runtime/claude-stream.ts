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

/** One classified NDJSON line from the headless child's stdout. */
export type HeadlessStreamEvent =
	| { kind: 'system'; subtype: string | undefined; raw: Record<string, unknown> }
	| { kind: 'rate_limit_event'; raw: Record<string, unknown> }
	| { kind: 'assistant'; raw: Record<string, unknown> }
	| { kind: 'user'; raw: Record<string, unknown> }
	| { kind: 'result'; totalCostUsd: number | undefined; raw: Record<string, unknown> }
	| { kind: 'stream_event'; raw: Record<string, unknown> }
	| { kind: 'malformed'; reason: HeadlessStreamMalformedReason; raw: unknown };

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
			return { kind: 'result', totalCostUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined, raw: obj };
		case 'stream_event':
			// GOTCHA H: named branch, deliberately ignored. Not emitted today
			// (--include-partial-messages is never passed), but must never fall
			// through the generic `default` alongside real malformed input.
			return { kind: 'stream_event', raw: obj };
		default:
			return { kind: 'malformed', reason: 'unrecognized-type', raw: obj };
	}
}
