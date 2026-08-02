// test/util/self-invoke.test.ts
//
// Unit tests for resolveSelfInvokeArgv (US-001, CAM-426): the single
// canonical fix site for the compiled-vs-interpreted self-invoke bug class,
// keyed only on the positive `/$bunfs/` argv1 signal.

import { describe, expect, test } from 'bun:test';

import { resolveSelfInvokeArgv } from '../../src/util/self-invoke.ts';

describe('resolveSelfInvokeArgv (US-001, CAM-426)', () => {
	test('compiled mode: argv1 starting with /$bunfs/ returns [execPath] alone', () => {
		const argv = resolveSelfInvokeArgv('/usr/local/bin/cam', '/$bunfs/root/cam-branch');
		expect(argv).toEqual(['/usr/local/bin/cam']);
	});

	test('interpreted mode: a real argv1 script path returns [execPath, argv1]', () => {
		const argv = resolveSelfInvokeArgv('/opt/homebrew/bin/bun', '/repo/index.ts');
		expect(argv).toEqual(['/opt/homebrew/bin/bun', '/repo/index.ts']);
	});

	test('interpreted mode under a version-managed bun shim (basename e.g. "bun-1.3") with a real argv1: still interpreted -- basename is never consulted', () => {
		const argv = resolveSelfInvokeArgv('/opt/homebrew/bin/bun-1.3', '/repo/index.ts');
		expect(argv).toEqual(['/opt/homebrew/bin/bun-1.3', '/repo/index.ts']);
	});

	test('degenerate interpreted mode with undefined argv1 resolves to an execPath-only argv', () => {
		const argv = resolveSelfInvokeArgv('/opt/homebrew/bin/bun', undefined);
		expect(argv).toEqual(['/opt/homebrew/bin/bun']);
	});
});
