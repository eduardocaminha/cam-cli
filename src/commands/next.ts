// src/commands/next.ts
//
// Implementation of `cam next` — spawns the autonomous loop.
//
// What `cam next` does, step by step:
//   1. Resolves `permission_mode` from `~/.config/cam/config.toml` via
//      `readPermissionMode()` (default `bypassPermissions`). NO CLI flag
//      overrides this — see acceptance criterion 7 of US-007 and
//      `test/no-permission-mode-flag.test.ts`.
//   2. Pre-arms the cam-loop state file `.claude/cam-loop.local.md` BEFORE
//      claude starts, using the YAML-frontmatter-plus-prompt template at
//      `vendor/cam-loop.local.md.tmpl`. The companion stop hook
//      `vendor/cam-loop-stop-hook.sh` reads this file on every Stop event
//      and either re-emits the prompt or removes the file to terminate.
//   3. Detects the split mode:
//        - `tmux` on PATH → tmux-split: pane A runs claude in the current
//          terminal, pane B runs `cam dashboard` in a tmux pane. Works in
//          any terminal (Ghostty, iTerm2, Kitty, Terminal.app, SSH, etc.).
//          If already inside tmux ($TMUX set), uses `tmux split-window -h`.
//          Otherwise creates a new detached session named `cam`.
//        - VS Code (`TERM_PROGRAM=vscode`) → inline single-pane fallback.
//        - No tmux → inline single-pane fallback.
//   4. Returns the exit code of the spawned subprocess. For tmux splits,
//      the tmux call returns immediately; cam waits on the claude subprocess.
//
// Acceptance criteria (US-007):
//   1. `cam next` exists as a CLI subcommand (wired in `index.ts`).
//   2. Detects tmux + spawns split with claude (pane A) and
//      `cam dashboard` (pane B); plugin state file pre-armed.
//   3. Detects `TERM_PROGRAM=vscode` and falls back to inline single-pane.
//   4. Pre-arming uses the vendored `cam-loop.local.md.tmpl`.
//   5. Default `--max-iterations 30 --completion-promise "COMPLETE"`;
//      both overridable via `--max-iter N --completion-promise STR`.
//   6. Bun unit test mocks spawn + asserts pre-arming file is written and
//      the right args are passed.
//   7. No subcommand exposes `--permission-mode`; sourced from config.
//   8. `bunx tsc --noEmit` passes.
//
// Implementation notes:
// - `Bun.spawn` is the canonical spawn primitive (US-006 validated the API
//   surface against https://bun.sh/docs/api/spawn). We accept a `SpawnFn`
//   factory injection point for tests, exactly like `runPlan`.
// - `writeStateFile` is its own injection point so tests can verify what
//   would be written without touching the real filesystem.
// - The `dashboardCmd` injection point lets tests assert pane B's argv
//   without spawning the dashboard's alt-screen loop in a test runner.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { readPermissionMode } from '../config/permission-mode.ts';
import { printError } from '../logging/color.ts';
import {
	emitAttachHint,
	emitMutedHint,
	emitOk,
	emitSectionHeading,
	emitTitle,
	emitTrailingBlank,
	emitWarn,
} from '../logging/screen.ts';
import {
	ensureProjectSession,
	openPaneInSession,
	projectSessionName,
	type Env,
	type SpawnFn as TmuxSpawnFn,
} from '../tmux/session.ts';
import { readEmbedded } from '../vendor/embedded.ts';

// --- Constants -------------------------------------------------------------

/**
 * Default `--max-iterations` passed to the cam-loop plugin. 30 covers a
 * typical 15-story PRD plus a couple of review rounds — see
 * `scripts/cam/CLAUDE.md § Autonomous loop via the official cam-loop plugin`.
 */
export const DEFAULT_MAX_ITERATIONS = 30;

