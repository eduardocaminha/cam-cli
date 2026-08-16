// src/commands/init.ts
//
// Implementation of `cam init` — the per-machine readiness validator.
//
// Acceptance criteria (US-005, updated US-007, updated US-001 CAM-458):
//   1. Validates `claude` is on PATH; parses `--version`; warns (does not fail) on mismatch.
//   2. Runs the vendored smokes from `vendor/`:
//        - `check-agent-frontmatter.ts` (gcc-style YAML frontmatter validator)
//      A vendored-smoke exit 2 is treated as "skip-with-warning" not "fail" —
//      it means the smoke can't run in this environment (e.g. no git repo)
//      and that's fine for `init`.
//   3. Exits 0 on a clean machine, non-zero with structured diagnostics on a corrupted one.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

import { Box, render } from 'ink';
import { createElement } from 'react';

import { printError, printHint, printSuccess, printWarning } from '../logging/color.ts';
import { type CheckDef, type CheckOutcome, InitScreen } from '../ui/InitScreen.tsx';
import { Splash } from '../ui/Splash.tsx';
import { type EmbeddedKey, materializeEmbedded } from '../vendor/embedded.ts';
import { CAM_VERSION } from '../version.ts';

// --- Constants -------------------------------------------------------------

/**
 * Minimum version of Claude Code we know works with the cam loop driver.
 * The check is **soft**: a mismatch warns but does not abort `init` — Anthropic
 * ships Claude Code on a fast cadence, and pinning a hard floor would block
 * the harness on weeks-old releases for no real reason.
 */
const CLAUDE_VERSION_FLOOR = '2.0.0';

/**
 * Resolve a vendored smoke file's on-disk path. In dev mode the embedded
 * import returns the real `vendor/...` path; in the compiled binary it
 * materializes into a tmp cache (see `src/vendor/embedded.ts`) so the child
 * `bun` process spawned by the smoke runner can find it.
 */
function vendorScriptPath(key: EmbeddedKey): string {
	return materializeEmbedded(key);
}

// --- PATH validation -------------------------------------------------------

interface ValidationResult {
	ok: boolean;
	/** One-line summary suitable for printSuccess/printWarning/printError. */
	message: string;
	/** Optional secondary line — printed via printHint when present. */
	hint?: string;
}

/**
 * Injectable subprocess-spawn seam (CAM-205). Narrower than `typeof spawnSync`
 * on purpose: `lookupOnPath`/`validateClaude`/`runVendoredSmoke` only ever
 * need `{ status, stdout, stderr }` back, so tests can stub deterministic
 * shapes without real subprocesses. Defaults to `defaultSpawnFn` (a thin
 * wrapper over `node:child_process` `spawnSync`), preserving production
 * behavior byte-for-byte when no `spawnFn` is injected.
 */
export type SpawnFn = (
	cmd: string,
	args: string[],
) => { status: number | null; stdout: string; stderr: string };

