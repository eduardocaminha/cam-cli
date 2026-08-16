// src/commands/setup.ts
//
// Project-setup wizard — the second stage of `gship init`.
//
// After machine-validation passes, this wizard:
//   1. Asks (or reads from flags) new vs existing project.
//   2. Asks which issue system, merge mode, and plan-approval mode to use.
//   3. Verifies Claude Code is installed + logged in.
//   4. If new project: asks what the project is about.
//   5. Persists project config and installs the bundled templates.
//   6. Returns to the web-first flow.
//
// Flags accepted by parseSetupArgs (wired in index.ts):
//   --new | --existing
//   --issue-system linear | github | local
//   --merge-mode immediate | ci-gated
//   --plan-approval auto | operator
//   --description "<text>" (new projects only)
//   --resend-recipient "<email>"

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { render } from 'ink';
import { createElement } from 'react';
import type { IssueSystem } from '../config/issue-system.ts';
import { DEFAULTS, type MergeMode, type PlanApproval } from '../config/models.ts';
import { loadConfig, mergeIntoConfig, saveConfig } from '../config/toml.ts';
import { printError, printHint, printSuccess, printWarning } from '../logging/color.ts';
import { printAutomergeNotice } from '../logging/notices.ts';
import type { SpawnFn as BpSpawnFn } from '../release/branch-protection.ts';
import { materializeTemplates } from '../templates/embedded.ts';
import { type SetupAnswers, SetupScreen } from '../ui/SetupScreen.tsx';
import { applyMergeMode } from './setup-merge-mode.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectMode = 'new' | 'existing';
export type { IssueSystem } from '../config/issue-system.ts';

export interface SetupOptions {
	projectMode?: ProjectMode;
	issueSystem?: IssueSystem;
	mergeMode?: MergeMode;
	planApproval?: PlanApproval;
	resendRecipient?: string;
	description?: string;
	cwd?: string;
}

// ---------------------------------------------------------------------------
// Readline helpers (used when stdin is not a TTY: tests, CI, pipes)
// ---------------------------------------------------------------------------

export async function ask(
	question: string,
	defaultValue = '',
	input: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
	// Short-circuit: if the stream already ended, no future 'end'/'close' will be
	// re-emitted on a new readline interface. Resolve immediately to the default so
	// collectViaReadline never hangs when multiple options are undefined on a single
	// already-consumed EOF stream.
	// Duck-typed: NodeJS.ReadableStream minimal interface omits readableEnded;
	// Readable from node:stream does expose it. Check defensively.
	if ('readableEnded' in input && (input as unknown as { readableEnded: boolean }).readableEnded) {
		return defaultValue;
	}
	const output = input === process.stdin ? process.stdout : undefined;
	const rl = createInterface({ input, output });
	let answered = false;
	return new Promise((resolve) => {
		rl.on('close', () => {
			if (!answered) {
				answered = true;
				resolve(defaultValue);
			}
		});
		rl.question(question, (answer) => {
			answered = true;
			rl.close();
			resolve(answer.trim());
		});
	});
}

export async function askChoice<T extends string>(
	question: string,
	choices: readonly T[],
	defaultChoice?: T,
	input: NodeJS.ReadableStream = process.stdin,
): Promise<T> {
	const label = choices.map((c) => (c === defaultChoice ? `[${c}]` : c)).join(' / ');
	while (true) {
		const raw = await ask(`${question} (${label}): `, '', input);
		if (raw === '' && defaultChoice !== undefined) return defaultChoice;
		const lower = raw.toLowerCase() as T;
		if ((choices as readonly string[]).includes(lower)) return lower;
		printWarning(`Enter one of: ${choices.join(', ')}`);
	}
}

// ---------------------------------------------------------------------------
// Answer collection — Ink wizard when interactive, readline otherwise
// ---------------------------------------------------------------------------

/**
 * Pure gate predicate for the setup interactive path. Exported for unit tests.
 *
 * The Ink path (SetupScreen) uses useInput which needs raw mode on stdin.
 * Returning false routes to collectViaReadline (no crash) when stdin is not a
 * raw-capable TTY (e.g. build smoke: stdout TTY, stdin piped from /dev/null).
 */
