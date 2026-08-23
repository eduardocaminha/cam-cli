// src/runtime/claude-cli-reviewer.ts
//
// The independent reviewer role: a headless Claude CLI child that judges the
// change a run produced, and cannot touch it.
//
// Independence is a session property. Every review gets a brand new
// `--session-id`; `--resume` is never passed, so no reviewer inherits the
// implementer's context and its own reasoning about why the change is correct.
//
// Read-only is a capability property, not a prompt instruction, and an
// allowlist alone does NOT deliver it. Measured on 2026-08-15 against the
// installed CLI (2.1.233) by reading the `system/init` event of a real child:
// with only `--allowedTools Read,Grep,Glob --disallowedTools Bash,Edit,Write,
// NotebookEdit,Agent`, the child still reported 105 tools, 5 inherited MCP
// servers and 153 slash commands -- including Workflow, Skill, ToolSearch,
// RemoteTrigger and write-capable MCP tools such as Supabase apply_migration
// and Google Drive create_file. `--allowedTools` only PREAPPROVES; it never
// removes anything from the surface.
//
// Each of the three surfaces is therefore closed by the flag that owns it:
//   * `--tools Read,Grep,Glob` restricts the BUILT-IN set (`claude --help`:
//     "the list of available tools from the built-in set").
//   * `--strict-mcp-config` plus an empty `--mcp-config` drops every inherited
//     MCP server, which `--tools` does not govern.
//   * `--disable-slash-commands` drops the skills surface.
// `--permission-mode dontAsk` then denies anything outside the allow rules
// instead of prompting, so a locked-down `--print` run cannot stall or
// escalate, and `--disallowedTools` stays as a hard deny backstop.
// The same measurement over the resulting argv reports exactly
// ["Glob","Grep","Read"], zero MCP servers and zero slash commands.
//
// `--safe-mode` adds a fourth guard on every headless session: all inherited
// customization off, auth and permissions untouched. Same measurement on
// 2026-08-16 (CLI 2.1.233) still reports ["Glob","Grep","Read"], zero MCP
// servers and zero slash commands, with the child authenticated.
//
// The reviewer therefore cannot run `git diff` itself: the service collects
// the change with its own git seam and passes it in the prompt.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { getIssueOnMain } from '../commands/issue-get.ts';
import { buildClaudeEnv, runClaudeCli } from './claude-cli-process.ts';
import { defaultRunGit, type GitCommandRunner } from './git-runtime.ts';
import {
	claudeModelArgv,
	emitModelSelection,
	type ModelSlotResolver,
	resolveModelSlot,
} from './model-settings.ts';
import { formatOperatorDecisionList } from './operator-decision.ts';
import { OPERATOR_LANGUAGE_CONTRACT } from './operator-language.ts';
import type {
	RuntimeExecutionInput,
	RuntimeReviewer,
	RuntimeReviewResult,
} from './run-runtime.ts';
import { RUNTIME_SOURCE_REF } from './source-ref.ts';

/** The reviewer's whole capability surface: restricts `--tools`, preapproves `--allowedTools`. */
export const REVIEWER_TOOLS = 'Read,Grep,Glob';
/** Hard-deny backstop, by bare name, on top of the restricted surface. */
export const REVIEWER_DISALLOWED_TOOLS = 'Bash,Edit,Write,NotebookEdit,Agent';
/** Deny anything outside the allowlist rather than prompt for it. */
export const REVIEWER_PERMISSION_MODE = 'dontAsk';
/** No MCP server at all, paired with `--strict-mcp-config` to drop inherited ones. */
export const REVIEWER_MCP_CONFIG = '{"mcpServers":{}}';

const DIFF_LIMIT = 60_000;

/**
 * What separates CLEAN from FINDINGS, for both providers.
 *
 * GSHIP-714: GSHIP-712 was reviewed as FINDINGS over a stale comment inside a
 * test -- no executable or observable effect -- which resumed the Opus
 * executor and paid for a second full review. The old wording ruled out only
 * "style preference and speculation", so any true-but-immaterial remark still
 * qualified as "a defect you can point at in a specific file". CLEAN is now
 * defined as the absence of a material defect, not the absence of every
 * possible improvement, and the material axes are named. Comments and docs
 * stay in scope exactly when they are public, contractual, operational, or
 * able to mislead execution or verification.
 *
 * It is a prompt contract, not a filter: no severity field, no score, no
 * post-hoc pruning of what the reviewer returned.
 */
