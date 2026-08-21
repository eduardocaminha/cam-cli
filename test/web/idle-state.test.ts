// test/web/idle-state.test.ts
//
// Real-server coverage for the between-cycle snapshot extension. The fixture
// publishes main to a real remote and tracks it, so the route exercises the
// sanctioned backlog reader over the runtime source ref (CAM-580), rather than
// deriving issue state from working-tree files.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
	resolveBootSourceSha,
	resolveWorkflowRevision,
	startWebServer,
} from '../../src/commands/web.ts';
import { fingerprintSpec } from '../../src/issues/spec.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import { GSHIP_VERSION } from '../../src/version.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function git(cwd: string, args: string[], env?: Record<string, string>): void {
	const result = Bun.spawnSync(['git', ...args], {
		cwd,
		env: env === undefined ? undefined : { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr));
	}
}

/** An author identity supplied only via env vars for one commit, never written to any config file. */
const UNPERSISTED_COMMIT_IDENTITY = {
	GIT_AUTHOR_NAME: 'Unpersisted Seed Author',
	GIT_AUTHOR_EMAIL: 'unpersisted-seed@example.invalid',
	GIT_COMMITTER_NAME: 'Unpersisted Seed Author',
	GIT_COMMITTER_EMAIL: 'unpersisted-seed@example.invalid',
};

function issue(overrides: Partial<IssueEntry> & Pick<IssueEntry, 'id' | 'title'>): IssueEntry {
	return {
		stage: 'idea',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-08-01T00:00:00Z',
		updatedAt: '2026-08-02T00:00:00Z',
		...overrides,
	};
}

/**
 * `identify: false` leaves the repository with no committer identity at all
 * in its own config, local or global -- the seed commit below still needs
 * one to succeed, so it supplies `UNPERSISTED_COMMIT_IDENTITY` through env
 * vars for that one call only, never written to any file (GSHIP-654).
 *
 * `git var GIT_AUTHOR_IDENT` -- what `checkGitIdentity` reads -- also accepts
 * an identity it auto-detects from the OS user and hostname when config and
 * env vars are both silent, and whether that guess succeeds depends on
 * hostname-resolution details of whatever machine happens to run this suite,
 * not on anything this fixture controls. `user.useConfigOnly` is git's own
 * switch for refusing that guess (confirmed to leave both config- and
 * env-var-based resolution untouched); setting it locally here, without ever
 * setting user.name/email, makes "no identity" the same deterministic state
 * on every host, matching what a genuinely identity-less container measures.
 */
function seedIdleRepo(options: { identify?: boolean } = {}): string {
	const identify = options.identify ?? true;
	const root = createTestTmpdir('gship-web-idle-');
	const cwd = join(root, 'repo');
	mkdirSync(cwd, { recursive: true });
	git(cwd, ['init', '-q', '--initial-branch=main']);
	if (identify) {
		git(cwd, ['config', 'user.email', 'gship-test@example.com']);
		git(cwd, ['config', 'user.name', 'Gateship Test']);
	} else {
		git(cwd, ['config', 'user.useConfigOnly', 'true']);
	}
	// The server under test writes its durable run store to .gship/ inside cwd
	// (RunRuntime's default path); ignore it like the real repo does so a
	// broad `git add .` in these fixtures never sweeps up that live state.
	writeFileSync(join(cwd, '.gitignore'), '.gship/\n');

	const approvedSpec = { scope: 'test', verify: ['true'] };
	const issues = [
		issue({ id: 'GSHIP-1', title: 'first idea' }),
		issue({
			id: 'GSHIP-2',
			title: 'ready',
			stage: 'specified',
			spec: approvedSpec,
			approval: {
				fingerprint: fingerprintSpec(approvedSpec),
				approvedAt: '2026-08-02T00:00:00Z',
			},
		}),
		issue({ id: 'GSHIP-3', title: 'blocked', stage: 'specified', blockedBy: ['GSHIP-1'] }),
	];
	const issueDir = join(cwd, '.gateship', 'issues');
	mkdirSync(issueDir, { recursive: true });
	for (const entry of issues) {
		writeFileSync(join(issueDir, `${entry.id}.json`), JSON.stringify(entry));
	}
	git(cwd, ['add', '.']);
	git(cwd, ['commit', '-q', '-m', 'seed backlog'], identify ? undefined : UNPERSISTED_COMMIT_IDENTITY);

	// The snapshot derives the backlog from the runtime source ref, so the
	// fixture publishes main to a remote and tracks it.
	const remote = join(root, 'remote.git');
	git(cwd, ['clone', '-q', '--bare', cwd, remote]);
	git(cwd, ['remote', 'add', 'origin', remote]);
	git(cwd, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);

	return cwd;
}

