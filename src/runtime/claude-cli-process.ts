// src/runtime/claude-cli-process.ts
//
// Child-process plumbing shared by the two headless Claude CLI roles the
// runtime owns: the implementer executor and the independent reviewer. Both
// spawn a detached `claude --print` child, feed one stream-json user message
// on stdin, translate the NDJSON stdout into durable run events, and hand the
// whole process group to the service on cancellation. Keeping one lifecycle
// here is what lets the reviewer be a second role instead of a second engine.

import { classifyHeadlessStreamLine } from './claude-stream.ts';
import { runAgentProcess } from './agent-process.ts';

const CLAUDE_NESTING_ENV = [
	'CLAUDECODE',
	'CLAUDE_CODE_ENTRYPOINT',
	'CLAUDE_CODE_SESSION_ID',
	'CLAUDE_CODE_SSE_PORT',
	'CLAUDE_CODE_EXECPATH',
	'CLAUDE_AGENT_SDK_VERSION',
] as const;

export const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const MAX_ACTIVITY_TEXT = 2_000;

export interface ClaudeCliRunInput {
	argv: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	prompt: string;
	signal: AbortSignal;
	emit: (kind: string, payload?: Record<string, unknown>) => void;
	/** Event namespace, so a reviewer child is distinguishable from the implementer. */
	eventPrefix: string;
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
	const env = { ...source };
	for (const key of CLAUDE_NESTING_ENV) delete env[key];
	delete env.ANTHROPIC_API_KEY;
	delete env.CLAUDE_CODE_OAUTH_TOKEN;
	delete env.TMUX;
	delete env.TMUX_PANE;
	return env;
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
		if (event.kind === 'system') {
			input.emit(`${input.eventPrefix}.system`, { subtype: event.subtype ?? 'unknown' });
		} else if (event.kind === 'assistant') {
			input.emit(`${input.eventPrefix}.activity`, projectAssistantActivity(event.raw));
		} else if (event.kind === 'rate_limit_event') {
			input.emit(`${input.eventPrefix}.rate-limit`);
		} else if (event.kind === 'result') {
			resultSeen = true;
			resultIsError = event.raw.is_error === true;
			if (typeof event.raw.result === 'string') summary = event.raw.result;
			structuredOutput = event.raw['structured_output'];
			input.emit(`${input.eventPrefix}.result`);
		}
		},
	});
	if (processResult.exitCode !== 0) {
		throw new Error(
			`Claude CLI exited with ${processResult.exitCode}: ${processResult.stderr.trim().slice(-1_000)}`,
		);
	}
	if (!resultSeen) throw new Error('Claude CLI exited without a result event.');
	if (resultIsError) throw new Error(summary || 'Claude CLI returned an error result.');
	return {
		summary,
		...(structuredOutput === undefined ? {} : { structuredOutput }),
	};
}
