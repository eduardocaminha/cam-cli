// src/supervisor/backend-adapter.ts
//
// BackendAdapter seam (US-002/US-003, CAM-54/339). Design record: ADR-0047
// (docs/adr/0047-backendadapter-seam-methods-vs-inputs-vs-shared-contract-and-the-six-mismatch-resolution.md).
//
// ADR-0047 fixes the seam as ONE concrete adapter method:
//
//   buildSpawnArgv(actor, opts): string
//
// where `model`, `agentName`, `permissionMode`, and the env-unset prefix are
// INPUTS threaded through opts, not separate adapter methods. Completion
// detection (worker report / sentinel text parsing) is explicitly a SHARED
// CONTRACT that lives outside the adapter (see ADR-0038) and must never be
// added here.
//
// US-003 (CAM-339) inverts the US-002 direction: the real per-actor argv
// assembly (env-strip prefix, CAM_WORKER=1 marker, shell-escaping, agent/model
// defaults) now lives HERE, in ClaudeAdapter.buildSpawnArgv, instead of inside
// the four builder functions. buildImplementerWorkerArgv (worker-argv.ts),
// buildPlannerWorkerArgv / buildAuditorWorkerArgv (plan-argv.ts), and
// buildReviewerWorkerArgv (review.ts) are now thin wrappers that resolve their
// own actor and delegate to `new ClaudeAdapter().buildSpawnArgv(actor, opts)`.
// This module intentionally does NOT import from worker-argv.ts / plan-argv.ts
// / review.ts (those three import FROM here instead) so the dependency graph
// stays a one-way fan-out with no import cycle.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULTS } from '../config/models.ts';
import type { WorkerIsolation } from '../config/models.ts';
import { stripFrontmatter } from '../templates/frontmatter.ts';

/** The four worker actors in scope for the seam (ADR-0046/0047). */
export type WorkerActor = 'implementer' | 'planner' | 'auditor' | 'reviewer';

/**
 * Shared input shape for buildSpawnArgv, covering every value that varies
 * per call site across the four actors today. `taskPrompt` and
 * `permissionMode` are required for implementer/planner/auditor and optional
 * for reviewer (which has its own defaults, mirroring
 * ReviewerWorkerArgvOptions).
 */
export interface SpawnArgvOptions {
	/** UUID for this worker invocation; passed as --session-id. */
	uuid: string;
	/**
	 * Free-text task prompt sent to the agent. Will be shell-escaped.
	 * Required for implementer/planner/auditor; optional for reviewer
	 * (defaults to REVIEWER_TASK_PROMPT).
	 */
	taskPrompt?: string;
	/**
	 * Claude permission mode forwarded to the spawned process (NEVER a cam CLI
	 * flag). Required for implementer/planner/auditor; optional for reviewer
	 * (defaults to 'bypassPermissions').
	 */
	permissionMode?: string;
	/** Agent name matching the .claude/agents/<name>.md frontmatter. */
	agentName?: string;
	/** Model to pass as `--model` to the spawned process. */
	model?: string;
	/**
	 * Worker isolation mode (US-001, CAM-242): threads into the env-unset
	 * prefix so CLAUDE_CODE_OAUTH_TOKEN is stripped on 'host' only.
	 */
	isolation?: WorkerIsolation;
	/**
	 * Repo working directory to compute the reviewer branch diff from
	 * (US-001, CAM-354). Only consumed by CodexAdapter's 'reviewer' branch
	 * (see renderReviewerDiffBlock); every other actor/adapter ignores it, so
	 * threading it through the shared options shape is a no-op everywhere
	 * else -- ClaudeAdapter's rendered argv is unaffected. Defaults to
	 * `process.cwd()`. Exposed as an input (not a default baked into the
	 * adapter) purely so a test can point it at a throwaway fixture repo.
	 */
	cwd?: string;
}

/**
 * BackendAdapter: the seam between the supervisor and whatever CLI actually
 * gets spawned for a worker actor. Exposes exactly one concrete method
 * (ADR-0047): every per-actor/per-call-site variation is an INPUT to that
 * method, not a method of its own. Completion detection is deliberately
 * NOT part of this interface (shared contract, lives outside the adapter).
 */
