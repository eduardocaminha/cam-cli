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

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { printError, printHint, printSuccess, printWarning } from '../logging/color.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectMode = 'new' | 'existing';

export interface SetupOptions {
	projectMode?: ProjectMode;
	description?: string;
	noTmux?: boolean;
	cwd?: string;
}

// ---------------------------------------------------------------------------
// Readline helpers
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

// Resolve templates/ relative to this source file, regardless of whether
// we're running from src/ (dev) or from a compiled binary (dist/).
function templatesDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	// dev: src/commands/setup.ts → ../../templates
	// compiled binary lands in project root alongside templates/
	const candidate = join(here, '../../templates');
	if (existsSync(candidate)) return candidate;
	// fallback: same dir as binary
	return join(here, 'templates');
}

function copyTemplates(cwd: string): void {
	const tplDir = templatesDir();
	const targets: Array<{ src: string; dst: string }> = [
		{ src: join(tplDir, 'commands'), dst: join(cwd, '.claude', 'commands') },
		{ src: join(tplDir, 'agents'), dst: join(cwd, '.claude', 'agents') },
		{ src: join(tplDir, 'scripts', 'cam'), dst: join(cwd, 'scripts', 'cam') },
	];

	for (const { src, dst } of targets) {
		if (!existsSync(src)) {
			printWarning(`template dir not found: ${src} — skipping`);
			continue;
		}
		mkdirSync(dst, { recursive: true });
		cpSync(src, dst, { recursive: true });
		const count = readdirSync(src).length;
		const rel = dst.startsWith(cwd) ? dst.slice(cwd.length + 1) : dst;
		printSuccess(`installed ${count} file(s) → ${rel}`);
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
function buildSetupPrompt(opts: {
	projectMode: ProjectMode;
	description: string;
}): string {
	const base = [
		'You are setting up this project for the cam autonomous loop.',
		'The cam templates have already been installed into:',
		'  .claude/commands/  (cam-next.md, cam-plan.md, cam-review.md, cam-ship.md, cam-prune.md)',
		'  .claude/agents/    (subagent-planner.md, subagent-implementer.md, subagent-reviewer.md, subagent-auditor.md)',
		'  scripts/cam/       (CLAUDE.md, handoff.schema.json, journal.md)',
		'',
		'Your task — adapt ALL template placeholders to this specific project:',
		'1. Read the project structure (files, package.json / Cargo.toml / go.mod, etc.).',
		'2. Update scripts/cam/CLAUDE.md: real stack, quality-gate commands, conventions.',
		'3. Update .claude/agents/subagent-planner.md: project name, stack, domain terms.',
		'4. Update .claude/agents/subagent-reviewer.md checklist: real framework, auth, data patterns.',
		'5. Update .claude/agents/subagent-implementer.md: real quality-gate commands.',
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
 * Spawn the setup agent in a tmux split.
 *
 * Layout (same window, horizontal split):
 *   ┌──────────────────────────────┬─────────────────────┐
 *   │  Pane 0: agent (claude/codex)│  Pane 1: key menu   │
 *   │  bypassPermissions           │  c → interact        │
 *   │                              │  v → view-only       │
 *   └──────────────────────────────┴─────────────────────┘
 *
 * Pane 1 is a small bash script that:
 *   - shows a live tail of the last 10 lines of the agent's output log
 *   - reads a single keypress in a loop:
 *       c → tmux select-pane -t 0  (switch focus to agent for interaction)
 *       v → opens a readonly split of pane 0 (tmux split-window piping pane output)
 *       q → exit the menu pane
 */
function spawnSetupTmux(opts: {
	prompt: string;
	cwd: string;
}): void {
	const { prompt, cwd } = opts;

	// Write prompt to file to avoid shell-quoting nightmares.
	const dotClaude = join(cwd, '.claude');
	mkdirSync(dotClaude, { recursive: true });
	const promptFile = join(dotClaude, '.cam-setup-prompt.txt');
	writeFileSync(promptFile, prompt, 'utf8');

	// Agent command — reads prompt from file as first turn.
	const agentCmd = `claude --permission-mode bypassPermissions "$(cat '${promptFile}')"`;

	// Pane 1: interactive key menu. Uses `read -rsn1` to capture a single
	// keypress without Enter. `c` switches focus to pane 0; `v` splits a
	// read-only view; `q` exits.
	const menuScript = [
		'set +m',
		"CYAN='\\033[1;36m' BOLD='\\033[1m' RST='\\033[0m'",
		'clear',
		'printf "$CYAN  cam init — project setup running...$RST\\n\\n"',
		'printf "  The agent is adapting the cam templates to your project.\\n\\n"',
		'printf "  ${BOLD}c${RST}  switch to agent pane (interact)\\n"',
		'printf "  ${BOLD}v${RST}  open view-only pane\\n"',
		'printf "  ${BOLD}q${RST}  close this menu\\n\\n"',
		'while true; do',
		'  read -rsn1 key',
		'  case "$key" in',
		'    c|C) tmux select-pane -t 0; break ;;',
		"    v|V) tmux split-window -v -l 12 \"tmux pipe-pane -o -t 0 'cat >> /tmp/cam-agent-view.log'; tail -f /tmp/cam-agent-view.log\"; break ;;",
		'    q|Q) exit 0 ;;',
		'  esac',
		'done',
	].join('\n');

	const insideTmux = Boolean(process.env['TMUX']);

	if (insideTmux) {
		// We are already in a tmux session.
		// 1. Split right (pane 1 = menu), keep focus on current pane.
		// 2. Run the agent in the current pane (pane 0).
		const menuResult = spawnSync(
			'tmux',
			['split-window', '-h', '-l', '36', '-d', 'bash', '-c', menuScript],
			{ stdio: 'inherit' },
		);
		if ((menuResult.status ?? 1) !== 0) {
			printWarning('tmux split for menu pane failed — continuing without it');
		}
		// Replace current pane with the agent (exec so it inherits the pane).
		spawnSync('tmux', ['send-keys', `bash -c ${JSON.stringify(agentCmd)}`, 'Enter'], {
			stdio: 'inherit',
		});
	} else {
		// Outside tmux: create a detached session, agent in pane 0.
		const sessionName = 'cam-setup';
		spawnSync(
			'tmux',
			[
				'new-session', '-d',
				'-s', sessionName,
				'-x', '220', '-y', '50',
				'bash', '-c', agentCmd,
			],
			{ cwd, stdio: 'inherit' },
		);
		// Add the menu pane (pane 1) in the same window.
		spawnSync(
			'tmux',
			['split-window', '-t', `${sessionName}:0`, '-h', '-l', '36', '-d', 'bash', '-c', menuScript],
			{ stdio: 'inherit' },
		);
		printSuccess(`tmux session "${sessionName}" created`);
		printHint(`attach:           tmux attach -t ${sessionName}`);
		printHint(`attach read-only: tmux attach -t ${sessionName} -r`);
	}
}


// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function runSetup(options: SetupOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();

	// --- Step 1: new or existing? -------------------------------------------
	let projectMode = options.projectMode;
	if (!projectMode) {
		projectMode = await askChoice(
			'Is this a new project or an existing one?',
			['new', 'existing'] as const,
			'existing',
		);
	}
	printSuccess(`project mode: ${projectMode}`);

	// --- Step 2: verify claude is installed and logged in ------------------
	const agentResult = verifyAgent();
	if (agentResult.ok) {
		printSuccess(`claude found at ${agentResult.path}`);
	} else {
		printError('claude not ready', agentResult.hint);
		printHint('fix the issues above and re-run `cam init`');
		return 1;
	}

	// --- Step 5: project description (new projects only) --------------------
	let description = options.description ?? '';
	if (projectMode === 'new' && !description) {
		description = await ask('What is this project about? (free-form): ');
		if (!description) {
			printWarning('No description provided — the agent will infer from the codebase.');
		}
	}

	// --- Step 6: copy templates ---------------------------------------------
	copyTemplates(cwd);

	// --- Step 7: spawn tmux split (unless --no-tmux) ------------------------
	if (options.noTmux) {
		printSuccess('templates installed — skipping tmux (--no-tmux)');
		printHint('next: open your project in Claude Code and run /cam-plan');
		return 0;
	}

	const prompt = buildSetupPrompt({ projectMode, description });

	try {
		spawnSetupTmux({ prompt, cwd });
		printSuccess('setup agent launched in tmux split');
	} catch (err) {
		printError(
			'failed to launch tmux split',
			err instanceof Error ? err.message : String(err),
		);
		printHint('run `cam init --no-tmux` to skip the tmux step and install templates only');
		return 1;
	}

	return 0;
}

// ---------------------------------------------------------------------------
// Arg parser (called from index.ts)
// ---------------------------------------------------------------------------

export interface ParsedSetupArgs {
	projectMode?: ProjectMode;
	description?: string;
	noTmux: boolean;
	help: boolean;
}

export function parseSetupArgs(args: string[]): ParsedSetupArgs | null {
	const result: ParsedSetupArgs = { noTmux: false, help: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '--help' || arg === '-h') { result.help = true; continue; }
		if (arg === '--new') { result.projectMode = 'new'; continue; }
		if (arg === '--existing') { result.projectMode = 'existing'; continue; }
		if (arg === '--no-tmux') { result.noTmux = true; continue; }
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
		printError(`unknown init option: ${arg}`);
		return null;
	}
	return result;
}
