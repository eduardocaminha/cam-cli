// test/validate-agents-md.test.ts
//
// Unit tests for scripts/validate-agents-md.ts (US-001, CAM-61 PRD).
//
// Filesystem-touching cases (resolvable path, glob match, allowlisted-missing,
// templates/** exclusion) use a temp directory seeded per-test so results
// never depend on the live repo's docs staying static.
//
// Coverage (AC8):
//   - valid cam cmd
//   - invalid cam cmd
//   - valid bun run
//   - invalid bun run
//   - resolvable path
//   - unresolved (failing) path
//   - allowlisted-missing path
//   - :NNN line-ref stripping
//   - :NNN-NNN line-ref stripping
//   - glob match
//   - unused-allowlist-entry warning
// Plus: templates/** never scanned, fenced-code-block regression, heuristic
// ignore cases (URLs, placeholders, spaces).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AGENTS_GLOB,
	extractBacktickSpans,
	extractBunRunScript,
	extractCamCommand,
	findKnownMissingMatch,
	isPathClaimCandidate,
	KNOWN_MISSING,
	resolvesOnDisk,
	resolveScanTargets,
	SCAN_FILES,
	stripFencedCodeBlocks,
	stripLineRef,
	validateDocs,
	type KnownMissingEntry,
} from '../scripts/validate-agents-md.ts';

const COMMANDS = ['run', 'next', 'plan', 'issue', 'review', 'ship'] as const;
const BUN_SCRIPTS = ['typecheck', 'test', 'check:all', 'embed-vendor:check'] as const;

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'cam-cli-validate-agents-md-'));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractCamCommand: cam <cmd> claims
// ---------------------------------------------------------------------------

describe('extractCamCommand', () => {
	test('extracts the command token from a `cam <cmd>` span', () => {
		expect(extractCamCommand('cam next')).toBe('next');
	});

	test('extracts only the first token, ignoring trailing args', () => {
		expect(extractCamCommand('cam journal append --cycle-close')).toBe('journal');
	});

	test('bare "cam" with no subcommand is not a claim', () => {
		expect(extractCamCommand('cam')).toBeUndefined();
	});

	test('unrelated span is not a claim', () => {
		expect(extractCamCommand('the cam binary')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// extractBunRunScript: bun run <x> claims
// ---------------------------------------------------------------------------

describe('extractBunRunScript', () => {
	test('extracts a simple script name', () => {
		expect(extractBunRunScript('bun run typecheck')).toBe('typecheck');
	});

	test('extracts a colon-namespaced script name', () => {
		expect(extractBunRunScript('bun run embed-vendor:check')).toBe('embed-vendor:check');
	});

	test('unrelated span is not a claim', () => {
		expect(extractBunRunScript('bun test')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// validateDocs: cam-cmd claim class
// ---------------------------------------------------------------------------

describe('validateDocs — cam-cmd claims', () => {
	test('valid cam cmd: no finding', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'Run `cam next` to continue.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir },
		);
		expect(result.findings).toHaveLength(0);
	});

	test('invalid cam cmd: finding with kind cam-cmd', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'Run `cam frobnicate` to continue.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir },
		);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]!.kind).toBe('cam-cmd');
		expect(result.findings[0]!.reason).toContain('frobnicate');
	});
});

// ---------------------------------------------------------------------------
// validateDocs: bun-run claim class
// ---------------------------------------------------------------------------

describe('validateDocs — bun-run claims', () => {
	test('valid bun run: no finding', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'Run `bun run typecheck` first.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir },
		);
		expect(result.findings).toHaveLength(0);
	});

	test('invalid bun run: finding with kind bun-run', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'Run `bun run nonexistent-script` first.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir },
		);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]!.kind).toBe('bun-run');
		expect(result.findings[0]!.reason).toContain('nonexistent-script');
	});
});

// ---------------------------------------------------------------------------
// validateDocs: path-claim class — resolution against the filesystem
// ---------------------------------------------------------------------------

