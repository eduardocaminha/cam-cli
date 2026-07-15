// test/validate-agents-md.test.ts
//
// Unit tests for scripts/validate-agents-md.ts (US-001, CAM-61 PRD;
// git-tracked-tree resolution added US-R2-001, CAM-61).
//
// Path-claim resolution is tested via `trackedFiles` arrays / `isIgnored`
// fakes injected directly into ValidationOptions (no real git calls, matching
// the ratchet-diff.ts DI convention) for the fast unit-test surface. The
// dedicated "regression" describe block below uses REAL git plumbing
// (git init / git add / git check-ignore) against throwaway temp repos to
// prove the tracked-tree-vs-working-tree determinism fix, since a plain
// (non-git) injected temp dir cannot distinguish the two by construction.
//
// Coverage (AC8):
//   - valid cam cmd
//   - invalid cam cmd
//   - valid bun run
//   - invalid bun run
//   - resolvable path
//   - unresolved (failing) path
//   - allowlisted-missing path
//   - :NNN and :NNN-NNN line-ref stripping
//   - glob match
//   - unused-allowlist-entry warning
// Plus: templates/** never scanned, fenced-code-block regression, heuristic
// ignore cases (URLs, placeholders, spaces), and the tracked-tree regression
// tests (US-R2-001).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
	makeGetTrackedFiles,
	makeIsIgnored,
	resolvesInTrackedTree,
	resolveScanTargets,
	SCAN_FILES,
	stripFencedCodeBlocks,
	stripLineRef,
	validateDocs,
	type IsIgnoredFn,
	type KnownMissingEntry,
} from '../scripts/validate-agents-md.ts';
import { COMMANDS as REAL_COMMANDS } from '../index.ts';

const COMMANDS = ['run', 'next', 'plan', 'issue', 'review', 'ship'] as const;
const BUN_SCRIPTS = ['typecheck', 'test', 'check:all', 'embed-vendor:check'] as const;

/** Fake IsIgnoredFn for tests that don't care about git-ignore exemption. */
const NOT_IGNORED: IsIgnoredFn = () => false;

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
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir, trackedFiles: [], isIgnored: NOT_IGNORED },
		);
		expect(result.findings).toHaveLength(0);
	});

	test('invalid cam cmd: finding with kind cam-cmd', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'Run `cam frobnicate` to continue.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir, trackedFiles: [], isIgnored: NOT_IGNORED },
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
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir, trackedFiles: [], isIgnored: NOT_IGNORED },
		);
		expect(result.findings).toHaveLength(0);
	});

	test('invalid bun run: finding with kind bun-run', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'Run `bun run nonexistent-script` first.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir, trackedFiles: [], isIgnored: NOT_IGNORED },
		);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]!.kind).toBe('bun-run');
		expect(result.findings[0]!.reason).toContain('nonexistent-script');
	});
});

// ---------------------------------------------------------------------------
// validateDocs: path-claim class — resolution against the git-tracked tree
// ---------------------------------------------------------------------------

