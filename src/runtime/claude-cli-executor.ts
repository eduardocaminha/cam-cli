import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { getIssueOnMain } from '../commands/issue-get.ts';
import {
	type AgentSession,
	type AgentSessionInput,
	type AgentSessionResult,
	ProviderCallError,
} from './agent-session.ts';
import { buildClaudeEnv, runClaudeCli } from './claude-cli-process.ts';
import {
	claudeModelArgv,
	emitModelSelection,
	MODEL_PROBE_PROMPT,
	MODEL_PROBE_TIMEOUT_MS,
	type ModelProbeResult,
	type ModelSlot,
	type ModelSlotResolver,
	resolveModelSlot,
} from './model-settings.ts';
import { formatOperatorDecisionList } from './operator-decision.ts';
import { OPERATOR_LANGUAGE_CONTRACT } from './operator-language.ts';
import { normalizeProposalDrafts, PROPOSAL_LIMITS } from './run-proposal.ts';
import type {
	RuntimeExecutionInput,
	RuntimeExecutionResult,
	RuntimeExecutor,
	RuntimeExecutorHandoff,
} from './run-runtime.ts';
import { RUNTIME_SOURCE_REF } from './source-ref.ts';

export interface ClaudeCliExecutorOptions {
	session?: AgentSession;
	command?: string[];
	model?: string;
	effort?: string;
	/** Asked at every spawn, so the operator's choice needs no restart. */
	resolveModel?: ModelSlotResolver;
	permissionMode?: string;
	sourceEnv?: Record<string, string | undefined>;
	/**
	 * The dedicated Claude subscription token (GSHIP-704), resolved fresh at
	 * every spawn -- the same "consulted per spawn, never at construction"
	 * rule `resolveModel` already follows, so connecting, rotating or
	 * disconnecting the credential in Settings needs no service restart.
	 * Absent means no dedicated credential is configured; the existing
	 * external login fallback keeps deciding, exactly as before this issue.
	 */
	resolveClaudeCredential?: () => string | undefined;
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
	effort?: string;
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
		// No inherited customization; auth, model, built-in tools and permissions
		// keep working. Adds to the flags below, never replaces them.
		'--safe-mode',
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
	argv.push(...claudeModelArgv(input));
	if (input.jsonSchema !== undefined) argv.push('--json-schema', JSON.stringify(input.jsonSchema));
	return argv;
}