function defaultSpawnFn(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(cmd, args, { encoding: 'utf8' });
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Look up an executable on PATH. We use `command -v` via `/bin/sh` rather than
 * `which` because `command -v` is POSIX-mandated and respects shell builtins,
 * while `which` behavior varies across distros. Returns the resolved path or
 * `null` when the binary is not found.
 */
function lookupOnPath(name: string, spawnFn: SpawnFn = defaultSpawnFn): string | null {
	const result = spawnFn('/bin/sh', ['-c', `command -v ${name}`]);
	if (result.status !== 0) return null;
	const trimmed = result.stdout.trim();
	return trimmed === '' ? null : trimmed;
}

/**
 * Compare two semver-ish strings (`X.Y.Z`) numerically. Trailing pre-release
 * suffixes (`-beta.1`) are stripped because Anthropic occasionally ships
 * canary builds and we don't want canary detection to count as a "mismatch".
 * Returns: negative if `a < b`, 0 if equal, positive if `a > b`.
 */
function compareVersions(a: string, b: string): number {
	const norm = (v: string): number[] =>
		v
			.replace(/^v/, '')
			.split(/[-+]/, 1)[0]!
			.split('.')
			.map((p) => Number.parseInt(p, 10) || 0);
	const av = norm(a);
	const bv = norm(b);
	const len = Math.max(av.length, bv.length);
	for (let i = 0; i < len; i += 1) {
		const diff = (av[i] ?? 0) - (bv[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function validateClaude(spawnFn: SpawnFn = defaultSpawnFn): ValidationResult {
	const path = lookupOnPath('claude', spawnFn);
	if (!path) {
		return {
			ok: false,
			message: 'Claude is not on PATH',
			hint: 'Install Claude Code from https://claude.com/claude-code and ensure the install puts the binary on PATH',
		};
	}
	const version = spawnFn('claude', ['--version']);
	if (version.status !== 0) {
		// Found on PATH but `--version` errored. Warn but don't fail — Claude Code
		// occasionally ships a transient `--version` regression and we don't want
		// `cam init` to block on that.
		return {
			ok: true,
			message: `Claude found at ${path} (version unparseable)`,
			hint: '`claude --version` exited non-zero; continuing anyway',
		};
	}
	const versionString = version.stdout.trim();
	// Match the first dotted-numeric run; tolerates TUI noise like
	// "Claude Code 2.5.13 (Sonnet 4.6, ...)".
	const versionMatch = versionString.match(/(\d+\.\d+\.\d+)/);
	if (!versionMatch) {
		return {
			ok: true,
			message: `Claude found at ${path} (version unparseable)`,
			hint: `\`claude --version\` returned: ${versionString}`,
		};
	}
	const detectedVersion = versionMatch[1]!;
	if (compareVersions(detectedVersion, CLAUDE_VERSION_FLOOR) < 0) {
		return {
			ok: true,
			message: `Claude found at ${path} (version ${detectedVersion}, < floor ${CLAUDE_VERSION_FLOOR})`,
			hint: 'Older Claude Code may not support the runtime flags Gateship uses; consider `claude update`',
		};
	}
	return {
		ok: true,
		message: `Claude found at ${path} (version ${detectedVersion})`,
	};
}

// --- Vendored smoke runners ------------------------------------------------

/**
 * Result of running one vendored smoke. We distinguish "skipped" from "passed"
 * so the operator gets a clear signal: a clean machine with no `.claude/agents/`
 * (e.g. running `cam init` from `~`) shouldn't claim a passing-validation it
 * never actually ran.
 */
interface SmokeResult {
	ok: boolean;
	skipped: boolean;
	stdout: string;
	stderr: string;
}

/**
 * Run a vendored `.ts` smoke via `bun`. Returns the structured result.
 *
 * Exit code mapping:
 *   0   → ok=true, skipped depends on stdout content
 *   1   → ok=false (real failure; stderr contains diagnostics)
 *   2   → ok=true, skipped=true (environmental — not a clean-machine concern)
 *   any → ok=false (treat unknown exits as failures with raw stderr surfaced)
 */
function runVendoredSmoke(scriptPath: string, spawnFn: SpawnFn = defaultSpawnFn): SmokeResult {
	if (!existsSync(scriptPath)) {
		return {
			ok: false,
			skipped: false,
			stdout: '',
			stderr: `vendored smoke missing: ${scriptPath}`,
		};
	}
	const result = spawnFn('bun', [scriptPath]);
	const stdout = result.stdout ?? '';
	const stderr = result.stderr ?? '';
	const status = result.status ?? -1;

	// Heuristic for the "skip-when-environment-unavailable" pattern: if a smoke
	// script logs `[smoke] ... skipping` to stdout and exits 0, we treat it as
	// "skipped" rather than "passed". A passing run also exits 0 but logs a
	// different summary, so the heuristic discriminates by substring. A
	// false-positive on a script that legitimately printed "skipping" in its
	// success summary would be a minor labelling issue, not a correctness one.
	const isSkipLog = /\bskipping\b/i.test(stdout) || /\bskipping\b/i.test(stderr);

	if (status === 0) {
		return { ok: true, skipped: isSkipLog, stdout, stderr };
	}
	if (status === 2) {
		return { ok: true, skipped: true, stdout, stderr };
	}
	return { ok: false, skipped: false, stdout, stderr };
}

function reportSmoke(label: string, result: SmokeResult): void {
	if (result.skipped) {
		printWarning(`${label} skipped`, result.stdout.trim() || result.stderr.trim() || 'no diagnostic line');
		return;
	}
	if (result.ok) {
		printSuccess(`${label} ok`);
		return;
	}
	printError(`${label} failed`);
	for (const line of result.stderr.split('\n')) {
		if (line.trim()) printHint(line);
	}
}

// --- Public entrypoint -----------------------------------------------------

export interface InitOptions {
	/**
	 * Injectable subprocess-spawn seam (CAM-205). Only reaches the non-interactive
	 * (`runInitLinear`) path — tests run under `bun test` where stdin/stdout are
	 * not TTYs, so `isInitInteractiveGate` always routes here. Defaults to real
	 * `spawnSync` via `defaultSpawnFn` when omitted, preserving production
	 * behavior byte-for-byte.
	 */
	spawnFn?: SpawnFn;
}

/**
 * Pure gate predicate for the init interactive path. Exported for unit tests.
 *
 * The Ink path (InitScreen) calls useInput which needs raw mode on stdin.
 * Returning false routes to runInitLinear (no crash) when stdin is not a
 * raw-capable TTY (e.g. build smoke: stdout TTY, stdin piped from /dev/null).
 */
export function isInitInteractiveGate(
	stdoutIsTTY: boolean,
	stdinIsTTY: boolean,
	ci: string | undefined,
): boolean {
	return stdoutIsTTY && stdinIsTTY && !ci;
}

/**
 * Run the full `cam init` flow. Returns the process exit code.
 *
 * Two render paths:
 *  - Interactive TTY: animated Ink screen with per-check spinners.
 *  - Non-TTY (CI, pipes, `bun test`): legacy linear print output, kept
 *    verbatim so existing tests and log-scrapers stay valid.
 */
export async function runInit(options: InitOptions = {}): Promise<number> {
	const isInteractive = isInitInteractiveGate(
		Boolean(process.stdout.isTTY),
		Boolean(process.stdin.isTTY),
		process.env.CI,
	);
	if (!isInteractive) {
		return runInitLinear(options.spawnFn);
	}
	return runInitInteractive();
}

function runInitLinear(spawnFn: SpawnFn = defaultSpawnFn): number {
	const failures: string[] = [];

	// 1. claude
	const claude = validateClaude(spawnFn);
	if (claude.ok) {
		printSuccess(claude.message);
		if (claude.hint) printHint(claude.hint);
	} else {
		printError(claude.message, claude.hint);
		failures.push('claude');
	}

	// 2. vendored smokes
	const frontmatter = runVendoredSmoke(vendorScriptPath('check-agent-frontmatter.ts'), spawnFn);
	reportSmoke('check-agent-frontmatter', frontmatter);
	if (!frontmatter.ok) failures.push('check-agent-frontmatter');

	// 3. summary
	if (failures.length > 0) {
		printError(
			`${failures.length} check(s) failed`,
			`Failing: ${failures.join(', ')}`,
		);
		return 1;
	}
	printSuccess('Machine ready');
	return 0;
}

async function runInitInteractive(): Promise<number> {
	const checks = buildInteractiveChecks();
	let failedIds: string[] = [];
	const view = createElement(
		Box,
		{ flexDirection: 'column' },
		createElement(Splash, { version: CAM_VERSION }),
		createElement(InitScreen, {
			checks,
			onDone: (ids: string[]) => {
				failedIds = ids;
				unmount();
			},
		}),
	);
	const { unmount, waitUntilExit } = render(view);
	await waitUntilExit();
	return failedIds.length === 0 ? 0 : 1;
}

function buildInteractiveChecks(): CheckDef[] {
	return [
		{
			id: 'claude',
			label: 'claude',
			description: 'Required to spawn Claude Code sessions',
			run: () => toOutcome(validateClaude(), { okDetail: parseClaudeDetail }),
		},
		{
			id: 'check-agent-frontmatter',
			label: 'agent-frontmatter',
			description: 'Validates .claude/agents/*.md files',
			run: () => smokeToOutcome(runVendoredSmoke(vendorScriptPath('check-agent-frontmatter.ts'))),
		},
	];
}

function toOutcome(
	r: ValidationResult,
	opts: { okDetail: (r: ValidationResult) => string },
): CheckOutcome {
	if (!r.ok) {
		return { status: 'fail', detail: r.message, ...(r.hint ? { hint: r.hint } : {}) };
	}
	const detail = opts.okDetail(r);
	if (r.hint) {
		// `ok: true` with a hint = soft warning (version floor, unparseable, etc.).
		return { status: 'warn', detail, hint: r.hint };
	}
	return { status: 'ok', detail };
}

function parseClaudeDetail(r: ValidationResult): string {
	const m = r.message.match(/version (\d+\.\d+\.\d+)/);
	return m ? `v${m[1]}` : 'ready';
}

function smokeToOutcome(r: SmokeResult): CheckOutcome {
	if (r.ok && r.skipped) {
		const note = (r.stdout.trim() || r.stderr.trim() || '').split('\n')[0] ?? 'no diagnostic line';
		return { status: 'warn', detail: 'skipped', hint: note };
	}
	if (r.ok) {
		return { status: 'ok', detail: 'smoke passed' };
	}
	const firstStderrLine = r.stderr.split('\n').find((l) => l.trim() !== '') ?? 'failed';
	return { status: 'fail', detail: 'smoke failed', hint: firstStderrLine };
}
