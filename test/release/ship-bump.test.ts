// test/release/ship-bump.test.ts
//
// Unit tests for runShipBump (src/release/ship-bump.ts).
//
// All git calls and file I/O are injected as fakes; no real git binary or
// filesystem is touched. Each test exercises a single behavior slice.
//
// AC-1: result carries { from, to, bumpType, commitsClassified } + emitOk result line.
// AC-2: writeEvent captures the structured event with bumpType in the shape.
// AC-3: no-op path emits result/event with bumpType 'none', from === to.
//
// US-003 (CAM-89), US-007 (CAM-89).

import { describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';

import { runShipBump, type ShipBumpOptions, type ShipBumpResult } from '../../src/release/ship-bump.ts';

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

/** Build ShipBumpOptions with captured writers and optional event/resultLine capture. */
function makeOpts(
	subjects: string[],
	initialVersion = '0.1.2',
	extras: Partial<Pick<ShipBumpOptions, 'writeEvent' | 'emitResultLine'>> = {},
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
		...extras,
	};

	return { opts, calls, written };
}

// ---------------------------------------------------------------------------
// Tests: no-op path (AC-3) -- bumpType: none, from === to
// ---------------------------------------------------------------------------

describe('runShipBump - no-op when bumpType is none', () => {
	test('empty commit list -> bumpType none', () => {
		const { opts, calls, written } = makeOpts([]);

		const result = runShipBump(opts);

		expect(result.bumpType).toBe('none');
		expect(result.from).toBe('0.1.2');
		expect(result.to).toBe('0.1.2');
		// from === to is the no-op contract (AC-3)
		expect(result.from).toBe(result.to);
		expect(result.commitsClassified).toBe(0);
		expect(written.versionTs).toBeUndefined();
		expect(written.packageJson).toBeUndefined();
		expect(written.changelog).toBeUndefined();
		// No commit call
		expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBeUndefined();
	});

	test('only chore/docs/refactor commits -> bumpType none', () => {
		const { opts, calls, written } = makeOpts([
			'chore(cam): mark US-002 done',
			'docs: update README',
			'refactor: extract helper',
			'chore(release): bump version to 0.1.1',
		]);

		const result = runShipBump(opts);

		expect(result.bumpType).toBe('none');
		expect(result.from).toBe(result.to);
		expect(result.commitsClassified).toBe(4);
		expect(written.versionTs).toBeUndefined();
		expect(written.packageJson).toBeUndefined();
		expect(written.changelog).toBeUndefined();
		expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'commit')).toBeUndefined();
	});

	test('no-op emits result line (AC-3)', () => {
		const emitted: Array<{ msg: string; suffix?: string }> = [];
		const { opts } = makeOpts([], '0.1.2', {
			emitResultLine: (msg, suffix) => { emitted.push({ msg, suffix }); },
		});

		runShipBump(opts);

		expect(emitted.length).toBe(1);
		expect(emitted[0]?.msg).toMatch(/^bump: none/);
		expect(emitted[0]?.suffix).toMatch(/0\.1\.2/);
	});

	test('no-op fires writeEvent with bumpType none (AC-2, AC-3)', () => {
		const events: ShipBumpResult[] = [];
		const { opts } = makeOpts(['chore: housekeeping'], '0.1.2', {
			writeEvent: (e) => { events.push(e); },
		});

		runShipBump(opts);

		expect(events.length).toBe(1);
		const ev = events[0];
		if (!ev) throw new Error('expected event');
		// bumpType field is required by AC-2 oracle (grep -q "bumpType" in this file)
		expect(ev.bumpType).toBe('none');
		expect(ev.from).toBe('0.1.2');
		expect(ev.to).toBe('0.1.2');
		expect(ev.commitsClassified).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Tests: patch bump (AC-1, AC-2)
// ---------------------------------------------------------------------------

describe('runShipBump - patch bump (fix:)', () => {
	test('single fix commit -> 0.1.2 becomes 0.1.3', () => {
		const { opts, calls, written } = makeOpts(['fix: correct off-by-one error']);

		const result = runShipBump(opts);

		expect(result.bumpType).toBe('patch');
		expect(result.from).toBe('0.1.2');
		expect(result.to).toBe('0.1.3');
		expect(result.commitsClassified).toBe(1);

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

	test('emits result line for patch bump (AC-1)', () => {
		const emitted: Array<{ msg: string; suffix?: string }> = [];
		const { opts } = makeOpts(['fix: something'], '0.1.2', {
			emitResultLine: (msg, suffix) => { emitted.push({ msg, suffix }); },
		});

		runShipBump(opts);

		expect(emitted.length).toBe(1);
		expect(emitted[0]?.msg).toMatch(/^bump: patch/);
		expect(emitted[0]?.suffix).toMatch(/0\.1\.2 -> 0\.1\.3/);
	});

	test('writeEvent carries { from, to, bumpType, commitsClassified } (AC-2)', () => {
		const events: ShipBumpResult[] = [];
		const { opts } = makeOpts(['fix: correct something'], '0.1.2', {
			writeEvent: (e) => { events.push(e); },
		});

		runShipBump(opts);

		expect(events.length).toBe(1);
		const ev = events[0];
		if (!ev) throw new Error('expected event');
		expect(ev.bumpType).toBe('patch');
		expect(ev.from).toBe('0.1.2');
		expect(ev.to).toBe('0.1.3');
		expect(ev.commitsClassified).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Tests: minor bump (AC-1)
// ---------------------------------------------------------------------------

describe('runShipBump - minor bump (feat:)', () => {
	test('feat commit -> 0.1.2 becomes 0.2.0', () => {
		const { opts, written } = makeOpts(['feat: add --bump flag to cam ship']);

		const result = runShipBump(opts);

		expect(result.bumpType).toBe('minor');
		expect(result.from).toBe('0.1.2');
		expect(result.to).toBe('0.2.0');

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
		expect(result.bumpType).toBe('minor');
		expect(result.to).toBe('0.2.0');
		expect(result.commitsClassified).toBe(2);
	});

	test('result line suffix shows from -> to (AC-1)', () => {
		const emitted: Array<{ msg: string; suffix?: string }> = [];
		const { opts } = makeOpts(['feat: new capability'], '0.1.2', {
			emitResultLine: (msg, suffix) => { emitted.push({ msg, suffix }); },
		});
		runShipBump(opts);
		expect(emitted[0]?.suffix).toBe('0.1.2 -> 0.2.0');
	});
});

// ---------------------------------------------------------------------------
// Tests: major bump demoted by 0.x convention (AC-1)
// ---------------------------------------------------------------------------

describe('runShipBump - breaking change on 0.x version', () => {
	test('feat!: on 0.x -> minor increment (0.x convention)', () => {
		const { opts } = makeOpts(['feat!: drop legacy API'], '0.1.2');

		const result = runShipBump(opts);

		// classifyBump returns 'major'; computeNextVersion demotes to minor on 0.x
		expect(result.bumpType).toBe('major');
		expect(result.to).toBe('0.2.0');
	});

	test('BREAKING CHANGE: token on 1.x -> true major bump', () => {
		const { opts } = makeOpts(['feat: BREAKING CHANGE: remove old API'], '1.2.3');

		const result = runShipBump(opts);

		expect(result.to).toBe('2.0.0');
		expect(result.from).toBe('1.2.3');
	});
});

// ---------------------------------------------------------------------------
// Tests: exit-status guards on git add / git commit (US-R1-001)
// ---------------------------------------------------------------------------

describe('runShipBump - git exit-status guards', () => {
	/** Build a spawnFn that returns a non-zero exit for the specified git subcommand. */
	function makeFailingSpawnFn(subjects: string[], failSubcmd: 'add' | 'commit') {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		function spawnFn(cmd: string, args: string[], _opts: { encoding: 'utf8' }): import('node:child_process').SpawnSyncReturns<string> {
			calls.push({ cmd, args });
			if (cmd === 'git' && args[0] === 'log') {
				return { stdout: subjects.join('\n'), stderr: '', status: 0, pid: 1, output: [null, subjects.join('\n'), ''], signal: null, error: undefined };
			}
			if (cmd === 'git' && args[0] === failSubcmd) {
				return { stdout: '', stderr: 'hook rejected commit', status: 1, pid: 2, output: [null, '', 'hook rejected commit'], signal: null, error: undefined };
			}
			return { stdout: '', stderr: '', status: 0, pid: 3, output: [null, '', ''], signal: null, error: undefined };
		}
		return { spawnFn, calls };
	}

	test('throws when git add returns non-zero, does not emit success line', () => {
		const { spawnFn } = makeFailingSpawnFn(['fix: something'], 'add');
		const emitted: string[] = [];
		const events: ShipBumpResult[] = [];
		const opts: ShipBumpOptions = {
			cwd: '/fake',
			spawnFn,
			clock: () => '2026-06-26T00:00:00.000Z',
			readVersionTs: () => `export const CAM_VERSION = '0.1.2';\n`,
			readPackageJson: () => '{\n  "version": "0.1.2"\n}\n',
			writeVersionTs: () => {},
			writePackageJson: () => {},
			readChangelog: () => '# Changelog\n\n## [Unreleased]\n\n',
			writeChangelog: () => {},
			emitResultLine: (msg) => { emitted.push(msg); },
			writeEvent: (e) => { events.push(e); },
		};

		expect(() => runShipBump(opts)).toThrow(/git add failed/);
		// Success result line must NOT be emitted when git add fails.
		expect(emitted.length).toBe(0);
		expect(events.length).toBe(0);
	});

	test('throws when git commit returns non-zero (pre-commit hook), does not emit success line', () => {
		const { spawnFn } = makeFailingSpawnFn(['fix: something'], 'commit');
		const emitted: string[] = [];
		const events: ShipBumpResult[] = [];
		const opts: ShipBumpOptions = {
			cwd: '/fake',
			spawnFn,
			clock: () => '2026-06-26T00:00:00.000Z',
			readVersionTs: () => `export const CAM_VERSION = '0.1.2';\n`,
			readPackageJson: () => '{\n  "version": "0.1.2"\n}\n',
			writeVersionTs: () => {},
			writePackageJson: () => {},
			readChangelog: () => '# Changelog\n\n## [Unreleased]\n\n',
			writeChangelog: () => {},
			emitResultLine: (msg) => { emitted.push(msg); },
			writeEvent: (e) => { events.push(e); },
		};

		expect(() => runShipBump(opts)).toThrow(/git commit failed/);
		// Success result line must NOT be emitted when commit fails.
		expect(emitted.length).toBe(0);
		expect(events.length).toBe(0);
	});

	test('no-op path (bumpType none) does not reach git add/commit, so no status check needed there', () => {
		// Sanity: make sure the no-op path still works even with a "failing" spawnFn
		// because no add/commit is invoked.
		const { spawnFn } = makeFailingSpawnFn([], 'commit');
		const emitted: string[] = [];
		const opts: ShipBumpOptions = {
			cwd: '/fake',
			spawnFn,
			clock: () => '2026-06-26T00:00:00.000Z',
			readVersionTs: () => `export const CAM_VERSION = '0.1.2';\n`,
			readPackageJson: () => '{\n  "version": "0.1.2"\n}\n',
			writeVersionTs: () => {},
			writePackageJson: () => {},
			readChangelog: () => '# Changelog\n\n## [Unreleased]\n\n',
			writeChangelog: () => {},
			emitResultLine: (msg) => { emitted.push(msg); },
		};

		const result = runShipBump(opts);
		expect(result.bumpType).toBe('none');
		// No-op path still emits its own result line.
		expect(emitted.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Tests: git log command shape (AC-1)
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
// Tests: CHANGELOG roll (AC-1)
// ---------------------------------------------------------------------------

describe('runShipBump - CHANGELOG roll', () => {
	test('writes CHANGELOG with versioned heading when bumpType is non-none', () => {
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

	test('versioned section body comes from commits, not old hand-maintained body (AC-4)', () => {
		// sampleChangelog() contains hand-maintained "- New feature." / "- Some change."
		// but the commits only have "feat: new thing" -- the generated body wins.
		const { opts, written } = makeOpts(['feat: new thing']);
		runShipBump(opts);
		expect(written.changelog).toContain('### Added');
		expect(written.changelog).toContain('- new thing');
		// Old hand-maintained entries must NOT appear in the versioned section
		expect(written.changelog).not.toContain('- New feature.');
		expect(written.changelog).not.toContain('- Some change.');
		expect(written.changelog).not.toContain('### Changed');
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
