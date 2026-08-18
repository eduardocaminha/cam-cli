// src/runtime/claude-cli-process.ts
//
// Child-process plumbing shared by the two headless Claude CLI roles the
// runtime owns: the implementer executor and the independent reviewer. Both
// spawn a detached `claude --print` child, feed one stream-json user message
// on stdin, translate the NDJSON stdout into durable run events, and hand the
// whole process group to the service on cancellation. Keeping one lifecycle
// here is what lets the reviewer be a second role instead of a second engine.

import { ProviderRefusalError } from './agent-session.ts';
import {
	type ClaudeModelUsage,
	type ClaudeResultUsage,
	classifyHeadlessStreamLine,
} from './claude-stream.ts';
import { runAgentProcess } from './agent-process.ts';
import { buildAllowlistedEnv } from './child-env.ts';
import type { ModelSlot } from './model-settings.ts';

export const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const MAX_ACTIVITY_TEXT = 2_000;

export interface ClaudeCliRunInput {
	argv: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	prompt: string;
	signal: AbortSignal;
	/**
	 * `eventClass` declares GSHIP-627's activity/decision split at the emit
	 * call site; omitted means the store defaults it to `decision`.
	 */
	emit: (kind: string, payload?: Record<string, unknown>, eventClass?: 'activity' | 'decision') => void;
	/** Event namespace, so a reviewer child is distinguishable from the implementer. */
	eventPrefix: string;
	/**
	 * The pair GSHIP-617 already resolved for this spawn, so the usage event
	 * below (GSHIP-623) can carry it without a second lookup. Pass the empty
	 * slot, not an absent field, when neither is configured.
	 */
	slot: ModelSlot;
	terminationGraceMs?: number;
	onSpawn?: (pid: number) => void;
}

export interface ClaudeCliResult {
	summary: string;
	structuredOutput?: unknown;
}

export function buildClaudeEnv(
	source: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return buildAllowlistedEnv(source, ['CLAUDE_CONFIG_DIR']);
}

/** Persist only operator-visible prose and tool names from an assistant event. */
export function projectAssistantActivity(raw: Record<string, unknown>): Record<string, unknown> {
	const message = raw['message'];
	if (message === null || typeof message !== 'object' || Array.isArray(message)) return {};
	const content = (message as Record<string, unknown>)['content'];
	if (!Array.isArray(content)) return {};

	const text: string[] = [];
	const tools: string[] = [];
	for (const block of content) {
		if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
		const record = block as Record<string, unknown>;
		if (record['type'] === 'text' && typeof record['text'] === 'string') {
			text.push(record['text']);
		}
		if (record['type'] === 'tool_use' && typeof record['name'] === 'string') {
			tools.push(record['name']);
		}
	}
	const joined = text.join('\n').trim().slice(0, MAX_ACTIVITY_TEXT);
	return {
		...(joined.length === 0 ? {} : { text: joined }),
		...(tools.length === 0 ? {} : { tools }),
	};
}

function compact(record: object): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	);
}

/**
 * One durable event per provider invocation carrying what the CLI reported
 * for it (GSHIP-623): the resolved model/effort pair beside the cost and
 * token counts, so a run's total is derivable by summing this event's kind
 * alone. Omitted entirely when the CLI reported nothing measurable -- never
 * emitted with a fabricated zero, which would read as "this call was free".
 */
function emitUsage(
	emit: (kind: string, payload?: Record<string, unknown>) => void,
	eventPrefix: string,
	slot: ModelSlot,
	result: {
		totalCostUsd: number | undefined;
		usage: ClaudeResultUsage | undefined;
		modelUsage: ClaudeModelUsage[] | undefined;
	},
): void {
	if (result.totalCostUsd === undefined && result.usage === undefined && result.modelUsage === undefined) {
		return;
	}
	emit(`${eventPrefix}.usage`, {
		...(slot.model === undefined ? {} : { model: slot.model }),
		...(slot.effort === undefined ? {} : { effort: slot.effort }),
		...(result.totalCostUsd === undefined ? {} : { totalCostUsd: result.totalCostUsd }),
		...(result.usage === undefined ? {} : { usage: compact(result.usage) }),
		...(result.modelUsage === undefined
			? {}
			: { modelUsage: result.modelUsage.map((entry) => compact(entry)) }),
	});
}

/**
 * Run one headless Claude CLI turn and return its final result text. Throws on
 * a non-zero exit, a missing result event, an error result, or cancellation --
 * and never resolves before the child process group has actually settled.
 */
export async function runClaudeCli(input: ClaudeCliRunInput): Promise<ClaudeCliResult> {
	const message = JSON.stringify({
		type: 'user',
		message: { role: 'user', content: input.prompt },
	});
	let resultSeen = false;
	let resultIsError = false;
	let summary = '';
	let structuredOutput: unknown;
	const processResult = await runAgentProcess({
		argv: input.argv,
		cwd: input.cwd,
		env: input.env,
		stdin: `${message}\n`,
		signal: input.signal,
		terminationGraceMs: input.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
		...(input.onSpawn === undefined ? {} : { onSpawn: input.onSpawn }),
		onLine: (line) => {
		const event = classifyHeadlessStreamLine(line);
		// Only these two stream kinds are declared activity (GSHIP-627): they are
		// the CLI's raw provider/review output, never a decision the run made.
		// Everything else below stays undeclared and defaults to decision.
		if (event.kind === 'system') {
			input.emit(`${input.eventPrefix}.system`, { subtype: event.subtype ?? 'unknown' }, 'activity');
		} else if (event.kind === 'assistant') {
			input.emit(`${input.eventPrefix}.activity`, projectAssistantActivity(event.raw), 'activity');
		} else if (event.kind === 'rate_limit_event') {
			input.emit(`${input.eventPrefix}.rate-limit`);
		} else if (event.kind === 'result') {
			resultSeen = true;
			resultIsError = event.raw.is_error === true;
			if (typeof event.raw.result === 'string') summary = event.raw.result;
			structuredOutput = event.raw['structured_output'];
			input.emit(`${input.eventPrefix}.result`);
			emitUsage(input.emit, input.eventPrefix, input.slot, {
				totalCostUsd: event.totalCostUsd,
				usage: event.usage,
				modelUsage: event.modelUsage,
			});
		}
		},
	});
	if (processResult.exitCode !== 0) {
		throw new Error(
			`Claude CLI exited with ${processResult.exitCode}: ${processResult.stderr.trim().slice(-1_000)}`,
		);
	}
	if (!resultSeen) throw new Error('Claude CLI exited without a result event.');
	if (resultIsError) throw new ProviderRefusalError(summary || 'Claude CLI returned an error result.');
	return {
		summary,
		...(structuredOutput === undefined ? {} : { structuredOutput }),
	};
}
