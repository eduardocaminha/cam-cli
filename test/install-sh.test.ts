// test/install-sh.test.ts — US-R1-001 (CAM-460)
//
// install.sh's tag-resolution error path was unreachable dead code: under
// `set -euo pipefail`, `TAG="$(curl ... | grep -m1 ... | sed ...)"` aborts the
// whole script the instant curl or grep exits non-zero (curl failure, or grep
// finding zero matches because no Release has been published yet), so the
// friendly `if [[ -z "${TAG}" ]]` guard right below it could never run. The
// script died silently: no message on stdout or stderr, just a bare exit 1.
//
// These tests execute install.sh for real (not a static grep of the source,
// which would not have caught this — the buggy lines read fine statically).
// A fake `curl` shim on PATH stands in for the GitHub API so the test is
// hermetic (no real network call, deterministic regardless of whether a
// Release has been published yet).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createTestTmpdir } from './helpers/test-tmpdir';
import { join } from 'node:path';
import { waitForCondition } from './helpers/wait-for-condition';

// GATESHIP_TEST_INSTALL_SH lets a reviewer independently re-run the
// red-against-main sweep for the atomic-swap legs below (US-001, CAM-497):
// `GATESHIP_TEST_INSTALL_SH=<path to main's install.sh> bun test ... -t '...'`
// exercises a different script than the repo copy without editing this file.
const INSTALL_SCRIPT = process.env.GATESHIP_TEST_INSTALL_SH || join(import.meta.dir, '..', 'install.sh');

let fakeBinDir: string;
let installDir: string;

beforeEach(() => {
	fakeBinDir = createTestTmpdir('gship-test-install-bin-');
	installDir = createTestTmpdir('gship-test-install-dest-');
});

afterEach(() => {
	rmSync(fakeBinDir, { recursive: true, force: true });
	rmSync(installDir, { recursive: true, force: true });
});

/**
 * A hashing snippet shared by the 'success' and 'checksum-mismatch' shim
 * variants below: probes sha256sum/shasum the same way install.sh itself
 * does, so the fake curl can compute a real digest from whatever bytes it
 * just served instead of ever freezing a digest literal into the test source.
 */
const HASH_FN = [
	'hash_file() {',
	'  if command -v sha256sum >/dev/null 2>&1; then',
	'    sha256sum "$1" | awk \'{print $1}\'',
	'  else',
	'    shasum -a 256 "$1" | awk \'{print $1}\'',
	'  fi',
	'}',
].join('\n');

/** Writes a fake `curl` executable to fakeBinDir that reacts to the releases-list URL. */
function writeFakeCurl(
	behavior:
		| 'network-failure'
		| 'empty-list'
		| 'success'
		| 'checksum-mismatch'
		| 'checksums-unavailable'
		| 'no-checksum-entry',
): void {
	// The SHA256SUMS.txt-branch body: for 'checksums-unavailable' the manifest
	// request itself fails (curl exit 22, what `-f` produces on a 404) while
	// the asset call below is untouched and still serves normally; for
	// 'no-checksum-entry' the manifest request succeeds but the one line it
	// serves names a DIFFERENT asset than the one install.sh's own os/arch
	// detection resolved, so install.sh's `grep -F "  ${ASSET}"` finds zero
	// matches even though the manifest itself was reachable; for the other
	// two behaviors it writes the matching one-line manifest as before.
	const sumsBranchLines =
		behavior === 'checksums-unavailable'
			? ['  exit 22']
			: behavior === 'no-checksum-entry'
				? [
						`  printf "%s  %s\\n" "${'0'.repeat(64)}" "gateship-unrelated-asset" > "\${OUT}"`,
						'  exit 0',
					]
				: [
						'  ASSET_NAME="$(cut -d" " -f1 "${STATE}")"',
						'  PAYLOAD_HASH="$(cut -d" " -f2 "${STATE}")"',
						behavior === 'checksum-mismatch'
							? '  MANIFEST_HASH="$(printf "" | hash_file /dev/stdin)"'
							: '  MANIFEST_HASH="${PAYLOAD_HASH}"',
						'  printf "%s  %s\\n" "${MANIFEST_HASH}" "${ASSET_NAME}" > "${OUT}"',
						'  exit 0',
					];
	const script =
		behavior === 'network-failure'
			? '#!/usr/bin/env bash\nexit 22\n' // curl -f style failure (e.g. rate-limit 403)
			: behavior === 'empty-list'
				? '#!/usr/bin/env bash\necho "[]"\nexit 0\n' // 200 OK, no releases published yet
				: // 'success' / 'checksum-mismatch' / 'checksums-unavailable': three call
					// shapes hit this shim — (1) no `-o`: the releases-list lookup, JSON
					// on stdout; (2) `-o <path>`, URL is the asset: write a dummy
					// payload; (3) `-o <path>`, URL ends in SHA256SUMS.txt: write a
					// one-line manifest whose digest is computed from the payload bytes
					// this SAME shim just served in call (2) — never a frozen literal —
					// or fail like a 404 for 'checksums-unavailable'. State (the
					// payload's digest + asset basename) is stashed in a file next to
					// the shim itself, since each call is a fresh process.
					[
						'#!/usr/bin/env bash',
						HASH_FN,
						'STATE="$(dirname "$0")/.checksum-state"',
						'URL=""',
						'OUT=""',
						'prev=""',
						'for arg in "$@"; do',
						'  if [[ "${prev}" == "-o" ]]; then',
						'    OUT="${arg}"',
						'  elif [[ "${arg}" != -* ]]; then',
						'    URL="${arg}"',
						'  fi',
						'  prev="${arg}"',
						'done',
						'if [[ "${URL}" == *SHA256SUMS.txt* ]]; then',
						...sumsBranchLines,
						'fi',
						'if [[ -n "${OUT}" ]]; then',
						'  printf "#!/bin/sh\\necho fake-gateship-binary\\n" > "${OUT}"',
						'  printf "%s %s" "$(basename "${URL}")" "$(hash_file "${OUT}")" > "${STATE}"',
						'  exit 0',
						'fi',
						'echo \'[{"tag_name": "v9.9.9"}]\'',
						'exit 0',
					].join('\n');
	const curlPath = join(fakeBinDir, 'curl');
	writeFileSync(curlPath, script);
	chmodSync(curlPath, 0o755);
}

