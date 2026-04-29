// src/commands/next.ts
//
// Implementation of `ralph next` — spawns the autonomous loop.
//
// What `ralph next` does, step by step:
//   1. Resolves `permission_mode` from `~/.config/ralph/config.toml` via
//      `readPermissionMode()` (default `bypassPermissions`). NO CLI flag
//      overrides this — see acceptance criterion 7 of US-007 and
//      `test/no-permission-mode-flag.test.ts`.
//   2. Pre-arms the official `ralph-loop` plugin by writing its state file
//      `.claude/ralph-loop.local.md` BEFORE claude starts. The on-disk shape
//      mirrors what the plugin's `setup-ralph-loop.sh` produces (YAML
//      frontmatter + prompt body); we vendored a template at
//      `vendor/ralph-loop.local.md.tmpl` so `ralph next` works on a fresh
//      machine without shelling into the plugin's setup script.
//   3. Detects the host terminal:
//        - Ghostty (`GHOSTTY_RESOURCES_DIR` set, OR `TERM_PROGRAM=ghostty`)
//          → spawn a horizontal split via `ghostty +new-split horizontal`,
//            with pane A running `claude --permission-mode <mode> /ralph-next`
//            and pane B running `ralph dashboard` (read-only).
//        - VS Code (`TERM_PROGRAM=vscode`) → inline single-pane fallback.
//          The IDE is the dashboard; splitting into a Ghostty pane from
//          inside the embedded terminal would surprise the operator.
//        - Anything else → inline single-pane fallback. We don't try to
//          autodetect iTerm/Kitty/etc. — Ghostty is the documented driver
//          (per `scripts/ralph/CLAUDE.md § Autonomous loop via ralph CLI`).
//   4. Returns the exit code of the spawned subprocess. For Ghostty splits,
//      `ghostty +new-split` returns immediately after creating the pane; for
//      inline fallback, ralph waits on the claude subprocess.
//
// Acceptance criteria (US-007):
//   1. `ralph next` exists as a CLI subcommand (wired in `index.ts`).
//   2. Detects Ghostty + spawns horizontal split with claude (pane A) and
//      `ralph dashboard` (pane B); plugin state file pre-armed.
//   3. Detects `TERM_PROGRAM=vscode` and falls back to inline single-pane.
//   4. Pre-arming uses the vendored `ralph-loop.local.md.tmpl`.
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
import { printError, printHint, printSuccess } from '../logging/color.ts';
import { readEmbedded } from '../vendor/embedded.ts';

// --- Constants -------------------------------------------------------------

/**
 * Default `--max-iterations` passed to the ralph-loop plugin. 30 covers a
 * typical 15-story PRD plus a couple of review rounds — see
 * `scripts/ralph/CLAUDE.md § Autonomous loop via the official ralph-loop plugin`.
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
const RALPH_NEXT_PROMPT = '/ralph-next';

/** State-file path relative to cwd. Owned by the upstream plugin. */
const STATE_FILE_PATH = '.claude/ralph-loop.local.md';

// --- Host detection --------------------------------------------------------

export type HostMode = 'ghostty-split' | 'inline';

/**
 * Detect the host terminal. The detection order matters: VS Code's embedded
 * terminal sometimes also sets `GHOSTTY_RESOURCES_DIR` (the user may have
 * Ghostty as their default terminal but be running VS Code's embedded
 * terminal which inherits env vars from the parent shell). We check
 * `TERM_PROGRAM=vscode` FIRST so the IDE-embedded case wins.
 */
export function detectHost(env: NodeJS.ProcessEnv = process.env): HostMode {
	if (env['TERM_PROGRAM'] === 'vscode') return 'inline';
	if (env['GHOSTTY_RESOURCES_DIR']) return 'ghostty-split';
	if (env['TERM_PROGRAM'] === 'ghostty') return 'ghostty-split';
	return 'inline';
}

// --- Vendored template -----------------------------------------------------