/**
 * Run `body` against one live server, giving it a snapshot reader it can call
 * more than once: the boot sha is resolved when the process starts, so what the
 * ref does afterwards is only observable through a second read of the same
 * server.
 *
 * `buildSha` stands in for the compiled-binary global (GSHIP-648): omitted, it
 * defers to the real `readBuildSha()`, which is always null under `bun test`
 * since nothing here compiles a binary, so the server falls back to the ref
 * read exactly as it did before that global existed.
 */
async function withSnapshotServer<T>(
	cwd: string,
	body: (readSnapshot: () => Promise<Record<string, unknown>>) => Promise<T>,
	buildSha?: string | null,
): Promise<T> {
	// This suite is about idle state and service freshness, not git identity,
	// and needs no seam for it: the snapshot's `checkGitIdentity` reads
	// whatever `git commit` itself would resolve (GSHIP-654), and
	// seedIdleRepo() below already sets a local `user.name`/`user.email`, so
	// it reports already-configured regardless of whether the host running
	// the suite has one of its own.
	const handle = startWebServer({ port: 0, cwd, buildSha });
	try {
		return await body(async () => {
			const response = await fetch(`http://${handle.hostname}:${handle.port}/api/snapshot`);
			expect(response.status).toBe(200);
			return (await response.json()) as Record<string, unknown>;
		});
	} finally {
		await handle.stop();
	}
}

async function getSnapshot(cwd: string): Promise<Record<string, unknown>> {
	return await withSnapshotServer(cwd, (readSnapshot) => readSnapshot());
}

function sourceSha(cwd: string): string {
	const result = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--verify', 'origin/main'], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
	return new TextDecoder().decode(result.stdout).trim();
}

/**
 * Land one more commit on the remote's main that touches `src/`, the shape of
 * an ordinary code change, and refresh the tracking ref.
 */
