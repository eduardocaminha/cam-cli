import { test, expect, describe } from 'bun:test';
import type { MetaLoopObserveEventDetail, WorkerEventDetail } from '../../src/supervisor/events.ts';

describe('MetaLoopObserveEventDetail', () => {
	test('wouldSelect variant is assignable to WorkerEventDetail and round-trips through JSON', () => {
		const detail: MetaLoopObserveEventDetail = {
			wouldSelect: 'CAM-42',
			rank: 1,
			wsjf: 3.75,
		};

		// Assignable to WorkerEventDetail (the wider union)
		const asDetail: WorkerEventDetail = detail;
		expect(asDetail).toBeDefined();

		// Round-trip through JSON.stringify
		const json = JSON.stringify(detail);
		const parsed = JSON.parse(json) as Record<string, unknown>;

		expect(parsed['wouldSelect']).toBe('CAM-42');
		expect(parsed['rank']).toBe(1);
		expect(parsed['wsjf']).toBe(3.75);
		expect(Object.keys(parsed).sort()).toEqual(['rank', 'wouldSelect', 'wsjf']);
	});

	test('drained variant is assignable to WorkerEventDetail and round-trips through JSON', () => {
		const detail: MetaLoopObserveEventDetail = { drained: true };

		// Assignable to WorkerEventDetail (the wider union)
		const asDetail: WorkerEventDetail = detail;
		expect(asDetail).toBeDefined();

		// Round-trip through JSON.stringify
		const json = JSON.stringify(detail);
		const parsed = JSON.parse(json) as Record<string, unknown>;

		expect(parsed['drained']).toBe(true);
		expect(Object.keys(parsed)).toEqual(['drained']);
	});
});
