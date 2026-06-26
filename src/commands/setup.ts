// src/commands/setup.ts
//
// Project-setup wizard — the second stage of `cam init`.
//
// After machine-validation passes, this wizard:
//   1. Asks (or reads from flags) new vs existing project.
//   2. Asks which agent(s): claude | codex | both.
//   3. If both: asks which is the default.
//   4. Verifies chosen agent(s) are installed + logged in.
//   5. If new project: asks what the project is about.
//   6. Copies templates/ into .claude/commands/, .claude/agents/, scripts/cam/.
//   7. Opens a tmux split in the current window (or new session if outside tmux):
//        - Pane A (left): agent in bypassPermissions, reads project + writes
//          project-specific config from templates.
//        - Pane B (right): "setup dashboard" — tail -f of a log file showing
//          ~10 lines of agent output + key hints.
//      Ctrl+C → tmux attach to pane A (interact).
//      Ctrl+V → tmux attach to pane A in read-only mode.
//   8. Returns 0 when tmux split is spawned.
//
// Flags accepted by parseSetupArgs (wired in index.ts):
//   --new | --existing
//   --agent claude | codex | both
//   --default claude | codex  (only relevant with --agent=both)
//   --description "<text>"     (new projects only)
//   --no-tmux                  copy templates + print next steps, no tmux

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { render } from 'ink';
import { createElement } from 'react';

import { mergeIntoConfig } from '../config/toml.ts';
import { DEFAULTS, type MergeMode } from '../config/models.ts';
import { printError, printHint, printSuccess, printWarning } from '../logging/color.ts';
import { applyMergeMode } from './setup-merge-mode.ts';
import type { SpawnFn as BpSpawnFn } from '../release/branch-protection.ts';
import { printAutomergeNotice } from '../logging/notices.ts';
import { materializeTemplates } from '../templates/embedded.ts';
import { buildOrchestratorBootPrompt } from './run.ts';
import { SetupScreen, type SetupAnswers } from '../ui/SetupScreen.tsx';
import { tmuxArgs } from '../tmux/session.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectMode = 'new' | 'existing';
export type IssueSystem = 'linear' | 'github' | 'none';

export interface SetupOptions {
	projectMode?: ProjectMode;
	issueSystem?: IssueSystem;
	mergeMode?: MergeMode;
	description?: string;
	noTmux?: boolean;
	cwd?: string;
}

// ---------------------------------------------------------------------------
// Readline helpers (used when stdin is not a TTY: tests, CI, pipes)
// ---------------------------------------------------------------------------

