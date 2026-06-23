// test/ci-workflow.test.ts
//
// Green-local == green-CI proof (US-003, CAM-59 PRD).
//
// Runs check:ci-parity logic against the REAL committed
// .github/workflows/ci.yml and asserts it is structurally correct.
// This test must stay in sync with the workflow file; if ci.yml drifts,
// this test fails locally before the bad commit reaches CI.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkParityFromFile } from '../scripts/check-ci-parity.ts';
import { GATES } from '../scripts/check-all.ts';

// ---------------------------------------------------------------------------
// Resolve the real ci.yml path relative to this test file's directory
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(import.meta.dir, '..');
const CI_YML = join(PROJECT_ROOT, '.github', 'workflows', 'ci.yml');
const ciContent = readFileSync(CI_YML, 'utf8');

// ---------------------------------------------------------------------------
// Parity: the real ci.yml passes checkParityFromFile
// ---------------------------------------------------------------------------

describe('ci.yml parity check', () => {
	test('checkParityFromFile passes against the real ci.yml', () => {
		const result = checkParityFromFile(CI_YML, GATES);
		if (!result.ok) {
			// Surface the exact errors so a failing run is actionable
			throw new Error(
				`ci-parity check failed:\n${result.errors.join('\n')}`,
			);
		}
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Structural assertions: macos-latest + tmux install
// ---------------------------------------------------------------------------

describe('ci.yml structural assertions', () => {
	test('declares runs-on: macos-latest', () => {
		expect(ciContent).toContain('runs-on: macos-latest');
	});

	test('installs tmux via brew', () => {
		expect(ciContent).toContain('brew install tmux');
	});

	test('uses oven-sh/setup-bun@v2', () => {
		expect(ciContent).toContain('oven-sh/setup-bun@v2');
	});

	test('installs deps with --frozen-lockfile', () => {
		expect(ciContent).toContain('bun install --frozen-lockfile');
	});

	test('invokes only bun run check:all as the gate spine', () => {
		expect(ciContent).toContain('bun run check:all');
	});

	test('triggers on pull_request', () => {
		expect(ciContent).toContain('pull_request');
	});

	test('sets cancel-in-progress: true', () => {
		expect(ciContent).toContain('cancel-in-progress: true');
	});
});
