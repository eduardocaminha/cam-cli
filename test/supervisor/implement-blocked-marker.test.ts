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
	type ImplementBlockedMarker,
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
		};

		writeImplementBlockedMarker(filePath, marker);

		expect(readImplementBlockedMarker(filePath)).toEqual(marker);
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
		};
		const second: ImplementBlockedMarker = {
			issueId: '195',
			story: 'US-005',
			reason: 'pane-died-pre-result',
			writtenAt: '2026-07-11T02:00:00Z',
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
