// test/docs/embedded-vendor-comment-fidelity.test.ts
//
// Tripwire: the header comment of scripts/generate-embedded-vendor.ts once
// claimed that `bun build --compile` cannot embed arbitrary files in the
// binary. That claim is false (`import ... with { type: "file" }` embeds a
// file verbatim and resolves to a `$bunfs` path), and it escalated into an
// architecture-contract amendment that removed the web UI from the binary
// for a nonexistent cost (memory/project_definicoes_web_headless.md, emenda
// 9 of 2026-08-11, revoked by the 2026-08-13 amendments). This test pins
// both directions: the false claim stays absent, and the comment carries
// the two true facts (Bun embeds natively via `with { type: "file" }`; this
// script inlines CONTENT as string constants by choice, because consumers
// need content in memory, not a path).
//
// The absence assertion is guarded against silent non-match by a fabricated
// test that feeds the normalizer the original wrapped comment lines and
// asserts the detector fires (same species as recorte-fidelity.test.ts).

import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT_PATH = join(import.meta.dir, '../../scripts/generate-embedded-vendor.ts');

const FALSE_CLAIM = 'does NOT include arbitrary files in the binary; only TS modules transitively imported';

/**
 * Collapses the header comment's line wrapping so phrase assertions are not
 * broken by where a `//` line happens to wrap: strips leading `// ` markers
 * and normalizes all whitespace runs to a single space.
 */
function normalize(text: string): string {
	return text
		.split('\n')
		.map((line) => line.replace(/^\s*\/\/ ?/, ''))
		.join(' ')
		.replace(/\s+/g, ' ');
}

function readNormalizedScript(): string {
	return normalize(readFileSync(SCRIPT_PATH, 'utf8'));
}

describe('generate-embedded-vendor header comment fidelity', () => {
	test('the false claim (compile cannot embed arbitrary files) is absent', () => {
		expect(readNormalizedScript()).not.toContain(FALSE_CLAIM);
	});

	test('fabricated: the normalizer detects the false claim in its original wrapped form', () => {
		const originalWrappedLines = [
			'// (`bun build --compile`). `bun build --compile` does NOT include arbitrary',
			'// files in the binary; only TS modules transitively imported. Embedding as',
		].join('\n');
		expect(normalize(originalWrappedLines)).toContain(FALSE_CLAIM);
	});

	test('the comment names the native embed mechanism: with { type: "file" } returning a $bunfs path', () => {
		const text = readNormalizedScript();
		expect(text).toContain('with { type: "file" }');
		expect(text).toContain('$bunfs');
	});

	test('the comment states this script inlines content as string constants by choice', () => {
		const text = readNormalizedScript();
		expect(text).toContain('inlines file contents as utf8 string constants');
		expect(text).toContain('the content in memory, not a path');
	});
});
