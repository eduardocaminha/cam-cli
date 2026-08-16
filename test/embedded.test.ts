import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { EMBEDDED_CONTENTS, readEmbedded } from '../src/vendor/embedded.ts';

describe('embedded loop-state template', () => {
	test('matches the source byte-for-byte', () => {
		const source = readFileSync(resolve(import.meta.dir, '..', 'vendor', 'cam-loop.local.md.tmpl'), 'utf8');
		expect(EMBEDDED_CONTENTS['cam-loop.local.md.tmpl']).toBe(source);
		expect(readEmbedded('cam-loop.local.md.tmpl')).toBe(source);
	});

	test('is the only remaining embedded asset', () => {
		expect(Object.keys(EMBEDDED_CONTENTS)).toEqual(['cam-loop.local.md.tmpl']);
	});
});
