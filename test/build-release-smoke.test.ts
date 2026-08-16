// test/build-release-smoke.test.ts
//
// CAM-15 invariant: the build-release.sh AC4 soft-check MUST be hermetic. It
// runs the freshly compiled `gship` binary through `init`, and `gship init`
// chains `runSetup`, which copies templates into its cwd. Run against the repo
// root it clobbered versioned files. The fix isolates the smoke on every axis:
// a throwaway mktemp -d as cwd, --existing --issue-system none (skip the
// interactive setup wizard), </dev/null (stdin), an absolute binary path, and
// a tmp config.
//
// This is a static-source guard (mirrors test/no-permission-mode-flag.test.ts):
// it reads scripts/build-release.sh and fails the build if the soft-check ever
// regresses to a non-hermetic `init` invocation. No compiled binary needed.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// GATESHIP_TEST_BUILD_RELEASE_SH lets a reviewer independently re-run the
// red-against-main sweep for the atomic-rename ordering block below (US-002,
// CAM-497): `GATESHIP_TEST_BUILD_RELEASE_SH=<path to main's build-release.sh>
// bun test ... -t 'atomic rename'` exercises a different script than the repo
// copy without editing this file.
const SCRIPT_PATH =
	process.env.GATESHIP_TEST_BUILD_RELEASE_SH || resolve(import.meta.dir, '..', 'scripts', 'build-release.sh');
const script = readFileSync(SCRIPT_PATH, 'utf8');

/**
 * Lines that invoke the compiled binary with the `init` subcommand. The binary
 * is referenced via an absolute-path variable (BIN_ABS) in the hermetic smoke;
 * a regression might use the bare relative `${BIN}` or a literal. We match any
 * line that runs something ending in a binary reference immediately followed by
 * `init`, ignoring comments.
 *
 * Targets the real hermetic line, e.g.:
 *   if (cd "${SMOKE_DIR}" && "${BIN_ABS}" init --existing --issue-system none </dev/null); then
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

	test('the init invocation carries the full non-interactive flag set', () => {
		// These properties keep the smoke from mutating the repo or blocking:
		// --existing skips project-mode + description prompts, --issue-system none
		// skips the issue prompt, and </dev/null closes stdin.
		expect(script).toContain('--existing');
		expect(script).toContain('--issue-system none');
		expect(script).toContain('</dev/null');
	});

	test('every binary `init` invocation is hermetic: cd into tmpdir + absolute path', () => {
		const invocations = binInitInvocations();
		// There must be at least one (the soft-check) and every one must be safe.
		expect(invocations.length).toBeGreaterThan(0);
		for (const line of invocations) {
			// (a) preceded by a cd into the smoke tmpdir on the same line (subshell form)
			expect(line).toMatch(/cd\s+"?\$\{?SMOKE_DIR\}?"?/);
			// (b) uses the absolute binary path, never the bare relative ${BIN}
			expect(line).toContain('${BIN_ABS}');
			expect(line).not.toMatch(/"\$\{BIN\}"\s+init/);
		}
	});

	test('the tmpdir is cleaned up on exit (trap, survives abort paths)', () => {
		expect(script).toMatch(/rm\s+-rf\s+"?\$\{?SMOKE_DIR/);
		// A trap on EXIT cleans up even if an earlier build step aborts. The
		// single trap is extended (US-002, CAM-497) to also clear a leftover
		// staged install file, never joined by a second `trap ... EXIT`.
		expect(script).toMatch(/trap\s+'rm -rf "\$\{SMOKE_DIR:-\}" \$\{STAGED:\+"\$\{STAGED\}"\}'\s+EXIT/);
	});

	test('the soft-check branches on the claude prerequisite, not blanket non-zero tolerance (US-003)', () => {
		// Probes `command -v claude`; absent = tolerated, installed + crash = build aborts.
		expect(script).toContain('command -v claude');
		expect(script).toMatch(/real init crash/);
	});
});

describe('build-release.sh writes dist/SHA256SUMS.txt post-codesign, from produced names (US-001, CAM-495)', () => {
	const loopStart = script.indexOf('for entry in "${TARGETS[@]}"; do');
	const loopEnd = script.indexOf('\ndone', loopStart);
	const manifestIdx = script.indexOf('SHA256SUMS.txt', loopEnd);
	const installIdx = script.indexOf('DO_INSTALL}" == "true"', loopEnd);

	test('the TARGETS loop and the manifest write are both present, loop closes first', () => {
		expect(loopStart).toBeGreaterThan(-1);
		expect(loopEnd).toBeGreaterThan(loopStart);
		expect(manifestIdx).toBeGreaterThan(-1);
	});

	test('the manifest is written only after the TARGETS loop closes (post-codesign)', () => {
		expect(manifestIdx).toBeGreaterThan(loopEnd);
	});

	test('the manifest write precedes the --install block', () => {
		expect(installIdx).toBeGreaterThan(-1);
		expect(manifestIdx).toBeLessThan(installIdx);
	});

	test('the shasum invocation never globs dist/gateship-*; it hashes the collected name array', () => {
		expect(script).not.toMatch(/shasum[^\n]*gateship-\*/);
		expect(script).not.toMatch(/dist\/gateship-\*/);
		expect(script).toMatch(/shasum -a 256[^\n]*MANIFEST_NAMES/);
	});

	test('the name array is populated inside the loop from the produced OUT_NAME, not hardcoded', () => {
		const arrayPushIdx = script.indexOf('MANIFEST_NAMES+=');
		expect(arrayPushIdx).toBeGreaterThan(loopStart);
		expect(arrayPushIdx).toBeLessThan(loopEnd);
		expect(script.slice(arrayPushIdx, arrayPushIdx + 40)).toContain('OUT_NAME');
	});
});

