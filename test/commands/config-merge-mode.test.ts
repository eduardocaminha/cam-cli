// test/commands/config-merge-mode.test.ts
//
// Unit tests for merge-mode persistence + branch-protection invocation
// in mergeConfigChoices() (src/commands/config.ts).
//
// No Ink rendering — drives the pure helper directly with injected fakes.
//
// AC-1: mergeConfigChoices with mergeMode='immediate' persists
//       [ship] merge_mode='immediate' to project.toml.  [oracle: bun test]
// AC-2: mergeConfigChoices with mergeMode='ci-gated' invokes the
//       branch-protection helper (spawnFn receives gh api PUT call).
//       [oracle: bun test]
// AC-3: mergeConfigChoices with mergeMode='immediate' does NOT invoke
//       branch-protection (spawnFn receives zero calls after [models]/[backend]
//       writes). [oracle: bun test]
// AC-4 (backward-compat): mergeConfigChoices without mergeMode does not write
//       [ship] section and does not invoke spawnFn. [oracle: bun test]
//
// US-004 (CAM-101).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SpawnSyncReturns } from 'node:child_process';

import {
	mergeConfigChoices,
	type MergeModeOpts,
} from '../../src/commands/config.ts';
import type { ConfigChoices } from '../../src/commands/config.ts';
import { loadConfig } from '../../src/config/toml.ts';
import { readMergeMode } from '../../src/config/models.ts';
import type { Phase } from '../../src/config/models.ts';
import type { SpawnFn } from '../../src/release/branch-protection.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PHASES: readonly Phase[] = [
	'orchestrator',
	'planner',
	'auditor',
	'implementer',
	'reviewer',
	'ship',
];

function makeChoices(mergeMode?: 'immediate' | 'ci-gated'): ConfigChoices {
	return {
		models: Object.fromEntries(
			PHASES.map((p) => [p, 'claude-sonnet-4-6']),
		) as Record<Phase, string>,
		backend: 'claude',
		...(mergeMode !== undefined ? { mergeMode } : {}),
	};
}

function ok(stdout = ''): SpawnSyncReturns<string> {
	return {
		stdout,
		stderr: '',
		status: 0,
		pid: 1,
		output: [null, stdout, ''],
		signal: null,
		error: undefined,
	};
}

function fail(stderr = ''): SpawnSyncReturns<string> {
	return {
		stdout: '',
		stderr,
		status: 1,
		pid: 1,
		output: [null, '', stderr],
		signal: null,
		error: undefined,
	};
}

function protectionResponseChecks(): string {
	return JSON.stringify({
		required_status_checks: {
			strict: true,
			checks: [{ context: 'ci' }, { context: 'ci-container' }],
			contexts: [],
		},
	});
}

function repoResponseOk(): string {
	return JSON.stringify({
		allow_auto_merge: true,
		allow_squash_merge: true,
	});
}

interface CallRecord { cmd: string; args: string[] }

function makeSeqSpawnFn(
	responses: SpawnSyncReturns<string>[],
): { spawnFn: SpawnFn; calls: CallRecord[] } {
	const calls: CallRecord[] = [];
	let idx = 0;
	const spawnFn: SpawnFn = (cmd, args, _opts) => {
		calls.push({ cmd, args });
		const resp = responses[idx] ?? ok('');
		idx++;
		return resp;
	};
	return { spawnFn, calls };
}