/**
 * Writes a `curl` shim for the no-hash-tool leg only: pure bash builtins
 * (no `cut`/`dirname`/`basename`/external hash tool), since that leg
 * deliberately strips every tool from PATH except the ones install.sh
 * itself needs — the shim that fabricates it must not silently depend on
 * anything install.sh doesn't. `assetName`/`digest` are computed by the
 * caller (never a shell hash-tool invocation) and baked into the script text.
 */
function writeNoHashToolCurl(assetName: string, digest: string): void {
	const script = [
		'#!/bin/bash',
		'URL=""',
		'OUT=""',
		'prev=""',
		'for arg in "$@"; do',
		'  if [[ "${prev}" == "-o" ]]; then',
		'    OUT="${arg}"',
		'  elif [[ "${arg}" != -* ]]; then',
		'    URL="${arg}"',
		'  fi',
		'  prev="${arg}"',
		'done',
		'if [[ "${URL}" == *SHA256SUMS.txt* ]]; then',
		`  printf '%s  %s\\n' '${digest}' '${assetName}' > "\${OUT}"`,
		'  exit 0',
		'fi',
		'if [[ -n "${OUT}" ]]; then',
		'  printf "dummy-binary-bytes" > "${OUT}"',
		'  exit 0',
		'fi',
		'echo \'[{"tag_name": "v9.9.9"}]\'',
		'exit 0',
	].join('\n');
	const curlPath = join(fakeBinDir, 'curl');
	writeFileSync(curlPath, script);
	chmodSync(curlPath, 0o755);
}

/** Resolves the absolute path of a real host tool via the ambient (non-test) PATH. */
function whichReal(tool: string): string {
	const result = Bun.spawnSync(['/usr/bin/which', tool]);
	const resolved = new TextDecoder().decode(result.stdout).trim();
	if (!resolved) {
		throw new Error(`test setup: required tool not found on this host: ${tool}`);
	}
	return resolved;
}

/**
 * The asset name install.sh's own os/arch detection would compute on THIS
 * host, mirroring its case statement so the fake manifest line matches.
 */
function assetNameForHost(): string {
	const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined;
	const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined;
	if (!os || !arch) {
		throw new Error(`unsupported test host platform/arch: ${process.platform}/${process.arch}`);
	}
	return `gateship-${os}-${arch}`;
}

