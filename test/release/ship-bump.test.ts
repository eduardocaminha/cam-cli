// test/release/ship-bump.test.ts
//
// Unit tests for runShipBump (src/release/ship-bump.ts).
//
// All git calls and file I/O are injected as fakes; no real git binary or
// filesystem is touched. Each test exercises a single behavior slice.
//
// AC-2: feat/fix/breaking commits -> correct bump + commit message + file writes.
// AC-3: all-none commits -> no-op, no file writes, no commit.
//
// US-003 (CAM-89).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { runShipBump, type ShipBumpOptions } from '../../src/release/ship-bump.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal SpawnSyncReturns<string> success value. */
function ok(stdout = ''): SpawnSyncReturns<string> {
	return { stdout, stderr: '', status: 0, pid: 1, output: [null, stdout, ''], signal: null, error: undefined };
}

/** Fake spawnFn that returns the provided subjects for git-log and success for everything else. */
function makeSpawnFn(subjects: string[]) {
	const calls: Array<{ cmd: string; args: string[] }> = [];

	function spawnFn(cmd: string, args: string[], _opts: { encoding: 'utf8' }): SpawnSyncReturns<string> {
		calls.push({ cmd, args });
		// git log main..HEAD --pretty=%s
		if (cmd === 'git' && args[0] === 'log') {
			return ok(subjects.join('\n'));
		}
		return ok('');
	}

	return { spawnFn, calls };
}

/** Minimal version.ts content with the given version literal. */
function versionTs(v: string): string {
	return `export const CAM_VERSION = '${v}';\n`;
}

/** Minimal package.json content with the given version. */
function packageJson(v: string): string {
	return `{\n  "version": "${v}"\n}\n`;
}

/** Minimal CHANGELOG.md content for test fixtures. */
function sampleChangelog(): string {
	return '# Changelog\n\n---\n\n## [Unreleased]\n\n### Added\n\n- New feature.\n\n### Changed\n\n- Some change.\n';
}

/** Build ShipBumpOptions with captured writers. */
function makeOpts(
	subjects: string[],
	initialVersion = '0.1.2',
): {
	opts: ShipBumpOptions;
	calls: Array<{ cmd: string; args: string[] }>;
	written: { versionTs?: string; packageJson?: string; changelog?: string };
} {
	const { spawnFn, calls } = makeSpawnFn(subjects);
	const written: { versionTs?: string; packageJson?: string; changelog?: string } = {};

	const opts: ShipBumpOptions = {
		cwd: '/fake/project',
		spawnFn,
		clock: () => '2026-06-26T00:00:00.000Z',
		readVersionTs: () => versionTs(initialVersion),
		readPackageJson: () => packageJson(initialVersion),
		writeVersionTs: (text) => { written.versionTs = text; },
		writePackageJson: (text) => { written.packageJson = text; },
		readChangelog: () => sampleChangelog(),
		writeChangelog: (text) => { written.changelog = text; },
	};

	return { opts, calls, written };
}

// ---------------------------------------------------------------------------
// Tests: no-op path (AC-3)
// ---------------------------------------------------------------------------

describe('runShipBump - no-op when bump is none', () => {
	test('empty commit list -> no-op', () => {
		const { opts, calls, written } = makeOpts([]);

		const result = runShipBump(opts);

		expect(result.noOp).toBe(true);
		expect(written.versionTs).toBeUndefined();
		expect(written.packageJson).toBeUndefined();
		expect(written.changelog).toBeUndefined();
		// No commit call
		expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBeUndefined();
	});

	test('only chore/docs/refactor commits -> no-op', () => {
		const { opts, calls, written } = makeOpts([
			'chore(cam): mark US-002 done',
			'docs: update README',
			'refactor: extract helper',
			'chore(release): bump version to 0.1.1',
		]);

		const result = runShipBump(opts);

		expect(result.noOp).toBe(true);
		expect(written.versionTs).toBeUndefined();
		expect(written.packageJson).toBeUndefined();
		expect(written.changelog).toBeUndefined();
		expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBeUndefined();
	});

	test('no-op result carries reason string', () => {
		const { opts } = makeOpts([]);
		const result = runShipBump(opts);
		if (!result.noOp) throw new Error('expected noOp');
		expect(result.reason).toMatch(/none/i);
	});
});

// ---------------------------------------------------------------------------
// Tests: patch bump (AC-2)
// ---------------------------------------------------------------------------

describe('runShipBump - patch bump (fix:)', () => {
	test('single fix commit -> 0.1.2 becomes 0.1.3', () => {
		const { opts, calls, written } = makeOpts(['fix: correct off-by-one error']);

		const result = runShipBump(opts);

		expect(result.noOp).toBe(false);
		if (result.noOp) return;
		expect(result.bump).toBe('patch');
		expect(result.oldVersion).toBe('0.1.2');
		expect(result.newVersion).toBe('0.1.3');

		expect(written.versionTs).toContain("'0.1.3'");
		expect(written.packageJson).toContain('"0.1.3"');

		const commitCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'commit');
		expect(commitCall?.args).toContain('chore(release): bump version to 0.1.3');
	});

	test('git add is called with src/version.ts, package.json, and CHANGELOG.md', () => {
		const { opts, calls } = makeOpts(['fix: minor typo']);
		runShipBump(opts);
		const addCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'add');
		expect(addCall?.args).toContain('src/version.ts');
		expect(addCall?.args).toContain('package.json');
		expect(addCall?.args).toContain('CHANGELOG.md');
	});
});