async function ask(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

async function askChoice<T extends string>(
	question: string,
	choices: readonly T[],
	defaultChoice?: T,
): Promise<T> {
	const label = choices.map((c) => (c === defaultChoice ? `[${c}]` : c)).join(' / ');
	while (true) {
		const raw = await ask(`${question} (${label}): `);
		if (raw === '' && defaultChoice !== undefined) return defaultChoice;
		const lower = raw.toLowerCase() as T;
		if ((choices as readonly string[]).includes(lower)) return lower;
		printWarning(`Enter one of: ${choices.join(', ')}`);
	}
}

// ---------------------------------------------------------------------------
// Answer collection — Ink wizard when interactive, readline otherwise
// ---------------------------------------------------------------------------

function isInteractiveTTY(): boolean {
	return Boolean(process.stdout.isTTY) && !process.env['CI'];
}

async function collectSetupAnswers(options: SetupOptions): Promise<SetupAnswers | null> {
	// If every answer came from CLI flags, skip prompting entirely.
	const needsMode = options.projectMode === undefined;
	const needsIssue = options.issueSystem === undefined;
	const needsMerge = options.mergeMode === undefined;
	const needsDesc =
		options.projectMode === 'new' && options.description === undefined;
	if (!needsMode && !needsIssue && !needsMerge && !needsDesc) {
		return {
			projectMode: options.projectMode!,
			issueSystem: options.issueSystem!,
			mergeMode: options.mergeMode!,
			description: options.description ?? '',
		};
	}

	if (isInteractiveTTY()) {
		return collectViaInk(options);
	}
	return collectViaReadline(options);
}

async function collectViaReadline(options: SetupOptions): Promise<SetupAnswers> {
	const projectMode =
		options.projectMode ??
		(await askChoice(
			'Is this a new project or an existing one?',
			['new', 'existing'] as const,
			'existing',
		));
	const issueSystem =
		options.issueSystem ??
		(await askChoice(
			'Which issue system does this project use?',
			['linear', 'github', 'none'] as const,
			'none',
		));
	const mergeMode =
		options.mergeMode ??
		(await askChoice(
			'Merge mode for cam ship',
			['immediate', 'ci-gated'] as const,
			'immediate',
		));
	let description = options.description ?? '';
	if (projectMode === 'new' && description === '') {
		description = await ask('What is this project about? (free-form): ');
	}
	return { projectMode, issueSystem, mergeMode, description };
}

function collectViaInk(options: SetupOptions): Promise<SetupAnswers | null> {
	const prefilled: Partial<SetupAnswers> = {};
	if (options.projectMode !== undefined) prefilled.projectMode = options.projectMode;
	if (options.issueSystem !== undefined) prefilled.issueSystem = options.issueSystem;
	if (options.mergeMode !== undefined) prefilled.mergeMode = options.mergeMode;
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

function copyTemplates(cwd: string): void {
	const counts = materializeTemplates(cwd);
	const targets: Array<{ subtree: keyof typeof counts; rel: string }> = [
		{ subtree: 'commands', rel: '.claude/commands' },
		{ subtree: 'agents', rel: '.claude/agents' },
		{ subtree: 'scripts/cam', rel: 'scripts/cam' },
	];
	for (const { subtree, rel } of targets) {
		printSuccess(`Installed ${counts[subtree]} file(s) → ${rel}`);
	}
}

// ---------------------------------------------------------------------------
// Tmux launch
// ---------------------------------------------------------------------------

/**
 * The prompt given to the agent to configure the project from the installed
 * templates. For new projects it includes the user's description; for existing
 * ones it instructs the agent to infer from the codebase.
 */
export function buildSetupPrompt(opts: {
	projectMode: ProjectMode;
	description: string;
}): string {
	const base = [
		'You are setting up this project for the cam autonomous loop.',
		'The cam templates have already been installed into:',
		'  .claude/commands/  (cam-issue.md, cam-plan.md, cam-next.md, cam-review.md, cam-ship.md, cam-prune.md)',
		'  .claude/agents/    (subagent-orchestrator.md, subagent-planner.md, subagent-implementer.md, subagent-reviewer.md, subagent-auditor.md)',
		'  scripts/cam/       (CLAUDE.md, handoff.schema.json, journal.md)',
		'',
		'Your task — adapt ALL template placeholders to this specific project:',
		'1. Read the project structure (files, package.json / Cargo.toml / go.mod, etc.).',
		'2. Update scripts/cam/CLAUDE.md: real stack, quality-gate commands, conventions.',
		'3. Update .claude/agents/subagent-planner.md: project name, stack, domain terms.',
		'4. Update .claude/agents/subagent-reviewer.md checklist: real framework, auth, data patterns.',
		'5. Update .claude/agents/subagent-implementer.md: real quality-gate commands.',
		'   Adaptation point: `bun run check:all` is cam\'s aggregate quality gate.',
		'   Map it to this project\'s equivalent aggregate gate when one exists',
		'   (e.g. `make check`, `poe test-all`, `./gradlew check`);',
		'   degrade to typecheck + test when no aggregate gate exists.',
		'6. Update .claude/agents/subagent-auditor.md § F.domain: project-specific sanity checks.',
		'7. Replace ALL occurrences of generic placeholder text (e.g. "<project typecheck command>").',
		'8. Do NOT modify scripts/cam/journal.md — it is managed by the orchestrator at runtime.',
		'9. If the project needs project-specific rules or skills (api.md, testing.md, etc.),',
		'   create them under .claude/rules/ or .claude/skills/ with real content inferred from the codebase.',
		'10. When done, print exactly: CAM_SETUP_STATUS=DONE',
	].join('\n');

	if (opts.projectMode === 'new') {
		return [
			base,
			'',
			`Project description provided by the operator: ${opts.description}`,
			'',
			'Since this is a NEW project, also:',
			'- Create a minimal CLAUDE.md at the repo root if one does not exist.',
			'- Create a minimal AGENTS.md if the project will use subagents.',
		].join('\n');
	}

	return [
		base,
		'',
		'This is an EXISTING project. Infer everything from the codebase — do NOT assume.',
	].join('\n');
}

/**
 * Build the menu pane bash script.
 *
 * Two-state menu:
 *   - "initial": waiting for the config agent to emit CAM_SETUP_STATUS=DONE.
 *     Polls every 2s via `tmux capture-pane -p -S -` (full scrollback).
 *     While polling, accepts c/v/q keypresses.
 *   - "post":    config done → orchestrator pane was just spawned.
 *     Accepts o/c/k/q (o=orchestrator, c=config, k=kill-config, q=quit menu).
 *
 * The script reads `CAM_CONFIG_PANE` and `CAM_ORCH_PROMPT_FILE` from the
 * environment (passed via `tmux split-window -e`).
 *
 * Single quotes guard the bash content from JS string interpolation. Where
 * we need to embed a JS value, we close the single-quote, concat, and reopen.
 */
export function buildSetupMenuScript(): string {
	return `#!/bin/bash
set +m

CYAN='\\033[1;36m'
GREEN='\\033[1;32m'
BOLD='\\033[1m'
DIM='\\033[2m'
RST='\\033[0m'

CAM_CONFIG_PANE="\${CAM_CONFIG_PANE:-}"
CAM_ORCH_PROMPT_FILE="\${CAM_ORCH_PROMPT_FILE:-.claude/.cam-orchestrator-prompt.txt}"
CAM_ORCH_PANE=""

show_initial() {
	clear
	printf "\${CYAN}  cam init — setup running...\${RST}\\n\\n"
	printf "  \${BOLD}c\${RST}  switch to config pane (interact)\\n"
	printf "  \${BOLD}v\${RST}  open read-only viewer\\n"
	printf "  \${BOLD}q\${RST}  close this menu\\n\\n"
	printf "\${DIM}  waiting for CAM_SETUP_STATUS=DONE...\${RST}\\n"
}

show_post() {
	clear
	printf "\${GREEN}  ✓ cam setup complete\${RST}\\n\\n"
	printf "  Orchestrator launched in the new pane.\\n"
	printf "  Config pane is still alive for review.\\n\\n"
	printf "  \${BOLD}o\${RST}  switch to orchestrator pane\\n"
	printf "  \${BOLD}c\${RST}  switch to config pane\\n"
	printf "  \${BOLD}k\${RST}  close (kill) the config pane\\n"
	printf "  \${BOLD}q\${RST}  close this menu\\n"
}

handoff() {
	# Spawn the orchestrator pane immediately to the right of the config pane.
	CAM_ORCH_PANE=$(tmux split-window \\
		-h -t "\${CAM_CONFIG_PANE}" -l 50% -P -F '#{pane_id}' \\
		"bash -c 'claude --permission-mode bypassPermissions \\"\\$(cat \${CAM_ORCH_PROMPT_FILE})\\"'") || CAM_ORCH_PANE=""
}

state=initial
show_initial

while true; do
	if [[ "\${state}" == "initial" ]]; then
		# 2s timeout lets the polling fire even if the user is idle.
		read -rsn1 -t 2 key
		case "\${key}" in
			c|C) tmux select-pane -t "\${CAM_CONFIG_PANE}" ;;
			v|V) tmux split-window -v -l 12 "tmux pipe-pane -t '\${CAM_CONFIG_PANE}' -o 'cat >> /tmp/cam-config.log'; tail -f /tmp/cam-config.log" ;;
			q|Q) exit 0 ;;
		esac
		# Poll for DONE in the config pane's full scrollback.
		if tmux capture-pane -t "\${CAM_CONFIG_PANE}" -p -S - 2>/dev/null | grep -q "CAM_SETUP_STATUS=DONE"; then
			handoff
			state=post
			show_post
		fi
	else
		read -rsn1 key
		case "\${key}" in
			o|O) [[ -n "\${CAM_ORCH_PANE}" ]] && tmux select-pane -t "\${CAM_ORCH_PANE}" ;;
			c|C) tmux select-pane -t "\${CAM_CONFIG_PANE}" ;;
			k|K) tmux kill-pane -t "\${CAM_CONFIG_PANE}" ;;
			q|Q) exit 0 ;;
		esac
	fi
done
`;
}

/**
 * Spawn the setup agent in a tmux split with auto-handoff to the orchestrator.
 *
 * Initial layout (same window, horizontal split):
 *   ┌──────────────────────────────┬─────────────────────┐
 *   │  Pane: config agent (claude) │  Pane: setup menu   │
 *   │  bypassPermissions           │  c → interact        │
 *   │                              │  v → view-only       │
 *   │                              │  q → close menu      │
 *   │                              │  (polling for DONE)  │
 *   └──────────────────────────────┴─────────────────────┘
 *
 * After CAM_SETUP_STATUS=DONE is detected, the menu pane spawns the
 * orchestrator automatically and reshapes itself:
 *
 *   ┌────────────────┬────────────────┬───────────────────┐
 *   │  config agent  │  orchestrator  │  setup menu       │
 *   │  (idle / quit) │  (interactive) │  o → orchestrator │
 *   │                │                │  c → config       │
 *   │                │                │  k → kill config  │
 *   │                │                │  q → close menu   │
 *   └────────────────┴────────────────┴───────────────────┘
 */
function spawnSetupTmux(opts: {
	prompt: string;
	cwd: string;
}): void {
	const { prompt, cwd } = opts;

	// Persist all the artifacts the panes need.
	const dotClaude = join(cwd, '.claude');
	mkdirSync(dotClaude, { recursive: true });

	const promptFile = join(dotClaude, '.cam-setup-prompt.txt');
	writeFileSync(promptFile, prompt, 'utf8');

	const orchPromptFile = join(dotClaude, '.cam-orchestrator-prompt.txt');
	writeFileSync(orchPromptFile, buildOrchestratorBootPrompt(), 'utf8');

	const menuFile = join(dotClaude, '.cam-setup-menu.sh');
	writeFileSync(menuFile, buildSetupMenuScript(), 'utf8');

	// Agent command — reads prompt from file as first turn.
	const agentCmd = `claude --permission-mode bypassPermissions "$(cat '${promptFile}')"`;
	const menuCmd = `bash '${menuFile}'`;

	const insideTmux = Boolean(process.env['TMUX']);

	if (insideTmux) {
		// Inside-tmux: these calls target the user's live interactive window,
		// which lives in the user's current security session (ambient socket),
		// not the cam dedicated socket. Do NOT wrap with tmuxArgs() here.
		const idResult = spawnSync(
			'tmux',
			['display-message', '-p', '#{pane_id}'],
			{ encoding: 'utf8' },
		);
		const configPaneId = (idResult.stdout ?? '').trim();
		if (!configPaneId) {
			printWarning('Could not capture current tmux pane id — auto-handoff disabled');
		}

		// Split right with the menu pane, exposing the config pane id + orch
		// prompt path via env vars so the script can find them.
		const menuResult = spawnSync(
			'tmux',
			[
				'split-window', '-h', '-l', '36', '-d',
				'-e', `CAM_CONFIG_PANE=${configPaneId}`,
				'-e', `CAM_ORCH_PROMPT_FILE=${orchPromptFile}`,
				'bash', '-c', menuCmd,
			],
			{ stdio: 'inherit' },
		);
		if ((menuResult.status ?? 1) !== 0) {
			printWarning('tmux split for menu pane failed — continuing without it');
		}
		// Run the agent in the original pane.
		spawnSync('tmux', ['send-keys', `bash -c ${JSON.stringify(agentCmd)}`, 'Enter'], {
			stdio: 'inherit',
		});
	} else {
		// Outside tmux: create a detached session on the dedicated -L cam socket.
		const sessionName = 'cam-setup';
		const newSession = spawnSync(
			'tmux',
			tmuxArgs([
				'new-session', '-d',
				'-s', sessionName,
				'-x', '220', '-y', '50',
				'-P', '-F', '#{pane_id}',
				'bash', '-c', agentCmd,
			]),
			{ cwd, encoding: 'utf8' },
		);
		const configPaneId = (newSession.stdout ?? '').trim();
		if ((newSession.status ?? 1) !== 0 || !configPaneId) {
			printError(
				'tmux new-session failed',
				`Exit code ${newSession.status} — install tmux or run with --no-tmux`,
			);
			return;
		}

		// Add the menu pane (right side) with env vars so it can drive handoff.
		spawnSync(
			'tmux',
			tmuxArgs([
				'split-window', '-t', `${sessionName}:0`, '-h', '-l', '36', '-d',
				'-e', `CAM_CONFIG_PANE=${configPaneId}`,
				'-e', `CAM_ORCH_PROMPT_FILE=${orchPromptFile}`,
				'bash', '-c', menuCmd,
			]),
			{ stdio: 'inherit' },
		);
		printSuccess(`tmux session "${sessionName}" created`);
		printHint(`Attach:           tmux attach -t ${sessionName}`);
		printHint(`Attach read-only: tmux attach -t ${sessionName} -r`);
	}
}


// ---------------------------------------------------------------------------
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
		printHint('Fix the issues above and re-run `cam init`');
		return 1;
	}

	// --- Step 2: collect answers (interactive Ink screen or readline) -------
	const answers = await collectSetupAnswers(options);
	if (answers === null) {
		printWarning('Setup cancelled');
		return 1;
	}
	const { projectMode, issueSystem, mergeMode, description } = answers;

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
	}
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
		});
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

	// --- Step 7: spawn tmux split (unless --no-tmux) ------------------------
	if (options.noTmux) {
		printSuccess('Templates installed — skipping tmux (--no-tmux)');
		printHint('Next: open your project in Claude Code and run /cam-plan');
		return 0;
	}

	const prompt = buildSetupPrompt({ projectMode, description });

	try {
		spawnSetupTmux({ prompt, cwd });
		printSuccess('Setup agent launched in tmux split');
	} catch (err) {
		printError(
			'Failed to launch tmux split',
			err instanceof Error ? err.message : String(err),
		);
		printHint('Run `cam init --no-tmux` to skip the tmux step and install templates only');
		return 1;
	}

	return 0;
}

