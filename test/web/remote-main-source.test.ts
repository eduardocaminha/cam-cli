// test/web/remote-main-source.test.ts
//
// CAM-580 acceptance criterion 3: the idle snapshot derives its backlog from
// origin/main, so an issue a merge already shipped stops being plannable even
// while the local main is deliberately behind.
//
// The fixture keeps the clone's `main` pinned at the pre-merge commit on
// purpose: with the old reader that stale ref is what the browser was offered,
// and the next run would start from a base the remote had already moved past.
//
// The last case guards the other half of the criterion -- the route must not
// turn into a `git fetch` per poll. The refresh belongs to the start of a run
// and to the terminal of a ship.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';
import { readBacklogFromMain } from '../../src/issues/backlog.ts';
import { fingerprintSpec } from '../../src/issues/spec.ts';
import { RUNTIME_SOURCE_REF } from '../../src/runtime/source-ref.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

function git(cwd: string, args: string[]): string {
	const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

function identify(cwd: string): void {
	git(cwd, ['config', 'user.name', 'Gateship Test']);
	git(cwd, ['config', 'user.email', 'test@example.invalid']);
}

function writeIssue(cwd: string, file: string, id: string, stage: string): void {
	mkdirSync(join(cwd, '.gateship', 'issues'), { recursive: true });
	const spec = { acceptanceCriteria: ['works'], scope: 'test', gotchas: [], domainTerms: [] };
	writeFileSync(
		join(cwd, '.gateship', 'issues', file),
		`${JSON.stringify({
			id,
			title: `${id} fixture`,
			stage,
			status: 'open',
			blockedBy: [],
			createdAt: '2026-08-15T00:00:00Z',
			updatedAt: '2026-08-15T00:00:00Z',
			spec,
			approval: stage === 'specified'
				? { fingerprint: fingerprintSpec(spec), approvedAt: '2026-08-15T00:00:00Z' }
				: undefined,
		}, null, 2)}\n`,
	);
}

interface Fixture {
	/** Author clone that publishes merges, standing in for the GitHub side. */
	author: string;
	remote: string;
	local: string;
}

/**
 * A clone whose `main` is pinned at the pre-merge commit while `origin/main`
 * already carries the merge that shipped CAM-579.
 */
function seedFixture(): Fixture {
	const root = createTestTmpdir('gship-web-source-');
	const seed = join(root, 'seed');
	mkdirSync(seed, { recursive: true });
	git(seed, ['init', '-q', '-b', 'main']);
	identify(seed);
	writeFileSync(join(seed, '.gitignore'), '.gship/\n');
	writeIssue(seed, 'CAM-0579.json', 'CAM-579', 'specified');
	writeIssue(seed, 'CAM-0580.json', 'CAM-580', 'specified');
	git(seed, ['add', '.']);
	git(seed, ['commit', '-q', '-m', 'seed backlog']);

	const remote = join(root, 'remote');
	git(root, ['clone', '-q', '--bare', seed, remote]);
	const local = join(root, 'local');
	git(root, ['clone', '-q', remote, local]);
	identify(local);
	const author = join(root, 'author');
	git(root, ['clone', '-q', remote, author]);
	identify(author);

	publishShip(author, 'CAM-0579.json', 'CAM-579');
	// Only the source ref is refreshed; refs/heads/main stays where it was.
	git(local, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']);

	return { author, remote, local };
}

/** The author clone ships an issue and publishes it, as a merged PR would. */
function publishShip(author: string, file: string, id: string): void {
	git(author, ['pull', '-q', '--ff-only']);
	writeIssue(author, file, id, 'shipped');
	git(author, ['add', '.']);
	git(author, ['commit', '-q', '-m', `ship ${id}`]);
	git(author, ['push', '-q', 'origin', 'main']);
}

async function idleBacklog(cwd: string): Promise<Record<string, unknown>> {
	const handle = startWebServer({ port: 0, cwd });
	try {
		const response = await fetch(`http://${handle.hostname}:${handle.port}/api/snapshot`);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as Record<string, unknown>;
		const idleState = payload['idleState'] as Record<string, unknown>;
		return idleState['backlog'] as Record<string, unknown>;
	} finally {
		await handle.stop();
	}
}

function plannableIds(backlog: Record<string, unknown>): string[] {
	return (backlog['plannable'] as Array<{ id: string }>).map((entry) => entry.id);
}

describe('the idle snapshot backlog source', () => {
	test('drops an issue the merge shipped even while local main is stale', async () => {
		const fixture = seedFixture();

		// The staleness is real: the local ref still offers CAM-579 as specified.
		expect(readBacklogFromMain(fixture.local)
			.map((entry) => `${entry.id}:${entry.stage}`))
			.toEqual(['CAM-579:specified', 'CAM-580:specified']);

		expect(plannableIds(await idleBacklog(fixture.local))).toEqual(['CAM-580']);
		expect(git(fixture.local, ['rev-parse', 'refs/heads/main']))
			.not.toBe(git(fixture.local, ['rev-parse', RUNTIME_SOURCE_REF]));
	});

	test('a poll reads the source ref rather than refreshing it', async () => {
		const fixture = seedFixture();
		expect(plannableIds(await idleBacklog(fixture.local))).toEqual(['CAM-580']);

		// The remote ships CAM-580 too. Nothing refreshed the clone's source ref,
		// so the snapshot must still report what that ref holds.
		publishShip(fixture.author, 'CAM-0580.json', 'CAM-580');
		const sourceBefore = git(fixture.local, ['rev-parse', RUNTIME_SOURCE_REF]);

		expect(plannableIds(await idleBacklog(fixture.local))).toEqual(['CAM-580']);
		expect(git(fixture.local, ['rev-parse', RUNTIME_SOURCE_REF])).toBe(sourceBefore);
	});
});