/**
 * Default `--completion-promise` value. The assistant emits
 * `<promise>COMPLETE</promise>` when the PRD is done, which the plugin's
 * stop hook compares case-sensitively.
 */
export const DEFAULT_COMPLETION_PROMISE = 'COMPLETE';

/**
 * The slash command that gets re-injected every turn by the plugin's stop
 * hook. Becomes the body of the state file (after the YAML frontmatter).
 */
const CAM_NEXT_PROMPT = '/cam-next';

/** State-file path relative to cwd. Owned by the upstream plugin. */
const STATE_FILE_PATH = '.claude/cam-loop.local.md';

// --- Host detection --------------------------------------------------------

export type HostMode = 'tmux-split' | 'inline';

/**
 * Injection type for a synchronous spawn used only to probe `tmux`.
 * Keeping it synchronous (~5ms) avoids async plumbing overhead for a
 * quick capability probe.
 *
 * `cmd` is argv-style. Returns `{ exitCode }`.
 * Returns `null` (or throws) if the binary is not on PATH.
 */
export type TmuxProbeFn = (cmd: string[]) => { exitCode: number } | null;

/** Default synchronous probe using `Bun.spawnSync`. */
function defaultTmuxProbe(cmd: string[]): { exitCode: number } | null {
	try {
		const result = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
		return { exitCode: result.exitCode ?? 1 };
	} catch {
		return null;
	}
}

/**
 * Detect the split mode to use.
 *
 * Resolution order:
 *   1. `TERM_PROGRAM=vscode` → inline (IDE embedded terminal; splitting would
 *      open a pane inside VS Code's terminal, which is confusing).
 *   2. `tmux` on PATH → `tmux-split`. Works in any terminal that has tmux
 *      (Ghostty, iTerm2, Kitty, plain Terminal.app, SSH sessions, etc.).
 *      If we are already inside a tmux session (`$TMUX` set), we split the
 *      current window. Otherwise we create a new detached session named `cam`.
 *   3. Anything else → inline.
 */
export function detectHost(
	env: NodeJS.ProcessEnv = process.env,
	tmuxProbe: TmuxProbeFn = defaultTmuxProbe,
): HostMode {
	if (env['TERM_PROGRAM'] === 'vscode') return 'inline';
	const probeResult = tmuxProbe(['tmux', '-V']);
	if (probeResult === null || probeResult.exitCode !== 0) return 'inline';
	return 'tmux-split';
}

// --- Vendored template -----------------------------------------------------

/**
 * Render the state-file body from the vendored template. Substitution is a
 * dumb literal `{{KEY}} → value` replace; we don't escape because the values
 * are constrained by us (an integer iteration cap, a non-empty literal
 * promise string, an ISO timestamp). The promise string is wrapped in YAML
 * double quotes to keep parity with the plugin's setup script.
 *
 * The template body comes from `vendor/cam-loop.local.md.tmpl`, which is
 * embedded into the compiled binary via `with { type: "file" }` (see
 * `src/vendor/embedded.ts`). In dev mode this reads from the real file on
 * disk; in compiled mode it reads from the bundled `$bunfs/` virtual path.
 */
export function renderStateFile(input: {
	maxIterations: number;
	completionPromise: string;
	prompt: string;
	startedAt: string;
	sessionId: string;
	/**
	 * PID of the long-running driver process (claude, spawned by cam next)
	 * that owns the loop. `cam resume` (US-010) reads this back to
	 * distinguish a still-alive loop from an orphaned state file: a stale
	 * PID with no live process means the loop crashed (terminal closed, OS
	 * rebooted, hard-kill). Defaults to `process.pid` when not provided.
	 */
	pid: number;
}): string {
	const tmpl = readEmbedded('cam-loop.local.md.tmpl');
	const promiseYaml =
		input.completionPromise.length === 0
			? 'null'
			: `"${input.completionPromise.replace(/"/g, '\\"')}"`;
	return tmpl
		.replace('{{SESSION_ID}}', input.sessionId)
		.replace('{{MAX_ITERATIONS}}', String(input.maxIterations))
		.replace('{{COMPLETION_PROMISE_YAML}}', promiseYaml)
		.replace('{{STARTED_AT}}', input.startedAt)
		.replace('{{PID}}', String(input.pid))
		.replace('{{PROMPT}}', input.prompt);
}

