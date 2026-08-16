import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { getIssueOnMain } from '../commands/issue-get.ts';
import { runAgentProcess } from './agent-process.ts';
import type { AgentSession, AgentSessionInput, AgentSessionResult } from './agent-session.ts';
import { buildAllowlistedEnv } from './child-env.ts';
import {
	buildWorkPrompt,
	EXECUTION_RESULT_SCHEMA,
	parseExecutionResult,
} from './claude-cli-executor.ts';
import type {
	RuntimeExecutionInput,
	RuntimeExecutionResult,
	RuntimeExecutor,
} from './run-runtime.ts';
import { RUNTIME_SOURCE_REF } from './source-ref.ts';

const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const MAX_ACTIVITY_TEXT = 2_000;

export interface CodexCliExecutorOptions {
	session?: AgentSession;
	command?: string[];
	model?: string;
	sourceEnv?: Record<string, string | undefined>;
	terminationGraceMs?: number;
	loadIssue?: (cwd: string, issueId: string) => string;
	onSpawn?: (pid: number) => void;
}

interface CodexInvocation {
	command: string[];
	sessionId: string;
	resume: boolean;
	model?: string;
	outputSchemaPath?: string;
	readOnly?: boolean;
}

interface CodexReviewInvocation {
	command: string[];
	model?: string;
	outputSchemaPath?: string;
}

export function buildCodexCliArgv(input: CodexInvocation): string[] {
	const argv = [...input.command, 'exec'];
	if (input.resume) argv.push('resume');
	argv.push('--json');
	if (input.readOnly) {
		argv.push(
			'--ignore-user-config',
			'-c',
			'sandbox_mode="read-only"',
			'-c',
			'approval_policy="never"',
		);
	} else {
		// Bypasses approvals and sandbox, but still never inherits user config.
		argv.push('--dangerously-bypass-approvals-and-sandbox', '--ignore-user-config');
	}
	if (input.model !== undefined) argv.push('--model', input.model);
	if (input.outputSchemaPath !== undefined) {
		argv.push('--output-schema', input.outputSchemaPath);
	}
	if (input.resume) argv.push(input.sessionId);
	argv.push('-');
	return argv;
}

export function buildCodexReviewArgv(input: CodexReviewInvocation): string[] {
	return buildCodexCliArgv({
		...input,
		sessionId: '',
		resume: false,
		readOnly: true,
	});
}

