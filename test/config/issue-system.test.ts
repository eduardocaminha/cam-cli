// test/config/issue-system.test.ts
//
// Tests for readIssueSystem in src/config/issue-system.ts (US-002, CAM-236).
//
// Unlike the other project.toml readers (readPlanApproval, readMergeMode,
// etc.), readIssueSystem takes an already-parsed config object (mirroring the
// ship-finalize.ts call site: parseToml runs once, the result is passed in)
// and is deliberately noisy on an invalid value instead of falling back.
//
// Coverage:
//   1. Absent key -> 'local'.
//   2. Valid values ('linear', 'github', 'local') -> returned as-is.
//   3. Deprecated alias 'none' -> normalizes to 'local', does NOT throw
//      (US-001, CAM-239).
//   4. Truly-unknown values -> throws.

import { describe, expect, test } from 'bun:test';
import { readIssueSystem } from '../../src/config/issue-system.ts';

describe('readIssueSystem - absent key', () => {
	test('returns "local" when issue_system is absent', () => {
		expect(readIssueSystem({})).toBe('local');
	});

	test('returns "local" when other keys are present but issue_system is not', () => {
		expect(readIssueSystem({ issue_prefix: 'CAM', backend: 'claude' })).toBe('local');
	});
});

describe('readIssueSystem - valid values', () => {
	test('returns "local" when issue_system = "local"', () => {
		expect(readIssueSystem({ issue_system: 'local' })).toBe('local');
	});

	test('returns "github" when issue_system = "github"', () => {
		expect(readIssueSystem({ issue_system: 'github' })).toBe('github');
	});

	test('returns "linear" when issue_system = "linear"', () => {
		expect(readIssueSystem({ issue_system: 'linear' })).toBe('linear');
	});
});

describe('readIssueSystem - deprecated alias', () => {
	test('normalizes the legacy "none" value to "local" and does not throw', () => {
		expect(readIssueSystem({ issue_system: 'none' })).toBe('local');
	});
});

describe('readIssueSystem - invalid values throw', () => {
	test('throws for an unrecognized string', () => {
		expect(() => readIssueSystem({ issue_system: 'jira' })).toThrow(
			"issue_system invalido: 'jira', esperado linear|github|local",
		);
	});

	test('throws for a number value', () => {
		expect(() => readIssueSystem({ issue_system: 1 })).toThrow(/issue_system invalido/);
	});

	test('throws for a boolean value', () => {
		expect(() => readIssueSystem({ issue_system: true })).toThrow(/issue_system invalido/);
	});

	test('throws for an empty string', () => {
		expect(() => readIssueSystem({ issue_system: '' })).toThrow(/issue_system invalido/);
	});

	test('throws for null', () => {
		expect(() => readIssueSystem({ issue_system: null })).toThrow(/issue_system invalido/);
	});
});