describe('validateDocs — path claims', () => {
	test('tracked path: no finding', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `real-file.ts` for details.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir, trackedFiles: ['real-file.ts'], isIgnored: NOT_IGNORED },
		);
		expect(result.findings).toHaveLength(0);
	});

	test('untracked, unignored path: finding with kind path', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `does/not/exist.ts` for details.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir, trackedFiles: [], isIgnored: NOT_IGNORED },
		);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]!.kind).toBe('path');
		expect(result.findings[0]!.reason).toContain('does/not/exist.ts');
	});

	test('git-ignored path: no finding, exempted even though untracked', () => {
		const isIgnored: IsIgnoredFn = (path) => path === 'scripts/cam/worker-report.json';
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `scripts/cam/worker-report.json` for details.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir, trackedFiles: [], isIgnored },
		);
		expect(result.findings).toHaveLength(0);
	});

	test('allowlisted-missing path: no finding, and the entry is marked used', () => {
		const knownMissing: KnownMissingEntry[] = [
			{ pattern: 'scripts/cam/prd.json', reason: 'generated by /cam-plan; absent until planned' },
		];
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'Read `scripts/cam/prd.json` for state.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing, cwd: workDir, trackedFiles: [], isIgnored: NOT_IGNORED },
		);
		expect(result.findings).toHaveLength(0);
		expect(result.unusedKnownMissing).toHaveLength(0);
	});

	test(':NNN line-ref is stripped before resolving', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `index.ts:2858` for the array.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir, trackedFiles: ['index.ts'], isIgnored: NOT_IGNORED },
		);
		expect(result.findings).toHaveLength(0);
	});

	test(':NNN-NNN line-ref range is stripped before resolving', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `plan-runner.ts:1313-1320` for the parser.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir, trackedFiles: ['plan-runner.ts'], isIgnored: NOT_IGNORED },
		);
		expect(result.findings).toHaveLength(0);
	});

	test('glob match: >=1 tracked-file match resolves the claim', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'Every persona lives at `.claude/agents/*.md`.' }],
			{
				commands: COMMANDS,
				bunScripts: BUN_SCRIPTS,
				knownMissing: [],
				cwd: workDir,
				trackedFiles: ['.claude/agents/subagent-foo.md'],
				isIgnored: NOT_IGNORED,
			},
		);
		expect(result.findings).toHaveLength(0);
	});

	test('glob-ish path with zero tracked-file matches still fails the gate', () => {
		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `.claude/nonexistent/*.md`.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: workDir, trackedFiles: [], isIgnored: NOT_IGNORED },
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
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing, cwd: workDir, trackedFiles: [], isIgnored: NOT_IGNORED },
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

	test('entries redundant with git-ignore auto-exemption were pruned (US-R2-001)', () => {
		const patterns = KNOWN_MISSING.map((entry) => entry.pattern);
		// These full paths are all covered by .gitignore rules directly; an
		// explicit KNOWN_MISSING entry for them would now be dead weight.
		expect(patterns).not.toContain('.claude/.cam-orch-ready');
		expect(patterns).not.toContain('scripts/cam/worker-report.json');
		expect(patterns).not.toContain('scripts/cam/review-report.json');
		expect(patterns).not.toContain('scripts/cam/review-artifact.txt');
		expect(patterns).not.toContain('.claude/.cam-*.json');
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
// resolvesInTrackedTree: literal file, directory-prefix, and glob resolution
// share one path, all against the tracked-file LIST (not the filesystem)
// ---------------------------------------------------------------------------

describe('resolvesInTrackedTree', () => {
	test('resolves a literal tracked file', () => {
		expect(resolvesInTrackedTree('a.ts', ['a.ts'])).toBe(true);
	});

	test('resolves a directory via a tracked file nested under it', () => {
		expect(resolvesInTrackedTree('vendor', ['vendor/foo.ts'])).toBe(true);
	});

	test('does not resolve a path with no matching tracked file', () => {
		expect(resolvesInTrackedTree('nope.ts', ['a.ts', 'vendor/foo.ts'])).toBe(false);
	});

	test('resolves a dotfile directory (e.g. .claude/agents) via a nested tracked file', () => {
		expect(resolvesInTrackedTree('.claude/agents', ['.claude/agents/subagent-foo.md'])).toBe(true);
	});

	test('resolves a trailing-slash directory claim (e.g. claude-code-harness/)', () => {
		expect(resolvesInTrackedTree('claude-code-harness/', ['claude-code-harness/README.md'])).toBe(true);
	});

	test('resolves a glob-ish claim against the tracked list', () => {
		expect(resolvesInTrackedTree('.claude/agents/*.md', ['.claude/agents/subagent-foo.md'])).toBe(true);
	});

	test('an empty tracked-file list resolves nothing', () => {
		expect(resolvesInTrackedTree('a.ts', [])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Regression: git-tracked-tree resolution vs. the live working tree
// (US-R2-001, CAM-61). Uses REAL git plumbing against throwaway temp repos --
// a plain injected temp dir (no git) cannot exercise this distinction, which
// is exactly why the pre-fix code's temp-dir unit tests stayed green despite
// the CI-vs-local nondeterminism the reviewer caught.
// ---------------------------------------------------------------------------

describe('regression: resolution follows the git-tracked tree, not the live working tree', () => {
	let repo: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), 'cam-cli-tracked-snapshot-'));
		spawnSync('git', ['init', '-q'], { cwd: repo });
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test('a git-ignored path-claim resolves even when absent from a clean tracked snapshot', () => {
		// Simulates `git archive HEAD | tar -x`: the ephemeral file is never
		// materialized, only the .gitignore rule that would exempt it.
		writeFileSync(join(repo, '.gitignore'), 'ignored-artifact.json\n');
		writeFileSync(join(repo, 'CLAUDE.md'), 'See `ignored-artifact.json` for state.\n');
		spawnSync('git', ['add', '.gitignore', 'CLAUDE.md'], { cwd: repo });

		const trackedFiles = makeGetTrackedFiles(repo)();
		const isIgnored = makeIsIgnored(repo);

		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `ignored-artifact.json` for state.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: repo, trackedFiles, isIgnored },
		);

		expect(result.findings).toHaveLength(0);
	});

	test('an untracked, unignored stray file on disk does NOT resolve the claim (the determinism defect)', () => {
		writeFileSync(join(repo, 'CLAUDE.md'), 'See `stray.ts` for details.\n');
		spawnSync('git', ['add', 'CLAUDE.md'], { cwd: repo });
		// stray.ts sits on disk but was never `git add`ed. Under the old
		// filesystem-glob resolution this would incorrectly resolve; under
		// git-tracked-tree resolution it must not.
		writeFileSync(join(repo, 'stray.ts'), 'export {};\n');

		const trackedFiles = makeGetTrackedFiles(repo)();
		const isIgnored = makeIsIgnored(repo);

		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `stray.ts` for details.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: repo, trackedFiles, isIgnored },
		);

		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]!.kind).toBe('path');
	});

	test('a tracked (git add-ed) file resolves via makeGetTrackedFiles even before commit', () => {
		writeFileSync(join(repo, 'CLAUDE.md'), 'See `tracked.ts` for details.\n');
		writeFileSync(join(repo, 'tracked.ts'), 'export {};\n');
		spawnSync('git', ['add', 'CLAUDE.md', 'tracked.ts'], { cwd: repo });

		const trackedFiles = makeGetTrackedFiles(repo)();
		const isIgnored = makeIsIgnored(repo);

		const result = validateDocs(
			[{ path: 'CLAUDE.md', text: 'See `tracked.ts` for details.' }],
			{ commands: COMMANDS, bunScripts: BUN_SCRIPTS, knownMissing: [], cwd: repo, trackedFiles, isIgnored },
		);

		expect(result.findings).toHaveLength(0);
	});
});