export const REVIEW_MATERIALITY_CONTRACT = [
	'Judge only whether the change is correct and limited to the issue.',
	'CLEAN means the change carries no material defect. It does not mean the',
	'change is beyond every possible improvement: a change you would have',
	'written differently, but that is correct, is CLEAN.',
	'Report a finding only for a concrete defect you can point at in a specific',
	'file, and only when it can alter executable behaviour, security, data',
	'integrity, the approved contract, the validity of the verification, a',
	'public interface, or the information the operator can observe. Work',
	'outside the issue is such a defect.',
	'Omit style preferences, optional refactors, naming, stale internal',
	'comments, internal prose and requests for extra tests when they do not',
	'reveal a real gap in behaviour. Comments and documentation stay material',
	'when they are public, contractual, used to operate the system, or able to',
	'induce incorrect execution or verification.',
	'Speculation is not a finding.',
] as const;

export interface ClaudeCliReviewerOptions {
	command?: string[];
	model?: string;
	effort?: string;
	/** Asked at every review, so the operator's choice needs no restart. */
	resolveModel?: ModelSlotResolver;
	sourceEnv?: Record<string, string | undefined>;
	/** The dedicated Claude subscription token (GSHIP-704); see `ClaudeCliExecutorOptions` for the precedence and per-spawn resolution this mirrors. */
	resolveClaudeCredential?: () => string | undefined;
	terminationGraceMs?: number;
	loadIssue?: (cwd: string, issueId: string) => string;
	runGit?: GitCommandRunner;
	newSessionId?: () => string;
	onSpawn?: (pid: number) => void;
}

interface ReviewerInvocation {
	command: string[];
	sessionId: string;
	model?: string;
	effort?: string;
	jsonSchema?: Record<string, unknown>;
}

/** Argv for one review. Never carries `--resume`: each review is a new session. */
export function buildReviewerCliArgv(input: ReviewerInvocation): string[] {
	const argv = [
		...input.command,
		'--print',
		'--input-format',
		'stream-json',
		'--output-format',
		'stream-json',
		'--verbose',
		// Adds to the three surface-closing flags below, never replaces them.
		'--safe-mode',
		'--permission-mode',
		REVIEWER_PERMISSION_MODE,
		// Every variadic option below is followed by another flag, never by a
		// positional, so none of them swallows the next argument.
		'--tools',
		REVIEWER_TOOLS,
		'--allowedTools',
		REVIEWER_TOOLS,
		'--disallowedTools',
		REVIEWER_DISALLOWED_TOOLS,
		'--disable-slash-commands',
		'--strict-mcp-config',
		'--mcp-config',
		REVIEWER_MCP_CONFIG,
		'--session-id',
		input.sessionId.toLowerCase(),
	];
	argv.push(...claudeModelArgv(input));
	// Same mechanism the executor already uses: the CLI answers through the
	// dedicated structured-output channel instead of the reviewer having to
	// append a JSON object to its own prose, which is what let a JSON example
	// from the review's own prose stand in for a missing verdict.
	if (input.jsonSchema !== undefined) argv.push('--json-schema', JSON.stringify(input.jsonSchema));
	return argv;
}

function defaultLoadIssue(cwd: string, issueId: string): string {
	const issue = getIssueOnMain(cwd, issueId, spawnSync, RUNTIME_SOURCE_REF);
	if (!issue.ok) throw new Error(`issue not found on ${RUNTIME_SOURCE_REF}: ${issueId}`);
	return issue.content;
}

export function collectChange(runGit: GitCommandRunner, cwd: string): { status: string; diff: string } {
	const status = runGit(cwd, ['status', '--porcelain', '--untracked-files=all']);
	const diff = runGit(cwd, ['diff', 'HEAD']);
	const diffText = diff.exitCode === 0 ? diff.stdout : `(git diff failed: ${diff.stderr.trim()})`;
	return {
		status: status.exitCode === 0 ? status.stdout.trim() : `(git status failed: ${status.stderr.trim()})`,
		diff: diffText.length > DIFF_LIMIT
			? `${diffText.slice(0, DIFF_LIMIT)}\n(diff truncated at ${DIFF_LIMIT} characters)`
			: diffText,
	};
}

/**
 * `decisions` are this run's own `run.operator-guidance` events, already
 * selected and chronologically ordered by `selectOperatorDecisions`
 * (GSHIP-630). An empty list leaves the prompt exactly as it was before this
 * issue -- every first review of a run has none.
 */