/**
 * Write `.claude/cam-loop.local.md` under `cwd`, creating `.claude/` if
 * needed. Returns the absolute path written. Refuses to clobber an existing
 * file unless `force` is true — an existing state file usually means a
 * previous loop is already running, and stomping on it would mid-flight
 * corrupt the iteration counter. The operator is told to clean up via
 * `/cancel-cam` (or `rm .claude/cam-loop.local.md`) before re-running.
 */
export function writeStateFile(
	cwd: string,
	body: string,
	options: { force?: boolean } = {},
): string {
	const target = join(cwd, STATE_FILE_PATH);
	const dir = dirname(target);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	if (existsSync(target) && !options.force) {
		throw new Error(
			`state file already exists at ${target} — run \`/cancel-cam\` (in the active session) or \`rm ${STATE_FILE_PATH}\` to clear`,
		);
	}
	writeFileSync(target, body, 'utf8');
	return target;
}

// --- Stop-hook materialization ---------------------------------------------

/** Path of the stop hook relative to cwd. */
export const STOP_HOOK_RELATIVE = '.claude/hooks/cam-loop-stop.sh';

/** Path of the project-local Claude settings file relative to cwd. */
export const SETTINGS_LOCAL_RELATIVE = '.claude/settings.local.json';

/**
 * The Claude Code hooks shape this story registers. The Stop event receives
 * a nested array of hook matchers; each matcher has a `hooks` array of
 * command descriptors. Per claude-code-hooks docs:
 *   { hooks: { Stop: [ { hooks: [ { type: 'command', command: '...' } ] } ] } }
 */
const STOP_HOOK_COMMAND = `bash ${STOP_HOOK_RELATIVE}`;

/**
 * Materialize the vendored stop-hook script to `<cwd>/.claude/hooks/cam-loop-stop.sh`
 * and chmod it executable. Called BEFORE writing the plugin state file so the
 * hook is registered before claude starts.
 *
 * Injection point `getStopHookContents` lets tests supply a fake body so they
 * don't depend on the real embedded asset.
 */
export function materializeStopHook(
	cwd: string,
	getStopHookContents: () => string = () => readEmbedded('cam-loop-stop-hook.sh'),
): string {
	const target = join(cwd, STOP_HOOK_RELATIVE);
	const dir = dirname(target);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const contents = getStopHookContents();
	writeFileSync(target, contents, 'utf8');
	chmodSync(target, 0o755);
	return target;
}

/**
 * Deep-merge helper for plain JSON objects. Source keys overwrite destination
 * keys at every depth; array values are replaced (not concatenated) to keep
 * the merge predictable. Non-object values at the same key follow the same
 * last-write-wins rule.
 *
 * We keep this intentionally minimal — `settings.local.json` only ever has
 * a shallow-to-medium depth (`hooks.Stop[0].hooks[0].command`), so a full
 * recursive merge is strictly more than needed but adds no risk.
 */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...target };
	for (const [key, val] of Object.entries(source)) {
		const existing = result[key];
		if (
			val !== null &&
			typeof val === 'object' &&
			!Array.isArray(val) &&
			existing !== null &&
			typeof existing === 'object' &&
			!Array.isArray(existing)
		) {
			result[key] = deepMerge(
				existing as Record<string, unknown>,
				val as Record<string, unknown>,
			);
		} else {
			result[key] = val;
		}
	}
	return result;
}