/**
 * Render the state-file body from the vendored template. Substitution is a
 * dumb literal `{{KEY}} → value` replace; we don't escape because the values
 * are constrained by us (an integer iteration cap, a non-empty literal
 * promise string, an ISO timestamp). The promise string is wrapped in YAML
 * double quotes to keep parity with the plugin's setup script.
 *
 * The template body comes from `vendor/ralph-loop.local.md.tmpl`, which is
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
	 * PID of the long-running driver process (claude or claude-auto-retry)
	 * that owns the loop. `ralph resume` (US-010) reads this back to
	 * distinguish a still-alive loop from an orphaned state file: a stale
	 * PID with no live process means the loop crashed (terminal closed, OS
	 * rebooted, hard-kill). Defaults to `process.pid` when not provided.
	 */
	pid: number;
}): string {
	const tmpl = readEmbedded('ralph-loop.local.md.tmpl');
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
 * Write `.claude/ralph-loop.local.md` under `cwd`, creating `.claude/` if
 * needed. Returns the absolute path written. Refuses to clobber an existing
 * file unless `force` is true — an existing state file usually means a
 * previous loop is already running, and stomping on it would mid-flight
 * corrupt the iteration counter. The operator is told to clean up via
 * `/cancel-ralph` (or `rm .claude/ralph-loop.local.md`) before re-running.
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
			`state file already exists at ${target} — run \`/cancel-ralph\` (in the active session) or \`rm ${STATE_FILE_PATH}\` to clear`,
		);
	}
	writeFileSync(target, body, 'utf8');
	return target;
}

// --- Stop-hook materialization ---------------------------------------------

/** Path of the stop hook relative to cwd. */
export const STOP_HOOK_RELATIVE = '.claude/hooks/ralph-loop-stop.sh';

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
 * Materialize the vendored stop-hook script to `<cwd>/.claude/hooks/ralph-loop-stop.sh`
 * and chmod it executable. Called BEFORE writing the plugin state file so the
 * hook is registered before claude starts.
 *
 * Injection point `getStopHookContents` lets tests supply a fake body so they
 * don't depend on the real embedded asset.
 */
