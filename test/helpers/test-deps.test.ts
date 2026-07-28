// test/helpers/test-deps.test.ts
//
// Coverage for test-deps.ts (US-001, CAM-424).
//
// AC2's behavioral seam tests inject absence via depPreflight's DI seam
// (available/waived), never real I/O: these are /usr/bin binaries that are
// always present on both macOS dev boxes and CI, so an absent-binary
// scenario cannot be reproduced through real probing. Per ADR-0039, a
// DI-injected absence stands in for real I/O exactly where the real-I/O
// route is unavailable -- this is the AC7-replacement case the story
// documents, not a tautological "the mock was called" assertion.

import { describe, expect, test } from 'bun:test';
import {
	depPreflight,
	getDepInfo,
	isAvailable,
	isWaived,
	parseWaivers,
	WAIVER_ENV_VAR,
	type DepName,
} from './test-deps.ts';

describe('getDepInfo / classification data', () => {
	test('every one of the 7 required binaries has classification data', () => {
		const expected: DepName[] = ['tmux', 'git', 'jq', 'pgrep', 'ps', 'uuidgen', 'bun'];
		for (const name of expected) {
			const info = getDepInfo(name);
			expect(info.name).toBe(name);
			expect(typeof info.available).toBe('boolean');
			expect(['hard-dependency', 'legitimate-environmental']).toContain(info.classification);
			expect(info.rationale.length).toBeGreaterThan(0);
			expect(info.installHint.length).toBeGreaterThan(0);
		}
	});

	test('ps is classified legitimate-environmental with the oven/bun container rationale', () => {
		const info = getDepInfo('ps');
		expect(info.classification).toBe('legitimate-environmental');
		expect(info.rationale.toLowerCase()).toContain('oven/bun');
		expect(info.rationale.toLowerCase()).toContain('recycle-watcher');
	});

	test('tmux is classified hard-dependency (every cam session is a tmux split)', () => {
		expect(getDepInfo('tmux').classification).toBe('hard-dependency');
	});

	test('getDepInfo returns the same frozen snapshot object on repeated calls (probed once)', () => {
		expect(getDepInfo('bun')).toBe(getDepInfo('bun'));
		expect(isAvailable('bun')).toBe(getDepInfo('bun').available);
	});
});

describe('parseWaivers', () => {
	test('undefined/empty input yields an empty set', () => {
		expect(parseWaivers(undefined).size).toBe(0);
		expect(parseWaivers('').size).toBe(0);
	});

	test('comma-separated names are split and trimmed', () => {
		const waivers = parseWaivers('tmux, ps ,git,, uuidgen');
		expect(waivers.has('tmux')).toBe(true);
		expect(waivers.has('ps')).toBe(true);
		expect(waivers.has('git')).toBe(true);
		expect(waivers.has('uuidgen')).toBe(true);
		expect(waivers.size).toBe(4);
	});
});

describe('isWaived', () => {
	test('reads CAM_TEST_WAIVERS from an injected env object', () => {
		expect(isWaived('jq', { [WAIVER_ENV_VAR]: 'jq,pgrep' })).toBe(true);
		expect(isWaived('git', { [WAIVER_ENV_VAR]: 'jq,pgrep' })).toBe(false);
		expect(isWaived('jq', {})).toBe(false);
	});
});

describe('depPreflight (AC2 behavioral seam tests)', () => {
	test('available dependency: proceeds without ever invoking the waiver check', () => {
		const result = depPreflight({
			name: 'git',
			available: () => true,
			waived: () => {
				throw new Error('waived() must not be invoked when the dependency is available');
			},
		});
		expect(result.kind).toBe('available');
	});

	test('injected absence of a hard dependency, NO waiver: fails, naming the binary with an actionable install hint', () => {
		const result = depPreflight({
			name: 'tmux',
			available: () => false,
			waived: () => false,
		});
		expect(result.kind).toBe('fail');
		if (result.kind === 'fail') {
			expect(result.message).toContain('tmux');
			// Actionable install hint: names a concrete install command.
			expect(result.message).toMatch(/brew install tmux|apt-get install tmux/);
		}
	});

	test('the SAME injected absence, WITH the waiver declared: yields skip-allowed', () => {
		const result = depPreflight({
			name: 'tmux',
			available: () => false,
			waived: () => true,
		});
		expect(result.kind).toBe('skip');
		if (result.kind === 'skip') {
			expect(result.reason).toContain('tmux');
			expect(result.reason).toContain(WAIVER_ENV_VAR);
		}
	});

	test('injected absence of the legitimate-environmental dependency (ps): skip-allowed WITHOUT a waiver', () => {
		const result = depPreflight({
			name: 'ps',
			available: () => false,
			waived: () => {
				throw new Error('waived() must not be invoked for a legitimate-environmental dependency');
			},
		});
		expect(result.kind).toBe('skip');
		if (result.kind === 'skip') {
			expect(result.reason.toLowerCase()).toContain('oven/bun');
		}
	});

	test('default wiring (no injection) resolves against the real probed snapshot without throwing', () => {
		// Not asserting a specific outcome (this suite always runs where bun is
		// present) -- only that the production default-wiring path (DI seam
		// omitted entirely) is exercised end-to-end without error.
		const result = depPreflight({ name: 'bun' });
		expect(result.kind).toBe('available');
	});
});
