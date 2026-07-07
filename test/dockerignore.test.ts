// test/dockerignore.test.ts
//
// US-001 (CAM-177) golden-fixture test for the repo-root .dockerignore.
// Asserts (a) the four allowlist lines are present, in exact relative
// order, and (b) a header comment block precedes them explaining the
// ignore-all-but-one rule and the "new COPY needs a matching re-include"
// invariant.

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const DOCKERIGNORE_PATH = resolve(import.meta.dir, '..', '.dockerignore');

const ALLOWLIST_LINES = ['*', '!.devcontainer', '.devcontainer/*', '!.devcontainer/claude-config.json'];

describe('.dockerignore golden fixture', () => {
	test('contains the four allowlist lines in exact relative order', async () => {
		const content = await Bun.file(DOCKERIGNORE_PATH).text();
		const lines = content.split('\n');

		const indices = ALLOWLIST_LINES.map((needle) => lines.indexOf(needle));

		for (const [i, index] of indices.entries()) {
			expect(index, `expected line ${JSON.stringify(ALLOWLIST_LINES[i])} to be present`).toBeGreaterThanOrEqual(0);
		}

		for (let i = 1; i < indices.length; i++) {
			const prev = indices[i - 1] as number;
			const curr = indices[i] as number;
			expect(curr, `expected ${JSON.stringify(ALLOWLIST_LINES[i])} to come after ${JSON.stringify(ALLOWLIST_LINES[i - 1])}`).toBeGreaterThan(prev);
		}
	});

	test('has a header comment explaining the ignore-all-but-one rule and the COPY invariant', async () => {
		const content = await Bun.file(DOCKERIGNORE_PATH).text();
		const lines = content.split('\n');

		const commentLines = lines.filter((line) => line.startsWith('#'));
		expect(commentLines.length).toBeGreaterThan(0);

		const hasCopyMention = commentLines.some((line) => /COPY/i.test(line));
		expect(hasCopyMention).toBe(true);
	});

	test('the header comment precedes the first allowlist line', async () => {
		const content = await Bun.file(DOCKERIGNORE_PATH).text();
		const lines = content.split('\n');

		const firstCommentIndex = lines.findIndex((line) => line.startsWith('#'));
		const firstAllowlistIndex = lines.indexOf(ALLOWLIST_LINES[0] as string);

		expect(firstCommentIndex).toBeGreaterThanOrEqual(0);
		expect(firstAllowlistIndex).toBeGreaterThan(firstCommentIndex);
	});
});