export interface BackendAdapter {
	/**
	 * Build the shell string passed to `respawn-pane` to launch an
	 * interactive TUI worker for `actor`.
	 */
	buildSpawnArgv(actor: WorkerActor, opts: SpawnArgvOptions): string;
}

/**
 * Throws when a required field for the given actor is missing. Implementer,
 * planner, and auditor all require taskPrompt + permissionMode (their
 * existing builders take these as required fields); reviewer defaults both.
 */
function requireForNonReviewerActor(
	actor: 'implementer' | 'planner' | 'auditor',
	opts: SpawnArgvOptions,
): { taskPrompt: string; permissionMode: string } {
	if (opts.taskPrompt === undefined) {
		throw new Error(`buildSpawnArgv: taskPrompt is required for actor '${actor}'`);
	}
	if (opts.permissionMode === undefined) {
		throw new Error(`buildSpawnArgv: permissionMode is required for actor '${actor}'`);
	}
	return { taskPrompt: opts.taskPrompt, permissionMode: opts.permissionMode };
}

// ---------------------------------------------------------------------------
// Shared argv-assembly primitives (US-003, CAM-339: consolidated here from
// worker-argv.ts / plan-argv.ts / review.ts, which now re-export the ones
// they used to define, for call sites that still import them by that path).
// ---------------------------------------------------------------------------

/** Default agent name; matches .claude/agents/subagent-implementer.md. */
export const DEFAULT_IMPLEMENTER_AGENT = 'subagent-implementer';

/** Default planner agent name; matches .claude/agents/subagent-planner.md. */
export const DEFAULT_PLANNER_AGENT = 'subagent-planner';

/** Default auditor agent name; matches .claude/agents/subagent-auditor.md. */
export const DEFAULT_AUDITOR_AGENT = 'subagent-auditor';

/** Default agent name; matches .claude/agents/subagent-reviewer.md. */
export const DEFAULT_REVIEWER_AGENT = 'subagent-reviewer';

/**
 * Default task prompt for the interactive reviewer session (CAM-42 US-003).
 * The <review> tag on the very last line is the completion sentinel the
 * supervisor polls for.
 */
export const REVIEWER_TASK_PROMPT =
	'Review all changes on the current branch vs main per your AGENT.md. Run the project quality gates. End your output with the <review> verdict tag on the very last line.';

/**
 * Canonical list of environment variables stripped from a spawned worker so it
 * does not inherit the parent claude session's identity. `CLAUDECODE=1` is the
 * one documented nesting gate: when set, a freshly spawned `claude` detects
 * nesting and exits before its session initializes. The rest are set by the SDK
 * (session id, entrypoint, exec path, sse port, sdk version) and are stripped
 * defensively so no stale parent-session identity leaks into the worker. The
 * worker command removes these via `env -u` so a worker spawned from a tmux
 * server that was bootstrapped inside a claude session still boots (CAM-43).
 *
 * Deliberately does NOT include CLAUDE_CONFIG_DIR or PATH: the worker must keep
 * the same config dir (subscription auth lives there) and the same PATH (so the
 * `claude` / `cam` binaries resolve).
 */
export const WORKER_ENV_UNSET: readonly string[] = [
	'CLAUDECODE',
	'CLAUDE_CODE_ENTRYPOINT',
	'CLAUDE_CODE_SESSION_ID',
	'CLAUDE_CODE_SSE_PORT',
	'CLAUDE_CODE_EXECPATH',
	'CLAUDE_AGENT_SDK_VERSION',
];

/**
 * Env vars stripped ONLY from host-isolation workers (US-001, CAM-242). The
 * tmux `-L cam` server is bootstrapped by `cam run` with `.env` loaded, so
 * CLAUDE_CODE_OAUTH_TOKEN lives in the server process's OS env and every
 * respawn-pane worker inherits it, overriding the interactive config-dir
 * login (~/.claude-pessoal). Stripping it forces the worker to authenticate
 * via the config-dir login instead of pinning to a possibly rate-limited
 * token account. NOT stripped in container mode: container workers have no
 * logged-in config dir and rely on worker-container.ts injecting this exact
 * var via `-e CLAUDE_CODE_OAUTH_TOKEN` (see buildDockerRunArgv).
 */
