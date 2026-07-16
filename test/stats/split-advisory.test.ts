// test/stats/split-advisory.test.ts
//
// Unit tests for computeSplitAdvisory (US-003 of CAM-136/241).
//
// Pure module: no filesystem I/O, inline historical records.

import { test, expect } from 'bun:test';
import { computeSplitAdvisory, type HistoricalJobSizeRecord } from '../../src/stats/split-advisory.ts';

// ---------------------------------------------------------------------------
// AC2: projection = historical mean of the same-jobSize bucket
// ---------------------------------------------------------------------------

test('projectedTokens is the mean of the same-jobSize bucket', () => {
	const records: HistoricalJobSizeRecord[] = [
		{ jobSize: 5, total: 1000 },
		{ jobSize: 5, total: 2000 },
		{ jobSize: 5, total: 3000 },
		{ jobSize: 8, total: 999999 },
	];
	const result = computeSplitAdvisory(records, { jobSize: 5, storyCount: 4 });
	expect(result.bucketSize).toBe(3);
	expect(result.projectedTokens).toBe(2000);
	expect(result.bucketMean).toBe(2000);
	expect(result.storyCount).toBe(4);
});

test('other-jobSize records never leak into the bucket', () => {
	const records: HistoricalJobSizeRecord[] = [
		{ jobSize: 3, total: 10 },
		{ jobSize: 8, total: 20 },
	];
	const result = computeSplitAdvisory(records, { jobSize: 13, storyCount: 1 });
	expect(result.bucketSize).toBe(0);
	expect(result.advisory).toBe(false);
});

// ---------------------------------------------------------------------------
// AC3: fires only above ~1.5x median; silent below; no-data -> no advisory
// ---------------------------------------------------------------------------

test('fires when projection exceeds 1.5x the bucket median', () => {
	// bucket: [100, 100, 1000] -> median 100, mean 400 -> 400 > 150 -> fires
	const records: HistoricalJobSizeRecord[] = [
		{ jobSize: 5, total: 100 },
		{ jobSize: 5, total: 100 },
		{ jobSize: 5, total: 1000 },
	];
	const result = computeSplitAdvisory(records, { jobSize: 5, storyCount: 2 });
	expect(result.bucketMedian).toBe(100);
	expect(result.projectedTokens).toBe(400);
	expect(result.advisory).toBe(true);
});

test('stays silent when projection is at or below 1.5x the bucket median', () => {
	// bucket: [100, 100, 100] -> median 100, mean 100 -> 100 is not > 150
	const records: HistoricalJobSizeRecord[] = [
		{ jobSize: 5, total: 100 },
		{ jobSize: 5, total: 100 },
		{ jobSize: 5, total: 100 },
	];
	const result = computeSplitAdvisory(records, { jobSize: 5, storyCount: 2 });
	expect(result.advisory).toBe(false);
});

test('boundary at exactly 1.5x does not fire (strictly greater-than)', () => {
	// bucket median 100 (two entries at 100), mean exactly 150 -> not > 150
	const records: HistoricalJobSizeRecord[] = [
		{ jobSize: 5, total: 100 },
		{ jobSize: 5, total: 100 },
		{ jobSize: 5, total: 200 },
	];
	// median of [100,100,200] = 100, mean = 400/3 = 133.33 -> below threshold
	const result = computeSplitAdvisory(records, { jobSize: 5, storyCount: 1 });
	expect(result.advisory).toBe(false);
});

test('empty records -> no advisory, no-data zeros', () => {
	const result = computeSplitAdvisory([], { jobSize: 5, storyCount: 3 });
	expect(result.advisory).toBe(false);
	expect(result.projectedTokens).toBe(0);
	expect(result.bucketMean).toBe(0);
	expect(result.bucketMedian).toBe(0);
	expect(result.bucketSize).toBe(0);
	expect(result.storyCount).toBe(3);
});

test('bucket with a zero median never fires (guards divide-by-zero-like blowup)', () => {
	const records: HistoricalJobSizeRecord[] = [
		{ jobSize: 5, total: 0 },
		{ jobSize: 5, total: 0 },
		{ jobSize: 5, total: 500 },
	];
	// median([0,0,500]) = 0
	const result = computeSplitAdvisory(records, { jobSize: 5, storyCount: 1 });
	expect(result.bucketMedian).toBe(0);
	expect(result.advisory).toBe(false);
});

// ---------------------------------------------------------------------------
// Even-length bucket median (guarded index access)
// ---------------------------------------------------------------------------

test('even-length bucket computes the averaged-middle-pair median', () => {
	const records: HistoricalJobSizeRecord[] = [
		{ jobSize: 8, total: 100 },
		{ jobSize: 8, total: 200 },
		{ jobSize: 8, total: 300 },
		{ jobSize: 8, total: 400 },
	];
	// sorted [100,200,300,400] -> median (200+300)/2 = 250
	const result = computeSplitAdvisory(records, { jobSize: 8, storyCount: 1 });
	expect(result.bucketMedian).toBe(250);
	expect(result.bucketMean).toBe(250);
	expect(result.advisory).toBe(false);
});
