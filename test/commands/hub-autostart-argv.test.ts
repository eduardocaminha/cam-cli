// test/commands/hub-autostart-argv.test.ts
//
// US-003 (CAM-482): the four legacy cycle controls (plan, next, review, ship)
// must autostart the hub via the EXACT binary/script running
// them, never a literal `cam` name resolved off PATH (a stale PATH binary
// could disagree with the branch that just invoked the proxy).
//
// `buildHubAutostartArgv` (src/util/hub-bootstrap.ts) is the single shared
// argv builder all four `doBootstrap` fallbacks now route through. This test
// asserts REAL argv shape from an INJECTED execPath/argv1 pair whose basename
// deliberately differs from the real running binary's, so a builder that
// silently fell back to a literal name (or to process.execPath internally
// instead of its parameters) would be caught red-handed. This file is red
// against main (buildHubAutostartArgv does not exist there).

import { describe, expect, test } from 'bun:test';
import { basename } from 'node:path';
import process from 'node:process';

import { buildHubAutostartArgv } from '../../src/util/hub-bootstrap.ts';

const INJECTED_EXEC_PATH = '/opt/injected-exec/injected-exec';
const INJECTED_ARGV1 = '/repo/injected-script.ts';

// Sanity: the injected execPath's basename must genuinely differ from the
// real binary running this test.
const realBasename = basename(process.execPath);
if (basename(INJECTED_EXEC_PATH) === realBasename) {
	throw new Error('test fixture collision: pick an injected execPath basename that differs from the real one');
}

/** No product-name literal ("cam") anywhere in the argv words. */
function assertNoProductNameLiteral(argv: string[]): void {
	for (const word of argv) {
		expect(word.toLowerCase()).not.toBe('cam');
	}
}

describe('buildHubAutostartArgv (US-003, CAM-482)', () => {
	test('compiled mode (argv1 absent): starts with the injected execPath, ends with run --no-attach, no literal binary name', () => {
		const argv = buildHubAutostartArgv(INJECTED_EXEC_PATH, undefined);
		expect(argv[0]).toBe(INJECTED_EXEC_PATH);
		expect(argv.slice(-2)).toEqual(['run', '--no-attach']);
		expect(argv).toEqual([INJECTED_EXEC_PATH, 'run', '--no-attach']);
		assertNoProductNameLiteral(argv);
	});

	test('interpreted mode (execPath + argv1): both tokens precede the run --no-attach subcommand, no literal binary name', () => {
		const argv = buildHubAutostartArgv(INJECTED_EXEC_PATH, INJECTED_ARGV1);
		expect(argv[0]).toBe(INJECTED_EXEC_PATH);
		expect(argv.slice(-2)).toEqual(['run', '--no-attach']);
		expect(argv).toEqual([INJECTED_EXEC_PATH, INJECTED_ARGV1, 'run', '--no-attach']);
		assertNoProductNameLiteral(argv);
	});

	test('never falls back to process.execPath when an injected execPath is supplied', () => {
		const argv = buildHubAutostartArgv(INJECTED_EXEC_PATH, INJECTED_ARGV1);
		expect(argv).not.toContain(process.execPath);
	});
});