export function materializeStopHook(
	cwd: string,
	getStopHookContents: () => string = () => readEmbedded('ralph-loop-stop-hook.sh'),
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
 * The hooks block ralph injects into `.claude/settings.local.json`. We write
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
 * never overwrite a key that ralph didn't put there.
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
 * The subset of `Bun.Subprocess` ralph-next uses. Mirrors the shape from
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
 * file has already been written to `.claude/ralph-loop.local.md`; the
 * plugin's stop hook reads that file to drive the loop. We pass
 * `RALPH_NEXT_PROMPT` as the trailing argument — claude treats that as
 * the first user-turn, kicking off iteration 1.
 */
export function buildClaudeArgv(permissionMode: string): string[] {
	return ['claude', '--permission-mode', permissionMode, RALPH_NEXT_PROMPT];
}

/**
 * Build the argv for pane B (the read-only dashboard). On the Ghostty split
 * path this runs alongside claude in a sibling pane. On the inline path
 * we don't spawn a dashboard at all — the IDE / single terminal IS the
 * dashboard view of claude's output.
 *
 * The argv form is `ralph dashboard` rather than `bun src/...` because by
 * the time `ralph next` is invoked, the operator has installed `ralph`
 * (either via `brew install` or the dev's local PATH symlink) — see US-002
 * + US-011 for the install story.
 */
export function buildDashboardArgv(): string[] {
	return ['ralph', 'dashboard'];
}

/**
 * Build the argv for the Ghostty split spawn. `ghostty +new-split
 * horizontal -- <cmd>` opens a new horizontal pane in the focused window
 * and runs the trailing command in it. We launch pane B (dashboard) this
 * way and leave pane A (claude) running in the operator's current pane —
 * the operator stays in their existing TTY, and the dashboard appears in
 * the new sibling pane.
 *
 * Reference: https://ghostty.org/docs/help/cli (action `+new-split`).
 */
export function buildGhosttySplitArgv(targetCmd: string[]): string[] {
	// `--` separates ghostty's flags from the trailing command. Without it,
	// flags like `--horizontal` could be misinterpreted by ghostty as its
	// own options.
	return ['ghostty', '+new-split', 'horizontal', '--', ...targetCmd];
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
}

/**
 * Run the full `ralph next` flow. Returns the process exit code.
 *
 * Resolution order:
 *   - Ghostty split: write state file → spawn `ghostty +new-split horizontal
 *     -- ralph dashboard` (pane B) → spawn `claude ... /ralph-next` in the
 *     current pane (pane A). Returns claude's exit code.
 *   - Inline fallback (VS Code or unknown terminal): write state file →
 *     spawn `claude ... /ralph-next` in current pane. Returns claude's
 *     exit code. No dashboard pane.
 */
export async function runNext(options: NextOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	const completionPromise = options.completionPromise ?? DEFAULT_COMPLETION_PROMISE;
	const permissionMode = options.permissionMode ?? readPermissionMode();
	const host = options.hostMode ?? detectHost();
	const spawn = options.spawn ?? defaultSpawn;
	const writer =
		options.writer ??
		((cwd2: string, body: string) => writeStateFile(cwd2, body, { force: options.force ?? false }));
	const hookMaterializer = options.hookMaterializer ?? ((cwd2: string) => materializeStopHook(cwd2));
	const settingsWriter = options.settingsWriter ?? ((cwd2: string) => writeSettingsLocal(cwd2));

	// 0. Materialize the vendored stop hook and register it in
	//    .claude/settings.local.json BEFORE writing the state file. This
	//    ensures the hook is registered in Claude Code's settings so it fires
	//    on Stop events — even when the official ralph-loop plugin is not
	//    installed in the spawned session.
	try {
		const hookPath = hookMaterializer(cwd);
		printSuccess(`materialized stop hook`, hookPath);
	} catch (err) {
		printError(
			'failed to materialize stop hook',
			err instanceof Error ? err.message : String(err),
		);
		return 1;
	}
	try {
		const settingsPath = settingsWriter(cwd);
		printSuccess(`registered Stop hook in`, settingsPath);
	} catch (err) {
		printError(
			'failed to write .claude/settings.local.json',
			err instanceof Error ? err.message : String(err),
		);
		return 1;
	}

	// 1. Render + write the state file. Failing here is fatal — without an
	//    armed plugin state file, claude wouldn't know to loop.
	const body = renderStateFile({
		maxIterations,
		completionPromise,
		prompt: RALPH_NEXT_PROMPT,
		startedAt: options.startedAt ?? new Date().toISOString(),
		sessionId: options.sessionId ?? process.env['CLAUDE_CODE_SESSION_ID'] ?? '',
		pid: options.pid ?? process.pid,
	});

	let writtenPath: string;
	try {
		writtenPath = writer(cwd, body);
	} catch (err) {
		printError(
			'failed to pre-arm ralph-loop state file',
			err instanceof Error ? err.message : String(err),
		);
		return 1;
	}
	printSuccess(`armed ${writtenPath}`, `max=${maxIterations} promise="${completionPromise}"`);

	// 2. Build pane A's argv (claude with the loop kick-off prompt).
	const claudeArgv = buildClaudeArgv(permissionMode);

	// 3. Branch on host detection.
	if (host === 'ghostty-split') {
		// Spawn pane B (dashboard) in a new horizontal split. We do this
		// FIRST so by the time pane A starts producing output, the
		// dashboard is already visible. The `ghostty +new-split` call
		// returns quickly (it just dispatches a window-message to the
		// focused Ghostty instance); we don't wait on it.
		const dashboardArgv = buildDashboardArgv();
		const splitArgv = buildGhosttySplitArgv(dashboardArgv);
		try {
			const splitProc = spawn(splitArgv, { cwd });
			// Best-effort: wait briefly for ghostty to dispatch the split.
			// If it errors (e.g. ghostty not on PATH, or no focused
			// instance), we surface a hint and continue with pane A
			// inline — the operator still gets the loop, just no sibling
			// dashboard. Don't block the loop on a dashboard issue.
			void splitProc.exited.catch((err: unknown) => {
				printHint(
					`ghostty split failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				printHint('continuing inline — open a separate `ralph dashboard` if you want one');
			});
		} catch (err) {
			printHint(
				`ghostty split spawn errored: ${err instanceof Error ? err.message : String(err)}`,
			);
			printHint('continuing inline — open a separate `ralph dashboard` if you want one');
		}
		printSuccess('Ghostty split: claude in current pane, dashboard in new horizontal pane');
	} else {
		printSuccess('inline mode (VS Code or unknown terminal): no split');
		printHint('your current terminal is the dashboard view of the loop');
	}

	// 4. Spawn pane A (claude). This is the foreground process; we wait on
	//    its exit.
	let claudeProc: NextSubprocess;
	try {
		claudeProc = spawn(claudeArgv, { cwd });
	} catch (err) {
		printError(
			'failed to spawn `claude`',
			err instanceof Error ? err.message : String(err),
		);
		printHint('verify `claude` is on PATH (re-run `ralph init` to validate)');
		return 1;
	}
	const exitCode = await claudeProc.exited;
	return exitCode ?? 0;
}
