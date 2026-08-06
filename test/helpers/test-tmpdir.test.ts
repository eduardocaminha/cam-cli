// test/helpers/test-tmpdir.test.ts
//
// Pins the behavior of the single test-scratch helper (US-002, CAM-508):
// every directory it creates lives under the repo-local scratch root, the
// root survives process.chdir(), git cannot walk out of it into cam-cli's
// own working tree, and directories created in a child process are reaped
// when that process exits.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
// `tmpdir()` is imported ONLY as a comparand below (never as `join(tmpdir(),
// ...)`, per GOTCHA 8 -- a future tree-wide oracle keys on that exact
// spelling being absent).
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { gitAvailable } from './test-deps';
import { createTestTmpdir, SCRATCH_ROOT } from './test-tmpdir';

const REPO_ROOT = join(import.meta.dir, '..', '..');

describe('createTestTmpdir', () => {
	test('returns a path under the repo-local scratch root', () => {
		const dir = createTestTmpdir();
		expect(dir.startsWith(SCRATCH_ROOT)).toBe(true);
	});

	test('does not start with the os temp dir', () => {
		const dir = createTestTmpdir();
		expect(dir.startsWith(tmpdir())).toBe(false);
	});

	test('stays under the scratch root after process.chdir() out of the repo', () => {
		const cwdBefore = process.cwd();
		try {
			// dirname(REPO_ROOT) is the parent of the repo checkout: outside the
			// repo, but not $TMPDIR, so this exercises the chdir concern in
			// isolation from the os-tmpdir concern above.
			process.chdir(dirname(REPO_ROOT));
			const dir = createTestTmpdir();
			expect(dir.startsWith(SCRATCH_ROOT)).toBe(true);
		} finally {
			process.chdir(cwdBefore);
		}
	});

	test('pinning guard: the first path segment relative to the repo root starts with a dot', () => {
		// Derived from the helper's own return value, never a frozen literal
		// (patterns.md:928): bun's test discovery walks the cwd at startup and
		// would collect a *.test.ts fixture left inside a gitignored directory
		// WITHOUT a leading dot, turning a crash-surviving fixture into a
		// phantom failing test on the next run.
		const dir = createTestTmpdir();
		const rel = relative(REPO_ROOT, dir);
		const firstSegment = rel.split(sep)[0];
		expect(firstSegment?.startsWith('.')).toBe(true);
	});

	test.skipIf(!gitAvailable)(
		'GIT_CEILING_DIRECTORIES stops git from resolving the cam-cli root from a scratch dir (env forwarded)',
		async () => {
			// Unchanged by US-R1-003 (CAM-508): git's own docs on
			// GIT_CEILING_DIRECTORIES say a ceiling that is a strict ANCESTOR of
			// the search's starting directory is respected (the walk stops before
			// reaching it, so its .git is never even checked) -- distinct from the
			// ceiling being the exact starting directory (still checked then). Here
			// GIT_CEILING_DIRECTORIES=SCRATCH_ROOT is a strict ancestor of `dir`,
			// so this still fails "not a git repository" even though SCRATCH_ROOT
			// now has its own .git (ensureScratchRootIsAGitRepo) -- confirmed
			// empirically. The important safety property (this fence never
			// resolves into cam-cli's own working tree) is proved by the two tests
			// below instead, which is what actually matters for the hazard this
			// story closes.
			const dir = createTestTmpdir();
			const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], {
				cwd: dir,
				env: process.env,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const exitCode = await proc.exited;
			const stderr = await new Response(proc.stderr).text();
			expect(exitCode).not.toBe(0);
			expect(stderr).toContain('not a git repository');
		},
	);

	test.skipIf(!gitAvailable)(
		'location-independent fence: the same holds even when the spawn site does NOT forward live process.env (US-R1-003, CAM-508)',
		async () => {
			// Reproduces the exact hazard the review finding named: a git spawn
			// call with no `env` option (matching src/commands/sidecar.ts's
			// checkoutMainFn/proceedBranchFn call shape) never sees the runtime
			// GIT_CEILING_DIRECTORIES mutation set by ensureScratchRoot -- so this
			// proves the fence holds on ensureScratchRootIsAGitRepo's stub repo
			// alone, independent of env propagation.
			const dir = createTestTmpdir();
			const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], {
				cwd: dir,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const exitCode = await proc.exited;
			const stdout = (await new Response(proc.stdout).text()).trim();
			expect(exitCode).toBe(0);
			const toplevel = realpathSync(stdout);
			expect(toplevel).toBe(realpathSync(SCRATCH_ROOT));
			expect(toplevel).not.toBe(realpathSync(REPO_ROOT));
		},
	);

	test('exit hook: a directory created by the helper in a `bun -e` child process is removed once that process exits', async () => {
		// This pins the secondary `process.on('exit', ...)` layer only (see
		// test-tmpdir.ts's header comment): `bun -e` is a runtime where exit
		// hooks DO fire, unlike `bun test` (pinned separately below).
		const helperPath = join(import.meta.dir, 'test-tmpdir.ts');
		const proc = Bun.spawn(['bun', '-e', `import { createTestTmpdir } from '${helperPath}'; console.log(createTestTmpdir());`], {
			cwd: REPO_ROOT,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode).toBe(0);
		const childDir = stdout.trim();
		expect(childDir.length > 0).toBe(true);
		expect(stderr).toBe('');

		expect(existsSync(childDir)).toBe(false);
	});

	test('reaper: a directory created via createTestTmpdir during a REAL `bun test` run is removed once that run exits', async () => {
		// US-R1-002 (CAM-508): the exit hook above never fires under `bun
		// test`, the runner every real call site in this suite uses. This
		// spawns the actual `bun test` runner (not `bun -e`) against a fixture
		// file, so it proves bunfig.toml's [test].preload + the afterAll in
		// test/helpers/reap-preload.ts really reaps the directory.
		const fixturePath = join(REPO_ROOT, 'test', 'fixtures', 'reap-preload-fixture.ts');
		const proc = Bun.spawn(['bun', 'test', fixturePath], {
			cwd: REPO_ROOT,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode).toBe(0);
		const match = stdout.match(/CAM_REAP_FIXTURE_DIR:(\S+)/);
		if (!match || !match[1]) {
			throw new Error(`fixture did not report a directory path; stdout=${stdout} stderr=${stderr}`);
		}
		const childDir = match[1];

		expect(existsSync(childDir)).toBe(false);
	});
});
