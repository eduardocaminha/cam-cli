// test/build-release-smoke.test.ts
//
// CAM-15 invariant: the build-release.sh AC4 soft-check MUST be hermetic. It
// runs the freshly compiled `cam` binary through `init`, and `cam init` chains
// `runSetup`, which copies templates over the cwd's versioned files and (without
// --no-tmux) spawns a tmux session + a live claude agent. Run against the repo
// root it clobbered 10 versioned files and left a cam-setup session (twice, on
// the operator machine). The fix isolates the smoke on every axis: a throwaway
// mktemp -d as cwd, --no-tmux (no tmux/agent), --existing --issue-system none
// (skip the interactive setup wizard), </dev/null (stdin), an absolute binary
// path, and a tmp config.
//
// This is a static-source guard (mirrors test/no-permission-mode-flag.test.ts):
// it reads scripts/build-release.sh and fails the build if the soft-check ever
// regresses to a non-hermetic `init` invocation. No compiled binary needed.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_PATH = resolve(import.meta.dir, '..', 'scripts', 'build-release.sh');
const script = readFileSync(SCRIPT_PATH, 'utf8');

/**
 * Lines that invoke the compiled binary with the `init` subcommand. The binary
 * is referenced via an absolute-path variable (BIN_ABS) in the hermetic smoke;
 * a regression might use the bare relative `${BIN}` or a literal. We match any
 * line that runs something ending in a binary reference immediately followed by
 * `init`, ignoring comments.
 *
 * Targets the real hermetic line, e.g.:
 *   if (cd "${SMOKE_DIR}" && CAM_CONFIG_PATH=... "${BIN_ABS}" init --no-tmux --existing --issue-system none </dev/null); then
 * The `\}"? \s+init` arm matches `${BIN_ABS}" init`; the `/cam"? \s+init` arm
 * catches a regression that hardcodes a `.../cam init` path.
 */
function binInitInvocations(): string[] {
	return script
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => !l.startsWith('#'))
		.filter((l) => /\}"?\s+init(\s|$)/.test(l) || /\/cam"?\s+init(\s|$)/.test(l));
}

describe('build-release.sh AC4 soft-check is hermetic (CAM-15)', () => {
	test('the smoke allocates a throwaway tmpdir (mktemp -d)', () => {
		expect(script).toContain('mktemp -d');
	});

	test('the init invocation carries the full non-interactive + no-tmux flag set', () => {
		// All four properties keep the smoke from mutating the repo or blocking:
		// --no-tmux (no tmux/agent), --existing (skip project-mode + description
		// prompts), --issue-system none (skip issue prompt), </dev/null (stdin).
		expect(script).toContain('--no-tmux');
		expect(script).toContain('--existing');
		expect(script).toContain('--issue-system none');
		expect(script).toContain('</dev/null');
	});

	test('every binary `init` invocation is hermetic: cd into tmpdir + --no-tmux + absolute path', () => {
		const invocations = binInitInvocations();
		// There must be at least one (the soft-check) and every one must be safe.
		expect(invocations.length).toBeGreaterThan(0);
		for (const line of invocations) {
			// (a) preceded by a cd into the smoke tmpdir on the same line (subshell form)
			expect(line).toMatch(/cd\s+"?\$\{?SMOKE_DIR\}?"?/);
			// (b) carries --no-tmux
			expect(line).toContain('--no-tmux');
			// (c) uses the absolute binary path, never the bare relative ${BIN}
			expect(line).toContain('${BIN_ABS}');
			expect(line).not.toMatch(/"\$\{BIN\}"\s+init/);
		}
	});

	test('the tmpdir is cleaned up on exit (trap, survives abort paths)', () => {
		expect(script).toMatch(/rm\s+-rf\s+"?\$\{?SMOKE_DIR/);
		// A trap on EXIT cleans up even if an earlier build step aborts.
		expect(script).toMatch(/trap\s+'rm -rf "\$\{SMOKE_DIR:-\}"'\s+EXIT/);
	});

	test('the soft-check branches on the claude prerequisite, not blanket non-zero tolerance (US-003)', () => {
		// Probes `command -v claude`; absent = tolerated, installed + crash = build aborts.
		expect(script).toContain('command -v claude');
		expect(script).toMatch(/real init crash/);
	});
});
