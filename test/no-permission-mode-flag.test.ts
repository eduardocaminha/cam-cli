// test/no-permission-mode-flag.test.ts
//
// US-007 acceptance criterion 7 invariant: NO subcommand parser registers a
// `--permission-mode` flag. The value is sourced exclusively from
// `~/.config/cam/config.toml` via `src/config/permission-mode.ts`. This
// test fails the build if a future change accidentally adds the flag back.
//
// Two-layer defense:
//   1. Behavioral — feed `--permission-mode acceptEdits` to each subcommand
//      parser and verify it returns null (parser treats it as an unknown
//      flag, surfacing a diagnostic). This is the load-bearing assertion.
//   2. Textual (smoke) — scan `index.ts` for any non-comment, non-help-text
//      registration line that includes `--permission-mode`. The textual
//      scan is allowed to false-positive on prose; we tolerate that as the
//      cost of a hard tripwire on a refactor that adds a real
//      `case '--permission-mode':` branch to a parser.
//
// The behavioral test is the primary contract. The textual smoke is a
// belt-and-braces check.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseIssueArgs, parseNextArgs, parsePlanArgs } from '../index.ts';

describe('no `--permission-mode` flag on any subcommand parser (behavioral)', () => {
	test('parsePlanArgs rejects --permission-mode', () => {
		// Capture stderr writes so the test runner output stays clean —
		// printError writes the diagnostic to stderr.
		const original = process.stderr.write.bind(process.stderr);
		const captured: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const result = parsePlanArgs(['--permission-mode', 'acceptEdits']);
			expect(result).toBeNull();
		} finally {
			process.stderr.write = original;
		}
		expect(captured.join('')).toMatch(/unknown plan option.*--permission-mode/i);
	});

	test('parseNextArgs rejects --permission-mode', () => {
		const original = process.stderr.write.bind(process.stderr);
		const captured: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const result = parseNextArgs(['--permission-mode', 'acceptEdits']);
			expect(result).toBeNull();
		} finally {
			process.stderr.write = original;
		}
		expect(captured.join('')).toMatch(/unknown next option.*--permission-mode/i);
	});

	test('parseNextArgs rejects --permission-mode=value (joined form)', () => {
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(parseNextArgs(['--permission-mode=acceptEdits'])).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});

	test('parseIssueArgs does not accept --permission-mode as a recognized flag', () => {
		// The invariant: no issue subcommand parser registers `--permission-mode`.
		// When given `['--permission-mode', 'acceptEdits']`, parseIssueArgs must
		// NOT silently consume the flag and its value. Since the parser only
		// accepts a single positional text arg, two tokens is an error -> null.
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			const result = parseIssueArgs(['--permission-mode', 'acceptEdits']);
			expect(result).toBeNull();
		} finally {
			process.stderr.write = original;
		}
	});
});

describe('no `--permission-mode` parser-branch in index.ts (textual smoke)', () => {
	test('no `case` or single-quoted match for --permission-mode in any parser', () => {
		const indexPath = resolve(import.meta.dir, '..', 'index.ts');
		const source = readFileSync(indexPath, 'utf8');

		// Catch the patterns a parser would use:
		//   `arg === '--permission-mode'`
		//   `case '--permission-mode':`
		//   `arg.startsWith('--permission-mode=')`
		// Any of these would mean we registered the flag. Prose mentions of
		// the literal in HELP text or comments are allowed (we explicitly
		// document the absence of the flag in NEXT_HELP / module docstring).
		const FORBIDDEN_PATTERNS = [
			/===\s*['"]--permission-mode['"]/,
			/case\s+['"]--permission-mode['"]/,
			/startsWith\(\s*['"]--permission-mode['"]/,
		];
		for (const pat of FORBIDDEN_PATTERNS) {
			expect(source).not.toMatch(pat);
		}
	});
});
