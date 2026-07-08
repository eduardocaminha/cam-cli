// test/supervisor/plan/plan-preflight-marker.test.ts
//
// Tests for the durable plan-preflight-failed marker (US-002, CAM-215).

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, test, expect } from 'bun:test';

import {
	PLAN_PREFLIGHT_FAILED_FILENAME,
	readPlanPreflightFailedMarker,
	writePlanPreflightFailedMarker,
	removePlanPreflightFailedMarker,
	truncatePreflightDetail,
	type PlanPreflightFailedMarker,
} from '../../../src/supervisor/plan-preflight-marker.ts';

describe('plan-preflight-failed marker: round-trip (US-002, CAM-215)', () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-plan-preflight-failed-'));
		filePath = join(tempDir, PLAN_PREFLIGHT_FAILED_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('PLAN_PREFLIGHT_FAILED_FILENAME is the expected literal', () => {
		expect(PLAN_PREFLIGHT_FAILED_FILENAME).toBe('.cam-plan-preflight-failed.json');
	});

	test('write then read round-trips the payload intact', () => {
		const marker: PlanPreflightFailedMarker = {
			step: 'clean-tree',
			detail: 'M src/foo.ts\n?? src/bar.ts',
			writtenAt: '2026-07-08T21:00:00Z',
		};

		writePlanPreflightFailedMarker(filePath, marker);

		expect(readPlanPreflightFailedMarker(filePath)).toEqual(marker);
	});

	test('readPlanPreflightFailedMarker returns null for an absent file', () => {
		expect(readPlanPreflightFailedMarker(filePath)).toBeNull();
	});

	test('readPlanPreflightFailedMarker returns null for malformed JSON', () => {
		writeFileSync(filePath, 'NOT VALID JSON {{{{', 'utf8');
		expect(readPlanPreflightFailedMarker(filePath)).toBeNull();
	});

	test('readPlanPreflightFailedMarker returns null for a JSON array', () => {
		writeFileSync(filePath, JSON.stringify([1, 2, 3]), 'utf8');
		expect(readPlanPreflightFailedMarker(filePath)).toBeNull();
	});

	test('readPlanPreflightFailedMarker returns null for a JSON null', () => {
		writeFileSync(filePath, 'null', 'utf8');
		expect(readPlanPreflightFailedMarker(filePath)).toBeNull();
	});

	test('readPlanPreflightFailedMarker returns null when required fields are missing', () => {
		writeFileSync(filePath, JSON.stringify({ step: 'typecheck' }), 'utf8');
		expect(readPlanPreflightFailedMarker(filePath)).toBeNull();
	});

	test('readPlanPreflightFailedMarker returns null on a shape-guard failure (wrong type)', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				step: 'typecheck',
				detail: 123,
				writtenAt: '2026-07-08T21:00:00Z',
			}),
			'utf8',
		);
		expect(readPlanPreflightFailedMarker(filePath)).toBeNull();
	});

	test('readPlanPreflightFailedMarker returns null when writtenAt is the wrong type', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				step: 'typecheck',
				detail: 'x',
				writtenAt: 12345,
			}),
			'utf8',
		);
		expect(readPlanPreflightFailedMarker(filePath)).toBeNull();
	});

	test('readPlanPreflightFailedMarker returns null when an issueId field is present but a required field is missing', () => {
		// Marker intentionally has no issueId (AC2); a stray issueId alone must
		// not make a shape-guard failure pass.
		writeFileSync(
			filePath,
			JSON.stringify({
				issueId: 'CAM-215',
				step: 'typecheck',
			}),
			'utf8',
		);
		expect(readPlanPreflightFailedMarker(filePath)).toBeNull();
	});

	test('writePlanPreflightFailedMarker overwrites a previous marker', () => {
		const first: PlanPreflightFailedMarker = {
			step: 'clean-tree',
			detail: 'first',
			writtenAt: '2026-07-08T20:00:00Z',
		};
		const second: PlanPreflightFailedMarker = {
			step: 'bun-test',
			detail: 'second',
			writtenAt: '2026-07-08T21:00:00Z',
		};

		writePlanPreflightFailedMarker(filePath, first);
		writePlanPreflightFailedMarker(filePath, second);

		expect(readPlanPreflightFailedMarker(filePath)).toEqual(second);
	});

	test('removePlanPreflightFailedMarker deletes the file', () => {
		writePlanPreflightFailedMarker(filePath, {
			step: 'typecheck',
			detail: 'x',
			writtenAt: '2026-07-08T21:00:00Z',
		});
		expect(existsSync(filePath)).toBe(true);

		removePlanPreflightFailedMarker(filePath);

		expect(existsSync(filePath)).toBe(false);
	});

	test('removePlanPreflightFailedMarker on an absent file is a silent no-op', () => {
		expect(existsSync(filePath)).toBe(false);
		expect(() => removePlanPreflightFailedMarker(filePath)).not.toThrow();
		expect(existsSync(filePath)).toBe(false);
	});
});

describe('truncatePreflightDetail (US-002, CAM-215)', () => {
	test('returns a single-line detail unchanged', () => {
		expect(truncatePreflightDetail('working tree not clean')).toBe('working tree not clean');
	});

	test('returns an empty string unchanged', () => {
		expect(truncatePreflightDetail('')).toBe('');
	});

	test('truncates a multi-line detail to the first line plus a (+N more) suffix', () => {
		const detail = 'M src/foo.ts\n?? src/bar.ts\n?? src/baz.ts';
		expect(truncatePreflightDetail(detail)).toBe('M src/foo.ts (+2 more)');
	});

	test('truncates a two-line detail to (+1 more)', () => {
		expect(truncatePreflightDetail('line one\nline two')).toBe('line one (+1 more)');
	});
});
