import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { GitFullVerifier } from '../../src/runtime/git-runtime.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const verificationInput = {
	runId: 'run-multistack',
	issueId: 'GSHIP-747',
	sessionId: 'session-multistack',
	resume: false,
	signal: new AbortController().signal,
	emit: () => {},
};

function git(cwd: string, args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function createRepository(prefix: string, files: Record<string, string>): string {
	const root = createTestTmpdir(prefix);
	execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Gateship Test'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'gateship-test@example.com'], { cwd: root });
	for (const [path, content] of Object.entries(files)) {
		const fullPath = join(root, path);
		mkdirSync(join(fullPath, '..'), { recursive: true });
		writeFileSync(fullPath, content);
	}
	execFileSync('git', ['add', '.'], { cwd: root });
	execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root });
	execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
	return root;
}

function prepareWorktree(root: string, name: string): string {
	const worktree = join(createTestTmpdir(`${name}-worktree-parent-`), 'worktree');
	git(root, ['worktree', 'add', '--quiet', '-b', `gship/${name}`, worktree, 'origin/main']);
	return worktree;
}

describe('GitFullVerifier multistack integration', () => {
	test('runs the base-authorized Bun command against the changed JavaScript worktree', async () => {
		const root = createRepository('gship-multistack-javascript-', {
			'.gateship/project.json': JSON.stringify({ version: 1, verify: ['bun test verify.test.js'] }),
			'implementation.js': "export const value = 'base';\n",
			'verify.test.js': "import { expect, test } from 'bun:test';\nimport { value } from './implementation.js';\ntest('changed implementation', () => expect(value).toBe('changed'));\n",
		});
		const worktree = prepareWorktree(root, 'gship-multistack-javascript');
		try {
			writeFileSync(join(worktree, 'implementation.js'), "export const value = 'changed';\n");
			const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
			const result = await new GitFullVerifier().verify({
				...verificationInput,
				cwd: worktree,
				emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
			});
			expect(result).toEqual({ ok: true });
			expect(events).toEqual([
				{ kind: 'full-verify.command.started', payload: { commandIndex: 1, origin: 'manifest' } },
				{ kind: 'full-verify.command.completed', payload: { commandIndex: 1, exitCode: 0, origin: 'manifest' } },
			]);
		} finally {
			git(root, ['worktree', 'remove', '--force', worktree]);
		}
	});

	test('runs the base-authorized python3 unittest command against the changed Python worktree', async () => {
		const root = createRepository('gship-multistack-python-', {
			'.gateship/project.json': JSON.stringify({ version: 1, verify: ['python3 -m unittest verify.py'] }),
			'implementation.py': "value = 'base'\n",
			'verify.py': "import unittest\nfrom implementation import value\n\nclass ImplementationTest(unittest.TestCase):\n    def test_changed_implementation(self):\n        self.assertEqual(value, 'changed')\n\nif __name__ == '__main__':\n    unittest.main()\n",
		});
		const worktree = prepareWorktree(root, 'gship-multistack-python');
		try {
			writeFileSync(join(worktree, 'implementation.py'), "value = 'changed'\n");
			const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
			const result = await new GitFullVerifier().verify({
				...verificationInput,
				cwd: worktree,
				emit: (kind, payload) => events.push({ kind, ...(payload === undefined ? {} : { payload }) }),
			});
			expect(result).toEqual({ ok: true });
			expect(events).toEqual([
				{ kind: 'full-verify.command.started', payload: { commandIndex: 1, origin: 'manifest' } },
				{ kind: 'full-verify.command.completed', payload: { commandIndex: 1, exitCode: 0, origin: 'manifest' } },
			]);
		} finally {
			git(root, ['worktree', 'remove', '--force', worktree]);
		}
	});
});
