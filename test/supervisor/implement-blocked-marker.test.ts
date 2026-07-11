// test/supervisor/implement-blocked-marker.test.ts
//
// Tests for the durable implement-blocked marker (US-005, CAM-195, Defect 2).

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, test, expect } from 'bun:test';

import {
	IMPLEMENT_BLOCKED_FILENAME,
	readImplementBlockedMarker,
	writeImplementBlockedMarker,
	removeImplementBlockedMarker,
	advanceBlockedMarker,
	type ImplementBlockedMarker,
	type AdvanceBlockedMarkerParams,
} from '../../src/supervisor/implement-blocked-marker.ts';

describe('implement-blocked marker: round-trip (US-005, CAM-195)', () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-implement-blocked-'));
		filePath = join(tempDir, IMPLEMENT_BLOCKED_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('IMPLEMENT_BLOCKED_FILENAME is the expected literal', () => {
		expect(IMPLEMENT_BLOCKED_FILENAME).toBe('.cam-implement-blocked.json');
	});

	test('write then read round-trips the payload intact', () => {
		const marker: ImplementBlockedMarker = {
			issueId: '195',
			story: 'US-005',
			reason: 'dead-worker: 4 consecutive timeout outcomes (advisory US-005)',
			writtenAt: '2026-07-11T02:00:00Z',
			consecutiveCount: 1,
			keyHash: 'abc123',
		};

		writeImplementBlockedMarker(filePath, marker);

		expect(readImplementBlockedMarker(filePath)).toEqual(marker);
	});

	test('round-trips with story: null (blocked before any story was selected)', () => {
		const marker: ImplementBlockedMarker = {
			issueId: '195',
			story: null,
			reason: 'blocked-no-implementable',
			writtenAt: '2026-07-11T02:00:00Z',
			consecutiveCount: 1,
			keyHash: 'abc123',
		};

		writeImplementBlockedMarker(filePath, marker);

		expect(readImplementBlockedMarker(filePath)).toEqual(marker);
	});

	test('round-trips escalated:true + haltedAt (US-001)', () => {
		const marker: ImplementBlockedMarker = {
			issueId: '195',
			story: 'US-005',
			reason: 'BLOCKED_QUALITY story=US-005 reason=tests_failed',
			writtenAt: '2026-07-11T02:00:00Z',
			consecutiveCount: 3,
			keyHash: 'abc123',
			escalated: true,
			haltedAt: '2026-07-11T02:00:00Z',
		};

		writeImplementBlockedMarker(filePath, marker);

		expect(readImplementBlockedMarker(filePath)).toEqual(marker);
	});

	test('readImplementBlockedMarker defaults consecutiveCount/keyHash for a pre-US-001 (CAM-195-era) marker on disk', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				issueId: '195',
				story: 'US-005',
				reason: 'dead-worker: 4 consecutive timeout outcomes',
				writtenAt: '2026-07-11T02:00:00Z',
			}),
			'utf8',
		);

		expect(readImplementBlockedMarker(filePath)).toEqual({
			issueId: '195',
			story: 'US-005',
			reason: 'dead-worker: 4 consecutive timeout outcomes',
			writtenAt: '2026-07-11T02:00:00Z',
			consecutiveCount: 1,
			keyHash: '',
		});
	});

	test('readImplementBlockedMarker returns null when consecutiveCount is present but mistyped', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				issueId: '195',
				story: 'US-005',
				reason: 'x',
				writtenAt: '2026-07-11T02:00:00Z',
				consecutiveCount: 'not-a-number',
			}),
			'utf8',
		);
		expect(readImplementBlockedMarker(filePath)).toBeNull();
	});

	test('readImplementBlockedMarker returns null when keyHash is present but mistyped', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				issueId: '195',
				story: 'US-005',
				reason: 'x',
				writtenAt: '2026-07-11T02:00:00Z',
				keyHash: 42,
			}),
			'utf8',
		);
		expect(readImplementBlockedMarker(filePath)).toBeNull();
	});

	test('readImplementBlockedMarker returns null when escalated is present but mistyped', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				issueId: '195',
				story: 'US-005',
				reason: 'x',
				writtenAt: '2026-07-11T02:00:00Z',
				escalated: 'yes',
			}),
			'utf8',
		);
		expect(readImplementBlockedMarker(filePath)).toBeNull();
	});

	test('readImplementBlockedMarker returns null when haltedAt is present but mistyped', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				issueId: '195',
				story: 'US-005',
				reason: 'x',
				writtenAt: '2026-07-11T02:00:00Z',
				haltedAt: 12345,
			}),
			'utf8',
		);
		expect(readImplementBlockedMarker(filePath)).toBeNull();
	});

	test('readImplementBlockedMarker returns null for an absent file', () => {
		expect(readImplementBlockedMarker(filePath)).toBeNull();
	});

	test('readImplementBlockedMarker returns null for malformed JSON', () => {
		writeFileSync(filePath, 'NOT VALID JSON {{{{', 'utf8');
		expect(readImplementBlockedMarker(filePath)).toBeNull();
	});

	test('readImplementBlockedMarker returns null for a JSON array', () => {
		writeFileSync(filePath, JSON.stringify([1, 2, 3]), 'utf8');
		expect(readImplementBlockedMarker(filePath)).toBeNull();
	});

	test('readImplementBlockedMarker returns null when required fields are missing', () => {
		writeFileSync(filePath, JSON.stringify({ issueId: '195' }), 'utf8');
		expect(readImplementBlockedMarker(filePath)).toBeNull();
	});

	test('readImplementBlockedMarker returns null on a shape-guard failure (story wrong type)', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				issueId: '195',
				story: 42,
				reason: 'x',
				writtenAt: '2026-07-11T02:00:00Z',
			}),
			'utf8',
		);
		expect(readImplementBlockedMarker(filePath)).toBeNull();
	});

	test('writeImplementBlockedMarker overwrites a previous marker', () => {
		const first: ImplementBlockedMarker = {
			issueId: '195',
			story: 'US-004',
			reason: 'timeout',
			writtenAt: '2026-07-11T01:00:00Z',
			consecutiveCount: 1,
			keyHash: 'first-key',
		};
		const second: ImplementBlockedMarker = {
			issueId: '195',
			story: 'US-005',
			reason: 'pane-died-pre-result',
			writtenAt: '2026-07-11T02:00:00Z',
			consecutiveCount: 1,
			keyHash: 'second-key',
		};

		writeImplementBlockedMarker(filePath, first);
		writeImplementBlockedMarker(filePath, second);

		expect(readImplementBlockedMarker(filePath)).toEqual(second);
	});

	test('removeImplementBlockedMarker deletes the file', () => {
		writeImplementBlockedMarker(filePath, {
			issueId: '195',
			story: 'US-005',
			reason: 'x',
			writtenAt: '2026-07-11T02:00:00Z',
			consecutiveCount: 1,
			keyHash: 'abc123',
		});
		expect(existsSync(filePath)).toBe(true);

		removeImplementBlockedMarker(filePath);

		expect(existsSync(filePath)).toBe(false);
	});

	test('removeImplementBlockedMarker on an absent file is a silent no-op', () => {
		expect(existsSync(filePath)).toBe(false);
		expect(() => removeImplementBlockedMarker(filePath)).not.toThrow();
		expect(existsSync(filePath)).toBe(false);
	});
});