describe('validateDocs — path claims', () => {
	test('resolvable path: no finding', () => {
		writeFileSync(join(workDir, 'real-file.ts'), 'export {};\n');
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `real-file.ts` for details.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir },
		);
		expect(result.findings).toHaveLength(0);
	});

	test('unresolved path: finding with kind path', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `does/not/exist.ts` for details.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir },
		);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]!.kind).toBe('path');
		expect(result.findings[0]!.reason).toContain('does/not/exist.ts');
	});

	test('allowlisted-missing path: no finding, and the entry is marked used', () => {
		const knownMissing: KnownMissingEntry[] = [
			{ pattern: 'scripts/cam/prd.json', reason: 'generated by /cam-plan; absent until planned' },
		];
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'Read `scripts/cam/prd.json` for state.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing, cwd: workDir },
		);
		expect(result.findings).toHaveLength(0);
		expect(result.unusedKnownMissing).toHaveLength(0);
	});

	test(':NNN line-ref is stripped before resolving', () => {
		writeFileSync(join(workDir, 'index.ts'), 'x'.repeat(3000) + '\n');
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `index.ts:2858` for the array.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir },
		);
		expect(result.findings).toHaveLength(0);
	});

	test(':NNN-NNN line-ref range is stripped before resolving', () => {
		writeFileSync(join(workDir, 'plan-runner.ts'), 'export {};\n');
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `plan-runner.ts:1313-1320` for the parser.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir },
		);
		expect(result.findings).toHaveLength(0);
	});

	test('glob match: >=1 filesystem match resolves the claim', () => {
		mkdirSync(join(workDir, '.claude/agents'), { recursive: true });
		writeFileSync(join(workDir, '.claude/agents/subagent-foo.md'), '---\n---\nbody\n');
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'Every persona lives at `.claude/agents/*.md`.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir },
		);
		expect(result.findings).toHaveLength(0);
	});

	test('glob-ish path with zero filesystem matches still fails the gate', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `.claude/nonexistent/*.md`.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir },
		);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]!.kind).toBe('path');
	});
});

// ---------------------------------------------------------------------------
// unused-allowlist-entry warning (dead KNOWN_MISSING guard)
// ---------------------------------------------------------------------------

describe('validateDocs — unused KNOWN_MISSING entries', () => {
	test('an entry that matches nothing this run is reported as unused, not a failure', () => {
		const knownMissing: KnownMissingEntry[] = [
			{ pattern: 'scripts/cam/prd.json', reason: 'generated by /cam-plan; absent until planned' },
			{ pattern: 'never/matched/anywhere.json', reason: 'dead entry for this test' },
		];
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'Read `scripts/cam/prd.json` for state.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing, cwd: workDir },
		);
		expect(result.findings).toHaveLength(0);
		expect(result.unusedKnownMissing).toHaveLength(1);
		expect(result.unusedKnownMissing[0]!.pattern).toBe('never/matched/anywhere.json');
	});

});

describe('KNOWN_MISSING (the real exported allowlist)', () => {
	test('every entry has a non-empty reason', () => {
		for (const entry of KNOWN_MISSING) {
			expect(entry.reason.length).toBeGreaterThan(0);
		}
	});

	test('every entry has a non-empty pattern', () => {
		for (const entry of KNOWN_MISSING) {
			expect(entry.pattern.length).toBeGreaterThan(0);
		}
	});
});

// ---------------------------------------------------------------------------
// findKnownMissingMatch is glob-capable
// ---------------------------------------------------------------------------