export function isSetupInteractiveGate(
	stdoutIsTTY: boolean,
	stdinIsTTY: boolean,
	ci: string | undefined,
): boolean {
	return stdoutIsTTY && stdinIsTTY && !ci;
}

// ---------------------------------------------------------------------------
// [loop] section scaffold (documents, does not pin, meta_loop/worker_isolation/
// orch_context_window — see src/config/models.ts for the readers)
// ---------------------------------------------------------------------------

/**
 * Scaffold a commented `[loop]` example section in `project.toml` documenting
 * `meta_loop`, `worker_isolation`, and `orch_context_window`. The three keys
 * are emitted as COMMENTED examples only — never active/pinned values — so
 * `readMetaLoop`/`readWorkerIsolation`/`readOrchContextWindow`
 * (`src/config/models.ts`) keep returning their code defaults (`off` /
 * `host` / `200000`) against a freshly scaffolded file.
 *
 * Must run AFTER every other `mergeIntoConfig` call against the same path:
 * `mergeIntoConfig`'s `saveConfig` step re-parses+re-serializes the file,
 * which silently drops comments (TOML comments are non-semantic — see the
 * `stringifyToml` contract in `src/config/toml.ts`). This is the dedicated
 * final write for `project.toml`.
 *
 * Idempotent: a no-op when `[loop]` already exists (a prior scaffold run, or
 * an operator hand-added an active `[loop]` key) so re-running `cam init`
 * never clobbers a hand-edited value.
 */
export function scaffoldLoopSection(projectToml: string): void {
	const config = loadConfig(projectToml);
	if (config['loop'] !== undefined) return;
	config['loop'] = {};
	saveConfig(projectToml, config, {
		loop: [
			'meta_loop = "auto"  # accepted: auto | observe | off (default: off)',
			'worker_isolation = "container"  # accepted: container | host (default: host)',
			'orch_context_window = 200000  # default: 200000',
		],
	});
}

function isInteractiveTTY(): boolean {
	return isSetupInteractiveGate(
		Boolean(process.stdout.isTTY),
		Boolean(process.stdin.isTTY),
		process.env['CI'],
	);
}

async function collectSetupAnswers(options: SetupOptions): Promise<SetupAnswers | null> {
	// If every answer came from CLI flags, skip prompting entirely.
	const needsMode = options.projectMode === undefined;
	const needsIssue = options.issueSystem === undefined;
	const needsMerge = options.mergeMode === undefined;
	const needsPlanApproval = options.planApproval === undefined;
	const needsDesc =
		options.projectMode === 'new' && options.description === undefined;
	if (!needsMode && !needsIssue && !needsMerge && !needsPlanApproval && !needsDesc) {
		return {
			projectMode: options.projectMode!,
			issueSystem: options.issueSystem!,
			mergeMode: options.mergeMode!,
			planApproval: options.planApproval!,
			description: options.description ?? '',
		};
	}

	if (isInteractiveTTY()) {
		return collectViaInk(options);
	}
	return collectViaReadline(options);
}

export async function collectViaReadline(
	options: SetupOptions,
	input: NodeJS.ReadableStream = process.stdin,
): Promise<SetupAnswers> {
	const projectMode =
		options.projectMode ??
		(await askChoice(
			'Is this a new project or an existing one?',
			['new', 'existing'] as const,
			'existing',
			input,
		));
	const issueSystem =
		options.issueSystem ??
		(await askChoice(
			'Which issue system does this project use?',
			['linear', 'github', 'local'] as const,
			'local',
			input,
		));
	const mergeMode =
		options.mergeMode ??
		(await askChoice(
			'Merge mode for cam ship',
			['immediate', 'ci-gated'] as const,
			'immediate',
			input,
		));
	const planApproval =
		options.planApproval ??
		(await askChoice(
			'Plan approval mode (auto = sidecar advances automatically; operator = human gate)',
			['auto', 'operator'] as const,
			'auto',
			input,
		));
	let description = options.description ?? '';
	if (projectMode === 'new' && description === '') {
		description = await ask('What is this project about? (free-form): ', '', input);
	}
	return { projectMode, issueSystem, mergeMode, planApproval, description };
}