/**
 * The hooks block cam injects into `.claude/settings.local.json`. We write
 * this shape because the Claude Code hooks API requires the nested form:
 *   { hooks: { Stop: [ { hooks: [ { type: 'command', command: '...' } ] } ] } }
 * This is the canonical hooks document format per claude-code-hooks docs.
 */
function buildHooksBlock(): Record<string, unknown> {
	return {
		hooks: {
			Stop: [
				{
					hooks: [
						{
							type: 'command',
							command: STOP_HOOK_COMMAND,
						},
					],
				},
			],
		},
	};
}

/**
 * Write or merge `<cwd>/.claude/settings.local.json` so the Stop hook command
 * is registered. Existing keys in the file are preserved via deep-merge — we
 * never overwrite a key that cam didn't put there.
 *
 * Injection point `reader` lets tests supply existing file contents without
 * touching the real filesystem.
 */
export function writeSettingsLocal(
	cwd: string,
	reader: (path: string) => string | null = (p) => {
		try {
			return existsSync(p) ? readFileSync(p, 'utf8') : null;
		} catch {
			return null;
		}
	},
): string {
	const target = join(cwd, SETTINGS_LOCAL_RELATIVE);
	const dir = dirname(target);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const raw = reader(target);
	let existing: Record<string, unknown> = {};
	if (raw !== null && raw.trim().length > 0) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		} catch {
			// Malformed JSON — start from an empty object rather than clobbering.
			// The merge below will add our keys without losing any valid state.
		}
	}

	const merged = deepMerge(existing, buildHooksBlock());
	writeFileSync(target, JSON.stringify(merged, null, 2) + '\n', 'utf8');
	return target;
}

// --- Spawn surface ---------------------------------------------------------

/**
 * The subset of `Bun.Subprocess` cam-next uses. Mirrors the shape from
 * `commands/plan.ts` so the test fakes can be shared.
 */
export interface NextSubprocess {
	readonly exited: Promise<number>;
	kill(signal?: number | string): void;
}

/**
 * Spawn factory — `cmd` is argv-style; `cwd` is the working directory.
 * Tests inject a fake that records the cmd + cwd and resolves `exited`
 * on demand.
 */
export type NextSpawnFn = (cmd: string[], options: { cwd: string }) => NextSubprocess;

/**
 * Default spawn — `Bun.spawn` with stdio:'inherit' across the board. We
 * inherit stdin/stdout/stderr because (1) the operator interacts with
 * claude's TUI directly and (2) for the inline fallback the dashboard is
 * the IDE's own terminal output (no separate pane to stream to).
 *
 * For the Ghostty split case, `ghostty +new-split horizontal -- <cmd>`
 * detaches the pane immediately (it inherits stdio from the new terminal,
 * not from this process), so the inherited stdio here is mostly a no-op —
 * `ghostty +new-split` itself writes a one-line ack to its stdout.
 */
function defaultSpawn(cmd: string[], options: { cwd: string }): NextSubprocess {
	const proc = Bun.spawn(cmd, {
		cwd: options.cwd,
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	});
	return {
		exited: proc.exited,
		kill(signal?: number | string) {
			proc.kill(signal as number | NodeJS.Signals | undefined);
		},
	};
}

// --- argv builders ---------------------------------------------------------

/**
 * Build the argv for pane A (claude with the loop pre-armed). The state
 * file has already been written to `.claude/cam-loop.local.md`; the
 * plugin's stop hook reads that file to drive the loop. We pass
 * `CAM_NEXT_PROMPT` as the trailing argument — claude treats that as
 * the first user-turn, kicking off iteration 1.
 */
export function buildClaudeArgv(permissionMode: string): string[] {
	return ['claude', '--permission-mode', permissionMode, CAM_NEXT_PROMPT];
}