export const EXECUTION_RESULT_SCHEMA = {
	type: 'object',
	properties: {
		status: { type: 'string', enum: ['completed', 'waiting-user'] },
		summary: { type: 'string', minLength: 1 },
		// Always present so the executor answers the question every time, even
		// when the honest answer is that nothing outside the issue came up.
		proposals: {
			type: 'array',
			maxItems: PROPOSAL_LIMITS.maxItems,
			items: {
				type: 'object',
				properties: {
					title: { type: 'string', minLength: 1, maxLength: PROPOSAL_LIMITS.title },
					evidence: { type: 'string', minLength: 1, maxLength: PROPOSAL_LIMITS.evidence },
				},
				required: ['title', 'evidence'],
				additionalProperties: false,
			},
		},
	},
	required: ['status', 'summary', 'proposals'],
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
		'--safe-mode',
		'--permission-mode',
		input.permissionMode,
	];
	argv.push(input.resume ? '--resume' : '--session-id', input.sessionId.toLowerCase());
	argv.push(...claudeModelArgv(input));
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
	decisions: readonly string[] = [],
	// Appended last, defaulted, so every existing positional call site keeps
	// working unchanged: only the two executors that actually reach the
	// full-verify gate (GSHIP-649) pass it.
	fullVerifyFeedback: string | undefined = undefined,
	ciFeedback: string | undefined = undefined,
	/** Present only on the one turn opening the alternate's new session (GSHIP-722). */
	handoff: RuntimeExecutorHandoff | undefined = undefined,
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
	// The full-project verification's own single automatic fix round
	// (GSHIP-649): a rejection here is the project's whole manifest, not the
	// reviewer, so it gets its own section instead of overloading reviewSection.
	const fullVerifySection = fullVerifyFeedback === undefined ? [] : [
		'',
		"The project's full verification (its `verify` script) failed after your change.",
		'Fix exactly this failure and nothing else; do not widen the change.',
		'',
		'Full verification output:',
		fullVerifyFeedback,
	];
	// The evidence the runtime persists is durable and role-neutral: PR, head,
	// check name and check URL. How to turn it into a diagnosis is
	// role-specific, so it lives here, in the executors' prompt, and not in the
	// shared evidence the read-only reviewer also receives (GSHIP-720).
	const ciSection = ciFeedback === undefined ? [] : [
		'',
		'A required CI check failed on the current pull request head.',
		'Fix only this mechanical CI failure in the current worktree. Do not commit, open another issue, branch, or pull request.',
		'The original issue specification remains binding and the current diff is the change being corrected.',
		'If the diagnosis requires the failed output, read it ephemerally from this worktree with `gh run view <check-url> --log-failed`, using the Check URL below.',
		'Do not copy log output into run events, summaries, proposals, metrics or any operator-visible field; keep it in this session only.',
		'',
		'CI failure evidence:',
		ciFeedback,
	];
	// A handoff (GSHIP-722) opens a brand new native session with no memory of
	// the primary provider's own reasoning: the current diff and status stand
	// in for it, so the alternative continues the change instead of restarting
	// it or waiting to be told what already happened.
	const handoffSection = handoff === undefined ? [] : [
		'',
		`This work transferred to you from ${handoff.fromProvider} after it reported ${handoff.reason}.`,
		'You are a new session with no memory of that provider\'s own reasoning. Inspect the current',
		'working tree state below and continue the issue from there; do not restart the implementation',
		'from scratch and do not wait for further instructions before continuing it.',
		'',
		'Working tree status at handoff:',
		handoff.status.length === 0 ? '(clean)' : handoff.status,
		'',
		'Diff against HEAD at handoff:',
		handoff.diff.trim().length === 0 ? '(empty)' : handoff.diff,
	];
	const guidanceSection = operatorGuidance === undefined ? [] : [
		'',
		'The operator answered your previous request. Treat this as the decision for the current turn:',
		operatorGuidance,
	];
	// Same source and ordering the reviewer's prompt carries (GSHIP-630): this
	// run's own `run.operator-guidance` events, chronological. An empty list
	// leaves the prompt exactly as it was before this issue -- every run's
	// first turn has none. Kept ahead of `guidanceSection` so the latest
	// answer still reads as the current turn's request, not as one more item
	// in the history above it.
	const decisionsSection = decisions.length === 0 ? [] : [
		'',
		'Decisions the operator has already made in this run, oldest first. These are binding, not suggestions:',
		...formatOperatorDecisionList(decisions),
	];
	return [
		resume
			? `Continue the existing Gateship work session for ${issueId}.`
			: handoff === undefined
				? `Implement Gateship issue ${issueId}.`
				: `Take over execution of Gateship issue ${issueId} in a new session.`,
		'Inspect the current working tree before editing and keep the change limited to this issue.',
		'Do not commit, push, merge, ship, or edit issue/runtime control state; the Gateship service owns lifecycle.',
		"Run only the smallest relevant checks while editing, then run the human-approved issue verification command once before completion; do not add `bun run check:all`, the full test suite, or other broad gates unless that exact command is already in the human-approved verification, because the service runs the project's `verify` script once after a clean review at the ship boundary.",
		'Return status completed when the issue work is ready for verification.',
		'Return status waiting-user only when a concrete operator decision is required; summarize the exact question and options.',
		'Keep this issue closed to its scope: work you discover outside it is not part of this run and must not be implemented here.',
		`Report such work in proposals instead, at most ${PROPOSAL_LIMITS.maxItems} items, each with a short title and the concrete evidence you saw while implementing. Return an empty array when nothing outside the scope came up.`,
		...handoffSection,
		...decisionsSection,
		...guidanceSection,
		...reviewSection,
		...fullVerifySection,
		...ciSection,
		'',
		// GSHIP-708: the contract names the Issue record as the source of the
		// operator's language, so it sits directly above it. Kept below the
		// variable sections -- review findings, a failed verify log, operator
		// guidance -- so no turn shape can push the two apart.
		...OPERATOR_LANGUAGE_CONTRACT,
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
	// A paused turn reports a question, not a finding: only a completed result
	// carries ideas worth keeping.
	if (status === 'waiting-user') return { outcome: status, summary: summary.trim() };
	return {
		outcome: status,
		summary: summary.trim(),
		proposals: normalizeProposalDrafts(result['proposals']),
	};
}

