// test/templates-gitignore-dotenv.test.ts
//
// US-001, CAM-499: `gship init` ships a `.gitignore` (templates/.gitignore,
// embedded into src/vendor/_generated.ts) that must make git actually ignore
// `.env` and its local-variant family (`.env.local`, `.env.production.local`,
// `.env.test.local`, ...) at the project root. Agents running with
// bypassPermissions commit and push on their own, so a credentials file the
// product docs tell users to create (GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN,
// RESEND_API_KEY) must never be committable by accident.
//
// This is proven by BEHAVIOR (real `git check-ignore` against a real tmpdir
// repo), never by substring presence in the template string. It covers both
// gitignore-production paths of `materializeTemplates` (src/templates/embedded.ts):
//   1. verbatim-write path: the target project has no `.gitignore` yet.
//   2. merge path: the target project already has its own `.gitignore`
//      (mergeGitignore appends only missing non-comment lines).
//
// US-R1-001, CAM-499 review follow-up: DOTENV_FILES alone is a positive-only
// control (every entry MUST be ignored), so a blanket `.env*` rule would pass
// both tests just as well as the intended non-blanket `.env` / `.env.local` /
// `.env.*.local` shape. NOT_IGNORED_FILES is the negative control that locks
// the non-blanket shape: `.env.example` must stay committable.

import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createTestTmpdir } from './helpers/test-tmpdir';
import { join } from 'node:path';

import { materializeTemplates } from '../src/templates/embedded.ts';

const DOTENV_FILES = ['.env', '.env.local', '.env.production.local', '.env.test.local'] as const;
const NOT_IGNORED_FILES = ['.env.example'] as const;

/** Real `git check-ignore -q <file>`; true iff git actually ignores it. */
function isIgnored(cwd: string, file: string): boolean {
	const r = Bun.spawnSync(['git', '-C', cwd, 'check-ignore', '-q', file]);
	return r.exitCode === 0;
}

function makeTmpRepo(): string {
	const cwd = createTestTmpdir('cam-gitignore-dotenv-');
	const init = Bun.spawnSync(['git', '-C', cwd, 'init', '-q']);
	if (init.exitCode !== 0) throw new Error(`git init failed: ${new TextDecoder().decode(init.stderr)}`);
	return cwd;
}

describe('templates gitignore ignores dotenv', () => {
	test('verbatim path: no pre-existing .gitignore, the materialized template ignores the dotenv family', () => {
		const cwd = makeTmpRepo();
		try {
			expect(existsSync(join(cwd, '.gitignore'))).toBe(false);
			materializeTemplates(cwd);
			expect(existsSync(join(cwd, '.gitignore'))).toBe(true);
			for (const file of DOTENV_FILES) {
				writeFileSync(join(cwd, file), '', 'utf8');
				expect(isIgnored(cwd, file)).toBe(true);
			}
			for (const file of NOT_IGNORED_FILES) {
				writeFileSync(join(cwd, file), '', 'utf8');
				expect(isIgnored(cwd, file)).toBe(false);
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('merge path: pre-existing .gitignore is preserved and the merged file still ignores the dotenv family', () => {
		const cwd = makeTmpRepo();
		try {
			writeFileSync(join(cwd, '.gitignore'), 'node_modules\n', 'utf8');
			materializeTemplates(cwd);
			for (const file of DOTENV_FILES) {
				writeFileSync(join(cwd, file), '', 'utf8');
				expect(isIgnored(cwd, file)).toBe(true);
			}
			for (const file of NOT_IGNORED_FILES) {
				writeFileSync(join(cwd, file), '', 'utf8');
				expect(isIgnored(cwd, file)).toBe(false);
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
