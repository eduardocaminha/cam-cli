// test/config/codex-models-cache.test.ts
//
// Unit tests for src/config/codex-models-cache.ts (US-002, CAM-398): the
// pure selector over parsed models_cache.json content, and the default
// production reader exercised against a real scratch tmpdir (never a fake
// filesystem, never a monkeypatched os.homedir).

import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { readCodexModelsCache, selectTopCodexModel } from '../../src/config/codex-models-cache.ts';

// ---------------------------------------------------------------------------
// selectTopCodexModel (pure selector over already-parsed JSON)
// ---------------------------------------------------------------------------

describe('selectTopCodexModel', () => {
	test('picks the top visibility=list, supported_in_api=true entry by ascending priority (fixture mirrors the live cache)', () => {
		const cache = {
			models: [
				{
					slug: 'gpt-5.3-codex',
					display_name: 'GPT-5.3 Codex',
					visibility: 'unlisted',
					supported_in_api: true,
					priority: 0,
				},
				{
					slug: 'gpt-5.6-sol',
					display_name: 'GPT-5.6 Sol',
					visibility: 'list',
					supported_in_api: true,
					priority: 1,
				},
			],
		};
		expect(selectTopCodexModel(cache)).toEqual({ ok: true, slug: 'gpt-5.6-sol' });
	});

	test('excludes an entry that is visibility=list but supported_in_api=false', () => {
		const cache = {
			models: [
				{ slug: 'gpt-5.3-codex', visibility: 'list', supported_in_api: false, priority: 0 },
				{ slug: 'gpt-5.6-sol', visibility: 'list', supported_in_api: true, priority: 1 },
			],
		};
		expect(selectTopCodexModel(cache)).toEqual({ ok: true, slug: 'gpt-5.6-sol' });
	});

	test('is stable for ties: first-inserted wins when priorities are equal', () => {
		const cache = {
			models: [
				{ slug: 'first-tied', visibility: 'list', supported_in_api: true, priority: 5 },
				{ slug: 'second-tied', visibility: 'list', supported_in_api: true, priority: 5 },
			],
		};
		expect(selectTopCodexModel(cache)).toEqual({ ok: true, slug: 'first-tied' });
	});

	test('not-ok: content is not an object', () => {
		const result = selectTopCodexModel('not an object');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
	});

	test('not-ok: content is null', () => {
		const result = selectTopCodexModel(null);
		expect(result.ok).toBe(false);
	});

	test('not-ok: models field is missing', () => {
		const result = selectTopCodexModel({});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('models');
	});

	test('not-ok: models field is not an array', () => {
		const result = selectTopCodexModel({ models: 'nope' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('models');
	});

	test('not-ok: an entry is not an object', () => {
		const result = selectTopCodexModel({ models: ['not-an-object'] });
		expect(result.ok).toBe(false);
	});

	test('not-ok: an entry has a non-string slug', () => {
		const result = selectTopCodexModel({
			models: [{ slug: 123, visibility: 'list', supported_in_api: true, priority: 1 }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('non-string slug');
	});

	test('not-ok: an entry has a non-number priority', () => {
		const result = selectTopCodexModel({
			models: [
				{ slug: 'gpt-5.6-sol', visibility: 'list', supported_in_api: true, priority: 'high' },
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('non-number priority');
	});

	test('not-ok: every entry is filtered out (none visibility=list AND supported_in_api=true)', () => {
		const result = selectTopCodexModel({
			models: [
				{ slug: 'a', visibility: 'unlisted', supported_in_api: true, priority: 0 },
				{ slug: 'b', visibility: 'list', supported_in_api: false, priority: 1 },
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
	});

	test('not-ok: models array is empty', () => {
		const result = selectTopCodexModel({ models: [] });
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// readCodexModelsCache (default production reader, real fs round-trip)
// ---------------------------------------------------------------------------

describe('readCodexModelsCache (real tmpdir round-trip)', () => {
	let scratchDir: string;

	beforeEach(() => {
		scratchDir = createTestTmpdir('cam-codex-models-cache-');
	});

	afterEach(() => {
		rmSync(scratchDir, { recursive: true, force: true });
	});

	test('reads a real file written to the scratch dir and resolves the top slug', () => {
		const cachePath = join(scratchDir, 'models_cache.json');
		writeFileSync(
			cachePath,
			JSON.stringify({
				models: [
					{
						slug: 'gpt-5.3-codex',
						visibility: 'unlisted',
						supported_in_api: true,
						priority: 0,
					},
					{
						slug: 'gpt-5.6-sol',
						visibility: 'list',
						supported_in_api: true,
						priority: 1,
					},
				],
			}),
		);

		expect(readCodexModelsCache(cachePath)).toEqual({ ok: true, slug: 'gpt-5.6-sol' });
	});

	test('not-ok: path does not exist', () => {
		const missingPath = join(scratchDir, 'does-not-exist.json');
		const result = readCodexModelsCache(missingPath);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain(missingPath);
	});

	test('not-ok: file content is not valid JSON', () => {
		const cachePath = join(scratchDir, 'models_cache.json');
		writeFileSync(cachePath, '{ this is not json');
		const result = readCodexModelsCache(cachePath);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain('not valid JSON');
	});

	test('not-ok: file is unreadable (permission denied)', () => {
		// Skipped when running as root (e.g. some CI containers), because root
		// bypasses unix file permissions entirely and chmod 000 would not
		// actually produce a read failure -- a false pass, not a real check.
		if (typeof process.getuid === 'function' && process.getuid() === 0) {
			return;
		}
		const cachePath = join(scratchDir, 'models_cache.json');
		writeFileSync(cachePath, JSON.stringify({ models: [] }));
		chmodSync(cachePath, 0o000);
		try {
			const result = readCodexModelsCache(cachePath);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toContain('failed to read');
		} finally {
			chmodSync(cachePath, 0o644);
		}
	});
});