describe('build-release.sh --install stages, verifies, then swaps by atomic rename (US-002, CAM-497, ADR-0058)', () => {
	// Every position below is derived from the --install loop text at read
	// time (indexOf over the script source), never a frozen line number, so
	// this block goes red the instant a step regresses to writing ${DEST}
	// directly or moves ahead of the rename.
	const installIdx = script.indexOf('if [[ "${DO_INSTALL}" == "true" ]]; then');
	const loopStart = script.indexOf('for NAME in gateship gship; do', installIdx);
	const loopEnd = script.indexOf('\n\tdone', loopStart);
	const loopText = script.slice(loopStart, loopEnd);

	const cpIdx = loopText.indexOf('cp "${HOST_BIN}" "${STAGED}"');
	const xattrIdx = loopText.indexOf('xattr -cr "${STAGED}"');
	const signIdx = loopText.indexOf('codesign --force --sign - "${STAGED}"');
	const verifyIdx = loopText.indexOf('codesign -v "${STAGED}"');
	const chmodIdx = loopText.indexOf('chmod +x "${STAGED}"');
	const smokeIdx = loopText.indexOf('SMOKE_ACTUAL="$("${STAGED}" --version)"');
	const codesignFailIdx = loopText.indexOf('ERROR: codesign verification failed');
	const smokeFailIdx = loopText.indexOf('ERROR: --version mismatch');
	const mvIdx = loopText.indexOf('mv -f "${STAGED}" "${DEST}"');

	test('the --install branch and its per-name loop are both present', () => {
		expect(installIdx).toBeGreaterThan(-1);
		expect(loopStart).toBeGreaterThan(installIdx);
		expect(loopEnd).toBeGreaterThan(loopStart);
	});

	test('the staged temp is allocated inside the destination directory, not $TMPDIR', () => {
		expect(loopText).toMatch(/mktemp\s+"\$\{DEST_DIR\}\/\./);
	});

	test('every preparation and verification step is present and names the staged file', () => {
		for (const idx of [cpIdx, xattrIdx, signIdx, verifyIdx, chmodIdx, smokeIdx, mvIdx]) {
			expect(idx).toBeGreaterThan(-1);
		}
	});

	test('every preparation and verification step precedes the atomic rename over the destination', () => {
		for (const idx of [cpIdx, xattrIdx, signIdx, verifyIdx, chmodIdx, smokeIdx]) {
			expect(idx).toBeLessThan(mvIdx);
		}
	});

	test('a failed codesign or --version verification aborts before the rename, leaving the previous installation intact', () => {
		// Both abort paths (`exit 1` on codesign failure, `exit 1` on a
		// --version mismatch) sit strictly before the mv -f swap: the
		// destination is only ever replaced once every check has already
		// passed against the staged file, so a failed verification never
		// destroys a working prior installation.
		expect(codesignFailIdx).toBeGreaterThan(-1);
		expect(codesignFailIdx).toBeLessThan(mvIdx);
		expect(smokeFailIdx).toBeGreaterThan(-1);
		expect(smokeFailIdx).toBeLessThan(mvIdx);
	});

	test('the staged variable is cleared immediately after the rename succeeds', () => {
		const clearIdx = loopText.indexOf('STAGED=""', mvIdx);
		expect(clearIdx).toBeGreaterThan(mvIdx);
	});
});
