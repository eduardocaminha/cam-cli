// test/supervisor/plan/plan-escalation.test.ts
//
// Tests for the durable plan-escalation marker (US-002, CAM-204).

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, test, expect } from 'bun:test';

import {
	PLAN_ESCALATED_FILENAME,
	readPlanEscalatedMarker,
	writePlanEscalatedMarker,
	removePlanEscalatedMarker,
	type PlanEscalatedMarker,
} from '../../../src/supervisor/plan-escalation.ts';

describe('plan-escalation marker: round-trip (US-002, CAM-204)', () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-plan-escalated-'));
		filePath = join(tempDir, PLAN_ESCALATED_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('PLAN_ESCALATED_FILENAME is the expected literal', () => {
		expect(PLAN_ESCALATED_FILENAME).toBe('.cam-plan-escalated.json');
	});

	test('write then read round-trips the payload intact', () => {
		const marker: PlanEscalatedMarker = {
			issueId: 'CAM-204',
			summary: 'Plan did not converge after 2 rounds.',
			findings: [
				{
					id: 'A.completeness-001',
					category: 'A.completeness',
					severity: 'critical',
					storyId: 'US-003',
					description: 'Missing teardown seam.',
					suggestion: 'Add a teardown hook.',
				},
			],
			roundsCompleted: 2,
			writtenAt: '2026-07-06T21:00:00Z',
		};

		writePlanEscalatedMarker(filePath, marker);

		expect(readPlanEscalatedMarker(filePath)).toEqual(marker);
	});

	test('round-trips with an empty findings array', () => {
		const marker: PlanEscalatedMarker = {
			issueId: 'CAM-204',
			summary: 'Non-convergent, no residual findings surfaced.',
			findings: [],
			roundsCompleted: 2,
			writtenAt: '2026-07-06T21:00:00Z',
		};

		writePlanEscalatedMarker(filePath, marker);

		expect(readPlanEscalatedMarker(filePath)).toEqual(marker);
	});

	test('readPlanEscalatedMarker returns null for an absent file', () => {
		expect(readPlanEscalatedMarker(filePath)).toBeNull();
	});

	test('readPlanEscalatedMarker returns null for malformed JSON', () => {
		writeFileSync(filePath, 'NOT VALID JSON {{{{', 'utf8');
		expect(readPlanEscalatedMarker(filePath)).toBeNull();
	});

	test('readPlanEscalatedMarker returns null for a JSON array', () => {
		writeFileSync(filePath, JSON.stringify([1, 2, 3]), 'utf8');
		expect(readPlanEscalatedMarker(filePath)).toBeNull();
	});

	test('readPlanEscalatedMarker returns null when required fields are missing', () => {
		writeFileSync(filePath, JSON.stringify({ issueId: 'CAM-204' }), 'utf8');
		expect(readPlanEscalatedMarker(filePath)).toBeNull();
	});

	test('readPlanEscalatedMarker returns null on a shape-guard failure (wrong type)', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				issueId: 'CAM-204',
				summary: 'x',
				findings: 'not-an-array',
				roundsCompleted: 2,
				writtenAt: '2026-07-06T21:00:00Z',
			}),
			'utf8',
		);
		expect(readPlanEscalatedMarker(filePath)).toBeNull();
	});

	test('writePlanEscalatedMarker overwrites a previous marker', () => {
		const first: PlanEscalatedMarker = {
			issueId: 'CAM-204',
			summary: 'first',
			findings: [],
			roundsCompleted: 1,
			writtenAt: '2026-07-06T20:00:00Z',
		};
		const second: PlanEscalatedMarker = {
			issueId: 'CAM-204',
			summary: 'second',
			findings: [],
			roundsCompleted: 2,
			writtenAt: '2026-07-06T21:00:00Z',
		};

		writePlanEscalatedMarker(filePath, first);
		writePlanEscalatedMarker(filePath, second);

		expect(readPlanEscalatedMarker(filePath)).toEqual(second);
	});

	test('removePlanEscalatedMarker deletes the file', () => {
		writePlanEscalatedMarker(filePath, {
			issueId: 'CAM-204',
			summary: 'x',
			findings: [],
			roundsCompleted: 1,
			writtenAt: '2026-07-06T21:00:00Z',
		});
		expect(existsSync(filePath)).toBe(true);

		removePlanEscalatedMarker(filePath);

		expect(existsSync(filePath)).toBe(false);
	});

	test('removePlanEscalatedMarker on an absent file is a silent no-op', () => {
		expect(existsSync(filePath)).toBe(false);
		expect(() => removePlanEscalatedMarker(filePath)).not.toThrow();
		expect(existsSync(filePath)).toBe(false);
	});
});
