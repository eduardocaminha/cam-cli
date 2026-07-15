// test/check-test-sleeps.test.ts
//
// Unit tests for scripts/check-test-sleeps.ts (US-001, CAM-305 PRD).
//
// All tests inject in-memory file records; no filesystem reads are made.
//
// Coverage:
//   scanForSleeps: flaggable Bun.sleepSync(<n>) fails
//   scanForSleeps: flaggable promisified setTimeout(<id>, <n>) fails
//   scanForSleeps: setTimeout(resolve, 0) literal fails (0 is matched)
//   scanForSleeps: same-line tracker-ref suppresses the violation
//   scanForSleeps: injected/recorded clocks are NOT matched
//   scanForSleeps: Bun.sleep( (async) is NOT matched
//   scanForSleeps: bare callback scheduler is NOT matched
//   scanForSleeps: variable-interval timer is NOT matched
//   filterScannablePaths: excluded dirs are dropped, test/ paths kept

import { describe, expect, test } from 'bun:test';
import { filterScannablePaths, scanForSleeps } from '../scripts/check-test-sleeps.ts';

// ---------------------------------------------------------------------------
// scanForSleeps: flaggable forms
// ---------------------------------------------------------------------------

describe('scanForSleeps — flaggable forms', () => {
	test('Bun.sleepSync(<n>) fails: cited=false, names file:line, kind', () => {
		const results = scanForSleeps([
			{ path: 'test/foo.test.ts', text: 'Bun.sleepSync(100);\n' }, // CAM-305: scanner test fixture, not a real sleep
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.cited).toBe(false);
		expect(results[0]!.path).toBe('test/foo.test.ts');
		expect(results[0]!.line).toBe(1);
		expect(results[0]!.kind).toBe('Bun.sleepSync');
	});

	test('promisified setTimeout(<id>, <n>) fails: cited=false, kind', () => {
		const results = scanForSleeps([
			{
				path: 'test/foo.test.ts',
				text: 'await new Promise((resolve) => setTimeout(resolve, 50));\n', // CAM-305: scanner test fixture, not a real sleep
			},
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.cited).toBe(false);
		expect(results[0]!.kind).toBe('setTimeout-promise');
	});

	test('setTimeout(resolve, 0) literal fails: 0 is matched, no magic-number carve-out', () => {
		const results = scanForSleeps([
			{
				path: 'test/helpers/flush-ink.ts',
				text: 'const oneTick = () => new Promise((resolve) => setTimeout(resolve, 0));\n', // CAM-305: scanner test fixture, not a real sleep
			},
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.cited).toBe(false);
		expect(results[0]!.kind).toBe('setTimeout-promise');
	});

	test('same-line tracker-ref (CAM-NNN) suppresses the violation', () => {
		const results = scanForSleeps([
			{ path: 'test/foo.test.ts', text: 'Bun.sleepSync(100); // CAM-306\n' },
		]);
		expect(results).toHaveLength(1);
		expect(results[0]!.cited).toBe(true);
	});

	test('same-line tracker-ref (#N or https URL) suppresses the violation', () => {
		const results = scanForSleeps([
			{ path: 'test/a.test.ts', text: 'Bun.sleepSync(50); // see #12\n' },
			{
				path: 'test/b.test.ts',
				text: 'Bun.sleepSync(50); // https://example.com/ticket/1\n',
			},
		]);
		expect(results).toHaveLength(2);
		expect(results[0]!.cited).toBe(true);
		expect(results[1]!.cited).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// scanForSleeps: known false-positive set (must NOT match)
// ---------------------------------------------------------------------------

describe('scanForSleeps — known false positives are not matched', () => {
	test('injected clock: sleepFn: field is not matched', () => {
		const results = scanForSleeps([
			{ path: 'test/foo.test.ts', text: 'const deps = { sleepFn: (ms: number) => {} };\n' },
		]);
		expect(results).toHaveLength(0);
	});

	test('injected clock: setTimeoutFn = assignment is not matched', () => {
		const results = scanForSleeps([
			{
				path: 'test/foo.test.ts',
				text: 'const setTimeoutFn = (cb: () => void, _ms: number): unknown => { cb(); return 0; };\n',
			},
		]);
		expect(results).toHaveLength(0);
	});

	test('injected clock: globalThis.setTimeout = assignment is not matched', () => {
		const results = scanForSleeps([
			{
				path: 'test/foo.test.ts',
				text: 'globalThis.setTimeout = (fn: () => void, _ms: number) => { fn(); return 0; };\n',
			},
		]);
		expect(results).toHaveLength(0);
	});

	test('injected clock: nowFn: field is not matched', () => {
		const results = scanForSleeps([
			{ path: 'test/foo.test.ts', text: 'const deps = { nowFn: () => Date.now() };\n' },
		]);
		expect(results).toHaveLength(0);
	});

	test('Bun.sleep( (async, non-Sync) is not matched', () => {
		const results = scanForSleeps([
			{ path: 'test/foo.test.ts', text: 'await Bun.sleep(60000);\n' },
		]);
		expect(results).toHaveLength(0);
	});

	test('bare callback scheduler setTimeout(cb, n) is not matched', () => {
		const results = scanForSleeps([
			{
				path: 'test/foo.test.ts',
				text: "setTimeout(() => reader.emit(Buffer.from('q')), 5);\n",
			},
		]);
		expect(results).toHaveLength(0);
	});

	test('variable-interval timer setTimeout(resolve, intervalMs) is not matched', () => {
		const results = scanForSleeps([
			{
				path: 'test/helpers/wait-for-condition.ts',
				text: 'await new Promise((resolve) => setTimeout(resolve, intervalMs));\n',
			},
		]);
		expect(results).toHaveLength(0);
	});

	test('no sleeps at all -> empty result', () => {
		const results = scanForSleeps([
			{ path: 'test/foo.test.ts', text: 'expect(1).toBe(1);\n' },
		]);
		expect(results).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// filterScannablePaths
// ---------------------------------------------------------------------------

describe('filterScannablePaths', () => {
	test('vendor/ paths are excluded', () => {
		expect(filterScannablePaths(['vendor/foo.ts'])).toEqual([]);
	});

	test('node_modules/ paths are excluded', () => {
		expect(filterScannablePaths(['node_modules/foo/bar.ts'])).toEqual([]);
	});

	test('claude-code-harness/ paths are excluded', () => {
		expect(filterScannablePaths(['claude-code-harness/foo.ts'])).toEqual([]);
	});

	test('dist/ paths are excluded', () => {
		expect(filterScannablePaths(['dist/foo.ts'])).toEqual([]);
	});

	test('normal test/ paths are kept', () => {
		expect(filterScannablePaths(['test/foo.test.ts'])).toEqual(['test/foo.test.ts']);
	});
});