export const HOST_ONLY_ENV_UNSET: readonly string[] = ['CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Render the `env -u VAR1 -u VAR2 ... ` prefix (with a trailing space) that
 * strips WORKER_ENV_UNSET (always) and, on 'host' isolation, HOST_ONLY_ENV_UNSET
 * (US-001, CAM-242) from a spawned worker. Prepended to every worker shell
 * string so the worker does not inherit nesting-detection env vars from the
 * tmux server (CAM-43), and, on host, so it does not inherit a possibly
 * rate-limited CLAUDE_CODE_OAUTH_TOKEN from the server's OS env. The `isolation`
 * argument is required (not defaulted) so every call site is explicit about
 * which mode it is building for; container callers must not silently strip the
 * token their worker actually needs. The var names are fixed identifiers, so
 * no escaping is needed.
 */
export function workerEnvPrefix(isolation: WorkerIsolation): string {
	const vars = isolation === 'host' ? [...WORKER_ENV_UNSET, ...HOST_ONLY_ENV_UNSET] : WORKER_ENV_UNSET;
	return `env ${vars.map((v) => `-u ${v}`).join(' ')} `;
}

/**
 * Worker-actor env marker assignment (US-002, CAM-63): identifies a spawned
 * implementer worker process so a later ACL hook (US-006) can distinguish a
 * worker-actor Write from a planner/orchestrator Write. Both run under
 * CAM_SESSION, so that var alone cannot disambiguate them; CAM_WORKER is the
 * narrower, positive signal set ONLY on the implementer worker path.
 *
 * `env` supports mixing `-u <var>` (unset) with `NAME=VALUE` (set) assignments
 * in the same invocation, so this is appended after the `-u` flags rendered by
 * `workerEnvPrefix` and before the `claude` binary name.
 *
 * Deliberately NOT folded into `workerEnvPrefix`: that function is shared with
 * the reviewer/planner/auditor branches of buildSpawnArgv below, and the
 * planner subagent must never inherit this marker (it legitimately writes
 * prd.json). It is also never added to the orchestrator/cam-run env path
 * (src/tmux/session.ts `new-session -e CAM_SESSION`).
 */
export const WORKER_ACTOR_ENV = 'CAM_WORKER=1';

/**
 * Escape a string for safe embedding inside a POSIX single-quoted shell argument.
 *
 * Single-quoting is the safest general-purpose shell escape: no characters
 * inside single quotes are interpreted by the shell except a single quote
 * itself, which terminates the quote. We handle embedded single quotes by
 * ending the current quote, inserting an escaped quote, then reopening.
 *
 * Example: `she said 'hi'` -> `'she said '\''hi'\''`
 *
 * This is the ONE definition (US-003, CAM-339): the three copies previously
 * duplicated in worker-argv.ts, plan-argv.ts, and review.ts are removed.
 */
function shellEscape(s: string): string {
	// Replace each ' with '\'' (end-quote, literal-quote, start-quote).
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * ClaudeAdapter: the claude-CLI implementation of BackendAdapter. Holds the
 * real per-actor argv assembly (US-003, CAM-339): buildImplementerWorkerArgv /
 * buildPlannerWorkerArgv / buildAuditorWorkerArgv / buildReviewerWorkerArgv
 * are now thin per-actor wrappers around this method, so any future actor
 * variation is authored once, here.
 */
export class ClaudeAdapter implements BackendAdapter {
	buildSpawnArgv(actor: WorkerActor, opts: SpawnArgvOptions): string {
		switch (actor) {
			case 'implementer': {
				const required = requireForNonReviewerActor('implementer', opts);
				const agentName = opts.agentName ?? DEFAULT_IMPLEMENTER_AGENT;
				const model = opts.model ?? DEFAULTS.implementer;
				const isolation = opts.isolation ?? 'host';
				const escapedPrompt = shellEscape(required.taskPrompt);
				return (
					workerEnvPrefix(isolation) +
					`${WORKER_ACTOR_ENV} ` +
					`claude` +
					` --permission-mode ${required.permissionMode}` +
					` --session-id ${opts.uuid}` +
					` --model ${shellEscape(model)}` +
					` --agent ${agentName}` +
					` ${escapedPrompt}`
				);
			}
			case 'planner': {
				const required = requireForNonReviewerActor('planner', opts);
				const agentName = opts.agentName ?? DEFAULT_PLANNER_AGENT;
				const model = opts.model ?? DEFAULTS.planner;
				const isolation = opts.isolation ?? 'host';
				const escapedPrompt = shellEscape(required.taskPrompt);
				return (
					workerEnvPrefix(isolation) +
					`claude` +
					` --permission-mode ${required.permissionMode}` +
					` --session-id ${opts.uuid}` +
					` --model ${shellEscape(model)}` +
					` --agent ${agentName}` +
					` ${escapedPrompt}`
				);
			}
			case 'auditor': {
				const required = requireForNonReviewerActor('auditor', opts);
				const agentName = opts.agentName ?? DEFAULT_AUDITOR_AGENT;
				const model = opts.model ?? DEFAULTS.auditor;
				const isolation = opts.isolation ?? 'host';
				const escapedPrompt = shellEscape(required.taskPrompt);
				return (
					workerEnvPrefix(isolation) +
					`claude` +
					` --permission-mode ${required.permissionMode}` +
					` --session-id ${opts.uuid}` +
					` --model ${shellEscape(model)}` +
					` --agent ${agentName}` +
					` ${escapedPrompt}`
				);
			}
			case 'reviewer': {
				const agentName = opts.agentName ?? DEFAULT_REVIEWER_AGENT;
				const model = opts.model ?? DEFAULTS.reviewer;
				const isolation = opts.isolation ?? 'host';
				const escapedPrompt = shellEscape(opts.taskPrompt ?? REVIEWER_TASK_PROMPT);
				const permissionMode = opts.permissionMode ?? 'bypassPermissions';
				return (
					workerEnvPrefix(isolation) +
					`claude` +
					` --permission-mode ${permissionMode}` +
					` --session-id ${opts.uuid}` +
					` --model ${shellEscape(model)}` +
					` --agent ${agentName}` +
					` ${escapedPrompt}`
				);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// CodexAdapter (US-001, CAM-350, ADR-0047 follow-up implementation).
// ---------------------------------------------------------------------------

/**
 * Env vars stripped from every codex worker, mirroring WORKER_ENV_UNSET's
 * role but for codex's own process model. Empty today: codex has no
 * documented nesting/identity-leak env var equivalent to claude's
 * `CLAUDECODE` gate (ADR-0047: "codex's adapter renders an independent
 * env-strip list; it does not attempt to reuse claude's literal var names").
 * Kept as a named list (not inlined) so a future codex-specific var can be
 * added here without touching buildSpawnArgv.
 */
export const CODEX_WORKER_ENV_UNSET: readonly string[] = [];

/**
 * Env vars stripped ONLY from host-isolation codex workers, mirroring
 * HOST_ONLY_ENV_UNSET's role. Empty today (host isolation, for codex, has no
 * known credential-leak equivalent to CLAUDE_CODE_OAUTH_TOKEN); kept as its
 * own list for the same reason as CODEX_WORKER_ENV_UNSET above.
 */
export const CODEX_HOST_ONLY_ENV_UNSET: readonly string[] = [];

/**
 * Render the codex-specific `env -u ...` prefix (trailing space), or the
 * empty string when the resolved unset list is empty (today, always). Mirrors
 * workerEnvPrefix's isolation-conditional shape (ADR-0047 mismatch e) without
 * sharing its var list: `CODEX_WORKER_ENV_UNSET` deliberately never includes
 * `CLAUDECODE`, since claude's nesting guard has no codex analog.
 */
export function codexEnvPrefix(isolation: WorkerIsolation): string {
	const vars = isolation === 'host' ? [...CODEX_WORKER_ENV_UNSET, ...CODEX_HOST_ONLY_ENV_UNSET] : CODEX_WORKER_ENV_UNSET;
	if (vars.length === 0) return '';
	return `env ${vars.map((v) => `-u ${v}`).join(' ')} `;
}

/**
 * Render codex's sandbox + approval flags from the same `permissionMode`
 * input claude's adapter reads (ADR-0047 mismatch e: METHOD-shaped behavior
 * inside buildSpawnArgv, not a caller-visible method). `--sandbox` and
 * `-c approval_policy=...` are mutually exclusive with
 * `--dangerously-bypass-approvals-and-sandbox` per the codex CLI reference,
 * so exactly one branch is ever emitted:
 *
 * - `permissionMode === 'bypassPermissions'` (claude's full-trust mode, the
 *   only permissionMode value any current call site actually passes) maps to
 *   `--dangerously-bypass-approvals-and-sandbox`: codex's own full-trust
 *   equivalent, matching claude's semantics one-for-one.
 * - Any other permissionMode maps to `--sandbox workspace-write
 *   -c approval_policy=never`: non-interactive (a spawned worker pane has no
 *   human to approve a prompt) but confined to the workspace, the closest
 *   codex sandbox mode to claude's non-bypass permission modes.
 *
 * The previously-rendered top-level-only approval flag is a `codex`-root
 * flag, not one `codex exec` accepts (US-001, CAM-397): passing it to the
 * `exec` subcommand fails argv parsing before the worker pane ever starts.
 * `-c approval_policy=never` is the `-c/--config` override `codex exec` does
 * accept and renders the same non-interactive approval policy (verified live
 * against codex-cli 0.144.6: `codex exec --sandbox workspace-write -c
 * approval_policy=never ...` parses and reports `approval: never / sandbox:
 * workspace-write` in its session header).
 */
function codexSandboxArgs(permissionMode: string): string {
	if (permissionMode === 'bypassPermissions') {
		return '--dangerously-bypass-approvals-and-sandbox';
	}
	return '--sandbox workspace-write -c approval_policy=never';
}

/**
 * Reads `.claude/agents/<agentName>.md`, strips its YAML frontmatter
 * (codex has no `--agent` analog, ADR-0047 mismatch d: the agent body itself
 * becomes the codex system/developer prompt), and writes the body to a fresh
 * file under `/tmp` (never under `.claude/`, so the plan preflight clean-tree
 * guard, ADR-0014, never sees it). Returns the tmpfile's absolute path, to be
 * passed as `-c model_instructions_file=<path>`.
 *
 * `appendedBlock` (US-001, CAM-354), when given, is appended after the agent
 * body with a single blank-line separator; used to inject the reviewer's
 * branch diff into the instructions-file BODY rather than the shell-escaped
 * argv prompt (ARG_MAX safety on large diffs).
 *
 * Synchronous node:fs read/write is a deliberate point-read/write (curated
 * invariant: Bun-only rule carves out readFileSync/writeFileSync for this).
 */
function writeCodexInstructionsFile(agentName: string, appendedBlock?: string): string {
	const agentPath = join('.claude', 'agents', `${agentName}.md`);
	const raw = readFileSync(agentPath, 'utf8');
	const body = stripFrontmatter(raw);
	const fullBody = appendedBlock !== undefined ? `${body}\n${appendedBlock}` : body;
	const tmpPath = join('/tmp', `cam-codex-${agentName}-${randomUUID()}.md`);
	writeFileSync(tmpPath, fullBody, 'utf8');
	return tmpPath;
}

// ---------------------------------------------------------------------------
// Reviewer diff injection (US-001, CAM-354).
//
// codex, unlike the claude reviewer, has no --agent harness step that forces
// it to ground itself in `git diff` before judging a branch (ADR-0047
// mismatch d). Left alone, codex pattern-matches repo context and can
// confabulate a confident CLEAN verdict about a changeset it never looked
// at. This block computes the real `git diff main...HEAD` at dispatch time
// and appends it to the codex reviewer's instructions-file body, with an
// explicit directive to review ONLY that diff.
// ---------------------------------------------------------------------------

/** Cap on injected diff size (chars); large diffs are truncated, never silently cut. */
const REVIEWER_DIFF_MAX_CHARS = 200_000;

/** Result of computing the reviewer branch diff against a resolved base ref. */
interface ReviewerDiffResult {
	status: 'ok' | 'no-changes' | 'error';
	diff: string;
	changedFiles: string[];
	truncated: boolean;
	/** Populated only on status === 'error'. */
	detail?: string;
}

/**
 * Runs `git diff main...HEAD` (three-dot: changes on the current branch
 * since its merge-base with main) plus `git diff --name-only main...HEAD`
 * in `cwd`. Never throws: a missing 'main' ref, a non-git cwd, or any other
 * git failure is reported as `status: 'error'` with the captured stderr in
 * `detail`, so a robustly-missing base ref degrades to a marker instead of
 * crashing the whole dispatch (AC3). An empty diff (branch has no changes
 * vs main) is reported as `status: 'no-changes'`, never an ambiguous empty
 * string (AC4).
 */
function computeReviewerDiff(cwd: string): ReviewerDiffResult {
	const diffResult = spawnSync('git', ['-C', cwd, 'diff', 'main...HEAD'], { encoding: 'utf8' });
	if (diffResult.status !== 0) {
		const detail = (diffResult.stderr ?? '').trim() || 'git diff main...HEAD failed (non-zero exit)';
		return { status: 'error', diff: '', changedFiles: [], truncated: false, detail };
	}

	const rawDiff = diffResult.stdout ?? '';
	if (rawDiff.trim().length === 0) {
		return { status: 'no-changes', diff: '', changedFiles: [], truncated: false };
	}

	const namesResult = spawnSync('git', ['-C', cwd, 'diff', '--name-only', 'main...HEAD'], { encoding: 'utf8' });
	const changedFiles =
		namesResult.status === 0
			? (namesResult.stdout ?? '')
					.split('\n')
					.map((line) => line.trim())
					.filter((line) => line.length > 0)
			: [];

	const truncated = rawDiff.length > REVIEWER_DIFF_MAX_CHARS;
	const diff = truncated ? rawDiff.slice(0, REVIEWER_DIFF_MAX_CHARS) : rawDiff;
	return { status: 'ok', diff, changedFiles, truncated };
}

/**
 * Renders the diff block appended to the codex reviewer's instructions-file
 * body. Always well-formed (AC4): 'error' and 'no-changes' both render an
 * explicit marker, never an empty string. A truncated diff carries a visible
 * `[diff truncated ...]` marker (AC5), never a silent cut.
 *
 * Resolves `opts.cwd` (defaulting to `process.cwd()`) itself so the
 * default-resolution operator lives here, not inline in
 * CodexAdapter.buildSpawnArgv's switch (keeps that switch's cognitive
 * complexity unchanged from before this story).
 */
function renderReviewerDiffBlock(opts: Pick<SpawnArgvOptions, 'cwd'>): string {
	const cwd = opts.cwd === undefined ? process.cwd() : opts.cwd;
	const result = computeReviewerDiff(cwd);
	const header = '## Injected branch diff (git diff main...HEAD)';

	if (result.status === 'error') {
		return [header, '', `[diff-unavailable: ${result.detail}]`].join('\n');
	}
	if (result.status === 'no-changes') {
		return [header, '', "[no-changes: the current branch has no diff vs main]"].join('\n');
	}

	const fileList =
		result.changedFiles.length > 0 ? result.changedFiles.map((f) => `- ${f}`).join('\n') : '(no changed file names reported)';
	const truncationMarker = result.truncated
		? `\n\n[diff truncated at ${REVIEWER_DIFF_MAX_CHARS} chars; changed-file list above is complete even when the diff body is truncated]`
		: '';
	const diffContent = result.diff + truncationMarker;

	// Fence-safe wrapper (CAM-355): derive the opener/closer backtick run so a
	// diff containing its own fenced-code or Markdown backtick runs can never
	// terminate the wrapper fence early. Per CommonMark, a fence only closes on
	// a run of backticks >= the opener's length, so the wrapper run must be
	// strictly longer than the longest backtick run present in the content.
	const longestBacktickRun = (diffContent.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
	const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));

	return [
		header,
		'',
		"Review ONLY the diff below (this branch's changes vs main, per `git diff main...HEAD`). " +
			'Do not review repo context, unrelated files, or history outside this diff.',
		'',
		'### Changed files',
		fileList,
		'',
		'### Diff',
		`${fence}diff`,
		diffContent,
		fence,
	].join('\n');
}

/**
 * CodexAdapter: the codex-CLI implementation of BackendAdapter (US-001,
 * CAM-350). Renders `codex exec` argv for the same four worker actors
 * ClaudeAdapter serves, per ADR-0047's mismatch resolutions:
 *
 * - (a) spawn-argv/seam: same one-method shape as ClaudeAdapter.
 * - (d) agent-prompt injection: `.claude/agents/<name>.md` body (frontmatter
 *   stripped) written to a `/tmp` file and passed via
 *   `-c model_instructions_file=<tmpfile>` (codex has no `--agent` flag).
 * - (e) permission/sandbox+env: codex's own sandbox/approval flags
 *   (codexSandboxArgs) and env-strip list (codexEnvPrefix), derived from the
 *   same permissionMode/isolation inputs claude's adapter reads, never
 *   claude's literal flag/var names.
 * - (f) model-id namespace: `opts.model` is threaded through opaquely as
 *   `-m <model>`, exactly like ClaudeAdapter's `--model`.
 *
 * Deliberately emits NO `--session-id` flag: `opts.uuid` is accepted (part of
 * the shared SpawnArgvOptions contract) but never threaded into codex argv --
 * codex has no claude-style resumable session-id concept in this slice, and
 * completion detection stays the existing report/sentinel shared contract
 * (ADR-0047), unaffected by this. `opts.taskPrompt` and `opts.permissionMode`
 * are required for implementer/planner/auditor and defaulted for reviewer,
 * mirroring ClaudeAdapter exactly (requireForNonReviewerActor is shared).
 */
export class CodexAdapter implements BackendAdapter {
	buildSpawnArgv(actor: WorkerActor, opts: SpawnArgvOptions): string {
		switch (actor) {
			case 'implementer': {
				const required = requireForNonReviewerActor('implementer', opts);
				const agentName = opts.agentName ?? DEFAULT_IMPLEMENTER_AGENT;
				const model = opts.model ?? DEFAULTS.implementer;
				const isolation = opts.isolation ?? 'host';
				return this.renderActor(agentName, model, required.taskPrompt, required.permissionMode, isolation);
			}
			case 'planner': {
				const required = requireForNonReviewerActor('planner', opts);
				const agentName = opts.agentName ?? DEFAULT_PLANNER_AGENT;
				const model = opts.model ?? DEFAULTS.planner;
				const isolation = opts.isolation ?? 'host';
				return this.renderActor(agentName, model, required.taskPrompt, required.permissionMode, isolation);
			}
			case 'auditor': {
				const required = requireForNonReviewerActor('auditor', opts);
				const agentName = opts.agentName ?? DEFAULT_AUDITOR_AGENT;
				const model = opts.model ?? DEFAULTS.auditor;
				const isolation = opts.isolation ?? 'host';
				return this.renderActor(agentName, model, required.taskPrompt, required.permissionMode, isolation);
			}
			case 'reviewer': {
				const agentName = opts.agentName ?? DEFAULT_REVIEWER_AGENT;
				const model = opts.model ?? DEFAULTS.reviewer;
				const isolation = opts.isolation ?? 'host';
				const taskPrompt = opts.taskPrompt ?? REVIEWER_TASK_PROMPT;
				const permissionMode = opts.permissionMode ?? 'bypassPermissions';
				// US-001 (CAM-354): reviewer-only diff injection. Never computed for
				// implementer/planner/auditor (AC6).
				const diffBlock = renderReviewerDiffBlock(opts);
				return this.renderActor(agentName, model, taskPrompt, permissionMode, isolation, diffBlock);
			}
		}
	}

	/** Shared per-actor argv assembly: only the defaults differ per actor. */
	private renderActor(
		agentName: string,
		model: string,
		taskPrompt: string,
		permissionMode: string,
		isolation: WorkerIsolation,
		appendedInstructionsBlock?: string,
	): string {
		const instructionsFile = writeCodexInstructionsFile(agentName, appendedInstructionsBlock);
		const escapedPrompt = shellEscape(taskPrompt);
		return (
			codexEnvPrefix(isolation) +
			`codex exec` +
			` ${codexSandboxArgs(permissionMode)}` +
			` -m ${shellEscape(model)}` +
			` -c model_instructions_file=${instructionsFile}` +
			` ${escapedPrompt}`
		);
	}
}

// ---------------------------------------------------------------------------
// selectAdapter (US-002, CAM-350, ADR-0047 follow-up).
// ---------------------------------------------------------------------------

/**
 * Map a resolved `readPhaseBackend(phase)` value to a concrete BackendAdapter.
 * This is the single choice-point that wires the previously-inert per-phase
 * backend resolution (US-001, CAM-349) into actual adapter dispatch: 'codex'
 * returns CodexAdapter, everything else (including 'claude' and any
 * unknown/future value) returns ClaudeAdapter. Defaulting unknown values to
 * ClaudeAdapter keeps every existing project.toml (no `[backend]` section, or
 * one with a typo'd/legacy value) behaving exactly as before this story.
 */
export function selectAdapter(backend: string): BackendAdapter {
	if (backend === 'codex') return new CodexAdapter();
	return new ClaudeAdapter();
}
