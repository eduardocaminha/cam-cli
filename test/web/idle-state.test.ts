// test/web/idle-state.test.ts
//
// Real-server coverage for the between-cycle snapshot extension. The fixture
// publishes main to a real remote and tracks it, so the route exercises the
// sanctioned backlog reader over the runtime source ref (CAM-580), rather than
// deriving issue state from working-tree files.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import { fingerprintSpec } from '../../src/issues/spec.ts';
import type { IssueEntry } from '../../src/issues/types.ts';
import { GSHIP_VERSION } from '../../src/version.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function git(cwd: string, args: string[]): void {
	const result = Bun.spawnSync(['git', ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr));
	}
}

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

function seedIdleRepo(): string {
	const root = createTestTmpdir('gship-web-idle-');
	const cwd = join(root, 'repo');
	mkdirSync(cwd, { recursive: true });
	git(cwd, ['init', '-q', '--initial-branch=main']);
	git(cwd, ['config', 'user.email', 'gship-test@example.com']);
	git(cwd, ['config', 'user.name', 'Gateship Test']);
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
	git(cwd, ['commit', '-q', '-m', 'seed backlog']);

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
				detail: expect.stringContaining('Reinicie o serviço'),
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
				detail: expect.stringContaining('Reinicie o serviço'),
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
				detail: expect.stringContaining('Reinicie o serviço'),
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
				detail: expect.stringContaining('Reinicie o serviço'),
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
				detail: expect.stringContaining('Reinicie o serviço'),
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
				detail: expect.stringContaining('Reinicie o serviço'),
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
