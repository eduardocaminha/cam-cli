import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkParityFromFile } from '../scripts/check-ci-parity.ts';
import { GATES } from '../scripts/check-all.ts';

const projectRoot = join(import.meta.dir, '..');
const workflowPath = join(projectRoot, '.github', 'workflows', 'ci.yml');
const workflow = readFileSync(workflowPath, 'utf8');

describe('CI workflow', () => {
	test('runs the same gate spine as local development', () => {
		expect(checkParityFromFile(workflowPath, GATES)).toEqual({ ok: true, errors: [] });
		expect(workflow).toContain('bun run check:all -- --json');
	});

	test('uses one host job with the pinned Bun version', () => {
		expect(workflow).toContain('runs-on: ubuntu-latest');
		expect(workflow).toContain('bun-version-file: .bun-version');
		expect(workflow).toContain('bun install --frozen-lockfile');
		expect(workflow).not.toContain('ci-container:');
		expect(workflow).not.toContain('tmux');
	});

	test('runs for pull requests and cancels stale runs', () => {
		expect(workflow).toContain('pull_request:');
		expect(workflow).toContain('cancel-in-progress: true');
	});
});