function advanceRemoteMain(cwd: string): void {
	mkdirSync(join(cwd, 'src'), { recursive: true });
	writeFileSync(join(cwd, 'src', 'later.ts'), 'export const landed = true;\n');
	git(cwd, ['add', '.']);
	git(cwd, ['commit', '-q', '-m', 'land after boot']);
	git(cwd, ['push', '-q', 'origin', 'main']);
	git(cwd, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
}

/**
 * Land one more commit on the remote's main that only touches a doc file --
 * the shape of a `HANDOFF.md` edit -- and refresh the tracking ref. Agents
 * read instruction files from the run's worktree, cut fresh from
 * `origin/main`, so a doc change never requires a restart.
 */
function advanceRemoteMainDocsOnly(cwd: string): void {
	writeFileSync(join(cwd, 'HANDOFF.md'), 'updated instructions\n');
	git(cwd, ['add', '.']);
	git(cwd, ['commit', '-q', '-m', 'update handoff notes']);
	git(cwd, ['push', '-q', 'origin', 'main']);
	git(cwd, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
}

/** Land one more commit on the remote's main that touches `webui/src/`. */
function advanceRemoteMainWebuiSrc(cwd: string): void {
	mkdirSync(join(cwd, 'webui', 'src'), { recursive: true });
	writeFileSync(join(cwd, 'webui', 'src', 'App.tsx'), 'export const App = () => null;\n');
	git(cwd, ['add', '.']);
	git(cwd, ['commit', '-q', '-m', 'ship a rebuilt bundle']);
	git(cwd, ['push', '-q', 'origin', 'main']);
	git(cwd, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
}

/** Land one more commit on the remote's main that touches `package.json`. */
function advanceRemoteMainManifest(cwd: string): void {
	writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'gateship', version: '0.0.1' }));
	git(cwd, ['add', '.']);
	git(cwd, ['commit', '-q', '-m', 'bump a dependency']);
	git(cwd, ['push', '-q', 'origin', 'main']);
	git(cwd, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
}

/**
 * Land one more commit on the remote's main that touches both a doc file and
 * `src/` in the same commit, and refresh the tracking ref.
 */
function advanceRemoteMainMixed(cwd: string): void {
	writeFileSync(join(cwd, 'HANDOFF.md'), 'updated instructions\n');
	mkdirSync(join(cwd, 'src'), { recursive: true });
	writeFileSync(join(cwd, 'src', 'new-module.ts'), 'export const x = 1;\n');
	git(cwd, ['add', '.']);
	git(cwd, ['commit', '-q', '-m', 'update docs and ship code']);
	git(cwd, ['push', '-q', 'origin', 'main']);
	git(cwd, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
}

/**
 * Delete the loose object for `sha` from the repo's object database. Used to
 * make a `git diff` between two otherwise-resolvable shas fail, without
 * touching either ref: `rev-parse --verify` on a ref never reads the object
 * a *different* sha points to, so this isolates the changed-path listing as
 * the thing that fails.
 */
function deleteLooseObject(cwd: string, sha: string): void {
	rmSync(join(cwd, '.git', 'objects', sha.slice(0, 2), sha.slice(2)));
}

describe('GET /api/snapshot idle state', () => {
	test('returns the source-ref-backed backlog', async () => {
		const cwd = seedIdleRepo();
		const payload = await getSnapshot(cwd);
		const idleState = payload['idleState'] as Record<string, unknown>;

		expect(Object.keys(payload)).toEqual(['idleState', 'version']);
		expect(payload['version']).toBe(GSHIP_VERSION);
		expect(idleState).toBeDefined();
		expect(Object.keys(idleState)).toEqual(['backlog']);
			expect(idleState['backlog']).toEqual({
			counts: { idea: 1, specified: 2, planned: 0 },
			drafts: [
				{
					id: 'GSHIP-2', title: 'ready', scope: 'test', verificationCommand: 'true',
					state: 'approved', approvedAt: '2026-08-02T00:00:00Z',
				},
				{ id: 'GSHIP-3', title: 'blocked', scope: '', verificationCommand: '', state: 'draft' },
			],
			plannable: [
				{
					id: 'GSHIP-2',
					title: 'ready',
					createdAt: '2026-08-01T00:00:00Z',
					updatedAt: '2026-08-02T00:00:00Z',
				},
			],
			byStage: {
				idea: [
					{
						id: 'GSHIP-1',
						title: 'first idea',
						createdAt: '2026-08-01T00:00:00Z',
						updatedAt: '2026-08-02T00:00:00Z',
					},
				],
				specified: [
					{
						id: 'GSHIP-2',
						title: 'ready',
						createdAt: '2026-08-01T00:00:00Z',
						updatedAt: '2026-08-02T00:00:00Z',
					},
					{
						id: 'GSHIP-3',
						title: 'blocked',
						createdAt: '2026-08-01T00:00:00Z',
						updatedAt: '2026-08-02T00:00:00Z',
					},
				],
				planned: [],
			},
		});
	});
});

/**
 * A repository fixture with no local identity and `user.useConfigOnly` set
 * (seedIdleRepo's own `identify: false` branch) still reads as resolvable
 * through whatever real global config the host running this suite happens to
 * have -- what `checkGitIdentity`'s `git var GIT_AUTHOR_IDENT` read is
 * supposed to see, by design: it is what `git commit` would actually use.
 * Pointing GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM at paths that do not exist
 * makes that read genuinely resolve nothing, on any host, without ever
 * touching that host's real config -- safe here specifically because
 * `checkGitIdentity` never writes, so there is no write for a stale mutated
 * env to land in the wrong place, unlike `ensureGitIdentity`.
 */
async function withNoEffectiveGitIdentity(cwd: string, body: () => Promise<void>): Promise<void> {
	const previousGlobal = process.env['GIT_CONFIG_GLOBAL'];
	const previousSystem = process.env['GIT_CONFIG_SYSTEM'];
	process.env['GIT_CONFIG_GLOBAL'] = join(cwd, 'nonexistent-gitconfig');
	process.env['GIT_CONFIG_SYSTEM'] = join(cwd, 'nonexistent-system-gitconfig');
	try {
		await body();
	} finally {
		if (previousGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
		else process.env['GIT_CONFIG_GLOBAL'] = previousGlobal;
		if (previousSystem === undefined) delete process.env['GIT_CONFIG_SYSTEM'];
		else process.env['GIT_CONFIG_SYSTEM'] = previousSystem;
	}
}

// The snapshot's own git-identity notice reads `checkGitIdentity` directly,
// with no test seam of its own: it is cheap and safe enough (one local `git
// var` read, never `gh`, never a write) to exercise for real against a
// fixture, unlike the commit paths' `ensureGitIdentity`, whose `gh` call
// this route must never be the one to trigger (GSHIP-654).
describe('GET /api/snapshot git identity (GSHIP-654)', () => {
	test('an already-configured identity adds no field', async () => {
		const cwd = seedIdleRepo();
		const handle = startWebServer({ port: 0, cwd });
		try {
			const response = await fetch(`http://${handle.hostname}:${handle.port}/api/snapshot`);
			const payload = (await response.json()) as Record<string, unknown>;
			expect(payload['gitIdentity']).toBeUndefined();
			expect(Object.keys(payload)).toEqual(['idleState', 'version']);
		} finally {
			await handle.stop();
		}
	});

	test('a missing identity surfaces its detail in the snapshot', async () => {
		const cwd = seedIdleRepo({ identify: false });
		await withNoEffectiveGitIdentity(cwd, async () => {
			const handle = startWebServer({ port: 0, cwd });
			try {
				const response = await fetch(`http://${handle.hostname}:${handle.port}/api/snapshot`);
				const payload = (await response.json()) as Record<string, unknown>;
				expect(payload['gitIdentity']).toMatchObject({ detail: expect.any(String) });
			} finally {
				await handle.stop();
			}
		});
	});

	// The defect this closes: checkGitIdentityOnce, the closure the snapshot
	// used to share with the commit paths, derived and wrote just like they
	// do. `ensureGitIdentity`'s `gh` call carries a five-second timeout, and
	// Bun's HTTP handlers run on one thread, so a snapshot that called it
	// could stall the whole service on a single GET. `checkGitIdentity`'s own
	// options do not even accept a `gh` runner (git-identity.test.ts), but
	// that guarantee is only as good as this route actually calling it: this
	// proves it end to end, against a repository with no identity at all, the
	// exact state a snapshot request would otherwise be tempted to fix.
	test('a snapshot request never calls gh and never writes any git config, even with identity missing', async () => {
		const cwd = seedIdleRepo({ identify: false });
		const localConfigPath = join(cwd, '.git', 'config');
		const configBefore = readFileSync(localConfigPath, 'utf8');
		// `[user]` itself is present (seedIdleRepo's own `useConfigOnly = true`,
		// GSHIP-654), but never a name or email: the precondition this test
		// needs is no author identity, not an empty section.
		expect(configBefore).not.toContain('name =');
		expect(configBefore).not.toContain('email =');

		await withNoEffectiveGitIdentity(cwd, async () => {
			const handle = startWebServer({ port: 0, cwd });
			try {
				const url = `http://${handle.hostname}:${handle.port}/api/snapshot`;
				const startedAt = performance.now();
				const response = await fetch(url);
				const elapsedMs = performance.now() - startedAt;
				const payload = (await response.json()) as Record<string, unknown>;

				expect(payload['gitIdentity']).toMatchObject({ detail: expect.any(String) });
				// A snapshot that called `gh` would take at least its five-second
				// timeout to answer at all; comfortably under that is evidence the
				// gh-free, write-free path ran instead of `ensureGitIdentity`.
				expect(elapsedMs).toBeLessThan(2_000);
				expect(readFileSync(localConfigPath, 'utf8')).toBe(configBefore);
			} finally {
				await handle.stop();
			}
		});
	});
});

describe('GET /api/snapshot service freshness', () => {
	test('a service on the sha it booted on says nothing', async () => {
		const cwd = seedIdleRepo();
		const payload = await getSnapshot(cwd);

		expect(payload['staleService']).toBeUndefined();
		expect(Object.keys(payload)).not.toContain('staleService');
	});

	test('a service older than origin/main reports the restart and both shas', async () => {
		const cwd = seedIdleRepo();
		const bootSha = sourceSha(cwd);

		await withSnapshotServer(cwd, async (readSnapshot) => {
			expect((await readSnapshot())['staleService']).toBeUndefined();

			advanceRemoteMain(cwd);
			const currentSha = sourceSha(cwd);
			expect(currentSha).not.toBe(bootSha);

			const notice = (await readSnapshot())['staleService'] as Record<string, unknown>;
			expect(notice).toEqual({
				bootSha,
				currentSha,
				detail: expect.stringContaining('Restart the service'),
			});
			expect(notice['detail']).toContain(bootSha);
			expect(notice['detail']).toContain(currentSha);
		});
	});

	test('an unresolvable origin/main is unknown, never an invented divergence', async () => {
		const cwd = seedIdleRepo();

		await withSnapshotServer(cwd, async (readSnapshot) => {
			// The ref the boot sha was read from is gone, so the comparison has no
			// current side: the read still answers, and it warns about nothing.
			git(cwd, ['update-ref', '-d', 'refs/remotes/origin/main']);

			const payload = await readSnapshot();
			expect(payload['staleService']).toBeUndefined();
			expect(payload['version']).toBe(GSHIP_VERSION);
		});
	});

	test('a diff confined to documentation says nothing -- the running process never loads it', async () => {
		const cwd = seedIdleRepo();

		await withSnapshotServer(cwd, async (readSnapshot) => {
			expect((await readSnapshot())['staleService']).toBeUndefined();

			advanceRemoteMainDocsOnly(cwd);

			expect((await readSnapshot())['staleService']).toBeUndefined();
		});
	});

	test('a diff touching webui/src/ reports the restart', async () => {
		const cwd = seedIdleRepo();
		const bootSha = sourceSha(cwd);

		await withSnapshotServer(cwd, async (readSnapshot) => {
			advanceRemoteMainWebuiSrc(cwd);
			const currentSha = sourceSha(cwd);

			const notice = (await readSnapshot())['staleService'] as Record<string, unknown>;
			expect(notice).toEqual({
				bootSha,
				currentSha,
				detail: expect.stringContaining('Restart the service'),
			});
		});
	});

	test('a diff touching package.json reports the restart', async () => {
		const cwd = seedIdleRepo();
		const bootSha = sourceSha(cwd);

		await withSnapshotServer(cwd, async (readSnapshot) => {
			advanceRemoteMainManifest(cwd);
			const currentSha = sourceSha(cwd);

			const notice = (await readSnapshot())['staleService'] as Record<string, unknown>;
			expect(notice).toEqual({
				bootSha,
				currentSha,
				detail: expect.stringContaining('Restart the service'),
			});
		});
	});

	test('a diff mixing documentation and code still reports the restart', async () => {
		const cwd = seedIdleRepo();
		const bootSha = sourceSha(cwd);

		await withSnapshotServer(cwd, async (readSnapshot) => {
			advanceRemoteMainMixed(cwd);
			const currentSha = sourceSha(cwd);

			const notice = (await readSnapshot())['staleService'] as Record<string, unknown>;
			expect(notice).toEqual({
				bootSha,
				currentSha,
				detail: expect.stringContaining('Restart the service'),
			});
		});
	});

	test('a failed changed-path listing says nothing, same as an unresolved sha', async () => {
		const cwd = seedIdleRepo();
		const bootSha = sourceSha(cwd);

		await withSnapshotServer(cwd, async (readSnapshot) => {
			advanceRemoteMain(cwd);
			expect(sourceSha(cwd)).not.toBe(bootSha);

			// Both shas still resolve as refs, but the object the boot sha names is
			// gone, so `git diff` between the two can't run: the listing failed
			// rather than agreeing on an empty diff, and the notice is omitted
			// exactly as it is for an unresolved sha.
			deleteLooseObject(cwd, bootSha);

			const payload = await readSnapshot();
			expect(payload['staleService']).toBeUndefined();
			expect(payload['version']).toBe(GSHIP_VERSION);
		});
	});
});

describe('GET /api/snapshot service freshness -- compiled build sha (GSHIP-648)', () => {
	test('a build sha older than the boot-time ref is preferred and catches the staleness the ref read alone would miss', async () => {
		const cwd = seedIdleRepo();
		const buildSha = sourceSha(cwd);

		// The shape of the bug this closes: a binary compiled at `buildSha` only
		// starts after a pull has already landed `advanceRemoteMain`'s commit, so
		// `origin/main` read fresh at boot is already the new commit -- the old
		// boot-ref comparison would find bootSha === currentSha and say nothing.
		advanceRemoteMain(cwd);
		const currentSha = sourceSha(cwd);
		expect(currentSha).not.toBe(buildSha);

		await withSnapshotServer(cwd, async (readSnapshot) => {
			const notice = (await readSnapshot())['staleService'] as Record<string, unknown>;
			expect(notice).toEqual({
				bootSha: buildSha,
				currentSha,
				detail: expect.stringContaining('Restart the service'),
			});
		}, buildSha);
	});

	test('no build sha falls back to the boot-time ref read, same as before the build sha existed', async () => {
		const cwd = seedIdleRepo();
		const bootSha = sourceSha(cwd);

		await withSnapshotServer(cwd, async (readSnapshot) => {
			expect((await readSnapshot())['staleService']).toBeUndefined();

			advanceRemoteMain(cwd);
			const currentSha = sourceSha(cwd);

			const notice = (await readSnapshot())['staleService'] as Record<string, unknown>;
			expect(notice).toEqual({
				bootSha,
				currentSha,
				detail: expect.stringContaining('Restart the service'),
			});
		}, null);
	});

	test('a build sha that does not resolve locally omits the notice, never inventing a divergence', async () => {
		const cwd = seedIdleRepo();
		// Shaped like a real sha, but no such object exists in this repository --
		// a build made from another clone, or from a branch that no longer exists.
		const unresolvableBuildSha = '0'.repeat(40);

		await withSnapshotServer(cwd, async (readSnapshot) => {
			advanceRemoteMain(cwd);

			const payload = await readSnapshot();
			expect(payload['staleService']).toBeUndefined();
			expect(payload['version']).toBe(GSHIP_VERSION);
		}, unresolvableBuildSha);
	});
});

// A container image compiled without its optional `GSHIP_BUILD_SHA` build arg
// (the Dockerfile's own default, and what the issue's own `docker build -t
// gateship:verify .` verify command produces) has no sha to compare against.
// `cwd` inside a container is the project being managed, not Gateship's own
// source tree, so falling back to reading its ref -- the ordinary source-run
// behavior above -- would compare against a ref with nothing to do with the
// running binary; a container "restart" can never apply newer Gateship code
// either way, only a rebuilt image can. `readSourceShaOfCwd` is a spy here
// specifically to prove that fallback is never even attempted.
describe('resolveBootSourceSha (GSHIP-654)', () => {
	test('a known build sha is used verbatim, container or not, and the ref is never read', () => {
		let calls = 0;
		const readSourceShaOfCwd = () => {
			calls += 1;
			return 'ref-sha';
		};

		expect(resolveBootSourceSha('build-sha', false, readSourceShaOfCwd)).toBe('build-sha');
		expect(resolveBootSourceSha('build-sha', true, readSourceShaOfCwd)).toBe('build-sha');
		expect(calls).toBe(0);
	});

	test('no build sha outside a container falls back to the ref read, unchanged from before GSHIP-654', () => {
		const readSourceShaOfCwd = () => 'ref-sha';

		expect(resolveBootSourceSha(null, false, readSourceShaOfCwd)).toBe('ref-sha');
	});

	test('no build sha inside a container says nothing, and never reads the ref at all', () => {
		let calls = 0;
		const readSourceShaOfCwd = () => {
			calls += 1;
			return 'ref-sha';
		};

		expect(resolveBootSourceSha(null, true, readSourceShaOfCwd)).toBeNull();
		expect(calls).toBe(0);
	});
});

describe('resolveWorkflowRevision', () => {
	test('prefers the embedded build over any source checkout', () => {
		let reads = 0;
		expect(resolveWorkflowRevision('build-sha', false, () => {
			reads += 1;
			return 'runtime-sha';
		})).toBe('build-sha');
		expect(reads).toBe(0);
	});

	test('a development run reads Gateship itself, never the managed project ref', () => {
		expect(resolveWorkflowRevision(null, false, () => 'runtime-sha')).toBe('runtime-sha');
	});

	test('an unidentified package or container falls back to the public version', () => {
		let containerReads = 0;
		expect(resolveWorkflowRevision(null, false, () => null)).toBe(`v${GSHIP_VERSION}`);
		expect(resolveWorkflowRevision(null, true, () => {
			containerReads += 1;
			return 'managed-project-sha';
		})).toBe(`v${GSHIP_VERSION}`);
		expect(containerReads).toBe(0);
	});
});
