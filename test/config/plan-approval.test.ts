// test/config/plan-approval.test.ts
//
// Tests for readPlanApproval in src/config/models.ts.
// Covers the four resolution paths required by US-001 (CAM-109):
//   1. Explicit 'auto'  -> returns 'auto'
//   2. Explicit 'operator' -> returns 'operator'
//   3. Absent (no [plan] section, no key) -> default 'auto'
//   4. Typo'd value -> falls back to 'auto'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { readPlanApproval } from '../../src/config/models.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-approval-test-'));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmpToml(content: string): string {
	const path = join(tmpDir, 'project.toml');
	writeFileSync(path, content, 'utf8');
	return path;
}

// ---------------------------------------------------------------------------
// Resolution path 1: explicit 'auto'
// ---------------------------------------------------------------------------

describe('readPlanApproval - explicit auto', () => {
	test('returns "auto" when [plan] plan_approval = "auto"', () => {
		const path = writeTmpToml(`
[plan]
plan_approval = "auto"
`);
		expect(readPlanApproval(path)).toBe('auto');
	});
});

// ---------------------------------------------------------------------------
// Resolution path 2: explicit 'operator'
// ---------------------------------------------------------------------------

describe('readPlanApproval - explicit operator', () => {
	test('returns "operator" when [plan] plan_approval = "operator"', () => {
		const path = writeTmpToml(`
[plan]
plan_approval = "operator"
`);
		expect(readPlanApproval(path)).toBe('operator');
	});

	test('reads plan_approval alongside other sections', () => {
		const path = writeTmpToml(`
[models]
orchestrator = "claude-opus-4-8"

[plan]
plan_approval = "operator"
`);
		expect(readPlanApproval(path)).toBe('operator');
	});
});

// ---------------------------------------------------------------------------
// Resolution path 3: absent (default 'auto')
// ---------------------------------------------------------------------------

describe('readPlanApproval - absent (default)', () => {
	test('returns "auto" when file does not exist', () => {
		const nonExistentPath = join(tmpDir, 'nonexistent.toml');
		expect(readPlanApproval(nonExistentPath)).toBe('auto');
	});

	test('returns "auto" when [plan] section is absent', () => {
		const path = writeTmpToml(`
issue_system = "none"
backend = "claude"
`);
		expect(readPlanApproval(path)).toBe('auto');
	});

	test('returns "auto" when plan_approval key is absent from [plan]', () => {
		const path = writeTmpToml(`
[plan]
other_key = "some-value"
`);
		expect(readPlanApproval(path)).toBe('auto');
	});

	test('returns "auto" when TOML is malformed', () => {
		const path = writeTmpToml(`
[plan
plan_approval = "operator"
`);
		expect(readPlanApproval(path)).toBe('auto');
	});
});

// ---------------------------------------------------------------------------
// Resolution path 4: typo'd value (falls back to 'auto')
// ---------------------------------------------------------------------------

describe('readPlanApproval - typo fallback', () => {
	test('returns "auto" for a typo\'d string value', () => {
		const path = writeTmpToml(`
[plan]
plan_approval = "operatr"
`);
		expect(readPlanApproval(path)).toBe('auto');
	});

	test('returns "auto" for an unrecognized string', () => {
		const path = writeTmpToml(`
[plan]
plan_approval = "manual"
`);
		expect(readPlanApproval(path)).toBe('auto');
	});

	test('returns "auto" when value is a number', () => {
		const path = writeTmpToml(`
[plan]
plan_approval = 1
`);
		expect(readPlanApproval(path)).toBe('auto');
	});

	test('returns "auto" when value is a boolean', () => {
		const path = writeTmpToml(`
[plan]
plan_approval = true
`);
		expect(readPlanApproval(path)).toBe('auto');
	});

	test('returns "auto" when value is empty string', () => {
		const path = writeTmpToml(`
[plan]
plan_approval = ""
`);
		expect(readPlanApproval(path)).toBe('auto');
	});
});

// ---------------------------------------------------------------------------
// configPath seam: override uses provided path, not cwd/project.toml
// ---------------------------------------------------------------------------

describe('readPlanApproval - configPath override', () => {
	test('uses configPath arg instead of cwd default', () => {
		const path = writeTmpToml(`
[plan]
plan_approval = "operator"
`);
		expect(readPlanApproval(path)).toBe('operator');
	});
});
