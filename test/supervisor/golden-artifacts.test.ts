// test/supervisor/golden-artifacts.test.ts
//
// Golden-fixture replay tests for the self-authored exit artifacts (US-003,
// CAM-302). Sibling of golden-sentinel.test.ts (US-001) and the
// transcript-usage replay block in usage.test.ts (US-002): committed,
// real-shaped fixtures under test/fixtures/golden/ are fed straight to the
// REAL fail-closed guards that gate these artifacts in production, so a
// drift in our own agent-emitted shapes fails this test instead of silently
// degrading a real story cycle.
//
// Artifacts covered:
//   - worker-report.json  -> parseWorkerReport (src/supervisor/report-parse.ts)
//   - review-report.json  -> parseReviewReport (src/supervisor/report-parse.ts)
//   - orch-handoff.json   -> readOrchHandoff (src/orchestrator/handoff.ts), fed
//     via a real tmpdir claudeDir (the function reads from disk, not a string)
//   - handoff.json (worker handoff) -> validated against
//     scripts/cam/handoff.schema.json (the worker-handoff contract), so a
//     schema drift (new required field, tightened type, etc.) fails this test
//     even though there is no dedicated runtime parser for this artifact.
//
// No live claude call, no tmux: fixtures are read from disk and fed to pure
// parsers / a real tmpdir fs round-trip only.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import handoffSchema from '../../scripts/cam/handoff.schema.json';
import { ORCH_HANDOFF_FILENAME, readOrchHandoff } from '../../src/orchestrator/handoff.ts';
import { parseReviewReport, parseWorkerReport } from '../../src/supervisor/report-parse.ts';

const GOLDEN_DIR = join(import.meta.dir, '..', 'fixtures', 'golden');

function readFixture(name: string): string {
	return readFileSync(join(GOLDEN_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// Minimal generic draft-07-subset JSON Schema validator (object/array/string/
// number/boolean types, required, properties, items, additionalProperties,
// enum). Reads the schema itself at test time so a change to
// handoff.schema.json (e.g. a new required field) is what actually drives
// pass/fail, rather than a hand-copied re-statement of today's shape.
// ---------------------------------------------------------------------------

interface JsonSchema {
	type?: string;
	required?: string[];
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	additionalProperties?: boolean;
	enum?: unknown[];
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case 'object':
			return typeof value === 'object' && value !== null && !Array.isArray(value);
		case 'array':
			return Array.isArray(value);
		case 'string':
			return typeof value === 'string';
		case 'number':
			return typeof value === 'number';
		case 'boolean':
			return typeof value === 'boolean';
		default:
			return true;
	}
}

function validateAgainstSchema(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
	if (schema.type && !matchesType(value, schema.type)) {
		errors.push(`${path}: expected type '${schema.type}', got ${JSON.stringify(value)}`);
		return;
	}
	if (schema.enum && !schema.enum.includes(value)) {
		errors.push(`${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
	}
	if (schema.type === 'object') {
		const obj = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in obj)) errors.push(`${path}: missing required property '${key}'`);
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(obj)) {
				if (!schema.properties || !(key in schema.properties)) {
					errors.push(`${path}: unexpected additional property '${key}'`);
				}
			}
		}
		for (const [key, subschema] of Object.entries(schema.properties ?? {})) {
			if (key in obj) validateAgainstSchema(subschema, obj[key], `${path}.${key}`, errors);
		}
	} else if (schema.type === 'array') {
		const arr = value as unknown[];
		if (schema.items) {
			arr.forEach((item, i) => validateAgainstSchema(schema.items as JsonSchema, item, `${path}[${i}]`, errors));
		}
	}
}

function freshClaudeDir(): string {
	return mkdtempSync(join(tmpdir(), 'cam-golden-orch-handoff-'));
}

// ---------------------------------------------------------------------------
// worker-report.json -> parseWorkerReport
// ---------------------------------------------------------------------------

describe('worker-report.json golden fixture (parseWorkerReport)', () => {
	test('fixture parses to its canonical WorkerReport shape', () => {
		const parsed = parseWorkerReport(readFixture('worker-report.json'));
		expect(parsed).toEqual({
			outcome: 'DONE',
			story: 'US-003',
			gates: { typecheck: 'ok', tests: '128 pass / 0 fail' },
			notes: 'none',
		});
	});
});

// ---------------------------------------------------------------------------
// review-report.json -> parseReviewReport
// ---------------------------------------------------------------------------

describe('review-report.json golden fixture (parseReviewReport)', () => {
	test('fixture parses to its canonical ReviewReport shape', () => {
		const parsed = parseReviewReport(readFixture('review-report.json'));
		expect(parsed).toEqual({
			verdict: 'CLEAN',
			findings: [
				{
					severity: 'SUGGESTION',
					text: 'Consider extracting the duplicated retry loop into a helper.',
					file: 'src/supervisor/host.ts',
					line: 118,
				},
			],
			artifactOfRecord: 'scripts/cam/review-artifact.txt',
		});
	});
});

// ---------------------------------------------------------------------------
// orch-handoff.json -> readOrchHandoff (real tmpdir claudeDir round-trip)
// ---------------------------------------------------------------------------

describe('orch-handoff.json golden fixture (readOrchHandoff)', () => {
	test('fixture written into a real tmpdir claudeDir reads back to its canonical shape', () => {
		const dir = freshClaudeDir();
		const raw = readFixture('orch-handoff.json');
		writeFileSync(join(dir, ORCH_HANDOFF_FILENAME), raw, 'utf8');

		const parsed = readOrchHandoff(dir);
		expect(parsed).toEqual(JSON.parse(raw));
		expect(parsed?.schemaVersion).toBe(1);
		expect(parsed?.reason).toBe('token-budget-exceeded');
	});
});

// ---------------------------------------------------------------------------
// handoff.json (worker handoff) -> validated against handoff.schema.json
// ---------------------------------------------------------------------------

describe('handoff.json golden fixture (handoff.schema.json contract)', () => {
	test('fixture satisfies the worker-handoff schema (a schema drift fails this test)', () => {
		const parsed: unknown = JSON.parse(readFixture('handoff.json'));
		const errors: string[] = [];
		validateAgainstSchema(handoffSchema as JsonSchema, parsed, 'root', errors);
		expect(errors).toEqual([]);
	});

	test('fixture carries the expected required + optional fields', () => {
		const parsed = JSON.parse(readFixture('handoff.json'));
		expect(parsed.lastCompletedStory).toEqual({
			id: 'US-002',
			title: 'Transcript-usage golden fixture + replay against usage parsers',
		});
		expect(parsed.branchName).toBe('cam/issue-302');
		expect(parsed.officialDocsValidated).toEqual([{ lib: 'none', status: 'no_external_lib_touched' }]);
	});
});
