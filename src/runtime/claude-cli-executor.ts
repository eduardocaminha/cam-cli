import process from 'node:process';

import { getIssueOnMain } from '../commands/issue-get.ts';
import { buildClaudeEnv, runClaudeCli } from './claude-cli-process.ts';
import type {
	RuntimeExecutionInput,
	RuntimeExecutionResult,
	RuntimeExecutor,
} from './run-runtime.ts';

export interface ClaudeCliExecutorOptions {
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
}

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
	return argv;
}

function defaultLoadIssue(cwd: string, issueId: string): string {
	const issue = getIssueOnMain(cwd, issueId);
	if (!issue.ok) throw new Error(`issue not found on main: ${issueId}`);
	return issue.content;
}

function buildWorkPrompt(
	issueId: string,
	issue: string,
	resume: boolean,
	reviewFeedback: string | undefined,
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
	return [
		resume
			? `Continue the existing Gateship work session for ${issueId}.`
			: `Implement Gateship issue ${issueId}.`,
		'Inspect the current working tree before editing and keep the change limited to this issue.',
		'Do not commit, push, merge, ship, or edit issue/runtime control state; the Gateship service owns lifecycle.',
		'Run focused tests for the changed surface. The service will perform independent verification afterward.',
		'If a user decision is required, stop editing and explain the exact decision in your final result.',
		...reviewSection,
		'',
		'Issue record:',
		issue,
	].join('\n');
}

export class ClaudeCliExecutor implements RuntimeExecutor {
	readonly #options: ClaudeCliExecutorOptions;

	constructor(options: ClaudeCliExecutorOptions = {}) {
		this.#options = options;
	}

	async execute(input: RuntimeExecutionInput): Promise<RuntimeExecutionResult> {
		const issue = (this.#options.loadIssue ?? defaultLoadIssue)(input.cwd, input.issueId);
		const prompt = buildWorkPrompt(input.issueId, issue, input.resume, input.reviewFeedback);
		const argv = buildClaudeCliArgv({
			command: this.#options.command ?? ['claude'],
			sessionId: input.sessionId,
			resume: input.resume,
			permissionMode: this.#options.permissionMode ?? 'bypassPermissions',
			...(this.#options.model === undefined ? {} : { model: this.#options.model }),
		});
		const summary = await runClaudeCli({
			argv,
			cwd: input.cwd,
			env: buildClaudeEnv(this.#options.sourceEnv ?? process.env),
			prompt,
			signal: input.signal,
			emit: input.emit,
			eventPrefix: 'provider',
			...(this.#options.terminationGraceMs === undefined
				? {}
				: { terminationGraceMs: this.#options.terminationGraceMs }),
			...(this.#options.onSpawn === undefined ? {} : { onSpawn: this.#options.onSpawn }),
		});
		return { outcome: 'completed', ...(summary.length === 0 ? {} : { summary }) };
	}
}
