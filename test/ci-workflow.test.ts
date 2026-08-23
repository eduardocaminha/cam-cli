// Static-source guard for .github/workflows/ci.yml (GSHIP-734). The workflow
// shape is intentionally checked from source so a concurrency or trigger
// change cannot silently reintroduce release suppression.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOW_PATH = resolve(import.meta.dir, '..', '.github', 'workflows', 'ci.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

function blockBetween(startMarker: string, endMarker: string): string {
	const start = workflow.indexOf(startMarker);
	expect(start).toBeGreaterThan(-1);
	const end = workflow.indexOf(endMarker, start + startMarker.length);
	return workflow.slice(start, end === -1 ? workflow.length : end);
}

describe('ci.yml push trigger (GSHIP-734)', () => {
	test('ignores only issue metadata paths on pushes to main', () => {
		const pushBlock = blockBetween('\n  push:\n', '\n  pull_request:\n');

		expect(pushBlock).toContain('branches: [main]');
		expect(pushBlock).toContain("paths-ignore:\n      - '.gateship/issues/**'");
		expect(pushBlock.match(/^      - .+$/gm)).toEqual(["      - '.gateship/issues/**'"]);
	});
});

describe('ci.yml concurrency (GSHIP-734)', () => {
	test('separates push runs by SHA and groups pull request runs by PR number', () => {
		const concurrencyBlock = blockBetween('\nconcurrency:\n', '\njobs:\n');

		expect(concurrencyBlock).toContain("github.event_name == 'push'");
		expect(concurrencyBlock).toContain('github.sha');
		expect(concurrencyBlock).toContain('github.event.pull_request.number');
		expect(concurrencyBlock).toContain('cancel-in-progress: true');
	});
});
