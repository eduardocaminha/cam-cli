// src/commands/run.ts
//
// `cam run` — opens or attaches the long-lived orchestrator tmux session.
//
// Behaviour (per project decision: always tmux, single session per project):
//   1. Compute the session name from the project (cwd basename + short hash).
//   2. If `tmux has-session -t <name>` succeeds → attach IF the session is
//      healthy; if it is stale/malformed (cat-placeholder panes, wrong pane
//      count) kill + recreate it fresh first (CAM-47, isSessionStale). A healthy
//      running session is never reset, so an active loop is not killed.
//   3. Otherwise → create a new session with 2 panes via ensureProjectSession:
//        Pane 0 (left):   claude orchestrator with boot prompt (US-001).
//        Pane 1 (right):  cam dashboard, permanent pane (US-002, US-010).
//      Then attach.
//
// Dependencies:
//   - tmux on PATH (verified by `cam init`).
//   - claude on PATH (verified by `cam init`).
//   - .claude/agents/subagent-orchestrator.md present in cwd (installed by
//     `cam init` stage 2).
//
// CLI contract:
//   cam run [--no-attach]         (don't attach, just create the session)

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

import { printError } from '../logging/color.ts';
import {
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
	emitWarn,
} from '../logging/screen.ts';
import {
	projectSessionName,
	ensureProjectSession,
	isSessionStale,
	tmuxArgs,
	type SpawnFn,
	type CreatedPaneIds,
} from '../tmux/session.ts';

// Re-export projectSessionName so existing callers (test/run.test.ts) continue
// to import it from this module without breaking.
export { projectSessionName } from '../tmux/session.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunOptions {
	noAttach?: boolean;
	cwd?: string;
	/** Injectable spawn function for unit tests. Defaults to spawnSync. */
	spawnFn?: SpawnFn;
	/** Injectable session-id generator for unit tests. Defaults to randomUUID. */
	genSessionId?: () => string;
}

export interface ParsedRunArgs {
	noAttach: boolean;
	help: boolean;
}

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------

function tmuxAvailable(spawnFn: SpawnFn): boolean {
	const r = spawnFn('tmux', tmuxArgs(['-V']), { stdio: 'ignore' });
	return (r.status ?? 1) === 0;
}

// ---------------------------------------------------------------------------
// Boot prompt
// ---------------------------------------------------------------------------

/**
 * The first message we feed claude so the orchestrator persona loads.
 *
 * We point at the agent file rather than inlining its contents — keeping the
 * prompt small and letting claude follow its `.claude/agents/` lookup.
 */