export class ClaudeAgentSession implements AgentSession {
	readonly provider = 'claude' as const;
	readonly #options: Omit<ClaudeCliExecutorOptions, 'loadIssue' | 'session'>;

	constructor(options: Omit<ClaudeCliExecutorOptions, 'loadIssue' | 'session'> = {}) {
		this.#options = options;
	}

	async run(input: AgentSessionInput): Promise<AgentSessionResult> {
		const slot = resolveModelSlot(this.#options);
		const invocation = {
			command: this.#options.command ?? ['claude'],
			sessionId: input.sessionId,
			resume: input.resume,
			permissionMode: this.#options.permissionMode ?? 'bypassPermissions',
			...slot,
			...(input.outputSchema === undefined ? {} : { jsonSchema: input.outputSchema }),
		};
		const argv = input.access === 'read-only'
			? buildClaudeReadOnlyArgv(invocation)
			: buildClaudeCliArgv(invocation);
		emitModelSelection(input.emit, input.eventPrefix, slot);
		return runClaudeCli({
			argv,
			cwd: input.cwd,
			env: buildClaudeEnv(this.#options.sourceEnv ?? process.env, this.#options.resolveClaudeCredential?.()),
			prompt: input.prompt,
			signal: input.signal,
			emit: input.emit,
			eventPrefix: input.eventPrefix,
			slot,
			...(this.#options.terminationGraceMs === undefined
				? {}
				: { terminationGraceMs: this.#options.terminationGraceMs }),
			...(this.#options.onSpawn === undefined ? {} : { onSpawn: this.#options.onSpawn }),
		});
	}
}

export interface ClaudeModelProbeOptions {
	command?: string[];
	sourceEnv?: Record<string, string | undefined>;
	timeoutMs?: number;
	/**
	 * The dedicated Claude subscription token (GSHIP-704): this probe is a
	 * fifth Gateship-owned Claude spawn, alongside the status probe,
	 * orchestrator, executor and reviewer, so a model/effort choice is
	 * validated against the same identity a real run would actually use --
	 * never silently falling back to ambient external login when only a
	 * dedicated credential is configured.
	 */
	resolveClaudeCredential?: () => string | undefined;
}

/**
 * Spawns Claude read-only with the chosen model and effort and a trivial
 * prompt, so an invalid choice is caught at save time instead of at the next
 * real run. Reuses the same read-only argv the orchestrator's own inspection
 * turns use, with --model/--effort added when the slot carries them.
 */
export async function probeClaudeModel(
	slot: ModelSlot,
	cwd: string,
	options: ClaudeModelProbeOptions = {},
): Promise<ModelProbeResult> {
	const session = new ClaudeAgentSession({
		command: options.command,
		model: slot.model,
		effort: slot.effort,
		sourceEnv: options.sourceEnv,
		resolveClaudeCredential: options.resolveClaudeCredential,
	});
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? MODEL_PROBE_TIMEOUT_MS,
	);
	try {
		await session.run({
			sessionId: randomUUID(),
			resume: false,
			cwd,
			prompt: MODEL_PROBE_PROMPT,
			access: 'read-only',
			signal: controller.signal,
			emit: () => {},
			eventPrefix: 'model-probe',
		});
		return { outcome: 'accepted' };
	} catch (error) {
		if (error instanceof ProviderCallError && error.kind === 'model-refused') {
			return { outcome: 'refused', message: error.message };
		}
		return {
			outcome: 'inconclusive',
			message: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
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
			input.operatorDecisions ?? [],
			input.fullVerifyFeedback,
			input.ciFeedback,
			input.executorHandoff,
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