function collectViaInk(options: SetupOptions): Promise<SetupAnswers | null> {
	const prefilled: Partial<SetupAnswers> = {};
	if (options.projectMode !== undefined) prefilled.projectMode = options.projectMode;
	if (options.issueSystem !== undefined) prefilled.issueSystem = options.issueSystem;
	if (options.mergeMode !== undefined) prefilled.mergeMode = options.mergeMode;
	if (options.planApproval !== undefined) prefilled.planApproval = options.planApproval;
	if (options.description !== undefined) prefilled.description = options.description;

	return new Promise((resolve) => {
		let result: SetupAnswers | null = null;
		const { unmount, waitUntilExit } = render(
			createElement(SetupScreen, {
				prefilled,
				onDone: (answers) => {
					result = answers;
					unmount();
				},
				onCancel: () => {
					result = null;
					unmount();
				},
			}),
		);
		waitUntilExit()
			.then(() => resolve(result))
			.catch(() => resolve(null));
	});
}

// ---------------------------------------------------------------------------
// Resend warning helper (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Emit a loud printWarning when plan_approval is "auto" and the Resend API
 * key is unconfigured. A missing key means non-convergence failures are silent:
 * no escalation email will fire when the review loop hits MAX_ROUNDS_DEBT.
 *
 * Exported so unit tests can call it directly without running the full
 * setup wizard (which requires claude to be installed).
 *
 * @param planApproval    The chosen plan approval mode.
 * @param resendApiKey    The configured Resend API key (empty string = unconfigured).
 * @param resendRecipient The configured Resend recipient (empty string = unconfigured).
 * @param warnFn          Injectable warning emitter (default: printWarning).
 */
export function warnIfResendUnconfigured(
	planApproval: PlanApproval,
	resendApiKey: string,
	resendRecipient: string,
	warnFn: (msg: string, hint?: string) => void = printWarning,
): void {
	if (planApproval === 'auto' && (resendApiKey === '' || resendRecipient === '')) {
		warnFn(
			'plan_approval is "auto" but Resend is not configured: non-convergence failures will be SILENT',
			'Set RESEND_API_KEY in your shell environment (like LINEAR_API_KEY); also set resend_recipient in [notify] of scripts/cam/project.toml',
		);
	}
}

// ---------------------------------------------------------------------------
// Agent verification
// ---------------------------------------------------------------------------

interface AgentVerifyResult {
	ok: boolean;
	path: string | null;
	hint?: string;
}

function lookupOnPath(name: string): string | null {
	const r = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
	if (r.status !== 0) return null;
	const t = r.stdout.trim();
	return t || null;
}

function verifyAgent(): AgentVerifyResult {
	const path = lookupOnPath('claude');
	if (!path) {
		return {
			ok: false,
			path: null,
			hint: 'Install Claude Code: https://claude.ai/code',
		};
	}

	// Auth check — best-effort; if the subcommand doesn't exist we skip
	const authCheck = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8' });
	const authOut = (authCheck.stdout ?? '') + (authCheck.stderr ?? '');
	const notLoggedIn =
		authCheck.status !== 0 && /not logged in|not authenticated|no account/i.test(authOut);
	if (notLoggedIn) {
		return {
			ok: false,
			path,
			hint: 'Not logged in to Claude. Run: claude auth login',
		};
	}

	return { ok: true, path };
}

// ---------------------------------------------------------------------------
// Template installation
// ---------------------------------------------------------------------------

export function copyTemplates(cwd: string): void {
	const counts = materializeTemplates(cwd);
	const targets: Array<{ subtree: keyof typeof counts; rel: string }> = [
		{ subtree: 'commands', rel: '.claude/commands' },
		{ subtree: 'agents', rel: '.claude/agents' },
		{ subtree: 'scripts/cam', rel: 'scripts/cam' },
		{ subtree: 'skills', rel: '.claude/skills' },
	];
	for (const { subtree, rel } of targets) {
		printSuccess(`Installed ${counts[subtree]} file(s) → ${rel}`);
	}
}

// Public entrypoint
// ---------------------------------------------------------------------------

