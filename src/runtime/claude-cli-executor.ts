import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { getIssueOnMain } from '../commands/issue-get.ts';
import type { AgentSession, AgentSessionInput, AgentSessionResult } from './agent-session.ts';
import { buildClaudeEnv, runClaudeCli } from './claude-cli-process.ts';
import type {
	RuntimeExecutionInput,
	RuntimeExecutionResult,
	RuntimeExecutor,
} from './run-runtime.ts';
import { RUNTIME_SOURCE_REF } from './source-ref.ts';

export interface ClaudeCliExecutorOptions {
	session?: AgentSession;
	command?: string[];
	model?: string;
	permissionMode?: string;
	sourceEnv?: Record<string, string | undefined>;
	terminationGraceMs?: number;
	loadIssue?: (cwd: string, issueId: string) => string;
	onSpawn?: (pid: number) => void;
}

interface ClaudeInvocation {
	command: string[];
	sessionId: string;
	resume: boolean;
	permissionMode: string;
	model?: string;
	jsonSchema?: Record<string, unknown>;
}

export function buildClaudeReadOnlyArgv(input: ClaudeInvocation): string[] {
	const argv = [
		...input.command,
		'--print',
		'--input-format',
		'stream-json',
		'--output-format',
		'stream-json',
		'--verbose',
		'--permission-mode',
		'dontAsk',
		'--tools',
		'Read,Grep,Glob',
		'--allowedTools',
		'Read,Grep,Glob',
		'--disallowedTools',
		'Bash,Edit,Write,NotebookEdit,Agent',
		'--disable-slash-commands',
		'--strict-mcp-config',
		'--mcp-config',
		'{"mcpServers":{}}',
	];
	argv.push(input.resume ? '--resume' : '--session-id', input.sessionId.toLowerCase());
	if (input.model !== undefined) argv.push('--model', input.model);
	if (input.jsonSchema !== undefined) argv.push('--json-schema', JSON.stringify(input.jsonSchema));
	return argv;
}

export const EXECUTION_RESULT_SCHEMA = {
	type: 'object',
	properties: {
		status: { type: 'string', enum: ['completed', 'waiting-user'] },
		summary: { type: 'string', minLength: 1 },
	},
	required: ['status', 'summary'],
	additionalProperties: false,
} as const;

export function buildClaudeCliArgv(input: ClaudeInvocation): string[] {
	const argv = [
		...input.command,
		'--print',
		'--input-format',
		'stream-json',
		'--output-format',
		'stream-json',
		'--verbose',
		'--permission-mode',
		input.permissionMode,
	];
	argv.push(input.resume ? '--resume' : '--session-id', input.sessionId.toLowerCase());
	if (input.model !== undefined) argv.push('--model', input.model);
	if (input.jsonSchema !== undefined) {
		argv.push('--json-schema', JSON.stringify(input.jsonSchema));
	}
	return argv;
}

function defaultLoadIssue(cwd: string, issueId: string): string {
	const issue = getIssueOnMain(cwd, issueId, spawnSync, RUNTIME_SOURCE_REF);
	if (!issue.ok) throw new Error(`issue not found on ${RUNTIME_SOURCE_REF}: ${issueId}`);
	return issue.content;
}

export function buildWorkPrompt(
	issueId: string,
	issue: string,
	resume: boolean,
	reviewFeedback: string | undefined,
	operatorGuidance: string | undefined,
): string {
	// The single automatic fix round carries the reviewer's findings verbatim:
	// the reviewer is a separate session, so nothing else puts them in context.
	const reviewSection = reviewFeedback === undefined ? [] : [
		'',
		'An independent read-only review of your change reported findings.',
		'Fix exactly these findings and nothing else; do not widen the change.',
		'',
		'Review findings:',
		reviewFeedback,
	];
	const guidanceSection = operatorGuidance === undefined ? [] : [
		'',
		'The operator answered your previous request. Treat this as the decision for the current turn:',
		operatorGuidance,
	];
	return [
		resume
			? `Continue the existing Gateship work session for ${issueId}.`
			: `Implement Gateship issue ${issueId}.`,
		'Inspect the current working tree before editing and keep the change limited to this issue.',
		'Do not commit, push, merge, ship, or edit issue/runtime control state; the Gateship service owns lifecycle.',
		'Run focused tests for the changed surface. The service will perform independent verification afterward.',
		'Return status completed when the issue work is ready for verification.',
		'Return status waiting-user only when a concrete operator decision is required; summarize the exact question and options.',
		...guidanceSection,
		...reviewSection,
		'',
		'Issue record:',
		issue,
	].join('\n');
}

export function parseExecutionResult(
	structuredOutput: unknown,
): RuntimeExecutionResult {
	if (structuredOutput === null || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)) {
		throw new Error('executor did not return structured run status');
	}
	const result = structuredOutput as Record<string, unknown>;
	const status = result['status'];
	const summary = result['summary'];
	if ((status !== 'completed' && status !== 'waiting-user')
		|| typeof summary !== 'string'
		|| summary.trim().length === 0) {
		throw new Error('executor returned an invalid structured run status');
	}
	return { outcome: status, summary: summary.trim() };
}

export class ClaudeAgentSession implements AgentSession {
	readonly provider = 'claude' as const;
	readonly #options: Omit<ClaudeCliExecutorOptions, 'loadIssue' | 'session'>;

	constructor(options: Omit<ClaudeCliExecutorOptions, 'loadIssue' | 'session'> = {}) {
		this.#options = options;
	}

	async run(input: AgentSessionInput): Promise<AgentSessionResult> {
		const invocation = {
			command: this.#options.command ?? ['claude'],
			sessionId: input.sessionId,
			resume: input.resume,
			permissionMode: this.#options.permissionMode ?? 'bypassPermissions',
			...(this.#options.model === undefined ? {} : { model: this.#options.model }),
			...(input.outputSchema === undefined ? {} : { jsonSchema: input.outputSchema }),
		};
		const argv = input.access === 'read-only'
			? buildClaudeReadOnlyArgv(invocation)
			: buildClaudeCliArgv(invocation);
		return runClaudeCli({
			argv,
			cwd: input.cwd,
			env: buildClaudeEnv(this.#options.sourceEnv ?? process.env),
			prompt: input.prompt,
			signal: input.signal,
			emit: input.emit,
			eventPrefix: input.eventPrefix,
			...(this.#options.terminationGraceMs === undefined
				? {}
				: { terminationGraceMs: this.#options.terminationGraceMs }),
			...(this.#options.onSpawn === undefined ? {} : { onSpawn: this.#options.onSpawn }),
		});
	}
}

export class ClaudeCliExecutor implements RuntimeExecutor {
	readonly #options: ClaudeCliExecutorOptions;
	readonly #session: AgentSession;

	constructor(options: ClaudeCliExecutorOptions = {}) {
		this.#options = options;
		this.#session = options.session ?? new ClaudeAgentSession(options);
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
