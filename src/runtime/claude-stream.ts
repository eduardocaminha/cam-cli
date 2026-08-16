// Claude Code stream-json event classification for the web runtime.
//
// Classifies one line of the headless child's `--output-format stream-json`
// NDJSON output into the event vocabulary actually MEASURED on 2026-08-08
// (ADR-0059/ADR-0060, GOTCHA I): `system` (including its `init` subtype),
// `rate_limit_event`, `assistant`, `user` and `result`. US-002 (CAM-516).
//
// `stream_event` gets its OWN named branch that deliberately IGNORES it
// (GOTCHA H): this PRD's argv builder (headless-argv.ts, US-001) never passes
// `--include-partial-messages`, so token-level `stream_event` deltas are not
// emitted today. The defect this avoids is the Warren transcript parser's
// generic-branch behavior (early-death.ts / src/transcript/usage.ts precedent
// for reading the SAME event vocabulary applied to on-disk transcripts): a
// type this repo does not yet consume must still be named explicitly rather
// than silently falling through a `default` alongside genuinely malformed
// input.
//
// A malformed line (invalid JSON, non-object JSON, or an object whose `type`
// is outside the measured vocabulary) is classified explicitly as `kind:
// 'malformed'` with a `reason`, never thrown out of the consumer -- mirrors
// the malformed-line convention already established by
// `extractLastAssistantEntry` (early-death.ts) and `parseTranscriptUsage`
// (src/transcript/usage.ts), which both skip rather than throw.

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