export async function runSetup(options: SetupOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();

	// --- Step 1: verify claude is installed and logged in -------------------
	// Run this BEFORE prompting so the user doesn't answer three questions
	// only to be told claude isn't installed. Same check as before, just
	// hoisted from between the prompts to in front of them.
	const agentResult = verifyAgent();
	if (!agentResult.ok) {
		printError('claude not ready', agentResult.hint);
		printHint('Fix the issues above and re-run `gship init`');
		return 1;
	}

	// --- Step 2: collect answers (interactive Ink screen or readline) -------
	const answers = await collectSetupAnswers(options);
	if (answers === null) {
		printWarning('Setup cancelled');
		return 1;
	}
	const { projectMode, issueSystem, mergeMode, planApproval, description } = answers;
	// Resend API key: read from RESEND_API_KEY env var only (not git-tracked).
	const resendApiKey = process.env['RESEND_API_KEY'] ?? '';
	const resendRecipient = options.resendRecipient ?? '';

	// Blank line to separate the Ink screen's rendered output from the linear
	// CLI prints that follow. Without this, the first hint/success line glues
	// to the bottom of the SetupScreen panel.
	if (isInteractiveTTY()) process.stdout.write('\n');

	// In non-TTY mode collectSetupAnswers already echoes nothing — print a
	// concise confirmation so log scrapers (and the CI test stream) still
	// see the chosen values. In TTY, the SetupScreen rendered the history
	// inline and there's nothing more to say here.
	if (!isInteractiveTTY()) {
		printSuccess(`Project mode: ${projectMode}`);
		printSuccess(`claude found at ${agentResult.path}`);
		printSuccess(`Issue system: ${issueSystem}`);
		printSuccess(`Merge mode: ${mergeMode}`);
		printSuccess(`Plan approval: ${planApproval}`);
	}

	// LOUD WARNING: auto mode with no Resend key means non-convergence failures
	// are silent (the escalation email will never fire). Warn the operator so
	// they can configure Resend before relying on the autonomous loop.
	warnIfResendUnconfigured(planApproval, resendApiKey, resendRecipient);
	if (issueSystem === 'linear') {
		printHint('Set LINEAR_API_KEY in your shell (get one at https://linear.app/settings/api)');
	} else if (issueSystem === 'github') {
		printHint('Ensure `gh auth status` passes before running /cam-issue');
	}
	// cam ship always opens a GitHub PR, so the auto-merge prerequisite is
	// unconditional regardless of the chosen issue_system.
	printAutomergeNotice();

	// Persist to scripts/cam/project.toml (per-project config).
	try {
		const projectToml = join(cwd, 'scripts', 'cam', 'project.toml');
		mergeIntoConfig(projectToml, {
			issue_system: issueSystem,
			models: {
				orchestrator: DEFAULTS.orchestrator,
				planner: DEFAULTS.planner,
				auditor: DEFAULTS.auditor,
				implementer: DEFAULTS.implementer,
				reviewer: DEFAULTS.reviewer,
				ship: DEFAULTS.ship,
			},
			backend: { name: 'claude' },
			ship: { merge_mode: mergeMode },
			plan: { plan_approval: planApproval },
		});
		// Persist Resend recipient when provided. The API key is read from
		// RESEND_API_KEY env var (not stored in git-tracked project.toml).
		if (resendRecipient !== '') {
			mergeIntoConfig(projectToml, {
				notify: { resend_recipient: resendRecipient },
			});
		}
		// Must run LAST: mergeIntoConfig's saveConfig strips comments on every
		// call, so scaffolding the [loop] section before any of the calls above
		// would have its comments silently discarded by the next merge.
		scaffoldLoopSection(projectToml);
		printSuccess(`Wrote ${projectToml.replace(cwd + '/', '')}`);
	} catch (err) {
		printWarning(
			`Could not write scripts/cam/project.toml: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// When ci-gated: configure branch protection via the US-002 helper.
	if (mergeMode === 'ci-gated') {
		const productionSpawnFn: BpSpawnFn = (cmd, args, opts) => spawnSync(cmd, args, opts);
		applyMergeMode({
			mergeMode,
			spawnFn: productionSpawnFn,
			emitHint: printHint,
			emitWarning: printWarning,
			emitResult: (msg) => printSuccess(msg),
		});
	}

	if (projectMode === 'new' && description === '') {
		printWarning('No description provided — the agent will infer from the codebase');
	}

	// --- Step 6: copy templates ---------------------------------------------
	copyTemplates(cwd);

	// --- Step 7: return to the web-first runtime -----------------------------
	printSuccess('Templates installed');
	printHint('Next: run `gship` to open the local web control surface');
	return 0;
}

// ---------------------------------------------------------------------------
// Arg parser (called from index.ts)
// ---------------------------------------------------------------------------

export interface ParsedSetupArgs {
	projectMode?: ProjectMode;
	issueSystem?: IssueSystem;
	mergeMode?: MergeMode;
	planApproval?: PlanApproval;
	resendRecipient?: string;
	description?: string;
	help: boolean;
}

const ISSUE_SYSTEMS: readonly IssueSystem[] = ['linear', 'github', 'local'];
const MERGE_MODES: readonly MergeMode[] = ['immediate', 'ci-gated'];
const PLAN_APPROVALS: readonly PlanApproval[] = ['auto', 'operator'];

export function parseSetupArgs(args: string[]): ParsedSetupArgs | null {
	const result: ParsedSetupArgs = { help: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '--help' || arg === '-h') { result.help = true; continue; }
		if (arg === '--new') { result.projectMode = 'new'; continue; }
		if (arg === '--existing') { result.projectMode = 'existing'; continue; }
		if (arg === '--issue-system') {
			const next = args[++i];
			if (next === 'none') { result.issueSystem = 'local'; continue; }
			if (!next || !(ISSUE_SYSTEMS as readonly string[]).includes(next)) {
				printError('--issue-system requires: linear | github | local');
				return null;
			}
			result.issueSystem = next as IssueSystem;
			continue;
		}
		if (arg.startsWith('--issue-system=')) {
			const val = arg.slice('--issue-system='.length);
			if (val === 'none') { result.issueSystem = 'local'; continue; }
			if (!(ISSUE_SYSTEMS as readonly string[]).includes(val)) {
				printError(`--issue-system must be linear, github, or local — got ${val}`);
				return null;
			}
			result.issueSystem = val as IssueSystem;
			continue;
		}
		if (arg === '--merge-mode') {
			const next = args[++i];
			if (!next || !(MERGE_MODES as readonly string[]).includes(next)) {
				printError('--merge-mode requires: immediate | ci-gated');
				return null;
			}
			result.mergeMode = next as MergeMode;
			continue;
		}
		if (arg.startsWith('--merge-mode=')) {
			const val = arg.slice('--merge-mode='.length);
			if (!(MERGE_MODES as readonly string[]).includes(val)) {
				printError(`--merge-mode must be immediate or ci-gated — got ${val}`);
				return null;
			}
			result.mergeMode = val as MergeMode;
			continue;
		}
		if (arg === '--description') {
			const next = args[++i];
			if (!next) { printError('--description requires a string'); return null; }
			result.description = next;
			continue;
		}
		if (arg.startsWith('--description=')) {
			result.description = arg.slice('--description='.length);
			continue;
		}
		if (arg === '--plan-approval') {
			const next = args[++i];
			if (!next || !(PLAN_APPROVALS as readonly string[]).includes(next)) {
				printError('--plan-approval requires: auto | operator');
				return null;
			}
			result.planApproval = next as PlanApproval;
			continue;
		}
		if (arg.startsWith('--plan-approval=')) {
			const val = arg.slice('--plan-approval='.length);
			if (!(PLAN_APPROVALS as readonly string[]).includes(val)) {
				printError(`--plan-approval must be auto or operator — got ${val}`);
				return null;
			}
			result.planApproval = val as PlanApproval;
			continue;
		}
		if (arg === '--resend-recipient') {
			const next = args[++i];
			if (!next) { printError('--resend-recipient requires a string'); return null; }
			result.resendRecipient = next;
			continue;
		}
		if (arg.startsWith('--resend-recipient=')) {
			result.resendRecipient = arg.slice('--resend-recipient='.length);
			continue;
		}
		printError(`Unknown init option: ${arg}`);
		return null;
	}
	return result;
}