export function buildOrchestratorBootPrompt(): string {
	return [
		'You are the cam orchestrator for this project.',
		'',
		'Read .claude/agents/subagent-orchestrator.md NOW. That file is your',
		'system prompt — every instruction in it applies to you for the entire',
		'duration of this session.',
		'',
		'If .claude/.cam-orch-handoff.json exists, read it FIRST and rehydrate from',
		"it: it is your previous self's serialized context (a token-budget",
		'self-handoff, CAM-23). Otherwise perform the cold-boot context sequence the',
		'agent file documents.',
		'',
		'After reading it, perform the boot context steps it documents (read',
		'CLAUDE.md, project.toml, journal.md, prd.json, current git state),',
		'then greet the operator with the one-screen summary it specifies.',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Orchestrator pane command (CAM-23: bounded self-handoff respawn)
// ---------------------------------------------------------------------------

/** Max consecutive orchestrator self-respawns per tmux session before teardown (CAM-23). */
export const DEFAULT_MAX_ORCH_RESPAWNS = 5;

/** Inputs for {@link buildOrchestratorPaneCommand}. */
export interface OrchestratorPaneCommandOptions {
	/** tmux session name to kill on teardown. */
	sessionName: string;
	/** Initial orchestrator session uuid (genSessionId; respawns mint fresh via uuidgen). */
	sessionId: string;
	/** Path to the boot-prompt file the orchestrator reads. */
	promptFile: string;
	/** Path to .cam-orch-session, rewritten with the fresh uuid on each respawn. */
	sessionIdMarker: string;
	/** Path to .cam-orch-handoff.json; its presence on claude exit triggers a respawn. */
	handoffMarker: string;
	/** Path to the loop state file (.claude/cam-loop.local.md); removed on teardown so an
	 * `/exit` leaves no stale state (matches `cam stop`, which `kill-session` alone did not). */
	stateFile: string;
	/** Max consecutive respawns (default DEFAULT_MAX_ORCH_RESPAWNS). */
	maxRespawns?: number;
}

/**
 * Build the `bash -c` payload for the orchestrator pane (CAM-23 US-003).
 *
 * The wrapper runs claude in a BOUNDED loop. On each claude exit it inspects the
 * handoff marker: if present (and under the respawn cap) it consumes the handoff
 * (rename to .consumed.json so the same payload cannot re-trigger), mints a FRESH
 * session uuid via `uuidgen`, rewrites .cam-orch-session, and re-execs claude so
 * the new session rehydrates from the handoff (US-004). Otherwise it tears the
 * tmux session down: removes the loop state file (so a clean `/exit` leaves no
 * stale `cam-loop.local.md`, matching `cam stop`) then kill-session. `bypassPermissions`
 * is preserved (intentional, 2026-06-06 lesson on macOS amfid). Pure string
 * assembly, no I/O, so it is unit-testable.
 */
export function buildOrchestratorPaneCommand(opts: OrchestratorPaneCommandOptions): string {
	const max = opts.maxRespawns ?? DEFAULT_MAX_ORCH_RESPAWNS;
	const consumed = opts.handoffMarker.replace(/\.json$/, '.consumed.json');
	// Single-quote-escape paths/values embedded in the bash -c string so a cwd
	// with spaces or quotes cannot break out of the argument boundary.
	const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
	return (
		`sid=${q(opts.sessionId)}; n=0; max=${max}; ` +
		`while true; do ` +
		`claude --permission-mode bypassPermissions --session-id "$sid" "$(cat ${q(opts.promptFile)})"; ` +
		`if [ -f ${q(opts.handoffMarker)} ] && [ "$n" -lt "$max" ]; then ` +
		`mv ${q(opts.handoffMarker)} ${q(consumed)}; ` +
		// Lowercase the uuid: macOS `uuidgen` emits UPPERCASE, but claude writes
		// transcripts with lowercase-uuid filenames (node randomUUID is lowercase),
		// so an uppercase --session-id would make orchestratorTranscriptPath miss
		// the transcript after a respawn and silently disable the budget check.
		`sid=$(uuidgen | tr 'A-Z' 'a-z'); ` +
		`printf '%s' "$sid" > ${q(opts.sessionIdMarker)}; ` +
		`n=$((n + 1)); ` +
		`else ` +
		`if [ "$n" -ge "$max" ]; then echo "cam: orchestrator respawn cap ($max) reached, tearing down"; fi; ` +
		// Clear the loop state file before kill-session so a clean `/exit` leaves no
		// stale `cam-loop.local.md` (kill-session alone left it; `cam stop` removes it).
		`rm -f ${q(opts.stateFile)}; ` +
		// sessionName is a sanitized identifier (projectSessionName); unquoted to
		// match the pre-CAM-23 command + the kill-session assertion in run.test.ts.
		`tmux -L cam kill-session -t ${opts.sessionName}; break; ` +
		`fi; ` +
		`done`
	);
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

/**
 * Create the orchestrator session using the shared session module.
 *
 * Delegates layout creation to ensureProjectSession (2-pane detached session),
 * then respawns the real command into each pane (replacing the silent `cat`
 * placeholder so no interactive shell flashes before it):
 *   - Pane 0: claude orchestrator (via `bash -c`, chained to kill-session).
 *   - Pane 1: `cam dashboard <orchPaneId>` (permanent monitor; orchPaneId binds
 *     the dashboard dispatch wiring to the real orchestrator pane).
 *
 * Pane IDs returned by ensureProjectSession are stable %<n> identifiers that
 * work regardless of the user's pane-base-index in .tmux.conf.
 *
 * Returns { sessionName, created: true } when a new session was built,
 * { sessionName, created: false } when it already existed (just attach).
 */
interface SetupOpts {
	cwd: string;
	sessionName: string;
	spawnFn: SpawnFn;
	genSessionId: () => string;
}

/**
 * Open or reconcile the orchestrator session (CAM-47):
 *   - new session             -> build + set up the 2 panes. created: true.
 *   - existing + healthy       -> attach untouched. created: false.
 *   - existing + stale/broken  -> kill + recreate fresh. created: true, reset: true.
 *
 * A healthy running session is NEVER reset (isSessionStale is conservative), so
 * `cam run` re-attach does not kill an active orchestrator/loop.
 */
function setupOrchestratorSession(opts: SetupOpts): {
	sessionName: string;
	created: boolean;
	reset: boolean;
} {
	const { sessionName, spawnFn } = opts;

	let panes: CreatedPaneIds | false = ensureProjectSession(sessionName, spawnFn);
	let reset = false;
	if (!panes) {
		// Session already exists. Attach only if healthy; a stale/half-setup
		// session (cat-placeholder panes, wrong pane count) is recreated so the
		// operator does not inherit a broken layout instead of being reconciled.
		if (!isSessionStale(sessionName, spawnFn)) {
			return { sessionName, created: false, reset: false };
		}
		spawnFn('tmux', tmuxArgs(['kill-session', '-t', sessionName]), { stdio: 'ignore' });
		panes = ensureProjectSession(sessionName, spawnFn);
		if (!panes) {
			// Recreate failed right after kill (should not happen): fall back to attach.
			return { sessionName, created: false, reset: false };
		}
		reset = true;
	}

	setupPanes(opts, panes);
	return { sessionName, created: true, reset };
}

/** Respawn the real commands into the 2 panes and apply the workspace chrome. */
function setupPanes(opts: SetupOpts, panes: CreatedPaneIds): void {
	const { cwd, sessionName, spawnFn, genSessionId } = opts;
	const { orchPaneId, dashboardPaneId } = panes;

	// CAM-23: a freshly created session must not inherit a stale handoff. If a
	// previous session was killed (cam stop, tmux kill-server, reboot) AFTER its
	// agent wrote .cam-orch-handoff.json but BEFORE the wrapper consumed it, the
	// file would linger and make this new session rehydrate from (and respawn off)
	// the wrong payload. Clear it; best-effort, a leftover is non-fatal.
	const staleHandoff = join(cwd, '.claude', '.cam-orch-handoff.json');
	if (existsSync(staleHandoff)) {
		try {
			rmSync(staleHandoff);
		} catch {
			// non-fatal: the wrapper would still consume it on the first exit.
		}
	}

	// Persist the boot prompt to a file so the agent command stays simple.
	const dotClaude = join(cwd, '.claude');
	mkdirSync(dotClaude, { recursive: true });
	const promptFile = join(dotClaude, '.cam-orchestrator-prompt.txt');
	writeFileSync(promptFile, buildOrchestratorBootPrompt(), 'utf8');

	// Generate and persist the orchestrator session id so the dashboard can
	// locate the JSONL transcript for token-spend reporting (US-002).
	const sessionId = genSessionId();
	writeFileSync(join(dotClaude, '.cam-orch-session'), sessionId, 'utf8');

	// Pane 0: orchestrator (claude), wrapped in the CAM-23 bounded self-handoff
	// loop. --permission-mode bypassPermissions is INTENTIONAL (2026-06-06): the
	// orchestrator runs unattended and must bypass; do NOT change to
	// readPermissionMode. --session-id passes the known uuid so the transcript is
	// written at <claudeDir>/projects/<encode(cwd)>/<uuid>.jsonl (US-002). On
	// claude exit the wrapper either respawns a FRESH orchestrator reading the
	// handoff (when .cam-orch-handoff.json is present, bounded by maxRespawns) or
	// kill-sessions the whole tmux session (the pre-CAM-23 teardown).
	const agentCmd = buildOrchestratorPaneCommand({
		sessionName,
		sessionId,
		promptFile,
		sessionIdMarker: join(dotClaude, '.cam-orch-session'),
		handoffMarker: join(dotClaude, '.cam-orch-handoff.json'),
		stateFile: join(dotClaude, 'cam-loop.local.md'),
	});
	// respawn-pane -k runs the command DIRECTLY in the pane, replacing the silent
	// `cat` placeholder. No interactive bash means no macOS zsh notice / prompt /
	// command echo flashing before the real command paints (`bash -c` is
	// non-interactive).
	spawnFn(
		'tmux',
		tmuxArgs(['respawn-pane', '-k', '-t', orchPaneId, 'bash', '-c', agentCmd]),
		{ stdio: 'ignore' },
	);

	// Pane 1: cam dashboard, permanent pane (US-002, US-010). Direct respawn,
	// no shell. The orchPaneId positional binds the dashboard dispatch wiring to
	// the real orchestrator pane (US-003/US-004). `q` exits the dashboard which
	// closes the pane; tmux reflows the survivor to fill the right column.
	spawnFn(
		'tmux',
		tmuxArgs(['respawn-pane', '-k', '-t', dashboardPaneId, 'cam', 'dashboard', orchPaneId]),
		{ stdio: 'ignore' },
	);

	// --- Workspace chrome (CAM-19) ------------------------------------------
	// Label each pane with a thin tmux border title, recolor to the cam design
	// tokens, highlight the active pane, and render a single status bar
	// (active pane | dim nav hint | cam-cli). Labels use a per-pane USER option
	// (@cam_label) rather than #{pane_title} because the orchestrator pane runs
	// claude, which can overwrite pane_title via OSC — a user option can't be
	// clobbered by the app. Option syntax validated against tmux 3.x.
	const ACCENT = '#4EBE7D';
	const MUTED = '#808080';
	const DARK = '#000000'; // dark fg readable on the accent green pill background
	const opt = (name: string, value: string): void => {
		spawnFn('tmux', tmuxArgs(['set-option', '-t', sessionName, name, value]), { stdio: 'ignore' });
	};
	const winOpt = (name: string, value: string): void => {
		spawnFn('tmux', tmuxArgs(['set-window-option', '-t', sessionName, name, value]), { stdio: 'ignore' });
	};
	const paneLabel = (paneId: string, label: string): void => {
		spawnFn('tmux', tmuxArgs(['set-option', '-p', '-t', paneId, '@cam_label', label]), { stdio: 'ignore' });
	};
	paneLabel(orchPaneId, 'orchestrator');
	paneLabel(dashboardPaneId, 'dashboard');
	const navHint = `#[fg=${MUTED}]click / Ctrl+b ←→ switch · exit orchestrator quits`;
	opt('pane-border-status', 'top');
	// Active pane title: same green pill as the status-left active indicator
	// (bg=accent fg=dark), so "green pill = active" reads the same top and bottom.
	// Inactive panes stay muted text.
	opt('pane-border-format', `#{?pane_active,#[bg=${ACCENT} fg=${DARK} bold] #{@cam_label} ,#[fg=${MUTED}] #{@cam_label} }#[default]`);
	// Both border styles are ACCENT so the SHARED divider is uniformly green
	// regardless of focus. tmux colors each side of a shared border with that
	// pane's own style; a muted inactive style left the divider half-green and
	// flipping with focus. The active pane is signalled by the green title pill,
	// not the border, so uniform-green borders lose no information.
	opt('pane-active-border-style', `fg=${ACCENT}`);
	opt('pane-border-style', `fg=${ACCENT}`);
	opt('status', 'on');
	// absolute-centre keeps the nav hint pinned to the middle of the FULL bar
	// regardless of the status-left/right widths, so it does not drift when the
	// active-pane name changes length (orchestrator vs menu).
	opt('status-justify', 'absolute-centre');
	opt('status-style', `bg=default fg=${MUTED}`);
	// Left: active-pane green pill. Right: cam-cli.
	opt('status-left', `#[fg=${MUTED}]active: #[bg=${ACCENT} fg=${DARK} bold] #{@cam_label} #[default]`);
	opt('status-left-length', '40');
	opt('status-right', `#[fg=${ACCENT} bold] cam-cli #[default]`);
	opt('status-right-length', '24');
	winOpt('window-status-format', navHint);
	winOpt('window-status-current-format', navHint);

	// Enable mouse mode on this session so the operator can click a pane to
	// focus it and scroll with the trackpad, instead of the tmux prefix dance
	// (Ctrl+b + arrows). Scoped to this session only. Note: with mouse on,
	// selecting text to copy needs Option held down (macOS Terminal/iTerm).
	spawnFn('tmux', tmuxArgs(['set-option', '-t', sessionName, 'mouse', 'on']), { stdio: 'ignore' });

	// Make sure focus is on the orchestrator pane.
	spawnFn('tmux', tmuxArgs(['select-pane', '-t', orchPaneId]), { stdio: 'ignore' });
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export function runRun(options: RunOptions = {}): number {
	const cwd = options.cwd ?? process.cwd();
	const spawnFn: SpawnFn = options.spawnFn ?? ((cmd, args, opts) =>
		spawnSync(cmd, args, { stdio: opts?.stdio ?? 'ignore' })
	);
	const genSessionId = options.genSessionId ?? randomUUID;

	// Title + leading blank up-front so every code path below shares the same
	// hierarchy as `cam status` / `cam help`.
	emitTitle('cam run');

	// 1. Pre-flight checks. Errors use `printError` directly (destructive
	//    bold lives at col 0 by design — it must stand out, not nestle inside
	//    a Section column).
	if (!tmuxAvailable(spawnFn)) {
		printError('tmux is not on PATH', 'install tmux and re-run `cam run`');
		emitTrailingBlank();
		return 1;
	}

	const orchestratorAgent = join(cwd, '.claude', 'agents', 'subagent-orchestrator.md');
	if (!existsSync(orchestratorAgent)) {
		printError(
			'subagent-orchestrator.md not found',
			'This project has not been initialized — run `cam init` first',
		);
		emitTrailingBlank();
		return 1;
	}

	// 2. Compute session name.
	const sessionName = projectSessionName(cwd);

	// 3. Open the "Session" section — everything from here is part of the
	//    create/attach narrative, so it lives under one heading.
	emitSectionHeading('Session');

	// Tests set CAM_RUN_DRY_RUN=1 to exercise pre-flight without spawning
	// real tmux processes. In that mode we only verify checks pass and
	// return 0 immediately.
	if (process.env['CAM_RUN_DRY_RUN'] === '1') {
		emitOk(`[dry-run] would create/attach session "${sessionName}"`);
		emitTrailingBlank();
		return 0;
	}

	let result: { sessionName: string; created: boolean; reset: boolean };
	try {
		result = setupOrchestratorSession({ cwd, sessionName, spawnFn, genSessionId });
		if (result.reset) {
			emitOk(`stale tmux session "${sessionName}" detected, recreated clean`);
		} else if (result.created) {
			emitOk(`tmux session "${sessionName}" created`);
		} else {
			emitOk(`tmux session "${sessionName}" already exists — attaching`);
		}
	} catch (err) {
		printError(
			'Failed to create orchestrator session',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}

	// 4. Attach (unless --no-attach).
	if (options.noAttach) {
		emitMutedHint(`Attach manually: tmux attach -t ${result.sessionName}`);
		emitTrailingBlank();
		return 0;
	}

	// `tmux attach` blocks until the user detaches. Inside another tmux,
	// `attach` is rejected — we use `switch-client` instead.
	const insideTmux = Boolean(process.env['TMUX']);
	const attach = insideTmux
		? spawnFn('tmux', tmuxArgs(['switch-client', '-t', result.sessionName]), { stdio: 'inherit' })
		: spawnFn('tmux', tmuxArgs(['attach-session', '-t', result.sessionName]), { stdio: 'inherit' });

	if ((attach.status ?? 1) !== 0) {
		emitWarn('tmux attach failed', `try manually: tmux attach -t ${result.sessionName}`);
		emitTrailingBlank();
		return attach.status ?? 1;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Arg parser (called from index.ts)
// ---------------------------------------------------------------------------

export function parseRunArgs(args: string[]): ParsedRunArgs | null {
	const result: ParsedRunArgs = { noAttach: false, help: false };
	for (const arg of args) {
		if (arg === '--help' || arg === '-h') {
			result.help = true;
			continue;
		}
		if (arg === '--no-attach') {
			result.noAttach = true;
			continue;
		}
		printError(`Unknown run option: ${arg}`);
		return null;
	}
	return result;
}