// ---------------------------------------------------------------------------
// Tests: minor bump (AC-2)
// ---------------------------------------------------------------------------

describe('runShipBump - minor bump (feat:)', () => {
	test('feat commit -> 0.1.2 becomes 0.2.0', () => {
		const { opts, written } = makeOpts(['feat: add --bump flag to cam ship']);

		const result = runShipBump(opts);

		expect(result.noOp).toBe(false);
		if (result.noOp) return;
		expect(result.bump).toBe('minor');
		expect(result.newVersion).toBe('0.2.0');

		expect(written.versionTs).toContain("'0.2.0'");
		expect(written.packageJson).toContain('"0.2.0"');
	});

	test('commit message is exact: chore(release): bump version to X.Y.Z', () => {
		const { opts, calls } = makeOpts(['feat: new feature']);
		runShipBump(opts);
		const commitCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'commit');
		// -m flag then exact message
		const mIdx = commitCall?.args.indexOf('-m');
		expect(mIdx).not.toBeUndefined();
		const message = mIdx !== undefined ? commitCall?.args[mIdx + 1] : undefined;
		expect(message).toBe('chore(release): bump version to 0.2.0');
	});

	test('mixed fix + feat -> minor wins (highest)', () => {
		const { opts } = makeOpts(['fix: patch thing', 'feat: new capability']);
		const result = runShipBump(opts);
		expect(result.noOp).toBe(false);
		if (result.noOp) return;
		expect(result.bump).toBe('minor');
		expect(result.newVersion).toBe('0.2.0');
	});
});

// ---------------------------------------------------------------------------
// Tests: major bump demoted by 0.x convention (AC-2)
// ---------------------------------------------------------------------------

describe('runShipBump - breaking change on 0.x version', () => {
	test('feat!: on 0.x -> minor increment (0.x convention)', () => {
		const { opts } = makeOpts(['feat!: drop legacy API'], '0.1.2');

		const result = runShipBump(opts);

		expect(result.noOp).toBe(false);
		if (result.noOp) return;
		// classifyBump returns 'major'; computeNextVersion demotes to minor on 0.x
		expect(result.bump).toBe('major');
		expect(result.newVersion).toBe('0.2.0');
	});

	test('BREAKING CHANGE: token on 1.x -> true major bump', () => {
		const { opts } = makeOpts(['feat: BREAKING CHANGE: remove old API'], '1.2.3');

		const result = runShipBump(opts);

		expect(result.noOp).toBe(false);
		if (result.noOp) return;
		expect(result.newVersion).toBe('2.0.0');
	});
});

// ---------------------------------------------------------------------------
// Tests: git log command shape (AC-2)
// ---------------------------------------------------------------------------

describe('runShipBump - git log command shape', () => {
	test('reads git log main..HEAD --pretty=%s', () => {
		const { opts, calls } = makeOpts(['feat: something']);
		runShipBump(opts);
		const logCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'log');
		expect(logCall?.args).toEqual(['log', 'main..HEAD', '--pretty=%s']);
	});
});

// ---------------------------------------------------------------------------
// Tests: CHANGELOG roll (AC-4)
// ---------------------------------------------------------------------------

describe('runShipBump - CHANGELOG roll', () => {
	test('writes CHANGELOG with versioned heading when bump is non-none', () => {
		const { opts, written } = makeOpts(['fix: correct something']);
		runShipBump(opts);
		expect(written.changelog).toBeDefined();
		expect(written.changelog).toContain('## [0.1.3] - 2026-06-26');
	});

	test('fresh ## [Unreleased] appears above the versioned heading in written CHANGELOG', () => {
		const { opts, written } = makeOpts(['feat: new capability']);
		runShipBump(opts);
		const changelog = written.changelog ?? '';
		const unreleasedIdx = changelog.indexOf('## [Unreleased]');
		const versionedIdx = changelog.indexOf('## [0.2.0] - 2026-06-26');
		expect(unreleasedIdx).toBeGreaterThanOrEqual(0);
		expect(versionedIdx).toBeGreaterThan(unreleasedIdx);
	});

	test('existing body content is preserved under the versioned heading', () => {
		const { opts, written } = makeOpts(['feat: new thing']);
		runShipBump(opts);
		expect(written.changelog).toContain('### Added');
		expect(written.changelog).toContain('- New feature.');
		expect(written.changelog).toContain('### Changed');
		expect(written.changelog).toContain('- Some change.');
	});

	test('date is extracted from clock ISO timestamp (YYYY-MM-DD slice)', () => {
		const { spawnFn, calls: _calls } = makeSpawnFn(['fix: something']);
		const written: { changelog?: string } = {};
		const opts: ShipBumpOptions = {
			cwd: '/fake',
			spawnFn,
			// Clock returns a non-midnight timestamp; only the date portion should appear
			clock: () => '2026-12-31T15:45:00.000Z',
			readVersionTs: () => versionTs('0.1.2'),
			readPackageJson: () => packageJson('0.1.2'),
			writeVersionTs: () => {},
			writePackageJson: () => {},
			readChangelog: () => sampleChangelog(),
			writeChangelog: (text) => { written.changelog = text; },
		};
		runShipBump(opts);
		expect(written.changelog).toContain('## [0.1.3] - 2026-12-31');
	});

	test('CHANGELOG is NOT written on no-op', () => {
		const { opts, written } = makeOpts([]);
		runShipBump(opts);
		expect(written.changelog).toBeUndefined();
	});
});
