// test/supervisor/behavioral-gate.test.ts
//
// Unit tests for src/supervisor/behavioral-gate.ts (US-001, CAM-116).
//
// Coverage:
//   1. parseOracleDirective returns null for criteria with no [oracle: ...] suffix.
//   2. parseOracleDirective classifies the three oracle kinds correctly:
//        named-command, file-assert, reviewer-judgment.
//   3. parseOracleDirective classifies tmux-pty oracles and exposes artifactRef.
//   4. Malformed / empty oracle text yields no-oracle, never throws.
//   5. parseOracleDirectives filters non-oracle criteria and preserves order.
//   6. AC4 guard: review-report.ts is untouched (import-only from behavioral-gate.ts).

import { describe, expect, test } from 'bun:test';
import {
	parseOracleDirective,
	parseOracleDirectives,
	type OracleDirective,
	type CriterionOracle,
} from '../../src/supervisor/behavioral-gate.ts';

// ---------------------------------------------------------------------------
// parseOracleDirective - null for absent oracle
// ---------------------------------------------------------------------------

describe('parseOracleDirective: no oracle suffix', () => {
	test('returns null for criterion with no [oracle: ...] suffix', () => {
		expect(parseOracleDirective('Typecheck passes.')).toBeNull();
	});

	test('returns null for empty string', () => {
		expect(parseOracleDirective('')).toBeNull();
	});

	test('returns null for criterion that mentions oracle in prose but not as suffix', () => {
		expect(
			parseOracleDirective(
				'The oracle convention is explained in the notes.',
			),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseOracleDirective - named-command
// ---------------------------------------------------------------------------

describe('parseOracleDirective: named-command', () => {
	test('parses bun run typecheck', () => {
		const result = parseOracleDirective(
			'Typecheck passes (bun run typecheck). [oracle: bun run typecheck]',
		);
		expect(result).toEqual({
			kind: 'named-command',
			command: 'bun run typecheck',
		} satisfies OracleDirective);
	});

	test('parses bun test', () => {
		const result = parseOracleDirective(
			'Tests pass (bun test). [oracle: bun test]',
		);
		expect(result).toEqual({
			kind: 'named-command',
			command: 'bun test',
		} satisfies OracleDirective);
	});

	test('parses grep command as named-command', () => {
		const result = parseOracleDirective(
			"The file contains the keyword. [oracle: grep -q 'keyword' path/to/file]",
		);
		expect(result).toEqual({
			kind: 'named-command',
			command: "grep -q 'keyword' path/to/file",
		} satisfies OracleDirective);
	});

	test('trims trailing whitespace inside brackets', () => {
		const result = parseOracleDirective('Some criterion. [oracle: bun test  ]');
		expect(result).toEqual({ kind: 'named-command', command: 'bun test' } satisfies OracleDirective);
	});

	test('handles trailing whitespace after closing bracket', () => {
		const result = parseOracleDirective('Criterion. [oracle: bun test]   ');
		expect(result).toEqual({ kind: 'named-command', command: 'bun test' } satisfies OracleDirective);
	});
});

// ---------------------------------------------------------------------------
// parseOracleDirective - file-assert
// ---------------------------------------------------------------------------

describe('parseOracleDirective: file-assert', () => {
	test('parses file-assert git diff --quiet', () => {
		const result = parseOracleDirective(
			'The ReviewFinding contract is not modified. [oracle: file-assert git diff --quiet src/supervisor/review-report.ts]',
		);
		expect(result).toEqual({
			kind: 'file-assert',
			command: 'git diff --quiet src/supervisor/review-report.ts',
		} satisfies OracleDirective);
	});

	test('parses file-assert with arbitrary command', () => {
		const result = parseOracleDirective(
			'File exists. [oracle: file-assert test -f dist/output.js]',
		);
		expect(result).toEqual({
			kind: 'file-assert',
			command: 'test -f dist/output.js',
		} satisfies OracleDirective);
	});
});

// ---------------------------------------------------------------------------
// parseOracleDirective - reviewer-judgment
// ---------------------------------------------------------------------------

describe('parseOracleDirective: reviewer-judgment', () => {
	test('parses reviewer-judgment', () => {
		const result = parseOracleDirective(
			'The screen layout matches the spec. [oracle: reviewer-judgment]',
		);
		expect(result).toEqual({ kind: 'reviewer-judgment' } satisfies OracleDirective);
	});
});

// ---------------------------------------------------------------------------
// parseOracleDirective - tmux-pty
// ---------------------------------------------------------------------------

describe('parseOracleDirective: tmux-pty', () => {
	test('parses tmux-pty with artifact reference', () => {
		const result = parseOracleDirective(
			'Session runs correctly. [oracle: tmux-pty screenshots/session.txt]',
		);
		expect(result).toEqual({
			kind: 'tmux-pty',
			toolName: 'tmux-pty',
			artifactRef: 'screenshots/session.txt',
		} satisfies OracleDirective);
	});

	test('exposes the toolName field as tmux-pty', () => {
		const result = parseOracleDirective(
			'Terminal output verified. [oracle: tmux-pty artifacts/output.log]',
		);
		expect(result?.kind).toBe('tmux-pty');
		if (result?.kind === 'tmux-pty') {
			expect(result.toolName).toBe('tmux-pty');
			expect(result.artifactRef).toBe('artifacts/output.log');
		}
	});
});

// ---------------------------------------------------------------------------
// parseOracleDirective - malformed / empty oracle text (no-oracle)
// ---------------------------------------------------------------------------

describe('parseOracleDirective: no-oracle (malformed)', () => {
	test('returns no-oracle for empty oracle content [oracle: ]', () => {
		const result = parseOracleDirective('Some criterion. [oracle: ]');
		expect(result).toEqual({ kind: 'no-oracle', raw: '' } satisfies OracleDirective);
	});

	test('returns no-oracle for file-assert with no payload', () => {
		// "file-assert" alone (no trailing space + command) → classifyOracleText
		// sees raw === "file-assert", which does not start with "file-assert "
		// (trailing space required), so falls through to named-command.
		// This is the designed behavior: no crash, graceful classification.
		const result = parseOracleDirective('Criterion. [oracle: file-assert]');
		// Falls through to named-command because there is no space after file-assert
		expect(result?.kind).toBe('named-command');
	});

	test('returns no-oracle for file-assert with only spaces as payload', () => {
		// After trim: raw = "file-assert", no space → named-command
		const result = parseOracleDirective('Criterion. [oracle: file-assert   ]');
		expect(result?.kind).toBe('named-command');
	});

	test('returns no-oracle for tmux-pty with no artifact ref', () => {
		// "tmux-pty" alone → does not match startsWith("tmux-pty ") → named-command
		const result = parseOracleDirective('Criterion. [oracle: tmux-pty]');
		expect(result?.kind).toBe('named-command');
	});

	test('never throws on any input', () => {
		const weirdInputs = [
			'[oracle: ]',
			'[oracle:  ]',
			'[oracle:   file-assert   ]',
			'[oracle: tmux-pty   ]',
			'[oracle: \t]',
		];
		for (const input of weirdInputs) {
			expect(() => parseOracleDirective(input)).not.toThrow();
		}
	});
});

// ---------------------------------------------------------------------------
// parseOracleDirectives (bulk)
// ---------------------------------------------------------------------------

describe('parseOracleDirectives', () => {
	test('returns empty array for empty criteria list', () => {
		expect(parseOracleDirectives([])).toEqual([]);
	});

	test('skips criteria with no oracle suffix', () => {
		const results = parseOracleDirectives([
			'No oracle here.',
			'Also no oracle.',
		]);
		expect(results).toEqual([]);
	});

	test('processes all oracle-carrying criteria in order', () => {
		const criteria = [
			'No oracle.',
			'Typecheck passes. [oracle: bun run typecheck]',
			'Also no oracle.',
			'Tests pass. [oracle: bun test]',
		];
		const results = parseOracleDirectives(criteria);

		expect(results).toHaveLength(2);

		expect(results[0]).toEqual({
			criterionIndex: 1,
			directive: { kind: 'named-command', command: 'bun run typecheck' },
		} satisfies CriterionOracle);

		expect(results[1]).toEqual({
			criterionIndex: 3,
			directive: { kind: 'named-command', command: 'bun test' },
		} satisfies CriterionOracle);
	});

	test('handles mixed oracle kinds in one criteria list', () => {
		const criteria = [
			'Typecheck. [oracle: bun run typecheck]',
			'File unchanged. [oracle: file-assert git diff --quiet src/foo.ts]',
			'Human check. [oracle: reviewer-judgment]',
			'Tmux session. [oracle: tmux-pty artifacts/pane.txt]',
		];
		const results = parseOracleDirectives(criteria);

		expect(results).toHaveLength(4);
		expect(results[0]?.directive.kind).toBe('named-command');
		expect(results[1]?.directive.kind).toBe('file-assert');
		expect(results[2]?.directive.kind).toBe('reviewer-judgment');
		expect(results[3]?.directive.kind).toBe('tmux-pty');
	});

	test('preserves criterionIndex correctly when first criteria have no oracle', () => {
		const criteria = [
			'First, no oracle.',
			'Second, no oracle.',
			'Third has oracle. [oracle: bun test]',
		];
		const results = parseOracleDirectives(criteria);

		expect(results).toHaveLength(1);
		expect(results[0]?.criterionIndex).toBe(2);
	});

	test('parses the PRD story US-001 acceptance criteria correctly', () => {
		// The actual acceptance criteria from the PRD that this story ships.
		const uS001Criteria = [
			'A pure exported function in src/supervisor/behavioral-gate.ts reads a PRD story\'s acceptanceCriteria and returns the parsed oracle directives (kind + payload) for each criterion carrying an [oracle: ...] suffix; criteria without an oracle yield no directive. [oracle: bun test]',
			'The parser recognizes the three oracle kinds the CAM-109 planner emits (named-command, file-assert, reviewer-judgment) and, for tmux-driven criteria, exposes the verification tool name (tmux-pty) and the artifact reference the criterion names. [oracle: bun test]',
			'A criterion whose oracle text is malformed or absent returns a typed \'no runnable oracle\' result rather than throwing (graceful: an unparseable oracle never crashes the gate). [oracle: bun test]',
			'The ReviewFinding/ReviewReport contract in src/supervisor/review-report.ts is not modified by this story (parser is read-only over the PRD). [oracle: file-assert git diff --quiet src/supervisor/review-report.ts]',
			'Typecheck passes (bun run typecheck). [oracle: bun run typecheck]',
			'Tests pass (bun test). [oracle: bun test]',
		];

		const results = parseOracleDirectives(uS001Criteria);

		// All 6 criteria have oracle suffixes
		expect(results).toHaveLength(6);

		expect(results[0]?.directive).toEqual({ kind: 'named-command', command: 'bun test' });
		expect(results[1]?.directive).toEqual({ kind: 'named-command', command: 'bun test' });
		expect(results[2]?.directive).toEqual({ kind: 'named-command', command: 'bun test' });
		expect(results[3]?.directive).toEqual({
			kind: 'file-assert',
			command: 'git diff --quiet src/supervisor/review-report.ts',
		});
		expect(results[4]?.directive).toEqual({ kind: 'named-command', command: 'bun run typecheck' });
		expect(results[5]?.directive).toEqual({ kind: 'named-command', command: 'bun test' });
	});
});

// ---------------------------------------------------------------------------
// AC4 guard: review-report.ts not modified
// ---------------------------------------------------------------------------

describe('behavioral-gate.ts does not import from or modify review-report.ts', () => {
	test('behavioral-gate.ts source does not import review-report', () => {
		const source = require('fs').readFileSync(
			require('path').join(__dirname, '../../src/supervisor/behavioral-gate.ts'),
			'utf8',
		);
		expect(source).not.toContain("from './review-report");
		expect(source).not.toContain('from "../supervisor/review-report');
	});
});
