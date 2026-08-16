import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseWebArgs } from '../index.ts';

describe('web CLI does not expose a permission-mode knob', () => {
	test('rejects --permission-mode', () => {
		const original = process.stderr.write.bind(process.stderr);
		const chunks: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			expect(parseWebArgs(['--permission-mode', 'acceptEdits'])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
		expect(chunks.join('')).toMatch(/unknown web option.*--permission-mode/i);
	});

	test('index has no parser branch for --permission-mode', () => {
		const source = readFileSync(resolve(import.meta.dir, '..', 'index.ts'), 'utf8');
		for (const pattern of [
			/===\s*['"]--permission-mode['"]/,
			/case\s+['"]--permission-mode['"]/,
			/startsWith\(\s*['"]--permission-mode['"]/,
		]) {
			expect(source).not.toMatch(pattern);
		}
	});
});
