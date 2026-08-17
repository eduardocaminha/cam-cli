import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { getIssueOnMain } from '../commands/issue-get.ts';
import type { AgentSession } from './agent-session.ts';
import {
	buildReviewPrompt,
	collectChange,
	parseReviewVerdict,
	REVIEW_RESULT_SCHEMA,
} from './claude-cli-reviewer.ts';
import {
	CodexReviewSession,
	type CodexCliExecutorOptions,
} from './codex-cli-executor.ts';
import { defaultRunGit, type GitCommandRunner } from './git-runtime.ts';
import type { ModelSlotResolver } from './model-settings.ts';
import type {
	RuntimeExecutionInput,
	RuntimeReviewer,
	RuntimeReviewResult,
} from './run-runtime.ts';
import { RUNTIME_SOURCE_REF } from './source-ref.ts';

export interface CodexCliReviewerOptions {
	session?: AgentSession;
	command?: string[];
	model?: string;
	effort?: string;
	/** Asked at every review, so the operator's choice needs no restart. */
	resolveModel?: ModelSlotResolver;
	sourceEnv?: Record<string, string | undefined>;
	terminationGraceMs?: number;
	loadIssue?: (cwd: string, issueId: string) => string;
	runGit?: GitCommandRunner;
	onSpawn?: (pid: number) => void;
}

function defaultLoadIssue(cwd: string, issueId: string): string {
	const issue = getIssueOnMain(cwd, issueId, spawnSync, RUNTIME_SOURCE_REF);
	if (!issue.ok) throw new Error(`issue not found on ${RUNTIME_SOURCE_REF}: ${issueId}`);
	return issue.content;
}

function sessionOptions(options: CodexCliReviewerOptions): Omit<
	CodexCliExecutorOptions,
	'loadIssue' | 'session'
> {
	return {
		...(options.command === undefined ? {} : { command: options.command }),
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.effort === undefined ? {} : { effort: options.effort }),
		...(options.resolveModel === undefined ? {} : { resolveModel: options.resolveModel }),
		...(options.sourceEnv === undefined ? {} : { sourceEnv: options.sourceEnv }),
		...(options.terminationGraceMs === undefined
			? {}
			: { terminationGraceMs: options.terminationGraceMs }),
		...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
	};
}

export class CodexCliReviewer implements RuntimeReviewer {
	readonly #options: CodexCliReviewerOptions;
	readonly #session: AgentSession;

	constructor(options: CodexCliReviewerOptions = {}) {
		this.#options = options;
		this.#session = options.session ?? new CodexReviewSession(sessionOptions(options));
	}

	async review(input: RuntimeExecutionInput): Promise<RuntimeReviewResult> {
		const issue = (this.#options.loadIssue ?? defaultLoadIssue)(input.cwd, input.issueId);
		const change = collectChange(this.#options.runGit ?? defaultRunGit, input.cwd);
		const result = await this.#session.run({
			sessionId: randomUUID(),
			resume: false,
			cwd: input.cwd,
			prompt: buildReviewPrompt(input.issueId, issue, change),
			outputSchema: REVIEW_RESULT_SCHEMA,
			signal: input.signal,
			emit: input.emit,
			eventPrefix: 'review',
		});
		return parseReviewVerdict(result.structuredOutput, result.summary);
	}
}