// ---------------------------------------------------------------------------
// Arg parser (called from index.ts)
// ---------------------------------------------------------------------------

export interface ParsedSetupArgs {
	projectMode?: ProjectMode;
	issueSystem?: IssueSystem;
	mergeMode?: MergeMode;
	description?: string;
	noTmux: boolean;
	help: boolean;
}

const ISSUE_SYSTEMS: readonly IssueSystem[] = ['linear', 'github', 'none'];
const MERGE_MODES: readonly MergeMode[] = ['immediate', 'ci-gated'];

export function parseSetupArgs(args: string[]): ParsedSetupArgs | null {
	const result: ParsedSetupArgs = { noTmux: false, help: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '--help' || arg === '-h') { result.help = true; continue; }
		if (arg === '--new') { result.projectMode = 'new'; continue; }
		if (arg === '--existing') { result.projectMode = 'existing'; continue; }
		if (arg === '--no-tmux') { result.noTmux = true; continue; }
		if (arg === '--issue-system') {
			const next = args[++i];
			if (!next || !(ISSUE_SYSTEMS as readonly string[]).includes(next)) {
				printError('--issue-system requires: linear | github | none');
				return null;
			}
			result.issueSystem = next as IssueSystem;
			continue;
		}
		if (arg.startsWith('--issue-system=')) {
			const val = arg.slice('--issue-system='.length);
			if (!(ISSUE_SYSTEMS as readonly string[]).includes(val)) {
				printError(`--issue-system must be linear, github, or none — got ${val}`);
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
		printError(`Unknown init option: ${arg}`);
		return null;
	}
	return result;
}
