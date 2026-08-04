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
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INSTALL_SCRIPT = join(import.meta.dir, '..', 'install.sh');

let fakeBinDir: string;
let installDir: string;

beforeEach(() => {
	fakeBinDir = mkdtempSync(join(tmpdir(), 'cam-test-install-bin-'));
	installDir = mkdtempSync(join(tmpdir(), 'cam-test-install-dest-'));
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
function writeFakeCurl(behavior: 'network-failure' | 'empty-list' | 'success' | 'checksum-mismatch'): void {
	const script =
		behavior === 'network-failure'
			? '#!/usr/bin/env bash\nexit 22\n' // curl -f style failure (e.g. rate-limit 403)
			: behavior === 'empty-list'
				? '#!/usr/bin/env bash\necho "[]"\nexit 0\n' // 200 OK, no releases published yet
				: // 'success' / 'checksum-mismatch': three call shapes hit this shim —
					// (1) no `-o`: the releases-list lookup, JSON on stdout;
					// (2) `-o <path>`, URL is the asset: write a dummy payload;
					// (3) `-o <path>`, URL ends in SHA256SUMS.txt: write a one-line
					// manifest whose digest is computed from the payload bytes this
					// SAME shim just served in call (2) — never a frozen literal.
					// State (the payload's digest + asset basename) is stashed in a
					// file next to the shim itself, since each call is a fresh process.
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
						'  ASSET_NAME="$(cut -d" " -f1 "${STATE}")"',
						'  PAYLOAD_HASH="$(cut -d" " -f2 "${STATE}")"',
						behavior === 'checksum-mismatch'
							? '  MANIFEST_HASH="$(printf "" | hash_file /dev/stdin)"'
							: '  MANIFEST_HASH="${PAYLOAD_HASH}"',
						'  printf "%s  %s\\n" "${MANIFEST_HASH}" "${ASSET_NAME}" > "${OUT}"',
						'  exit 0',
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

async function runInstallSh(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(['/bin/bash', INSTALL_SCRIPT], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			PATH: `${fakeBinDir}:/usr/bin:/bin`,
			GATESHIP_INSTALL_DIR: installDir,
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

describe('install.sh checksum verification (US-003, CAM-495)', () => {
	test('SHA256SUMS.txt digest mismatch: exits 1 before installing anything', async () => {
		writeFakeCurl('checksum-mismatch');

		const { exitCode, stderr } = await runInstallSh();

		expect(exitCode).toBe(1);
		expect(stderr).toContain('ERROR: checksum mismatch for');
		expect(await Bun.file(join(installDir, 'gateship')).exists()).toBe(false);
		expect(await Bun.file(join(installDir, 'gship')).exists()).toBe(false);
	});
});
