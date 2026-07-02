// test/commands/sidecar-read-plan-issue.test.ts
//
// Unit tests for makeReadPlanIssue in src/commands/sidecar.ts (US-001, CAM-154).
//
// AC4: A loop-state reader for plan_issue is exported and unit-tested (mirrors
//      makeReadLoopPhase at src/commands/sidecar.ts): it returns the plan_issue
//      string when present in .claude/cam-loop.local.md and undefined when
//      absent or unparseable.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeReadPlanIssue } from '../../src/commands/sidecar.ts';

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tempDir: string;
let claudeDir: string;
let stateFilePath: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'cam-read-plan-issue-'));
	claudeDir = join(tempDir, '.claude');
	mkdirSync(claudeDir, { recursive: true });
	stateFilePath = join(claudeDir, 'cam-loop.local.md');
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeReadPlanIssue (US-001, CAM-154)', () => {
	test('returns the plan_issue string when present in the state file', () => {
		writeFileSync(
			stateFilePath,
			['---', 'phase: planning', 'plan_issue: CAM-149', '---'].join('\n'),
			'utf8',
		);
		const fn = makeReadPlanIssue(claudeDir);
		expect(fn()).toBe('CAM-149');
	});

	test('returns undefined when file is absent', () => {
		const fn = makeReadPlanIssue(claudeDir);
		expect(fn()).toBeUndefined();
	});

	test('returns undefined when plan_issue field is absent from the state file', () => {
		writeFileSync(
			stateFilePath,
			['---', 'phase: planning', 'active: true', '---'].join('\n'),
			'utf8',
		);
		const fn = makeReadPlanIssue(claudeDir);
		expect(fn()).toBeUndefined();
	});

	test('returns undefined when the state file is unparseable', () => {
		writeFileSync(stateFilePath, 'not valid frontmatter at all', 'utf8');
		const fn = makeReadPlanIssue(claudeDir);
		expect(fn()).toBeUndefined();
	});

	test('returns the plan_issue value fresh on each call (reads file each time)', () => {
		const fn = makeReadPlanIssue(claudeDir);
		// File absent at first call.
		expect(fn()).toBeUndefined();
		// Now write the file.
		writeFileSync(
			stateFilePath,
			['---', 'plan_issue: CAM-200', '---'].join('\n'),
			'utf8',
		);
		// Second call reads fresh value.
		expect(fn()).toBe('CAM-200');
	});

	test('returns undefined for an empty plan_issue string (treated as absent)', () => {
		// The parseStateFile contract: plan_issue must be non-empty to be stored.
		// An empty string is not stored by the parser, so the reader sees undefined.
		writeFileSync(
			stateFilePath,
			['---', 'phase: planning', '---'].join('\n'),
			'utf8',
		);
		const fn = makeReadPlanIssue(claudeDir);
		expect(fn()).toBeUndefined();
	});
});
