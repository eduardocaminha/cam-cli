// test/patterns/record.test.ts
//
// Unit tests for src/patterns/record.ts (US-001).
//
// Coverage (per AC 2/3/4):
//   - isPatternRecord: valid record accepted; malformed input (wrong types,
//     missing fields, bad enum values, non-object, non-array outcomes)
//     rejected by returning false, never throwing.
//   - parsePatternRecordsJsonl: valid lines kept, unparseable/malformed lines
//     dropped without throwing, blank lines skipped.
//   - confirmationScore: successCount + 0.5 * partialCount, failure
//     contributes 0, empty outcomes -> 0.

import { describe, expect, test } from 'bun:test';
import {
	confirmationScore,
	isPatternRecord,
	parsePatternRecordsJsonl,
	type PatternRecord,
} from '../../src/patterns/record.ts';

const validRecord: PatternRecord = {
	type: 'gotcha',
	classification: 'tactical',
	recorded_at: '2026-07-17T00:00:00.000Z',
	name: 'example-pattern',
	description: 'An example pattern used across tests.',
	evidence: 'Observed in US-001 review.',
	dir_anchors: ['src/patterns'],
	outcomes: [
		{ status: 'success', recorded_at: '2026-07-17T00:00:00.000Z' },
		{ status: 'partial', recorded_at: '2026-07-17T01:00:00.000Z' },
	],
};

// ---------------------------------------------------------------------------
// isPatternRecord
// ---------------------------------------------------------------------------

describe('isPatternRecord', () => {
	test('accepts a valid record', () => {
		expect(isPatternRecord(validRecord)).toBe(true);
	});

	test('accepts a valid record with empty outcomes', () => {
		expect(isPatternRecord({ ...validRecord, outcomes: [] })).toBe(true);
	});

	test.each(['foundational', 'tactical', 'observational'] as const)(
		'accepts classification %s',
		(classification) => {
			expect(isPatternRecord({ ...validRecord, classification })).toBe(true);
		},
	);

	test('rejects null', () => {
		expect(isPatternRecord(null)).toBe(false);
	});

	test('rejects a bare string', () => {
		expect(isPatternRecord('not a record')).toBe(false);
	});

	test('rejects an array', () => {
		expect(isPatternRecord([validRecord])).toBe(false);
	});

	test('rejects an invalid classification value', () => {
		expect(isPatternRecord({ ...validRecord, classification: 'bogus' })).toBe(false);
	});

	test('rejects a missing required field (name)', () => {
		const { name: _name, ...rest } = validRecord;
		expect(isPatternRecord(rest)).toBe(false);
	});

	test('rejects a mistyped field (dir_anchors not an array)', () => {
		expect(isPatternRecord({ ...validRecord, dir_anchors: 'src/patterns' })).toBe(false);
	});

	test('rejects a dir_anchors array with a non-string entry', () => {
		expect(isPatternRecord({ ...validRecord, dir_anchors: ['ok', 1] })).toBe(false);
	});

	test('rejects outcomes that is not an array', () => {
		expect(isPatternRecord({ ...validRecord, outcomes: {} })).toBe(false);
	});

	test('rejects a malformed outcome entry (invalid status)', () => {
		expect(
			isPatternRecord({
				...validRecord,
				outcomes: [{ status: 'bogus', recorded_at: '2026-07-17T00:00:00.000Z' }],
			}),
		).toBe(false);
	});

	test('rejects a malformed outcome entry (missing recorded_at)', () => {
		expect(isPatternRecord({ ...validRecord, outcomes: [{ status: 'success' }] })).toBe(false);
	});

	test('never throws on arbitrary garbage input', () => {
		expect(() => isPatternRecord(undefined)).not.toThrow();
		expect(() => isPatternRecord(42)).not.toThrow();
		expect(isPatternRecord(undefined)).toBe(false);
		expect(isPatternRecord(42)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// parsePatternRecordsJsonl
// ---------------------------------------------------------------------------

describe('parsePatternRecordsJsonl', () => {
	test('parses valid JSONL into records', () => {
		const raw = [JSON.stringify(validRecord), JSON.stringify({ ...validRecord, name: 'second' })].join(
			'\n',
		);
		const parsed = parsePatternRecordsJsonl(raw);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]?.name).toBe('example-pattern');
		expect(parsed[1]?.name).toBe('second');
	});

	test('skips blank lines', () => {
		const raw = `${JSON.stringify(validRecord)}\n\n\n${JSON.stringify(validRecord)}\n`;
		expect(parsePatternRecordsJsonl(raw)).toHaveLength(2);
	});

	test('drops an unparseable (non-JSON) line without throwing', () => {
		const raw = `${JSON.stringify(validRecord)}\nnot json at all {{{\n${JSON.stringify(validRecord)}`;
		expect(() => parsePatternRecordsJsonl(raw)).not.toThrow();
		expect(parsePatternRecordsJsonl(raw)).toHaveLength(2);
	});

	test('drops a well-formed-JSON-but-malformed-record line', () => {
		const raw = `${JSON.stringify(validRecord)}\n${JSON.stringify({ classification: 'bogus' })}`;
		expect(parsePatternRecordsJsonl(raw)).toHaveLength(1);
	});

	test('returns an empty array for empty input', () => {
		expect(parsePatternRecordsJsonl('')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// confirmationScore
// ---------------------------------------------------------------------------

describe('confirmationScore', () => {
	test('returns 0 for a record with no outcomes', () => {
		expect(confirmationScore({ ...validRecord, outcomes: [] })).toBe(0);
	});

	test('counts successCount + 0.5 * partialCount', () => {
		// validRecord has 1 success + 1 partial -> 1 + 0.5 = 1.5
		expect(confirmationScore(validRecord)).toBe(1.5);
	});

	test('failure entries contribute 0', () => {
		const record: PatternRecord = {
			...validRecord,
			outcomes: [
				{ status: 'failure', recorded_at: '2026-07-17T00:00:00.000Z' },
				{ status: 'failure', recorded_at: '2026-07-17T01:00:00.000Z' },
			],
		};
		expect(confirmationScore(record)).toBe(0);
	});

	test('mixes all three statuses correctly', () => {
		const record: PatternRecord = {
			...validRecord,
			outcomes: [
				{ status: 'success', recorded_at: '2026-07-17T00:00:00.000Z' },
				{ status: 'success', recorded_at: '2026-07-17T00:00:00.000Z' },
				{ status: 'partial', recorded_at: '2026-07-17T00:00:00.000Z' },
				{ status: 'failure', recorded_at: '2026-07-17T00:00:00.000Z' },
			],
		};
		// 2 success + 0.5 * 1 partial = 2.5
		expect(confirmationScore(record)).toBe(2.5);
	});
});