describe('advanceBlockedMarker: dedup key + consecutive-count logic (US-001, CAM-214)', () => {
	const PRD_HASH = 'prd-hash-a';

	function params(overrides: Partial<AdvanceBlockedMarkerParams> = {}): AdvanceBlockedMarkerParams {
		return {
			issueId: '214',
			story: 'US-003',
			reason: 'Worker reported BLOCKED_QUALITY story=US-003 reason=tests_failed',
			writtenAt: '2026-07-11T02:00:00Z',
			...overrides,
		};
	}

	test('first-ever block (prev: null) starts consecutiveCount at 1, not escalated', () => {
		const marker = advanceBlockedMarker(null, params(), PRD_HASH);

		expect(marker.consecutiveCount).toBe(1);
		expect(marker.escalated).toBeFalsy();
		expect(marker.haltedAt).toBeUndefined();
		expect(marker.keyHash.length).toBeGreaterThan(0);
	});

	test('same storyId + same BLOCKED_* token + same prdHash increments consecutiveCount and rewrites keyHash to the same value', () => {
		const first = advanceBlockedMarker(null, params(), PRD_HASH);
		const second = advanceBlockedMarker(first, params({ writtenAt: '2026-07-11T02:05:00Z' }), PRD_HASH);

		expect(second.keyHash).toBe(first.keyHash);
		expect(second.consecutiveCount).toBe(2);
		expect(second.escalated).toBeFalsy();
		expect(second.haltedAt).toBeUndefined();
	});

	test('3rd consecutive identical key escalates: escalated:true, haltedAt stamped with the caller-supplied writtenAt', () => {
		const first = advanceBlockedMarker(null, params(), PRD_HASH);
		const second = advanceBlockedMarker(first, params({ writtenAt: '2026-07-11T02:05:00Z' }), PRD_HASH);
		const third = advanceBlockedMarker(
			second,
			params({ writtenAt: '2026-07-11T02:10:00Z' }),
			PRD_HASH,
		);

		expect(third.consecutiveCount).toBe(3);
		expect(third.escalated).toBe(true);
		expect(third.haltedAt).toBe('2026-07-11T02:10:00Z');
	});

	test('counts 1 and 2 leave escalated falsy and haltedAt absent (custom low threshold hits at the 2nd count)', () => {
		const first = advanceBlockedMarker(null, params(), PRD_HASH, 2);
		expect(first.escalated).toBeFalsy();
		expect(first.haltedAt).toBeUndefined();

		const second = advanceBlockedMarker(first, params({ writtenAt: '2026-07-11T02:05:00Z' }), PRD_HASH, 2);
		expect(second.consecutiveCount).toBe(2);
		expect(second.escalated).toBe(true);
		expect(second.haltedAt).toBe('2026-07-11T02:05:00Z');
	});

	test('a different BLOCKED_* token resets consecutiveCount to 1, rewrites keyHash, and clears escalated', () => {
		const first = advanceBlockedMarker(null, params(), PRD_HASH);
		const second = advanceBlockedMarker(first, params({ writtenAt: '2026-07-11T02:05:00Z' }), PRD_HASH);
		const third = advanceBlockedMarker(second, params({ writtenAt: '2026-07-11T02:10:00Z' }), PRD_HASH);
		expect(third.escalated).toBe(true);

		const fourth = advanceBlockedMarker(
			third,
			params({
				reason: 'Worker reported BLOCKED_AMBIGUITY story=US-003 reason=unclear',
				writtenAt: '2026-07-11T02:15:00Z',
			}),
			PRD_HASH,
		);

		expect(fourth.keyHash).not.toBe(third.keyHash);
		expect(fourth.consecutiveCount).toBe(1);
		expect(fourth.escalated).toBeFalsy();
		expect(fourth.haltedAt).toBeUndefined();
	});

	test('a different storyId resets the key even with the same token + prdHash', () => {
		const first = advanceBlockedMarker(null, params({ story: 'US-003' }), PRD_HASH);
		const second = advanceBlockedMarker(first, params({ story: 'US-004', writtenAt: '2026-07-11T02:05:00Z' }), PRD_HASH);

		expect(second.keyHash).not.toBe(first.keyHash);
		expect(second.consecutiveCount).toBe(1);
	});

	test('a different prdHash resets the key even with the same storyId + token', () => {
		const first = advanceBlockedMarker(null, params(), PRD_HASH);
		const second = advanceBlockedMarker(first, params({ writtenAt: '2026-07-11T02:05:00Z' }), 'prd-hash-b');

		expect(second.keyHash).not.toBe(first.keyHash);
		expect(second.consecutiveCount).toBe(1);
	});

	test('a reason carrying no BLOCKED_ token falls back to a stable literal so the key stays deterministic', () => {
		const noTokenParams = params({ reason: 'blocked-no-implementable' });
		const first = advanceBlockedMarker(null, noTokenParams, PRD_HASH);
		const second = advanceBlockedMarker(first, noTokenParams, PRD_HASH);

		// Deterministic: same (storyId, fallback token, prdHash) -> same key both times.
		expect(second.keyHash).toBe(first.keyHash);
		expect(second.consecutiveCount).toBe(2);
	});

	test('story: null (blocked before any story was selected) still produces a deterministic key', () => {
		const nullStoryParams = params({ story: null, reason: 'blocked-no-implementable' });
		const first = advanceBlockedMarker(null, nullStoryParams, PRD_HASH);
		const second = advanceBlockedMarker(first, nullStoryParams, PRD_HASH);

		expect(second.keyHash).toBe(first.keyHash);
		expect(second.consecutiveCount).toBe(2);
	});

	test('advanceBlockedMarker is pure: calling it twice with identical inputs produces identical output', () => {
		const a = advanceBlockedMarker(null, params(), PRD_HASH);
		const b = advanceBlockedMarker(null, params(), PRD_HASH);
		expect(a).toEqual(b);
	});

	test('the returned marker carries issueId/story/reason/writtenAt through unchanged', () => {
		const marker = advanceBlockedMarker(null, params(), PRD_HASH);
		expect(marker.issueId).toBe('214');
		expect(marker.story).toBe('US-003');
		expect(marker.reason).toBe('Worker reported BLOCKED_QUALITY story=US-003 reason=tests_failed');
		expect(marker.writtenAt).toBe('2026-07-11T02:00:00Z');
	});
});