describe('makeGetTrackedFiles / makeIsIgnored throw on git spawn failure (US-001)', () => {
	let nonRepoDir: string;

	beforeEach(() => {
		// A plain temp dir with no `git init` is not a git repository, so
		// `git ls-files` / `git check-ignore` exit non-zero (128) here.
		nonRepoDir = mkdtempSync(join(tmpdir(), 'cam-cli-non-repo-'));
	});

	afterEach(() => {
		rmSync(nonRepoDir, { recursive: true, force: true });
	});

	test('makeGetTrackedFiles throws when run against a non-repo cwd', () => {
		expect(() => makeGetTrackedFiles(nonRepoDir)()).toThrow();
	});

	test('makeIsIgnored throws when run against a non-repo cwd', () => {
		const isIgnored = makeIsIgnored(nonRepoDir);
		expect(() => isIgnored('some-file.ts')).toThrow();
	});

	test('makeGetTrackedFiles on a legitimately-empty git repo returns an empty list without throwing', () => {
		const repo = mkdtempSync(join(tmpdir(), 'cam-cli-empty-repo-'));
		try {
			spawnSync('git', ['init', '-q'], { cwd: repo });
			expect(makeGetTrackedFiles(repo)()).toEqual([]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	test('makeIsIgnored on a real (initialized) repo still returns true/false for exit 0/1, not throwing', () => {
		const repo = mkdtempSync(join(tmpdir(), 'cam-cli-real-repo-'));
		try {
			spawnSync('git', ['init', '-q'], { cwd: repo });
			writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
			writeFileSync(join(repo, 'tracked.txt'), 'hi\n');
			spawnSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: repo });

			const isIgnored = makeIsIgnored(repo);
			expect(isIgnored('ignored.txt')).toBe(true);
			expect(isIgnored('tracked.txt')).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Regression: the SHIPPED tree (post-ship-finalize) resolves clean
// (US-R2-002, CAM-61). ship-finalize `git rm`s the per-branch harness state
// files (src/commands/ship-finalize.ts harnessPaths) before CI ever checks
// out the shipped/main tree; the existing "regression" block above only
// snapshots the CURRENT tree (handoff.json still tracked), so it never
// exercised the shipped-tree condition that motivated the AC1 full-path
// KNOWN_MISSING entry for scripts/cam/handoff.json.
// ---------------------------------------------------------------------------

describe('regression: the shipped tree (harnessPaths removed) resolves clean', () => {
	let shipped: string;

	beforeEach(() => {
		shipped = mkdtempSync(join(tmpdir(), 'cam-cli-shipped-tree-'));
		// maxBuffer must be raised: the default (1MB) truncates this repo's
		// multi-MB archive stdout, which silently corrupts the tar extraction.
		const archive = spawnSync('git', ['archive', 'HEAD'], {
			cwd: process.cwd(),
			maxBuffer: 1024 * 1024 * 200,
		});
		spawnSync('tar', ['-x'], { cwd: shipped, input: archive.stdout });

		// Simulate ship-finalize's `git rm -f --ignore-unmatch` of the
		// per-branch harness state files (src/commands/ship-finalize.ts
		// harnessPaths): these are absent on the shipped/main tree that CI
		// actually checks out after a PR merges.
		for (const p of ['scripts/cam/prd.json', 'scripts/cam/handoff.json', 'scripts/cam/progress.txt']) {
			rmSync(join(shipped, p), { force: true });
		}

		spawnSync('git', ['init', '-q'], { cwd: shipped });
		spawnSync('git', ['add', '-A'], { cwd: shipped });
	});

	afterEach(() => {
		rmSync(shipped, { recursive: true, force: true });
	});

	test('validateDocs against the shipped-tree snapshot finds zero path-claim findings', async () => {
		const targets = resolveScanTargets(shipped);
		const docs = await Promise.all(
			targets.map(async (path) => ({ path, text: await Bun.file(join(shipped, path)).text() })),
		);
		const pkgJson = JSON.parse(await Bun.file(join(shipped, 'package.json')).text()) as {
			scripts?: Record<string, string>;
		};

		const result = validateDocs(docs, {
			commands: REAL_COMMANDS,
			bunScripts: Object.keys(pkgJson.scripts ?? {}),
			knownMissing: KNOWN_MISSING,
			cwd: shipped,
			trackedFiles: makeGetTrackedFiles(shipped)(),
			isIgnored: makeIsIgnored(shipped),
		});

		const pathFindings = result.findings.filter((finding) => finding.kind === 'path');
		expect(pathFindings).toHaveLength(0);
	});
});