/**
 * Build the argv for pane B (the read-only dashboard). On the tmux split
 * path this runs alongside claude in a sibling pane. On the inline path
 * we don't spawn a dashboard at all — the IDE / single terminal IS the
 * dashboard view of claude's output.
 *
 * The argv form is `cam dashboard` rather than `bun src/...` because by
 * the time `cam next` is invoked, the operator has installed `cam` on
 * PATH (compiled binary or dev shim) — see US-002 + US-011 for the install
 * story.
 */
export function buildDashboardArgv(): string[] {
	return ['cam', 'dashboard'];
}

// --- Public entrypoint -----------------------------------------------------

export interface NextOptions {
	/** Override `--max-iterations`; default `DEFAULT_MAX_ITERATIONS`. */
	maxIterations?: number;
	/** Override `--completion-promise`; default `DEFAULT_COMPLETION_PROMISE`. */
	completionPromise?: string;
	/** Override the host detection result (for tests). */
	hostMode?: HostMode;
	/** Override the working directory; default `process.cwd()`. */
	cwd?: string;
	/** Spawn factory — overridable for tests. */
	spawn?: NextSpawnFn;
	/**
	 * State-file writer override — overridable for tests. Receives the cwd
	 * and the rendered body; returns the path that would be written.
	 */
	writer?: (cwd: string, body: string) => string;
	/** Permission-mode override (purely for tests; production reads config). */
	permissionMode?: string;
	/** Force-overwrite an existing state file. Default: false. */
	force?: boolean;
	/** ISO timestamp used in the state-file frontmatter (override for tests). */
	startedAt?: string;
	/** Session id used in the state-file frontmatter (override for tests). */
	sessionId?: string;
	/** PID written to the state-file frontmatter (override for tests). Default: `process.pid`. */
	pid?: number;
	/**
	 * Override the stop-hook materializer for tests. Receives `cwd` and a
	 * `getContents` factory; returns the path written (or simulated).
	 */
	hookMaterializer?: (cwd: string) => string;
	/**
	 * Override the settings.local.json writer for tests. Receives `cwd`;
	 * returns the path written (or simulated).
	 */
	settingsWriter?: (cwd: string) => string;
	/**
	 * Override the tmux probe used by `detectHost`. Tests inject a scripted
	 * response so they never exec a real `tmux` binary.
	 */
	tmuxProbe?: TmuxProbeFn;
	/**
	 * Override the synchronous spawn function used for tmux session management
	 * (ensureProjectSession, openPaneInSession). Tests inject a fake so they
	 * never call a real tmux binary. Defaults to a spawnSync wrapper.
	 */
	tmuxSpawnFn?: TmuxSpawnFn;
	/**
	 * Override process.env for attach-hint detection. Tests inject a fake env
	 * to assert hint printed/suppressed without touching process.env.
	 */
	env?: Env;
}

/**
 * Run the full `cam next` flow. Returns the process exit code.
 *
 * Resolution order:
 *   - tmux-split: write state file → ensure the project session exists
 *     (3-pane layout via ensureProjectSession) → open a new pane inside
 *     the project session running `claude` (openPaneInSession). Returns 0
 *     immediately; the loop runs inside the session pane (thin launcher).
 *   - Inline fallback (VS Code or no tmux): write state file →
 *     spawn `claude ... /cam-next` in current pane. Returns claude's
 *     exit code. No session pane.
 */
