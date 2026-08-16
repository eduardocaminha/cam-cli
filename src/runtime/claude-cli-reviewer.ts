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
// The reviewer therefore cannot run `git diff` itself: the service collects
// the change with its own git seam and passes it in the prompt.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { getIssueOnMain } from '../commands/issue-get.ts';
import { buildClaudeEnv, runClaudeCli } from './claude-cli-process.ts';
import { defaultRunGit, type GitCommandRunner } from './git-runtime.ts';
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

export interface ClaudeCliReviewerOptions {
	command?: string[];
	model?: string;
	sourceEnv?: Record<string, string | undefined>;
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
	if (input.model !== undefined) argv.push('--model', input.model);
	return argv;
}

function defaultLoadIssue(cwd: string, issueId: string): string {
	const issue = getIssueOnMain(cwd, issueId, spawnSync, RUNTIME_SOURCE_REF);
	if (!issue.ok) throw new Error(`issue not found on ${RUNTIME_SOURCE_REF}: ${issueId}`);
	return issue.content;
}

function collectChange(runGit: GitCommandRunner, cwd: string): { status: string; diff: string } {
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

function buildReviewPrompt(
	issueId: string,
	issue: string,
	change: { status: string; diff: string },
): string {
	return [
		`Review the uncommitted change in this worktree for Gateship issue ${issueId}.`,
		'You are an independent reviewer. You have Read, Grep and Glob only, by design:',
		'you cannot edit files, run commands or delegate, and you must not try.',
		'Read the files around the diff before judging. Entries marked ?? in the',
		'status below are new files that the diff does not contain; open them with Read.',
		'',
		'Judge only whether the change is correct and limited to the issue.',
		'Report a finding only for a defect you can point at in a specific file:',
		'a real bug, a broken contract, or work outside the issue. Style preference',
		'and speculation are not findings.',
		'',
		'End your reply with a single JSON object on the last line and nothing after it:',
		'{"verdict":"CLEAN","findings":[]}',
		'or',
		'{"verdict":"FINDINGS","findings":[{"file":"path/to/file.ts","summary":"what is wrong and why it matters"}]}',
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

function parseJsonObject(text: string): Record<string, unknown> | null {
	const trimmed = text.trim().replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
	const whole = parseObjectCandidate(trimmed);
	if (whole !== null) return whole;

	// The verdict is the LAST object in the reply and may be preceded by prose.
	// Anchor on the final `}` and widen leftwards from the OUTERMOST `{`:
	// anchoring on the last `{` instead lands inside the nested findings array,
	// so a prose-prefixed FINDINGS reply would never parse and a valid review
	// would fail the run instead of buying its single fix round.
	const end = trimmed.lastIndexOf('}');
	for (
		let start = trimmed.indexOf('{');
		start >= 0 && start < end;
		start = trimmed.indexOf('{', start + 1)
	) {
		const candidate = parseObjectCandidate(trimmed.slice(start, end + 1));
		if (candidate !== null) return candidate;
	}
	return null;
}

function parseObjectCandidate(text: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Not a JSON object; the caller tries the next candidate.
	}
	return null;
}

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

/** Turn the reviewer's final text into a structured verdict, or throw. */
export function parseReviewVerdict(text: string): RuntimeReviewResult {
	const parsed = parseJsonObject(text);
	if (parsed === null) {
		throw new Error(`reviewer did not return a JSON verdict: ${text.trim().slice(-500)}`);
	}
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
		const argv = buildReviewerCliArgv({
			command: this.#options.command ?? ['claude'],
			sessionId: (this.#options.newSessionId ?? randomUUID)(),
			...(this.#options.model === undefined ? {} : { model: this.#options.model }),
		});
		const result = await runClaudeCli({
			argv,
			cwd: input.cwd,
			env: buildClaudeEnv(this.#options.sourceEnv ?? process.env),
			prompt: buildReviewPrompt(input.issueId, issue, change),
			signal: input.signal,
			emit: input.emit,
			eventPrefix: 'review',
			...(this.#options.terminationGraceMs === undefined
				? {}
				: { terminationGraceMs: this.#options.terminationGraceMs }),
			...(this.#options.onSpawn === undefined ? {} : { onSpawn: this.#options.onSpawn }),
		});
		return parseReviewVerdict(result.summary);
	}
}
