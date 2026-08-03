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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** Writes a fake `curl` executable to fakeBinDir that reacts to the releases-list URL. */
function writeFakeCurl(behavior: 'network-failure' | 'empty-list'): void {
	const script =
		behavior === 'network-failure'
			? '#!/usr/bin/env bash\nexit 22\n' // curl -f style failure (e.g. rate-limit 403)
			: '#!/usr/bin/env bash\necho "[]"\nexit 0\n'; // 200 OK, no releases published yet
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