/**
 * Builds a directory carrying every real tool install.sh needs EXCEPT
 * sha256sum/shasum (symlinks to the host binaries for uname/mktemp/chmod/
 * grep/sed/awk/mkdir/cp/rm — `rm` is used by install.sh's own EXIT trap, not
 * just the happy path — plus xattr on darwin, used on the darwin install
 * branch), so a stripped PATH cannot make bash itself, or any other tool
 * install.sh legitimately calls, unresolvable: only the hash tools are
 * deliberately absent. Caller is responsible for `rmSync`-ing the result.
 */
function buildPathWithoutHashTools(): string {
	const toolsDir = createTestTmpdir('gship-test-install-notools-');
	const required = ['uname', 'mktemp', 'chmod', 'grep', 'sed', 'awk', 'mkdir', 'cp', 'rm'];
	if (process.platform === 'darwin') {
		required.push('xattr');
	}
	for (const tool of required) {
		symlinkSync(whichReal(tool), join(toolsDir, tool));
	}
	return toolsDir;
}

async function runInstallSh(
	envOverrides: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// Invoked through the absolute interpreter path (never a bare 'bash' on
	// PATH) so a leg that deliberately strips PATH down to a curated tools-only
	// directory cannot make bash itself unresolvable and fail for the wrong
	// reason (a harness-broken 'command not found: bash', not install.sh's own
	// diagnostic).
	const proc = Bun.spawn(['/bin/bash', INSTALL_SCRIPT], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			PATH: `${fakeBinDir}:/usr/bin:/bin`,
			GATESHIP_INSTALL_DIR: installDir,
			...envOverrides,
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

describe('install.sh tag-resolution error path is reachable (US-R1-001, CAM-460)', () => {
	test('no releases published yet: exits 1 with a diagnostic on stderr, not a silent death', async () => {
		writeFakeCurl('empty-list');
		const { exitCode, stderr } = await runInstallSh();
		expect(exitCode).toBe(1);
		expect(stderr).toContain('ERROR: could not resolve the latest release tag from the GitHub API');
		// Install dir stays empty: the download step never runs.
		expect(await Bun.file(join(installDir, 'gateship')).exists()).toBe(false);
	});

	test('GitHub API unreachable (network failure / rate limit): exits 1 with a diagnostic on stderr', async () => {
		writeFakeCurl('network-failure');
		const { exitCode, stderr } = await runInstallSh();
		expect(exitCode).toBe(1);
		expect(stderr).toContain('ERROR: failed to reach the GitHub API to list releases');
	});

	test('bash -n install.sh: syntax check passes', async () => {
		const proc = Bun.spawn(['bash', '-n', INSTALL_SCRIPT], { stdout: 'pipe', stderr: 'pipe' });
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);
	});
});

describe('install.sh success path (US-R2-004, CAM-460)', () => {
	test('downloads the asset, installs both gateship and gship as executables, and leaves a pre-existing cam untouched', async () => {
		writeFakeCurl('success');
		const camPath = join(installDir, 'cam');
		const camContents = '#!/bin/sh\necho pre-existing-cam\n';
		writeFileSync(camPath, camContents);
		chmodSync(camPath, 0o755);

		const { exitCode, stdout } = await runInstallSh();

		expect(exitCode).toBe(0);
		expect(stdout).toContain('[install] checksum verified');
		expect(stdout).toContain('[install] done.');

		for (const name of ['gateship', 'gship']) {
			const dest = join(installDir, name);
			expect(await Bun.file(dest).exists()).toBe(true);
			expect(statSync(dest).mode & 0o111).toBeGreaterThan(0);
		}

		// Additive: the pre-existing `cam` binary is untouched, byte-for-byte.
		expect(await Bun.file(camPath).exists()).toBe(true);
		expect(readFileSync(camPath, 'utf8')).toBe(camContents);
	});
});

describe('install.sh fail-closed legs (US-004, CAM-495)', () => {
	test('hash mismatch: exits non-zero and leaves INSTALL_DIR with no entries', async () => {
		writeFakeCurl('checksum-mismatch');

		const { exitCode, stderr } = await runInstallSh();

		expect(exitCode).toBe(1);
		expect(stderr).toContain('ERROR: checksum mismatch for');
		expect(readdirSync(installDir)).toEqual([]);
	});

	test('checksums unavailable: SHA256SUMS.txt request fails while the asset itself serves fine, exits non-zero and leaves INSTALL_DIR with no entries', async () => {
		writeFakeCurl('checksums-unavailable');

		const { exitCode, stderr } = await runInstallSh();

		expect(exitCode).toBe(1);
		expect(stderr).toContain('ERROR: download failed');
		expect(readdirSync(installDir)).toEqual([]);
	});

	test("no hash tool: neither shasum nor sha256sum on PATH, exits non-zero, leaves INSTALL_DIR with no entries, and fails with install.sh's own diagnostic — not a 'command not found' from a broken harness", async () => {
		const toolsDir = buildPathWithoutHashTools();
		try {
			writeNoHashToolCurl(assetNameForHost(), 'a'.repeat(64));

			const { exitCode, stderr } = await runInstallSh({ PATH: `${fakeBinDir}:${toolsDir}` });

			expect(exitCode).toBe(1);
			expect(stderr).not.toContain('command not found');
			expect(stderr).toContain('ERROR: neither sha256sum nor shasum is available to verify the downloaded artifact');
			expect(readdirSync(installDir)).toEqual([]);
		} finally {
			rmSync(toolsDir, { recursive: true, force: true });
		}
	});

	test('no checksum entry: manifest is reachable but carries no line for this asset, exits non-zero with the "no checksum entry" diagnostic, and leaves INSTALL_DIR with no entries (US-R1-001, CAM-460)', async () => {
		writeFakeCurl('no-checksum-entry');

		const { exitCode, stderr } = await runInstallSh();

		expect(exitCode).toBe(1);
		expect(stderr).toContain(`ERROR: no checksum entry for ${assetNameForHost()}`);
		expect(readdirSync(installDir)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// US-001, CAM-497 — atomic-rename swap: install.sh must never write ${DEST}
// in place (ADR-0058). Two durable legs below prove the two symptoms the ADR
// names: a running process's mapped image must survive a reinstall AND the
// resulting file must be a real, freshly executable inode (not a directory
// entry replaced with a truncated/partial write mid-copy).
// ---------------------------------------------------------------------------

/**
 * Source for a real, standalone `bun build --compile` fixture: writes a
 * ready-marker (if CAM497_MARKER_PATH is set) immediately after starting,
 * then sleeps CAM497_SLEEP_MS (default 0) before exiting 0. Used for BOTH
 * roles below — the pre-existing binary a live process is executing, and the
 * asset install.sh downloads and installs over it — reusing identical bytes,
 * since a copy of any Apple-platform binary (or of ITSELF post-install) is
 * exactly the case a running-image-poisoning regression would kill.
 */
function fixtureSource(): string {
	return [
		"const markerPath = process.env.CAM497_MARKER_PATH;",
		"const sleepMs = Number(process.env.CAM497_SLEEP_MS ?? '0');",
		'if (markerPath) {',
		"  await Bun.write(markerPath, 'ready');",
		'}',
		'if (sleepMs > 0) {',
		'  await Bun.sleep(sleepMs);',
		'}',
		"console.log('cam497-fixture-ok');",
	].join('\n');
}

/**
 * Compiles `fixtureSource()` with a REAL `bun build --compile` into a scratch
 * dir (never skipped: an unavailable compiler throws loudly, per CAM-424).
 * `cwd` is pinned to the scratch dir because `bun build --compile` drops its
 * `.bun-build` temp file into its OWN cwd, not next to the outfile (CAM-426);
 * the caller's single `rmSync(scratchDir, {recursive:true,force:true})`
 * therefore sweeps source + outfile + the scratch file together. Left
 * ad-hoc/unsigned deliberately, matching install.sh itself (it never
 * codesigns, only strips the darwin quarantine bit): re-signing a trivial
 * single-module `bun build --compile` output was measured to fail codesign's
 * own strict-validation step nondeterministically on this toolchain (a
 * `bun build --compile` known limitation, oven-sh/bun#7208 — unrelated to
 * the bug under test), while executing the SAME unsigned artifact directly
 * out of a user-owned tmpdir, and reproducing the running-image-poisoning
 * bug against it, was verified to work every time.
 */
function compileFixtureBinary(): { binPath: string; scratchDir: string } {
	const scratchDir = createTestTmpdir('cam497-fixture-');
	writeFileSync(join(scratchDir, 'fixture.ts'), fixtureSource(), 'utf8');
	const build = Bun.spawnSync(['bun', 'build', '--compile', './fixture.ts', '--outfile', './fixture-bin'], {
		cwd: scratchDir,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (build.exitCode !== 0) {
		throw new Error(`bun build --compile failed (exit ${build.exitCode}): ${build.stderr.toString('utf8')}`);
	}
	return { binPath: join(scratchDir, 'fixture-bin'), scratchDir };
}

/**
 * Writes a fake `curl` that serves the REAL compiled fixture bytes for the
 * asset download and computes SHA256SUMS.txt live from those same bytes
 * (install.sh's own sha256sum/shasum probe order via HASH_FN), never a
 * frozen digest literal.
 */
function writeFixtureCurl(fixtureBinPath: string): void {
	const script = [
		'#!/usr/bin/env bash',
		HASH_FN,
		'FIXTURE_BIN=' + JSON.stringify(fixtureBinPath),
		'URL=""',
		'OUT=""',
		'prev=""',
		'for arg in "$@"; do',
		'  if [[ "${prev}" == "-o" ]]; then',
		'    OUT="${arg}"',
		'  elif [[ "${arg}" != -* ]]; then',
		'    URL="${arg}"',
		'  fi',
		'  prev="${arg}"',
		'done',
		'if [[ "${URL}" == *SHA256SUMS.txt* ]]; then',
		'  DIGEST="$(hash_file "${FIXTURE_BIN}")"',
		`  printf '%s  %s\\n' "\${DIGEST}" ${JSON.stringify(assetNameForHost())} > "\${OUT}"`,
		'  exit 0',
		'fi',
		'if [[ -n "${OUT}" ]]; then',
		'  cp "${FIXTURE_BIN}" "${OUT}"',
		'  exit 0',
		'fi',
		'echo \'[{"tag_name": "v9.9.9"}]\'',
		'exit 0',
	].join('\n');
	const curlPath = join(fakeBinDir, 'curl');
	writeFileSync(curlPath, script);
	chmodSync(curlPath, 0o755);
}

/** True iff a process with `pid` is currently alive (checked via signal 0, not Bun's cached exitCode). */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe('install.sh replaces a running binary via atomic rename, not in-place write (US-001, CAM-497)', () => {
	test(
		'reinstalling over ${INSTALL_DIR}/gship while a real process is executing it: install exits 0, the live process survives, and the resulting file still executes successfully',
		async () => {
			const { binPath: fixtureBin, scratchDir } = compileFixtureBinary();
			let liveProc: Bun.Subprocess | undefined;
			try {
				const liveDest = join(installDir, 'gship');
				copyFileSync(fixtureBin, liveDest);
				chmodSync(liveDest, 0o755);

				const markerPath = join(installDir, '.cam497-ready-marker');
				liveProc = Bun.spawn([liveDest], {
					stdout: 'ignore',
					stderr: 'pipe',
					stdin: 'ignore',
					env: { ...process.env, CAM497_MARKER_PATH: markerPath, CAM497_SLEEP_MS: '6000' },
				});
				await waitForCondition(() => Bun.file(markerPath).exists(), { timeoutMs: 5000 });

				writeFixtureCurl(fixtureBin);
				const { exitCode: installExit } = await runInstallSh();

				const liveProcessSurvived = isPidAlive(liveProc.pid);

				const reExec = Bun.spawnSync([liveDest], {
					stdout: 'pipe',
					stderr: 'pipe',
					stdin: 'ignore',
					env: { ...process.env, CAM497_SLEEP_MS: '0' },
				});

				expect(installExit).toBe(0);
				expect(liveProcessSurvived).toBe(true);
				expect(reExec.exitCode).toBe(0);
			} finally {
				if (liveProc) {
					liveProc.kill();
					await liveProc.exited;
				}
				rmSync(scratchDir, { recursive: true, force: true });
			}
		},
		{ timeout: 30_000 },
	);
});

describe("install.sh's atomic swap replaces the directory entry on reinstall, never rewrites the inode in place (US-001, CAM-497)", () => {
	test(
		'installing twice into the same INSTALL_DIR replaces the directory entry (a new inode each run), leaves the binary executable, and leaves no staged dot-file litter',
		async () => {
			writeFakeCurl('success');

			const first = await runInstallSh();
			expect(first.exitCode).toBe(0);
			const destPath = join(installDir, 'gship');
			const inodeAfterFirst = statSync(destPath).ino;

			const second = await runInstallSh();
			expect(second.exitCode).toBe(0);
			const inodeAfterSecond = statSync(destPath).ino;

			expect(inodeAfterSecond).not.toBe(inodeAfterFirst);
			expect(statSync(destPath).mode & 0o111).toBeGreaterThan(0);

			const leftoverDotfiles = readdirSync(installDir).filter((name) => name.startsWith('.'));
			expect(leftoverDotfiles).toEqual([]);
		},
		{ timeout: 15_000 },
	);
});
