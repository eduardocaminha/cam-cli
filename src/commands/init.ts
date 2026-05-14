// src/commands/init.ts
//
// Implementation of `cam init` — the per-machine readiness validator.
//
// Acceptance criteria (US-005, updated US-007):
//   1. Validates `claude` is on PATH; parses `--version`; warns (does not fail) on mismatch.
//   2. Runs the vendored smokes from `vendor/`:
//        - `check-agent-frontmatter.ts` (gcc-style YAML frontmatter validator)
//      A vendored-smoke exit 2 is treated as "skip-with-warning" not "fail" —
//      it means the smoke can't run in this environment (e.g. no git repo)
//      and that's fine for `init`.
//   3. Writes `~/.config/cam/config.toml` with `permission_mode = "bypassPermissions"`,
//      preserving any other existing keys.
//   4. Exits 0 on a clean machine, non-zero with structured diagnostics on a corrupted one.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { printError, printHint, printSuccess, printWarning } from '../logging/color.ts';
import { mergeIntoConfig } from '../config/toml.ts';
import { materializeEmbedded, type EmbeddedKey } from '../vendor/embedded.ts';

// --- Constants -------------------------------------------------------------

/**
 * Minimum version of Claude Code we know works with the cam loop driver.
 * The check is **soft**: a mismatch warns but does not abort `init` — Anthropic
 * ships Claude Code on a fast cadence, and pinning a hard floor would block
 * the harness on weeks-old releases for no real reason.
 */
const CLAUDE_VERSION_FLOOR = '2.0.0';

/**
 * Default path for the per-user config. Override via the `CAM_CONFIG_PATH`
 * env var so tests can target a tmpdir without touching the real `~/.config`.
 */
function defaultConfigPath(): string {
	return process.env.CAM_CONFIG_PATH ?? join(homedir(), '.config', 'cam', 'config.toml');
}

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
 * Look up an executable on PATH. We use `command -v` via `/bin/sh` rather than
 * `which` because `command -v` is POSIX-mandated and respects shell builtins,
 * while `which` behavior varies across distros. Returns the resolved path or
 * `null` when the binary is not found.
 */
function lookupOnPath(name: string): string | null {
	const result = spawnSync('/bin/sh', ['-c', `command -v ${name}`], {
		encoding: 'utf8',
		shell: false,
	});
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

function validateClaude(): ValidationResult {
	const path = lookupOnPath('claude');
	if (!path) {
		return {
			ok: false,
			message: 'claude is not on PATH',
			hint: 'install Claude Code from https://claude.com/claude-code and ensure the install puts the binary on PATH',
		};
	}
	const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
	if (version.status !== 0) {
		// Found on PATH but `--version` errored. Warn but don't fail — Claude Code
		// occasionally ships a transient `--version` regression and we don't want
		// `cam init` to block on that.
		return {
			ok: true,
			message: `claude found at ${path} (version unparseable)`,
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
			message: `claude found at ${path} (version unparseable)`,
			hint: `\`claude --version\` returned: ${versionString}`,
		};
	}
	const detectedVersion = versionMatch[1]!;
	if (compareVersions(detectedVersion, CLAUDE_VERSION_FLOOR) < 0) {
		return {
			ok: true,
			message: `claude found at ${path} (version ${detectedVersion}, < floor ${CLAUDE_VERSION_FLOOR})`,
			hint: 'older Claude Code may have different rate-limit message formatting; consider `claude update`',
		};
	}
	return {
		ok: true,
		message: `claude found at ${path} (version ${detectedVersion})`,
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
function runVendoredSmoke(scriptPath: string): SmokeResult {
	if (!existsSync(scriptPath)) {
		return {
			ok: false,
			skipped: false,
			stdout: '',
			stderr: `vendored smoke missing: ${scriptPath}`,
		};
	}
	const result = spawnSync('bun', [scriptPath], { encoding: 'utf8' });
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
	configPath?: string;
}

/**
 * Run the full `cam init` flow. Returns the process exit code.
 *
 * Calls into `mergeIntoConfig` for the writer step, so tests can drive the
 * full flow against an alternate config path via `CAM_CONFIG_PATH` or the
 * `options.configPath` argument without touching `~/.config/cam/config.toml`.
 */
export function runInit(options: InitOptions = {}): number {
	const failures: string[] = [];

	// 1. claude
	const claude = validateClaude();
	if (claude.ok) {
		printSuccess(claude.message);
		if (claude.hint) printHint(claude.hint);
	} else {
		printError(claude.message, claude.hint);
		failures.push('claude');
	}

	// 2. vendored smokes
	const frontmatter = runVendoredSmoke(vendorScriptPath('check-agent-frontmatter.ts'));
	reportSmoke('check-agent-frontmatter', frontmatter);
	if (!frontmatter.ok) failures.push('check-agent-frontmatter');

	// 3. write config
	const configPath = options.configPath ?? defaultConfigPath();
	try {
		mergeIntoConfig(configPath, { permission_mode: 'bypassPermissions' });
		printSuccess(`config written ${configPath}`);
	} catch (err) {
		printError(
			`failed to write ${configPath}`,
			err instanceof Error ? err.message : String(err),
		);
		failures.push('config');
	}

	// 5. summary
	if (failures.length > 0) {
		printError(
			`cam init: ${failures.length} check(s) failed`,
			`failing: ${failures.join(', ')}`,
		);
		return 1;
	}
	printSuccess('cam init: machine ready');
	return 0;
}
