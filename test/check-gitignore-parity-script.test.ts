// test/check-gitignore-parity-script.test.ts
//
// US-004, CAM-502: drives the real scripts/check-gitignore-parity.sh (the
// derived US-002 parity oracle) from `bun test`, so the existing `check:all`
// test gate enforces it on every change instead of depending on someone
// remembering to run the shell script by hand. This is the compensating
// coverage US-002's notes flagged for choosing a `.sh`: the precedent is
// test/build-release-smoke.test.ts, guarding the repo's other shell script.
//
// Three legs, all against the REAL script via Bun.spawnSync (no reimplementation,
// per the ANTI-SHADOW-MOCK convention in test/orch-agent-allowlist.test.ts):
//   1. parity leg (AC1): run against this repo's own root, assert a zero exit
//      and no DIVERGE line in stdout.
//   2. non-vacuity leg (AC2): the PROBES=<n> line must be above a degeneracy
//      floor, so an empty or collapsed derivation can never read as a pass.
//      The script's own contract already hard-fails at PROBES=0 (see the
//      fail-closed leg below); this floor is stricter, catching a derivation
//      that limps along with only 1-2 probes.
//   3. source-guard leg (AC3): the script text must carry no hand-written
//      artifact literal (e.g. a specific runtime-artifact filename), so the
//      derivation can't be quietly replaced with an enumerated list later.
//   4. fail-closed leg (AC4): run against a throwaway repo holding only a
//      copy of templates/.gitignore and no src/ tree to grep -- the
//      derivation collapses to zero probes and the script must exit
//      non-zero with its own FAIL message, never a false pass.
//
// HONEST LIMITATION (carried from the script's own header, and from this
// story's notes): the parity check is a set-equality comparison of git
// check-ignore verdicts. It detects template-vs-repo DIVERGENCE only. An
// artifact ignored by NEITHER file produces zero DIVERGE lines and passes.
// This test does not close that blind spot; test/templates-gitignore-runtime-artifacts.test.ts
// (US-003) is the complementary coverage for that class.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'check-gitignore-parity.sh');
const scriptText = readFileSync(SCRIPT_PATH, 'utf8');

// Below this many derived probes, the derivation is treated as degenerate
// even though it isn't literally zero (the script's own floor). Current
// live count on this repo is in the low 40s; 10 leaves generous headroom
// for legitimate shrinkage while still catching a collapsed derivation.
const DEGENERACY_FLOOR = 10;

function runParityScript(repoRoot: string): { stdout: string; exitCode: number } {
	const r = Bun.spawnSync(['bash', SCRIPT_PATH, repoRoot], { stdout: 'pipe', stderr: 'pipe' });
	return { stdout: new TextDecoder().decode(r.stdout), exitCode: r.exitCode };
}

describe('check-gitignore-parity.sh (US-004, CAM-502)', () => {
	test('parity leg: zero exit and no DIVERGE line against this repo (AC1)', () => {
		const { stdout, exitCode } = runParityScript(REPO_ROOT);
		expect(exitCode).toBe(0);
		expect(stdout).not.toMatch(/^DIVERGE /m);
	});

	test('non-vacuity leg: PROBES count is above the degeneracy floor (AC2)', () => {
		const { stdout } = runParityScript(REPO_ROOT);
		const probesLine = stdout.split('\n').find((l) => l.startsWith('PROBES='));
		expect(probesLine).toBeDefined();
		const count = Number((probesLine ?? '').slice('PROBES='.length));
		expect(Number.isFinite(count)).toBe(true);
		expect(count).toBeGreaterThan(DEGENERACY_FLOOR);
	});

	test('source-guard leg: the script carries no hand-written artifact literal (AC3)', () => {
		// A regression that swaps the live grep-derivation for a hand-enumerated
		// list would typically start by hardcoding one of the concrete runtime
		// artifacts this repo actually produces (see US-002/US-003 for the
		// full list). Checking one representative literal is enough to catch
		// that class of regression without duplicating the enumerated list here.
		expect(scriptText).not.toContain('cam-worker-events');
		expect(scriptText).not.toContain('.cam-sidecar-liveness-watcher');
	});

	test('fail-closed leg: a throwaway repo with only templates/.gitignore and no src/ exits non-zero (AC4)', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-gitignore-parity-failclosed-'));
		try {
			const templateGitignore = readFileSync(join(REPO_ROOT, 'templates', '.gitignore'), 'utf8');
			writeFileSync(join(cwd, '.gitignore'), templateGitignore, 'utf8');
			const { stdout, exitCode } = runParityScript(cwd);
			// Distinguish the script's own fail-closed verdict (exit 2, degenerate
			// derivation) from an unrelated subprocess crash: assert the exact
			// contract exit code AND the FAIL message, not just "non-zero".
			expect(exitCode).toBe(2);
			expect(stdout).toContain('FAIL: derivation produced zero probes');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
