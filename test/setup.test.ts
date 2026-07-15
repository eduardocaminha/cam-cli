// test/setup.test.ts
//
// US-001 acceptance criterion #4: copyTemplates emits an
// `Installed 5 file(s) → .claude/skills` line in its install summary.
//
// copyTemplates is intentionally non-interactive (pure filesystem + stdout),
// so we can exercise it directly from a unit test.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copyTemplates } from '../src/commands/setup.ts';

describe('copyTemplates — install summary includes skills line', () => {
	let cwd: string;
	let captured: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'cam-setup-test-'));
		captured = '';
		// Capture process.stdout.write (printSuccess writes there via color.ts:97).
		// Quiet mode must be OFF (default) so printSuccess is not suppressed.
		originalWrite = process.stdout.write.bind(process.stdout);
		// biome-ignore lint/suspicious/noExplicitAny: overriding built-in write signature
		(process.stdout as any).write = (chunk: string | Uint8Array, ..._args: unknown[]) => {
			if (typeof chunk === 'string') captured += chunk;
			return true;
		};
	});

	afterEach(() => {
		// Restore stdout before any assertion-failure reporting.
		// biome-ignore lint/suspicious/noExplicitAny: restoring overridden write
		(process.stdout as any).write = originalWrite;
		if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
	});

	test('emits Installed 5 file(s) → .claude/skills in the summary', () => {
		copyTemplates(cwd);
		expect(captured).toContain('Installed 5 file(s) → .claude/skills');
	});
});