export function buildCodexEnv(
	source: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return buildAllowlistedEnv(source, ['CODEX_HOME']);
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function errorText(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	const record = recordOf(value);
	return typeof record?.['message'] === 'string' ? record['message'] : undefined;
}

interface CodexStreamState {
	terminal: boolean;
	failed: string | undefined;
	summary: string;
	structuredOutput: unknown;
}

function buildTurnArgv(
	input: AgentSessionInput,
	options: Omit<CodexCliExecutorOptions, 'loadIssue' | 'session'>,
	schemaPath: string | undefined,
	review: boolean,
): string[] {
	const shared = {
		command: options.command ?? ['codex'],
		...(options.model === undefined ? {} : { model: options.model }),
		...(schemaPath === undefined ? {} : { outputSchemaPath: schemaPath }),
	};
	if (review) return buildCodexReviewArgv(shared);
	return buildCodexCliArgv({
		...shared,
		sessionId: input.sessionId,
		resume: input.resume,
		readOnly: input.access === 'read-only',
	});
}

function parseEventLine(line: string): Record<string, unknown> | null {
	try {
		return recordOf(JSON.parse(line) as unknown);
	} catch {
		return null;
	}
}

function consumeCompletedItem(
	itemValue: unknown,
	input: AgentSessionInput,
	state: CodexStreamState,
): void {
	const item = recordOf(itemValue);
	const itemType = item?.['type'];
	if (itemType !== 'agent_message') {
		if (typeof itemType === 'string' && itemType !== 'reasoning') {
			input.emit(`${input.eventPrefix}.activity`, { tools: [itemType] });
		}
		return;
	}
	const message = item?.['text'];
	if (typeof message !== 'string') return;
	state.summary = message;
	try {
		state.structuredOutput = JSON.parse(message) as unknown;
	} catch {
		state.structuredOutput = undefined;
	}
	const text = message.trim().slice(0, MAX_ACTIVITY_TEXT);
	if (text.length > 0) input.emit(`${input.eventPrefix}.activity`, { text });
}

function consumeCodexEvent(
	line: string,
	input: AgentSessionInput,
	state: CodexStreamState,
): void {
	const event = parseEventLine(line);
	if (event === null) return;
	const type = event['type'];
	if (type === 'thread.started') {
		const sessionId = event['thread_id'];
		if (typeof sessionId === 'string' && sessionId.length > 0) input.onSessionId?.(sessionId);
		return;
	}
	if (type === 'turn.failed') {
		state.failed = errorText(event['error']) ?? 'Codex turn failed.';
		return;
	}
	if (type === 'error') {
		state.failed = errorText(event['message']) ?? errorText(event['error']) ?? 'Codex error.';
		return;
	}
	if (type === 'turn.completed') {
		state.terminal = true;
		return;
	}
	if (type === 'item.completed') consumeCompletedItem(event['item'], input, state);
}

async function runCodexTurn(
	input: AgentSessionInput,
	options: Omit<CodexCliExecutorOptions, 'loadIssue' | 'session'>,
	schemaPath: string | undefined,
	review = false,
): Promise<AgentSessionResult> {
	const state: CodexStreamState = {
		terminal: false,
		failed: undefined,
		summary: '',
		structuredOutput: undefined,
	};
	const result = await runAgentProcess({
		argv: buildTurnArgv(input, options, schemaPath, review),
		cwd: input.cwd,
		env: buildCodexEnv(options.sourceEnv ?? process.env),
		stdin: input.prompt,
		signal: input.signal,
		terminationGraceMs: options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
		onLine: (line) => consumeCodexEvent(line, input, state),
		...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
	});
	if (state.failed !== undefined) throw new Error(state.failed);
	if (result.exitCode !== 0) {
		throw new Error(`Codex CLI exited with ${result.exitCode}: ${result.stderr.trim().slice(-1_000)}`);
	}
	if (!state.terminal) throw new Error('Codex CLI exited without a turn.completed event.');
	if (state.summary.length === 0) throw new Error('Codex CLI completed without an agent message.');
	return {
		summary: state.summary,
		...(state.structuredOutput === undefined ? {} : { structuredOutput: state.structuredOutput }),
	};
}

async function withOutputSchema(
	schema: Record<string, unknown> | undefined,
	run: (schemaPath: string | undefined) => Promise<AgentSessionResult>,
): Promise<AgentSessionResult> {
	if (schema === undefined) return run(undefined);
	const directory = mkdtempSync(join(tmpdir(), 'gship-codex-schema-'));
	const schemaPath = join(directory, 'output.schema.json');
	try {
		writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
		return await run(schemaPath);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export class CodexAgentSession implements AgentSession {
	readonly provider = 'codex' as const;
	readonly #options: Omit<CodexCliExecutorOptions, 'loadIssue' | 'session'>;

	constructor(options: Omit<CodexCliExecutorOptions, 'loadIssue' | 'session'> = {}) {
		this.#options = options;
	}

	async run(input: AgentSessionInput): Promise<AgentSessionResult> {
		return withOutputSchema(
			input.outputSchema,
			(schemaPath) => runCodexTurn(input, this.#options, schemaPath),
		);
	}
}

/** Fresh structured Codex review, with user config disabled and read-only access. */
export class CodexReviewSession implements AgentSession {
	readonly provider = 'codex' as const;
	readonly #options: Omit<CodexCliExecutorOptions, 'loadIssue' | 'session'>;

	constructor(options: Omit<CodexCliExecutorOptions, 'loadIssue' | 'session'> = {}) {
		this.#options = options;
	}

	async run(input: AgentSessionInput): Promise<AgentSessionResult> {
		return withOutputSchema(
			input.outputSchema,
			(schemaPath) => runCodexTurn(input, this.#options, schemaPath, true),
		);
	}
}

function defaultLoadIssue(cwd: string, issueId: string): string {
	const issue = getIssueOnMain(cwd, issueId, spawnSync, RUNTIME_SOURCE_REF);
	if (!issue.ok) throw new Error(`issue not found on ${RUNTIME_SOURCE_REF}: ${issueId}`);
	return issue.content;
}

export class CodexCliExecutor implements RuntimeExecutor {
	readonly #options: CodexCliExecutorOptions;
	readonly #session: AgentSession;

	constructor(options: CodexCliExecutorOptions = {}) {
		this.#options = options;
		this.#session = options.session ?? new CodexAgentSession(options);
	}

	async execute(input: RuntimeExecutionInput): Promise<RuntimeExecutionResult> {
		const issue = (this.#options.loadIssue ?? defaultLoadIssue)(input.cwd, input.issueId);
		const prompt = buildWorkPrompt(
			input.issueId,
			issue,
			input.resume,
			input.reviewFeedback,
			input.operatorGuidance,
		);
		const result = await this.#session.run({
			sessionId: input.sessionId,
			resume: input.resume,
			cwd: input.cwd,
			prompt,
			outputSchema: EXECUTION_RESULT_SCHEMA,
			signal: input.signal,
			emit: input.emit,
			eventPrefix: 'provider',
			...(input.setSessionId === undefined ? {} : { onSessionId: input.setSessionId }),
		});
		return parseExecutionResult(result.structuredOutput);
	}
}
