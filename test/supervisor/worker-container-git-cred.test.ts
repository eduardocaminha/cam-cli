// test/supervisor/worker-container-git-cred.test.ts
//
// File-assert tests for the git HTTPS credential configuration (US-003, CAM-150).
//
// These tests mirror the acceptance-criteria oracles:
//   AC1 - Dockerfile contains 'x-access-token' or 'credential' (positive oracle)
//   AC2 - No .ssh mount and no .git-credentials in devcontainer.json or Dockerfile
//   AC3 - No literal token values (ghp_, github_pat_) in Dockerfile or init-firewall.sh
//   AC4 - GITHUB_TOKEN env var is referenced by name (not by a baked-in value)
//   AC4b - Configuration uses HTTPS helper form, not ssh key path
//
// The .devcontainer/ directory is NOT embedded/vendored, so no embed-vendor step.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const DEVCONTAINER_DIR = join(ROOT, '.devcontainer');

const dockerfileContent = readFileSync(join(DEVCONTAINER_DIR, 'Dockerfile'), 'utf8');
const devcontainerContent = readFileSync(join(DEVCONTAINER_DIR, 'devcontainer.json'), 'utf8');
const initFirewallContent = readFileSync(join(DEVCONTAINER_DIR, 'init-firewall.sh'), 'utf8');

// ---------------------------------------------------------------------------
// AC1: positive oracle - credential helper or x-access-token form present
// ---------------------------------------------------------------------------

describe('git HTTPS credential configuration: positive oracle (AC1)', () => {
	test('Dockerfile contains "x-access-token" (HTTPS username convention)', () => {
		expect(dockerfileContent).toContain('x-access-token');
	});

	test('Dockerfile contains "credential" (git credential config key)', () => {
		expect(dockerfileContent).toContain('credential');
	});

	test('credential helper is configured for github.com over HTTPS (not a bare global)', () => {
		// Must scope to https://github.com to avoid affecting other hosts
		expect(dockerfileContent).toContain('credential.https://github.com.helper');
	});
});

// ---------------------------------------------------------------------------
// AC2: no ~/.ssh mount, no host credential file
// ---------------------------------------------------------------------------

describe('no ~/.ssh mount and no host credential file (AC2)', () => {
	test('devcontainer.json does not reference .ssh', () => {
		expect(devcontainerContent).not.toMatch(/\.ssh/);
	});

	test('devcontainer.json does not reference .git-credentials', () => {
		expect(devcontainerContent).not.toMatch(/\.git-credentials/);
	});

	test('Dockerfile does not reference .ssh', () => {
		expect(dockerfileContent).not.toMatch(/\.ssh/);
	});

	test('Dockerfile does not reference .git-credentials', () => {
		expect(dockerfileContent).not.toMatch(/\.git-credentials/);
	});
});

// ---------------------------------------------------------------------------
// AC3: no literal token values committed
// ---------------------------------------------------------------------------

describe('no literal token value committed (AC3)', () => {
	test('Dockerfile does not contain a ghp_ token', () => {
		expect(dockerfileContent).not.toMatch(/ghp_/);
	});

	test('Dockerfile does not contain a github_pat_ token', () => {
		expect(dockerfileContent).not.toMatch(/github_pat_/);
	});

	test('init-firewall.sh does not contain a ghp_ token', () => {
		expect(initFirewallContent).not.toMatch(/ghp_/);
	});

	test('init-firewall.sh does not contain a github_pat_ token', () => {
		expect(initFirewallContent).not.toMatch(/github_pat_/);
	});
});

// ---------------------------------------------------------------------------
// AC4: GITHUB_TOKEN env var is referenced by name; HTTPS form, not ssh
// ---------------------------------------------------------------------------

describe('GITHUB_TOKEN env var reference and HTTPS form (AC4)', () => {
	test('Dockerfile references GITHUB_TOKEN by name (env var, not a baked value)', () => {
		expect(dockerfileContent).toContain('GITHUB_TOKEN');
	});

	test('credential helper script references $GITHUB_TOKEN for the password', () => {
		// The helper line echoed into the script must reference the env var
		expect(dockerfileContent).toContain('${GITHUB_TOKEN}');
	});

	test('credential helper uses HTTPS form (x-access-token), not an SSH key path', () => {
		// The username "x-access-token" is the canonical GitHub HTTPS token username
		expect(dockerfileContent).toContain('x-access-token');
		// Must not configure an SSH identity file
		expect(dockerfileContent).not.toMatch(/IdentityFile|id_rsa|id_ed25519/);
	});
});
