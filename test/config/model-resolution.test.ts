// test/config/model-resolution.test.ts
//
// Tests for src/config/model-resolution.ts (US-003, CAM-398):
// resolvePhaseModel's backend-aware precedence for the codex and claude
// paths, and the fail-closed abort message shape.

import { rmSync, writeFileSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { resolvePhaseModel } from '../../src/config/model-resolution.ts';
import type { CodexModelsCacheReader, CodexModelSelection } from '../../src/config/codex-models-cache.ts';

let tmpDir: string;

beforeEach(() => {
	tmpDir = createTestTmpdir('cam-model-resolution-test-');
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmpToml(content: string): string {
	const path = join(tmpDir, 'project.toml');
	writeFileSync(path, content, 'utf8');
	return path;
}

/** A cache reader that always resolves to `slug`, recording every invocation. */
function makeResolvingCacheReader(slug: string): { reader: CodexModelsCacheReader; calls: number[] } {
	const calls: number[] = [];
	const reader: CodexModelsCacheReader = (): CodexModelSelection => {
		calls.push(Date.now());
		return { ok: true, slug };
	};
	return { reader, calls };
}

/** A cache reader that always fails, recording every invocation. */
function makeFailingCacheReader(reason: string): { reader: CodexModelsCacheReader; calls: number[] } {
	const calls: number[] = [];
	const reader: CodexModelsCacheReader = (): CodexModelSelection => {
		calls.push(Date.now());
		return { ok: false, reason };
	};
	return { reader, calls };
}

// ---------------------------------------------------------------------------
// AC2: the single "claude-shaped" decision fn is the US-001 superset
// ---------------------------------------------------------------------------

describe('resolvePhaseModel source shape', () => {
	test('imports isClaudeAliasModel from src/supervisor/codex-auth.ts (grep oracle companion)', async () => {
		const src = await Bun.file(join(import.meta.dir, '..', '..', 'src', 'config', 'model-resolution.ts')).text();
		expect(src).toContain('isClaudeAliasModel');
		expect(src).toContain("from '../supervisor/codex-auth.ts'");
	});
});

// ---------------------------------------------------------------------------
// AC1 + AC4: codex precedence -- nested pin > non-claude-shaped flat pin
// ---------------------------------------------------------------------------

describe('resolvePhaseModel: codex backend, nested pin (highest precedence)', () => {
	test('a nested [models.codex].<phase> pin wins verbatim over a differing flat value, cache reader never invoked', () => {
		const path = writeTmpToml(`
[models]
implementer = "gpt-5-other"

[models.codex]
implementer = "gpt-5-codex-pinned"
`);
		const { reader, calls } = makeResolvingCacheReader('gpt-5-should-not-be-used');
		const result = resolvePhaseModel({ phase: 'implementer', backend: 'codex', configPath: path, cacheReader: reader });
		expect(result).toEqual({ ok: true, model: 'gpt-5-codex-pinned' });
		expect(calls).toHaveLength(0);
	});

	test('a nested pin is honored verbatim even when there is no flat [models].<phase> at all', () => {
		const path = writeTmpToml(`
[models.codex]
implementer = "gpt-5-codex-pinned"
`);
		const result = resolvePhaseModel({ phase: 'implementer', backend: 'codex', configPath: path });
		expect(result).toEqual({ ok: true, model: 'gpt-5-codex-pinned' });
	});
});

describe('resolvePhaseModel: codex backend, non-claude-shaped flat pin (AC4)', () => {
	test('a non-claude-shaped flat value IS a valid codex pin, returned verbatim, cache reader never invoked', () => {
		const path = writeTmpToml(`
[models]
implementer = "gpt-5-codex"
`);
		const { reader, calls } = makeResolvingCacheReader('gpt-5-different-slug');
		const result = resolvePhaseModel({ phase: 'implementer', backend: 'codex', configPath: path, cacheReader: reader });
		expect(result).toEqual({ ok: true, model: 'gpt-5-codex' });
		expect(calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// AC3: dashed non-prefixed flat values are governed by the superset
// ---------------------------------------------------------------------------

describe('resolvePhaseModel: codex backend, claude-shaped flat values are NOT honored as a pin (AC3)', () => {
	for (const claudeShapedFlat of ['sonnet-4-5', 'sonnet', 'opus']) {
		test(`flat [models].implementer = '${claudeShapedFlat}' falls through to cache auto-resolution when the cache resolves`, () => {
			const path = writeTmpToml(`
[models]
implementer = "${claudeShapedFlat}"
`);
			const { reader } = makeResolvingCacheReader('gpt-5-cache-top');
			const result = resolvePhaseModel({ phase: 'implementer', backend: 'codex', configPath: path, cacheReader: reader });
			expect(result).toEqual({ ok: true, model: 'gpt-5-cache-top' });
		});

		test(`flat [models].implementer = '${claudeShapedFlat}' returns ok:false when the cache reader is not-ok`, () => {
			const path = writeTmpToml(`
[models]
implementer = "${claudeShapedFlat}"
`);
			const { reader } = makeFailingCacheReader('models cache file not found');
			const result = resolvePhaseModel({ phase: 'implementer', backend: 'codex', configPath: path, cacheReader: reader });
			expect(result.ok).toBe(false);
		});
	}

	test('no [models] config at all: the claude-tier DEFAULTS fallback is claude-shaped, falls to cache auto-resolution', () => {
		const path = writeTmpToml('');
		const { reader } = makeResolvingCacheReader('gpt-5-cache-top');
		const result = resolvePhaseModel({ phase: 'implementer', backend: 'codex', configPath: path, cacheReader: reader });
		expect(result).toEqual({ ok: true, model: 'gpt-5-cache-top' });
	});
});

// ---------------------------------------------------------------------------
// AC6: fail-closed abort message shape
// ---------------------------------------------------------------------------

describe('resolvePhaseModel: codex backend, fail-closed abort (AC6)', () => {
	const notOkReasons = [
		'models cache file not found at /home/x/.codex/models_cache.json',
		'failed to read models cache file: EACCES',
		"models cache 'models' field is missing or not an array",
		"no models cache entry is visibility='list' and supported_in_api=true",
	];

	for (const reason of notOkReasons) {
		test(`produces an actionable message for cache failure reason: ${reason}`, () => {
			const path = writeTmpToml(`
[models]
implementer = "sonnet"
`);
			const { reader } = makeFailingCacheReader(reason);
			const result = resolvePhaseModel({ phase: 'implementer', backend: 'codex', configPath: path, cacheReader: reader });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.message).toContain('~/.codex/models_cache.json');
				expect(result.message).toContain('[models.codex]');
			}
		});
	}

	test('is NOT produced when a valid pin exists, even if the cache reader would also fail', () => {
		const path = writeTmpToml(`
[models]
implementer = "gpt-5-codex"
`);
		const { reader } = makeFailingCacheReader('models cache file not found');
		const result = resolvePhaseModel({ phase: 'implementer', backend: 'codex', configPath: path, cacheReader: reader });
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AC5: claude backend
// ---------------------------------------------------------------------------

describe('resolvePhaseModel: claude backend', () => {
	for (const validModel of ['opus', 'sonnet', 'best', 'opusplan[1m]', 'claude-opus-4-8']) {
		test(`returns '${validModel}' verbatim, cache reader never invoked`, () => {
			const path = writeTmpToml(`
[models]
implementer = "${validModel}"
`);
			const { reader, calls } = makeResolvingCacheReader('gpt-5-should-not-be-used');
			const result = resolvePhaseModel({ phase: 'implementer', backend: 'claude', configPath: path, cacheReader: reader });
			expect(result).toEqual({ ok: true, model: validModel });
			expect(calls).toHaveLength(0);
		});
	}

	for (const invalidModel of ['sonnett', 'gpt-5.6-sol']) {
		test(`returns ok:false naming the offending value '${invalidModel}' and the project.toml [models] key, cache reader never invoked`, () => {
			const path = writeTmpToml(`
[models]
implementer = "${invalidModel}"
`);
			const { reader, calls } = makeResolvingCacheReader('gpt-5-should-not-be-used');
			const result = resolvePhaseModel({ phase: 'implementer', backend: 'claude', configPath: path, cacheReader: reader });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.message).toContain(invalidModel);
				expect(result.message).toContain('[models]');
				expect(result.message).toContain('implementer');
			}
			expect(calls).toHaveLength(0);
		});
	}

	test('with no [models] config at all, defaults to the claude-tier DEFAULTS value and validates ok', () => {
		const path = writeTmpToml('');
		const result = resolvePhaseModel({ phase: 'implementer', backend: 'claude', configPath: path });
		expect(result).toEqual({ ok: true, model: 'sonnet' });
	});
});