export async function runNext(options: NextOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	const completionPromise = options.completionPromise ?? DEFAULT_COMPLETION_PROMISE;
	const permissionMode = options.permissionMode ?? readPermissionMode();
	const env = options.env ?? process.env;

	const host: HostMode =
		options.hostMode ?? detectHost(process.env, options.tmuxProbe);

	const spawn = options.spawn ?? defaultSpawn;
	const writer =
		options.writer ??
		((cwd2: string, body: string) => writeStateFile(cwd2, body, { force: options.force ?? false }));
	const hookMaterializer = options.hookMaterializer ?? ((cwd2: string) => materializeStopHook(cwd2));
	const settingsWriter = options.settingsWriter ?? ((cwd2: string) => writeSettingsLocal(cwd2));

	// Default synchronous spawn for tmux session management calls.
	const { spawnSync } = await import('node:child_process');
	const tmuxSpawnFn: TmuxSpawnFn =
		options.tmuxSpawnFn ??
		((cmd, args, opts) => spawnSync(cmd, args, { stdio: opts?.stdio ?? 'ignore' }));

	emitTitle('cam next');
	emitSectionHeading('Loop');

	// 0. Materialize the vendored stop hook and register it in
	//    .claude/settings.local.json BEFORE writing the state file. This
	//    ensures the hook is registered in Claude Code's settings so it fires
	//    on Stop events — even when the official cam-loop plugin is not
	//    installed in the spawned session.
	try {
		const hookPath = hookMaterializer(cwd);
		emitOk('Materialized stop hook', hookPath);
	} catch (err) {
		printError(
			'Failed to materialize stop hook',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}
	try {
		const settingsPath = settingsWriter(cwd);
		emitOk('Registered Stop hook in', settingsPath);
	} catch (err) {
		printError(
			'Failed to write .claude/settings.local.json',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}

	// 1. Render + write the state file. Failing here is fatal — without an
	//    armed plugin state file, claude wouldn't know to loop.
	const body = renderStateFile({
		maxIterations,
		completionPromise,
		prompt: CAM_NEXT_PROMPT,
		startedAt: options.startedAt ?? new Date().toISOString(),
		sessionId: options.sessionId ?? process.env['CLAUDE_CODE_SESSION_ID'] ?? '',
		pid: options.pid ?? process.pid,
	});

	let writtenPath: string;
	try {
		writtenPath = writer(cwd, body);
	} catch (err) {
		printError(
			'Failed to pre-arm cam-loop state file',
			err instanceof Error ? err.message : String(err),
		);
		emitTrailingBlank();
		return 1;
	}
	emitOk(`Armed ${writtenPath}`, `max=${maxIterations} promise="${completionPromise}"`);

	// 2. Build pane A's argv (claude with the loop kick-off prompt).
	const claudeArgv = buildClaudeArgv(permissionMode);

	// 3. Branch on host detection.
	emitSectionHeading('Host');
	if (host === 'tmux-split') {
		// Ensure the project session exists (3-pane layout: orchestrator,
		// dashboard, menu). Then open a new pane inside the session running
		// the claude loop command. This is the thin-launcher pattern: we
		// return to the caller's shell immediately; the loop lives in the
		// project session pane.
		const sessionName = projectSessionName(cwd);
		try {
			ensureProjectSession(sessionName, tmuxSpawnFn);
			const claudeCmd = claudeArgv.join(' ');
			openPaneInSession(sessionName, claudeCmd, tmuxSpawnFn);
		} catch (err) {
			emitWarn(
				'tmux session pane launch failed',
				err instanceof Error ? err.message : String(err),
			);
			emitMutedHint('Falling back to inline mode — run `cam run` to use the session');
		}
		emitOk(`Launched claude in project session "${sessionName}"`);
		emitAttachHint(sessionName, env);
		emitTrailingBlank();
		return 0;
	} else {
		emitOk('Inline mode (VS Code or no tmux): no split');
		emitMutedHint('Your current terminal is the dashboard view of the loop');
	}

	// 4. Inline fallback only: spawn claude in the foreground and wait.
	//    In tmux-split mode we already returned above.
	let claudeProc: NextSubprocess;
	try {
		claudeProc = spawn(claudeArgv, { cwd });
	} catch (err) {
		printError(
			'Failed to spawn `claude`',
			`${err instanceof Error ? err.message : String(err)} (verify claude is on PATH, re-run \`cam init\`)`,
		);
		emitTrailingBlank();
		return 1;
	}
	const exitCode = await claudeProc.exited;
	return exitCode ?? 0;
}
