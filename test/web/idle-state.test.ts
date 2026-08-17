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
 */
async function withSnapshotServer<T>(
	cwd: string,
	body: (readSnapshot: () => Promise<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
	const handle = startWebServer({ port: 0, cwd });
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

/** Land one more commit on the remote's main and refresh the tracking ref. */
function advanceRemoteMain(cwd: string): void {
	writeFileSync(join(cwd, 'later.txt'), 'landed after the service booted\n');
	git(cwd, ['add', '.']);
	git(cwd, ['commit', '-q', '-m', 'land after boot']);
	git(cwd, ['push', '-q', 'origin', 'main']);
	git(cwd, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
}

/**
 * Land one more commit on the remote's main that only touches `.gateship/`,
 * the shape of an archive, an approve or a close, and refresh the tracking
 * ref.
 */
function advanceRemoteMainLedgerOnly(cwd: string): void {
	const issueDir = join(cwd, '.gateship', 'issues');
	writeFileSync(join(issueDir, 'GSHIP-4.json'), JSON.stringify(issue({ id: 'GSHIP-4', title: 'archived' })));
	git(cwd, ['add', '.']);
	git(cwd, ['commit', '-q', '-m', 'archive an issue']);
	git(cwd, ['push', '-q', 'origin', 'main']);
	git(cwd, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
}

/**
 * Land one more commit on the remote's main that touches both `.gateship/`
 * and a path outside it in the same commit, and refresh the tracking ref.
 */
function advanceRemoteMainMixed(cwd: string): void {
	const issueDir = join(cwd, '.gateship', 'issues');
	writeFileSync(join(issueDir, 'GSHIP-4.json'), JSON.stringify(issue({ id: 'GSHIP-4', title: 'archived' })));
	writeFileSync(join(cwd, 'later.txt'), 'landed after the service booted\n');
	git(cwd, ['add', '.']);
	git(cwd, ['commit', '-q', '-m', 'archive an issue and ship code']);
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

	test('a diff confined to .gateship/ says nothing -- archiving, approving and closing land there continuously', async () => {
		const cwd = seedIdleRepo();

		await withSnapshotServer(cwd, async (readSnapshot) => {
			expect((await readSnapshot())['staleService']).toBeUndefined();

			advanceRemoteMainLedgerOnly(cwd);

			expect((await readSnapshot())['staleService']).toBeUndefined();
		});
	});

	test('a diff mixing .gateship/ and code still reports the restart', async () => {
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