export function buildReviewPrompt(
	issueId: string,
	issue: string,
	change: { status: string; diff: string },
	decisions: readonly string[],
): string {
	return [
		`Review the uncommitted change in this worktree for Gateship issue ${issueId}.`,
		'You are an independent reviewer. You have Read, Grep and Glob only, by design:',
		'you cannot edit files, run commands or delegate, and you must not try.',
		'Read the files around the diff before judging. Entries marked ?? in the',
		'status below are new files that the diff does not contain; open them with Read.',
		'',
		...REVIEW_MATERIALITY_CONTRACT,
		'',
		...(decisions.length === 0 ? [] : [
			'Decisions the operator has already made for this run, oldest first:',
			...formatOperatorDecisionList(decisions),
			'',
			'You may disagree with one of these. If you do, say so explicitly: report',
			'that you disagree with a decision already made, not as a pending defect',
			'the change still needs to fix.',
			'',
		]),
		'End your reply with a single JSON object on the last line and nothing after it:',
		'{"verdict":"CLEAN","findings":[]}',
		'or',
		'{"verdict":"FINDINGS","findings":[{"file":"path/to/file.ts","summary":"what is wrong and why it matters"}]}',
		'',
		// GSHIP-708: between the verdict format and the Issue record, so the
		// contract sits next to both the expected output and the record whose
		// natural language it names as the operator's language.
		...OPERATOR_LANGUAGE_CONTRACT,
		'',
		'Issue record:',
		issue,
		'',
		'Working tree status:',
		change.status.length === 0 ? '(clean)' : change.status,
		'',
		'Diff against HEAD:',
		change.diff.trim().length === 0 ? '(empty)' : change.diff,
	].join('\n');
}

export const REVIEW_RESULT_SCHEMA = {
	type: 'object',
	properties: {
		verdict: { type: 'string', enum: ['CLEAN', 'FINDINGS'] },
		findings: {
			type: 'array',
			items: {
				type: 'object',
				properties: { file: { type: 'string' }, summary: { type: 'string' } },
				required: ['file', 'summary'],
				additionalProperties: false,
			},
		},
	},
	required: ['verdict', 'findings'],
	additionalProperties: false,
} as const;

function formatFindings(findings: unknown[]): string {
	return findings
		.map((finding, index) => {
			const record = finding !== null && typeof finding === 'object'
				? finding as Record<string, unknown>
				: {};
			const file = typeof record['file'] === 'string' ? record['file'] : 'unknown file';
			const summary = typeof record['summary'] === 'string'
				? record['summary']
				: JSON.stringify(finding);
			return `${index + 1}. ${file}: ${summary}`;
		})
		.join('\n');
}

/**
 * Turn the reviewer's structured output into a verdict, or throw. Never falls
 * back to scanning the reviewer's prose for a parseable object: that rescue
 * is what let a JSON example from the review's own prose stand in for a
 * verdict the reviewer never actually returned.
 */
export function parseReviewVerdict(structuredOutput: unknown, text: string): RuntimeReviewResult {
	if (structuredOutput === null || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)) {
		throw new Error(`reviewer did not return a structured verdict: ${text.trim().slice(-500)}`);
	}
	const parsed = structuredOutput as Record<string, unknown>;
	const verdict = parsed['verdict'];
	if (verdict === 'CLEAN') return { verdict: 'clean' };
	if (verdict !== 'FINDINGS') {
		throw new Error(`reviewer returned an unknown verdict: ${JSON.stringify(verdict)}`);
	}
	const findings = Array.isArray(parsed['findings']) ? parsed['findings'] : [];
	if (findings.length === 0) {
		throw new Error('reviewer reported FINDINGS without listing any finding');
	}
	return { verdict: 'findings', detail: formatFindings(findings) };
}

export class ClaudeCliReviewer implements RuntimeReviewer {
	readonly #options: ClaudeCliReviewerOptions;

	constructor(options: ClaudeCliReviewerOptions = {}) {
		this.#options = options;
	}

	async review(input: RuntimeExecutionInput): Promise<RuntimeReviewResult> {
		const issue = (this.#options.loadIssue ?? defaultLoadIssue)(input.cwd, input.issueId);
		const change = collectChange(this.#options.runGit ?? defaultRunGit, input.cwd);
		const slot = resolveModelSlot(this.#options);
		const argv = buildReviewerCliArgv({
			command: this.#options.command ?? ['claude'],
			sessionId: (this.#options.newSessionId ?? randomUUID)(),
			jsonSchema: REVIEW_RESULT_SCHEMA,
			...slot,
		});
		emitModelSelection(input.emit, 'review', slot);
		const result = await runClaudeCli({
			argv,
			cwd: input.cwd,
			env: buildClaudeEnv(this.#options.sourceEnv ?? process.env, this.#options.resolveClaudeCredential?.()),
			prompt: buildReviewPrompt(input.issueId, issue, change, input.operatorDecisions ?? []),
			signal: input.signal,
			emit: input.emit,
			eventPrefix: 'review',
			slot,
			...(this.#options.terminationGraceMs === undefined
				? {}
				: { terminationGraceMs: this.#options.terminationGraceMs }),
			...(this.#options.onSpawn === undefined ? {} : { onSpawn: this.#options.onSpawn }),
		});
		return parseReviewVerdict(result.structuredOutput, result.summary);
	}
}