function makeCaptures(): {
	hints: string[];
	warnings: string[];
	results: string[];
	mergeModeOpts: MergeModeOpts & { spawnFn: SpawnFn };
} {
	const hints: string[] = [];
	const warnings: string[] = [];
	const results: string[] = [];
	// Default spawnFn always returns success (overridden by specific tests).
	const { spawnFn } = makeSeqSpawnFn([
		ok('{}'),
		ok(protectionResponseChecks()),
		ok(repoResponseOk()),
	]);
	return {
		hints,
		warnings,
		results,
		mergeModeOpts: {
			spawnFn,
			emitHint: (msg) => hints.push(msg),
			emitWarning: (msg) => warnings.push(msg),
			emitResult: (msg) => results.push(msg),
		},
	};
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let configPath: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam-cfg-merge-'));
	configPath = join(tmpDir, 'project.toml');
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC-1: mergeMode='immediate' persists [ship] merge_mode to project.toml
// ---------------------------------------------------------------------------

describe('AC-1: mergeMode=immediate persists [ship] merge_mode', () => {
	test('writes merge_mode=immediate to [ship] section', () => {
		const { mergeModeOpts } = makeCaptures();
		mergeConfigChoices(configPath, makeChoices('immediate'), undefined, mergeModeOpts);

		const config = loadConfig(configPath);
		const ship = config['ship'] as Record<string, unknown>;
		expect(typeof ship).toBe('object');
		expect(ship['merge_mode']).toBe('immediate');
	});

	test('readMergeMode returns "immediate" after writing', () => {
		const { mergeModeOpts } = makeCaptures();
		mergeConfigChoices(configPath, makeChoices('immediate'), undefined, mergeModeOpts);
		expect(readMergeMode(configPath)).toBe('immediate');
	});

	test('preserves existing issue_system key', () => {
		writeFileSync(configPath, 'issue_system = "linear"\n', 'utf8');

		const { mergeModeOpts } = makeCaptures();
		mergeConfigChoices(configPath, makeChoices('immediate'), undefined, mergeModeOpts);

		const config = loadConfig(configPath);
		expect(config['issue_system']).toBe('linear');
	});
});

// ---------------------------------------------------------------------------
// AC-1 continued: mergeMode='ci-gated' persists [ship] merge_mode
// ---------------------------------------------------------------------------

describe('AC-1 continued: mergeMode=ci-gated persists [ship] merge_mode', () => {
	test('writes merge_mode=ci-gated to [ship] section', () => {
		const { spawnFn, calls: _calls } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		mergeConfigChoices(configPath, makeChoices('ci-gated'), undefined, { spawnFn });

		const config = loadConfig(configPath);
		const ship = config['ship'] as Record<string, unknown>;
		expect(ship['merge_mode']).toBe('ci-gated');
	});

	test('readMergeMode returns "ci-gated" after writing', () => {
		const { spawnFn } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		mergeConfigChoices(configPath, makeChoices('ci-gated'), undefined, { spawnFn });
		expect(readMergeMode(configPath)).toBe('ci-gated');
	});
});

// ---------------------------------------------------------------------------
// AC-2: mergeMode='ci-gated' invokes branch-protection helper (gh api PUT)
// ---------------------------------------------------------------------------

describe('AC-2: ci-gated invokes branch-protection helper', () => {
	test('spawnFn receives a gh api PUT call for ci-gated', () => {
		const { spawnFn, calls } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		mergeConfigChoices(configPath, makeChoices('ci-gated'), undefined, {
			spawnFn,
			ownerRepo: 'org/repo',
		});

		// At least one call must be a gh api PUT
		const putCall = calls.find(
			(c) => c.cmd === 'gh' && c.args.includes('-X') &&
				c.args[c.args.indexOf('-X') + 1] === 'PUT',
		);
		expect(putCall).toBeDefined();
	});

	test('emitResult gets "✓ ..." on successful configure-and-verify', () => {
		const { spawnFn } = makeSeqSpawnFn([
			ok('{}'),
			ok(protectionResponseChecks()),
			ok(repoResponseOk()),
		]);
		const results: string[] = [];
		mergeConfigChoices(configPath, makeChoices('ci-gated'), undefined, {
			spawnFn,
			ownerRepo: 'org/repo',
			emitResult: (msg) => results.push(msg),
		});

		expect(results.length).toBe(1);
		expect(results[0]).toMatch(/^✓/);
	});

	test('emitResult gets "⚠ ..." on fallback-warned (PUT failure)', () => {
		const { spawnFn } = makeSeqSpawnFn([
			fail('no admin rights'),
		]);
		const results: string[] = [];
		mergeConfigChoices(configPath, makeChoices('ci-gated'), undefined, {
			spawnFn,
			ownerRepo: 'org/repo',
			emitResult: (msg) => results.push(msg),
		});

		expect(results.length).toBe(1);
		expect(results[0]).toMatch(/^⚠/);
	});
});

// ---------------------------------------------------------------------------
// AC-3: mergeMode='immediate' does NOT invoke branch-protection
// ---------------------------------------------------------------------------

describe('AC-3: immediate does NOT invoke branch-protection helper', () => {
	test('spawnFn is never called for mergeMode=immediate', () => {
		const { spawnFn, calls } = makeSeqSpawnFn([]);
		mergeConfigChoices(configPath, makeChoices('immediate'), undefined, { spawnFn });

		// No spawnFn calls at all (no gh api calls)
		expect(calls.length).toBe(0);
	});

	test('emitHint and emitWarning are not called for immediate', () => {
		const { spawnFn } = makeSeqSpawnFn([]);
		const hints: string[] = [];
		const warnings: string[] = [];
		mergeConfigChoices(configPath, makeChoices('immediate'), undefined, {
			spawnFn,
			emitHint: (msg) => hints.push(msg),
			emitWarning: (msg) => warnings.push(msg),
		});

		expect(hints.length).toBe(0);
		expect(warnings.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// AC-4 (backward-compat): no mergeMode => [ship] section not written
// ---------------------------------------------------------------------------

describe('AC-4: no mergeMode field => backward compat (no [ship] section written)', () => {
	test('omitting mergeMode does not write a [ship] section', () => {
		const { spawnFn, calls } = makeSeqSpawnFn([]);
		mergeConfigChoices(configPath, makeChoices(undefined), undefined, { spawnFn });

		const config = loadConfig(configPath);
		// [ship] section must be absent
		expect(config['ship']).toBeUndefined();
		// No branch-protection calls
		expect(calls.length).toBe(0);
	});

	test('readMergeMode returns "immediate" (default) when no [ship] section', () => {
		mergeConfigChoices(configPath, makeChoices(undefined));
		expect(readMergeMode(configPath)).toBe('immediate');
	});
});