describe('findKnownMissingMatch', () => {
	test('matches a glob pattern against a concrete path', () => {
		const entries: KnownMissingEntry[] = [
			{ pattern: '.claude/.cam-*.json', reason: 'runtime marker' },
		];
		expect(findKnownMissingMatch('.claude/.cam-orch-handoff.json', entries)).toBeDefined();
	});

	test('returns undefined when no entry matches', () => {
		const entries: KnownMissingEntry[] = [{ pattern: 'a/b.json', reason: 'x' }];
		expect(findKnownMissingMatch('c/d.json', entries)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// isPathClaimCandidate / stripLineRef: heuristic edge cases
// ---------------------------------------------------------------------------

describe('isPathClaimCandidate', () => {
	test('a slash-containing span is a candidate', () => {
		expect(isPathClaimCandidate('src/foo.ts')).toBe(true);
	});

	test('a bare filename ending in a recognized extension is a candidate', () => {
		expect(isPathClaimCandidate('package.json')).toBe(true);
	});

	test('a span with a space is ignored', () => {
		expect(isPathClaimCandidate('git rev-parse --verify')).toBe(false);
	});

	test('a span with $ is ignored', () => {
		expect(isPathClaimCandidate('$HOME/foo.ts')).toBe(false);
	});

	test('a template placeholder with angle brackets is ignored', () => {
		expect(isPathClaimCandidate('src/commands/<cmd>.ts')).toBe(false);
	});

	test('a regex anchor span is ignored', () => {
		expect(isPathClaimCandidate('^cam/issue-<N>$')).toBe(false);
	});

	test('an http(s) URL is ignored, not treated as a path', () => {
		expect(isPathClaimCandidate('https://api.linear.app/graphql')).toBe(false);
	});

	test('a plain word with no slash and no recognized extension is ignored', () => {
		expect(isPathClaimCandidate('severity')).toBe(false);
	});
});

describe('stripLineRef', () => {
	test('strips a single-line ref', () => {
		expect(stripLineRef('index.ts:2858')).toBe('index.ts');
	});

	test('strips a range ref', () => {
		expect(stripLineRef('src/foo.ts:10-20')).toBe('src/foo.ts');
	});

	test('leaves a path with no trailing ref untouched', () => {
		expect(stripLineRef('src/foo.ts')).toBe('src/foo.ts');
	});
});

// ---------------------------------------------------------------------------
// extractBacktickSpans / stripFencedCodeBlocks: markdown parsing correctness
// ---------------------------------------------------------------------------

describe('stripFencedCodeBlocks', () => {
	test('removes a fenced code block entirely', () => {
		const text = 'before\n```ts\nconst x = `weird`;\n```\nafter';
		const stripped = stripFencedCodeBlocks(text);
		expect(stripped).not.toContain('const x');
		expect(stripped).toContain('before');
		expect(stripped).toContain('after');
	});
});

describe('extractBacktickSpans', () => {
	test('extracts simple inline spans', () => {
		expect(extractBacktickSpans('Run `cam next` then `bun test`.')).toEqual(['cam next', 'bun test']);
	});

	test('a fenced code block containing backticks does not corrupt span extraction', () => {
		const text = [
			'Use `cam next` to continue.',
			'```ts',
			'const x = `inner ${y}`;',
			'```',
			'Then run `bun test`.',
		].join('\n');
		expect(extractBacktickSpans(text)).toEqual(['cam next', 'bun test']);
	});

	test('no backticks: empty array', () => {
		expect(extractBacktickSpans('plain text, nothing to see')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// resolveScanTargets: fixed surface, templates/** never scanned
// ---------------------------------------------------------------------------

describe('resolveScanTargets', () => {
	test('includes the fixed CLAUDE.md targets', () => {
		mkdirSync(join(workDir, '.claude/agents'), { recursive: true });
		writeFileSync(join(workDir, 'CLAUDE.md'), '# root\n');
		mkdirSync(join(workDir, 'scripts/cam'), { recursive: true });
		writeFileSync(join(workDir, 'scripts/cam/CLAUDE.md'), '# cam\n');

		const targets = resolveScanTargets(workDir);
		expect(targets).toContain('CLAUDE.md');
		expect(targets).toContain('scripts/cam/CLAUDE.md');
	});

	test('includes .claude/agents/*.md files present on disk', () => {
		mkdirSync(join(workDir, '.claude/agents'), { recursive: true });
		writeFileSync(join(workDir, '.claude/agents/subagent-foo.md'), 'body\n');
		writeFileSync(join(workDir, '.claude/agents/subagent-bar.md'), 'body\n');

		const targets = resolveScanTargets(workDir);
		expect(targets).toContain('.claude/agents/subagent-foo.md');
		expect(targets).toContain('.claude/agents/subagent-bar.md');
	});

	test('templates/** is never included even when it contains matching content', () => {
		mkdirSync(join(workDir, 'templates/scripts/cam'), { recursive: true });
		writeFileSync(join(workDir, 'templates/scripts/cam/CLAUDE.md'), '# templated copy\n');
		mkdirSync(join(workDir, 'templates/.claude/agents'), { recursive: true });
		writeFileSync(join(workDir, 'templates/.claude/agents/subagent-foo.md'), 'body\n');

		const targets = resolveScanTargets(workDir);
		for (const target of targets) {
			expect(target.startsWith('templates/')).toBe(false);
		}
	});

	test('AGENTS_GLOB and SCAN_FILES do not reference templates/', () => {
		expect(AGENTS_GLOB.startsWith('templates/')).toBe(false);
		for (const file of SCAN_FILES) {
			expect(file.startsWith('templates/')).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// resolvesOnDisk: literal file, directory, and glob resolution share one path
// ---------------------------------------------------------------------------

describe('resolvesOnDisk', () => {
	test('resolves a literal file', () => {
		writeFileSync(join(workDir, 'a.ts'), 'export {};\n');
		expect(resolvesOnDisk('a.ts', workDir)).toBe(true);
	});

	test('resolves a directory', () => {
		mkdirSync(join(workDir, 'vendor'));
		expect(resolvesOnDisk('vendor', workDir)).toBe(true);
	});

	test('does not resolve a missing path', () => {
		expect(resolvesOnDisk('nope.ts', workDir)).toBe(false);
	});

	test('resolves a dotfile directory (e.g. .claude/agents)', () => {
		mkdirSync(join(workDir, '.claude/agents'), { recursive: true });
		expect(resolvesOnDisk('.claude/agents', workDir)).toBe(true);
	});
});
