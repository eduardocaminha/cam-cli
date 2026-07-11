// test/supervisor/post-merge-stalled-marker.test.ts
//
// Tests for the durable post-merge-stalled marker (US-001, CAM-174).

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, test, expect } from 'bun:test';

import {
	POST_MERGE_STALLED_FILENAME,
	readPostMergeStalledMarker,
	writePostMergeStalledMarker,
	removePostMergeStalledMarker,
	type PostMergeStalledMarker,
} from '../../src/supervisor/post-merge-stalled-marker.ts';

describe('post-merge-stalled marker: round-trip (US-001, CAM-174)', () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-post-merge-stalled-'));
		filePath = join(tempDir, POST_MERGE_STALLED_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('POST_MERGE_STALLED_FILENAME is the expected literal', () => {
		expect(POST_MERGE_STALLED_FILENAME).toBe('.cam-post-merge-stalled.json');
	});

	test('write then read round-trips the payload intact', () => {
		const marker: PostMergeStalledMarker = {
			prNumber: 174,
			issueId: '174',
			completedSteps: ['tag'],
			remainingSteps: ['branch-prune', 'issue-close'],
			reason: 'git pull origin main failed',
			writtenAt: '2026-07-11T02:00:00Z',
		};

		writePostMergeStalledMarker(filePath, marker);

		expect(readPostMergeStalledMarker(filePath)).toEqual(marker);
	});

	test('round-trips with issueId: null (merge-watch state carried none)', () => {
		const marker: PostMergeStalledMarker = {
			prNumber: 174,
			issueId: null,
			completedSteps: [],
			remainingSteps: ['tag', 'branch-prune'],
			reason: 'stalled before any step ran',
			writtenAt: '2026-07-11T02:00:00Z',
		};

		writePostMergeStalledMarker(filePath, marker);

		expect(readPostMergeStalledMarker(filePath)).toEqual(marker);
	});

	test('writePostMergeStalledMarker overwrites a previous marker', () => {
		const first: PostMergeStalledMarker = {
			prNumber: 174,
			issueId: '174',
			completedSteps: [],
			remainingSteps: ['tag'],
			reason: 'first',
			writtenAt: '2026-07-11T01:00:00Z',
		};
		const second: PostMergeStalledMarker = {
			prNumber: 175,
			issueId: '175',
			completedSteps: ['tag'],
			remainingSteps: ['branch-prune'],
			reason: 'second',
			writtenAt: '2026-07-11T02:00:00Z',
		};

		writePostMergeStalledMarker(filePath, first);
		writePostMergeStalledMarker(filePath, second);

		expect(readPostMergeStalledMarker(filePath)).toEqual(second);
	});

	test('removePostMergeStalledMarker deletes the file', () => {
		writePostMergeStalledMarker(filePath, {
			prNumber: 174,
			issueId: '174',
			completedSteps: [],
			remainingSteps: ['tag'],
			reason: 'x',
			writtenAt: '2026-07-11T02:00:00Z',
		});
		expect(existsSync(filePath)).toBe(true);

		removePostMergeStalledMarker(filePath);

		expect(existsSync(filePath)).toBe(false);
	});

	test('removePostMergeStalledMarker on an absent file is a silent no-op', () => {
		expect(existsSync(filePath)).toBe(false);
		expect(() => removePostMergeStalledMarker(filePath)).not.toThrow();
		expect(existsSync(filePath)).toBe(false);
	});

	test('readPostMergeStalledMarker returns null for an absent file', () => {
		expect(readPostMergeStalledMarker(filePath)).toBeNull();
	});

	test('readPostMergeStalledMarker returns null for malformed JSON', () => {
		writeFileSync(filePath, 'NOT VALID JSON {{{{', 'utf8');
		expect(readPostMergeStalledMarker(filePath)).toBeNull();
	});

	test('readPostMergeStalledMarker returns null for a JSON array', () => {
		writeFileSync(filePath, JSON.stringify([1, 2, 3]), 'utf8');
		expect(readPostMergeStalledMarker(filePath)).toBeNull();
	});

	test('readPostMergeStalledMarker returns null when required fields are missing', () => {
		writeFileSync(filePath, JSON.stringify({ prNumber: 174 }), 'utf8');
		expect(readPostMergeStalledMarker(filePath)).toBeNull();
	});

	test('readPostMergeStalledMarker returns null when prNumber is mistyped', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				prNumber: '174',
				issueId: '174',
				completedSteps: [],
				remainingSteps: [],
				reason: 'x',
				writtenAt: '2026-07-11T02:00:00Z',
			}),
			'utf8',
		);
		expect(readPostMergeStalledMarker(filePath)).toBeNull();
	});

	test('readPostMergeStalledMarker returns null when issueId is mistyped (not string|null)', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				prNumber: 174,
				issueId: 174,
				completedSteps: [],
				remainingSteps: [],
				reason: 'x',
				writtenAt: '2026-07-11T02:00:00Z',
			}),
			'utf8',
		);
		expect(readPostMergeStalledMarker(filePath)).toBeNull();
	});

	test('readPostMergeStalledMarker returns null when completedSteps is not a string array', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				prNumber: 174,
				issueId: '174',
				completedSteps: [1, 2],
				remainingSteps: [],
				reason: 'x',
				writtenAt: '2026-07-11T02:00:00Z',
			}),
			'utf8',
		);
		expect(readPostMergeStalledMarker(filePath)).toBeNull();
	});

	test('readPostMergeStalledMarker returns null when remainingSteps is not an array', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				prNumber: 174,
				issueId: '174',
				completedSteps: [],
				remainingSteps: 'not-an-array',
				reason: 'x',
				writtenAt: '2026-07-11T02:00:00Z',
			}),
			'utf8',
		);
		expect(readPostMergeStalledMarker(filePath)).toBeNull();
	});

	test('readPostMergeStalledMarker returns null when reason is mistyped', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				prNumber: 174,
				issueId: '174',
				completedSteps: [],
				remainingSteps: [],
				reason: 42,
				writtenAt: '2026-07-11T02:00:00Z',
			}),
			'utf8',
		);
		expect(readPostMergeStalledMarker(filePath)).toBeNull();
	});

	test('readPostMergeStalledMarker returns null when writtenAt is mistyped', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				prNumber: 174,
				issueId: '174',
				completedSteps: [],
				remainingSteps: [],
				reason: 'x',
				writtenAt: 12345,
			}),
			'utf8',
		);
		expect(readPostMergeStalledMarker(filePath)).toBeNull();
	});
});
