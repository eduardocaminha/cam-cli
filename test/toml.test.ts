// test/toml.test.ts
//
// Round-trip + merge tests for `src/config/toml.ts`. Uses Bun's built-in
// test runner (matches the rest of the repo).

import { describe, expect, test, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	loadConfig,
	mergeIntoConfig,
	parseToml,
	saveConfig,
	stringifyToml,
	type TomlComments,
} from '../src/config/toml.ts';

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'cam-cli-toml-'));
});

function cleanup(): void {
	if (workDir && existsSync(workDir)) {
		rmSync(workDir, { recursive: true, force: true });
	}
}

describe('stringifyToml + parseToml', () => {
	test('round-trips a top-level scalar config', () => {
		const original = { permission_mode: 'bypassPermissions' };
		const text = stringifyToml(original);
		expect(text).toBe('permission_mode = "bypassPermissions"\n');
		const parsed = parseToml(text);
		expect(parsed).toEqual(original);
		cleanup();
	});

	test('round-trips boolean and number scalars', () => {
		const original = { auto_resume: true, max_iterations: 30, prompt: '/cam-next' };
		const text = stringifyToml(original);
		const parsed = parseToml(text);
		expect(parsed).toEqual(original);
		cleanup();
	});

	test('round-trips a section table', () => {
		const original = {
			permission_mode: 'bypassPermissions',
			plugin: { max_iterations: 30, completion_promise: 'COMPLETE' },
		};
		const text = stringifyToml(original);
		const parsed = parseToml(text);
		expect(parsed).toEqual(original);
		cleanup();
	});

	test('escapes backslashes and quotes in string values', () => {
		const original = { path: 'C:\\Users\\eduardo\\Projects', label: 'with "quotes"' };
		const text = stringifyToml(original);
		const parsed = parseToml(text);
		expect(parsed).toEqual(original);
		cleanup();
	});

	test('emits keys in stable sorted order', () => {
		// Same content, different insertion order — output must be byte-identical.
		const a = stringifyToml({ b: 1, a: 1, c: 1 });
		const b = stringifyToml({ c: 1, a: 1, b: 1 });
		expect(a).toBe(b);
		cleanup();
	});

	test('parseToml on empty string returns {}', () => {
		expect(parseToml('')).toEqual({});
		cleanup();
	});

	test('parseToml throws on malformed TOML', () => {
		// Bun.TOML.parse throws an Error-shaped value on syntax errors.
		// Verified locally: `Bun.TOML.parse("invalid = [")` throws "Unexpected end of file".
		expect(() => parseToml('invalid = [')).toThrow();
		cleanup();
	});
});

describe('stringifyToml comment emission (US-001)', () => {
	test('omitting comments is byte-identical to the pre-existing no-comment output', () => {
		const config = {
			permission_mode: 'bypassPermissions',
			plugin: { max_iterations: 30, completion_promise: 'COMPLETE' },
		};
		expect(stringifyToml(config)).toBe(
			'permission_mode = "bypassPermissions"\n\n[plugin]\ncompletion_promise = "COMPLETE"\nmax_iterations = 30\n',
		);
		cleanup();
	});

	test('emits commented example lines under a section header with no active keys', () => {
		const config = { permission_mode: 'bypassPermissions', loop: {} };
		const comments: TomlComments = { loop: ['max_iterations = 30', 'auto_resume = true'] };
		const text = stringifyToml(config, comments);
		expect(text).toBe(
			'permission_mode = "bypassPermissions"\n\n[loop]\n# max_iterations = 30\n# auto_resume = true\n',
		);
		cleanup();
	});

	test('parser ignores comment lines: a commented [loop] example parses the same as without it', () => {
		const withComments = '[loop]\n# max_iterations = 30\nprompt = "/cam-next"\n';
		const withoutComments = '[loop]\nprompt = "/cam-next"\n';
		expect(parseToml(withComments)).toEqual(parseToml(withoutComments));
		cleanup();
	});

	test('round-trip: parseToml(stringifyToml(config, comments)) deep-equals config (active keys)', () => {
		const config = {
			permission_mode: 'bypassPermissions',
			loop: { max_iterations: 30 },
		};
		const comments: TomlComments = { loop: ['prompt = "/cam-next"'] };
		const text = stringifyToml(config, comments);
		expect(parseToml(text)).toEqual(config);
		cleanup();
	});

	test('round-trip: comment-only section (no active keys) deep-equals config', () => {
		const config = {
			permission_mode: 'bypassPermissions',
			loop: {},
		};
		const comments: TomlComments = { loop: ['max_iterations = 30', 'auto_resume = true'] };
		const text = stringifyToml(config, comments);
		expect(parseToml(text)).toEqual(config);
		cleanup();
	});
});

describe('loadConfig + saveConfig', () => {
	test('loadConfig returns {} for a missing file', () => {
		expect(loadConfig(join(workDir, 'does-not-exist.toml'))).toEqual({});
		cleanup();
	});

	test('saveConfig creates parent directories recursively', () => {
		const path = join(workDir, 'a', 'b', 'c', 'config.toml');
		saveConfig(path, { permission_mode: 'bypassPermissions' });
		expect(existsSync(path)).toBe(true);
		const reread = loadConfig(path);
		expect(reread).toEqual({ permission_mode: 'bypassPermissions' });
		cleanup();
	});

	test('saveConfig writes a trailing newline', () => {
		const path = join(workDir, 'config.toml');
		saveConfig(path, { foo: 'bar' });
		const raw = readFileSync(path, 'utf8');
		expect(raw.endsWith('\n')).toBe(true);
		cleanup();
	});

	test('save → read → equal (the AC round-trip)', () => {
		const path = join(workDir, 'config.toml');
		const original = {
			permission_mode: 'bypassPermissions',
			plugin: { max_iterations: 30, prompt: '/cam-next' },
		};
		saveConfig(path, original);
		const reread = loadConfig(path);
		expect(reread).toEqual(original);
		cleanup();
	});
});

describe('mergeIntoConfig', () => {
	test('preserves existing top-level keys when adding a new one', () => {
		const path = join(workDir, 'config.toml');
		saveConfig(path, { existing_key: 'preserved' });
		mergeIntoConfig(path, { permission_mode: 'bypassPermissions' });
		const result = loadConfig(path);
		expect(result).toEqual({ existing_key: 'preserved', permission_mode: 'bypassPermissions' });
		cleanup();
	});

	test('overwrites a top-level key when present in updates', () => {
		const path = join(workDir, 'config.toml');
		saveConfig(path, { permission_mode: 'old' });
		mergeIntoConfig(path, { permission_mode: 'bypassPermissions' });
		const result = loadConfig(path);
		expect(result.permission_mode).toBe('bypassPermissions');
		cleanup();
	});

	test('merges into an existing section, preserving sibling keys', () => {
		const path = join(workDir, 'config.toml');
		saveConfig(path, { plugin: { max_iterations: 30, prompt: 'old' } });
		mergeIntoConfig(path, { plugin: { prompt: '/cam-next' } });
		const result = loadConfig(path);
		expect(result.plugin).toEqual({ max_iterations: 30, prompt: '/cam-next' });
		cleanup();
	});

	test('writes a fresh file when the target does not exist', () => {
		const path = join(workDir, 'fresh', 'config.toml');
		mergeIntoConfig(path, { permission_mode: 'bypassPermissions' });
		const result = loadConfig(path);
		expect(result).toEqual({ permission_mode: 'bypassPermissions' });
		cleanup();
	});
});
