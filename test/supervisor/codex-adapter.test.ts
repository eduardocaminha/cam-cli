// test/supervisor/codex-adapter.test.ts
//
// Argv-shape tests for CodexAdapter.buildSpawnArgv (US-001, CAM-350, ADR-0047
// follow-up implementation). Unlike backend-adapter.test.ts's fully-pinned
// ClaudeAdapter goldens, these assertions can't pin the whole string literally:
// buildSpawnArgv writes a fresh /tmp instructions file on every call (a random
// suffix), so the argv contains a non-deterministic path. Instead: assert the
// fixed structural pieces by substring/regex, extract the tmpfile path, and
// verify its on-disk contents independently.

import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../../src/supervisor/backend-adapter.ts';
import { stripFrontmatter } from '../../src/templates/frontmatter.ts';

const SAMPLE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SAMPLE_PROMPT = "Implement it's US-001; use $HOME and `backtick`.";
const SAMPLE_MODE = 'bypassPermissions';

/** Extracts the path passed to `-c model_instructions_file=<path>`. */
function extractInstructionsFile(argv: string): string {
	const match = argv.match(/-c model_instructions_file=(\S+)/);
	if (!match?.[1]) throw new Error(`no model_instructions_file found in argv: ${argv}`);
	return match[1];
}

describe('CodexAdapter.buildSpawnArgv (US-001)', () => {
	for (const actor of ['implementer', 'planner', 'auditor', 'reviewer'] as const) {
		test(`${actor}: emits a codex exec command`, () => {
			const adapter = new CodexAdapter();
			const opts =
				actor === 'reviewer'
					? { uuid: SAMPLE_UUID }
					: { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
			const actual = adapter.buildSpawnArgv(actor, opts);
			expect(actual).toContain('codex exec');
		});

		test(`${actor}: uses --dangerously-bypass-approvals-and-sandbox for bypassPermissions`, () => {
			const adapter = new CodexAdapter();
			const opts =
				actor === 'reviewer'
					? { uuid: SAMPLE_UUID, permissionMode: 'bypassPermissions' }
					: { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: 'bypassPermissions' };
			const actual = adapter.buildSpawnArgv(actor, opts);
			expect(actual).toContain('--dangerously-bypass-approvals-and-sandbox');
			expect(actual).not.toContain('--ask-for-approval');
			expect(actual).not.toContain('--sandbox');
		});

		test(`${actor}: uses --sandbox workspace-write --ask-for-approval never for a non-bypass permissionMode`, () => {
			const adapter = new CodexAdapter();
			const opts =
				actor === 'reviewer'
					? { uuid: SAMPLE_UUID, permissionMode: 'acceptEdits' }
					: { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: 'acceptEdits' };
			const actual = adapter.buildSpawnArgv(actor, opts);
			expect(actual).toContain('--sandbox workspace-write');
			expect(actual).toContain('--ask-for-approval never');
			expect(actual).not.toContain('--dangerously-bypass-approvals-and-sandbox');
		});

		test(`${actor}: passes -m <model> from opts.model`, () => {
			const adapter = new CodexAdapter();
			const opts =
				actor === 'reviewer'
					? { uuid: SAMPLE_UUID, model: 'gpt-5.4-codex' }
					: {
							uuid: SAMPLE_UUID,
							taskPrompt: SAMPLE_PROMPT,
							permissionMode: SAMPLE_MODE,
							model: 'gpt-5.4-codex',
						};
			const actual = adapter.buildSpawnArgv(actor, opts);
			expect(actual).toContain("-m 'gpt-5.4-codex'");
		});

		test(`${actor}: -c model_instructions_file points at a /tmp file (never .claude/) holding the frontmatter-stripped agent body`, () => {
			const adapter = new CodexAdapter();
			const opts =
				actor === 'reviewer'
					? { uuid: SAMPLE_UUID }
					: { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
			const actual = adapter.buildSpawnArgv(actor, opts);
			const instructionsFile = extractInstructionsFile(actual);

			expect(instructionsFile.startsWith('/tmp/')).toBe(true);
			expect(instructionsFile).not.toContain('.claude/');

			const written = readFileSync(instructionsFile, 'utf8');
			const agentFileMap: Record<string, string> = {
				implementer: 'subagent-implementer',
				planner: 'subagent-planner',
				auditor: 'subagent-auditor',
				reviewer: 'subagent-reviewer',
			};
			const raw = readFileSync(`.claude/agents/${agentFileMap[actor]}.md`, 'utf8');
			const expectedBody = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

			// US-001 (CAM-354): the reviewer instructions file now carries an
			// appended diff-injection block after the agent body, so its content
			// is a PREFIX match, not byte-identical, for that actor only.
			if (actor === 'reviewer') {
				expect(written.startsWith(expectedBody)).toBe(true);
			} else {
				expect(written).toBe(expectedBody);
			}
			expect(written.startsWith('---')).toBe(false);
		});
	}

	test('shell-escapes the task prompt (single quotes, embedded quotes/backticks/$)', () => {
		const adapter = new CodexAdapter();
		const actual = adapter.buildSpawnArgv('implementer', {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(actual).toContain("'Implement it'\\''s US-001; use $HOME and `backtick`.'");
	});

	test('emits NO --session-id flag', () => {
		const adapter = new CodexAdapter();
		const actual = adapter.buildSpawnArgv('implementer', {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(actual).not.toContain('--session-id');
		expect(actual).not.toContain(SAMPLE_UUID);
	});

	test('emits NO claude-style CLAUDECODE nesting-guard env strip', () => {
		const adapter = new CodexAdapter();
		const actual = adapter.buildSpawnArgv('implementer', {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(actual).not.toContain('CLAUDECODE');
	});

	test('reviewer: all-defaults path (no taskPrompt/permissionMode) still renders a full command', () => {
		const adapter = new CodexAdapter();
		const actual = adapter.buildSpawnArgv('reviewer', { uuid: SAMPLE_UUID });
		expect(actual).toContain('codex exec');
		expect(actual).toContain('--dangerously-bypass-approvals-and-sandbox');
		expect(actual).toContain("-m 'opus'");
	});

	test('implementer/planner/auditor throw when taskPrompt is missing (never silently emits a bad argv)', () => {
		const adapter = new CodexAdapter();
		for (const actor of ['implementer', 'planner', 'auditor'] as const) {
			expect(() => adapter.buildSpawnArgv(actor, { uuid: SAMPLE_UUID, permissionMode: SAMPLE_MODE })).toThrow();
		}
	});

	test('implementer/planner/auditor throw when permissionMode is missing', () => {
		const adapter = new CodexAdapter();
		for (const actor of ['implementer', 'planner', 'auditor'] as const) {
			expect(() => adapter.buildSpawnArgv(actor, { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT })).toThrow();
		}
	});

	// -------------------------------------------------------------------------
	// Reviewer-only scoping (US-001, CAM-354, AC6): the diff block never
	// appears for implementer/planner/auditor, which read process.cwd() (this
	// repo) by default and have real diffs vs main available, yet must not
	// carry the injection.
	// -------------------------------------------------------------------------

	test('implementer/planner/auditor instructions files never carry the reviewer diff-injection block', () => {
		const adapter = new CodexAdapter();
		for (const actor of ['implementer', 'planner', 'auditor'] as const) {
			const actual = adapter.buildSpawnArgv(actor, {
				uuid: SAMPLE_UUID,
				taskPrompt: SAMPLE_PROMPT,
				permissionMode: SAMPLE_MODE,
			});
			const written = readFileSync(extractInstructionsFile(actual), 'utf8');
			expect(written).not.toContain('Injected branch diff');
		}
	});
});

// -----------------------------------------------------------------------------
// Reviewer diff injection against a REAL fixture git repo (US-001, CAM-354,
// AC1/AC2/AC3/AC4/AC5/AC8). Unit fakes can't prove the real `git diff
// main...HEAD` subprocess boundary behaves correctly; only a real tmpdir git
// repo does. Mirrors test/integration/triage-real-git.test.ts's fixture
// pattern: mkdtempSync, `git init` + `symbolic-ref HEAD refs/heads/main` (so
// the base ref is deterministically named 'main' regardless of the host's
// init.defaultBranch), seed commit, then a feature branch with a known change.
// -----------------------------------------------------------------------------

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'pipe' }).status === 0;

const dirsToCleanup: string[] = [];

afterEach(() => {
	for (const d of dirsToCleanup) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
	dirsToCleanup.length = 0;
});

function makeTmpRepo(prefix: string): { dir: string; run: (args: string[]) => { stdout: string; status: number | null } } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirsToCleanup.push(dir);

	const run = (args: string[]) => {
		const r = spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
		return { stdout: (r.stdout as string) ?? '', status: r.status };
	};

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	return { dir, run };
}

// -----------------------------------------------------------------------------
// stripFrontmatter fence-regex-independent body pin (US-001, CAM-351). Unlike
// the raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')-derived expectedBody
// check above (line ~100), which mirrors stripFrontmatter's own fence regex
// and so would pass even if that regex regressed identically in both places,
// this fixture's expected body is a hand-typed literal that never touches the
// fence regex at all: a regression in stripFrontmatter's regex changes the
// actual `stripped` value without changing this constant, so the assertion
// goes red instead of silently mirroring the bug.
// -----------------------------------------------------------------------------

describe('stripFrontmatter fixture pin (US-001, CAM-351)', () => {
	test('strips a controlled fixture frontmatter fence, matching a hand-pinned literal body', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-frontmatter-fixture-'));
		dirsToCleanup.push(dir);

		const fixtureFrontmatter = '---\nname: fixture-agent\ndescription: CAM-351 fixture agent\ncolor: blue\n---\n';
		const fixtureBody =
			'Fixture body line one with sentinel FIXTURE_BODY_SENTINEL_CAM_351.\nFixture body line two, no fences here.\n';
		const fixturePath = join(dir, 'fixture-agent.md');
		writeFileSync(fixturePath, fixtureFrontmatter + fixtureBody);

		const raw = readFileSync(fixturePath, 'utf8');
		const stripped = stripFrontmatter(raw);

		// Hand-pinned literal, authored independently of stripFrontmatter's own
		// fence regex (not derived by any .replace(/^---.../) call).
		const expectedBody =
			'Fixture body line one with sentinel FIXTURE_BODY_SENTINEL_CAM_351.\nFixture body line two, no fences here.\n';

		expect(stripped).toBe(expectedBody);
		expect(stripped.startsWith('---')).toBe(false);
		expect(stripped.split('\n')).not.toContain('---');
	});
});

describe('CodexAdapter reviewer diff injection against a real git fixture repo (US-001)', () => {
	test.skipIf(!gitAvailable)(
		'injects the real `git diff main...HEAD` content plus changed-file names into the reviewer instructions file (AC1, AC2, AC8)',
		() => {
			const { dir, run } = makeTmpRepo('cam-codex-diff-fixture-');

			writeFileSync(join(dir, 'seed.txt'), 'seed content\n');
			run(['add', '-A']);
			run(['commit', '-m', 'chore: seed main']);

			run(['checkout', '-b', 'feature/known-change']);
			writeFileSync(join(dir, 'feature.txt'), 'KNOWN_CHANGE_MARKER_CAM_354\n');
			run(['add', '-A']);
			run(['commit', '-m', 'feat: known change']);

			const adapter = new CodexAdapter();
			const actual = adapter.buildSpawnArgv('reviewer', { uuid: SAMPLE_UUID, cwd: dir });
			const written = readFileSync(extractInstructionsFile(actual), 'utf8');

			expect(written).toContain('Injected branch diff');
			expect(written).toContain('Review ONLY the diff below');
			expect(written).toContain('feature.txt');
			expect(written).toContain('KNOWN_CHANGE_MARKER_CAM_354');
		},
	);

	test.skipIf(!gitAvailable)('a branch with no diff vs main renders a well-formed no-changes marker, never a crash (AC4)', () => {
		const { dir } = makeTmpRepo('cam-codex-diff-nochange-');

		// No commits at all yet: `main` doesn't resolve to any commit, so this
		// also exercises the same no-crash path as a missing ref (AC3/AC4).
		const adapter = new CodexAdapter();
		const actual = adapter.buildSpawnArgv('reviewer', { uuid: SAMPLE_UUID, cwd: dir });
		const written = readFileSync(extractInstructionsFile(actual), 'utf8');

		expect(written).toContain('Injected branch diff');
		expect(written).not.toBe('');
		const hasNoChangesOrError = written.includes('[no-changes:') || written.includes('[diff-unavailable:');
		expect(hasNoChangesOrError).toBe(true);
	});

	test.skipIf(!gitAvailable)(
		'HEAD identical to main (no commits since) renders the explicit no-changes marker (AC4)',
		() => {
			const { dir, run } = makeTmpRepo('cam-codex-diff-identical-');
			writeFileSync(join(dir, 'seed.txt'), 'seed content\n');
			run(['add', '-A']);
			run(['commit', '-m', 'chore: seed main']);

			const adapter = new CodexAdapter();
			const actual = adapter.buildSpawnArgv('reviewer', { uuid: SAMPLE_UUID, cwd: dir });
			const written = readFileSync(extractInstructionsFile(actual), 'utf8');

			expect(written).toContain('[no-changes: the current branch has no diff vs main]');
		},
	);

	test.skipIf(!gitAvailable)('a missing main ref degrades to a visible error marker instead of crashing (AC3)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-codex-diff-noref-'));
		dirsToCleanup.push(dir);
		const run = (args: string[]) => spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

		run(['init']);
		run(['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
		run(['config', 'user.email', 'test@example.com']);
		run(['config', 'user.name', 'Test User']);
		writeFileSync(join(dir, 'seed.txt'), 'seed content\n');
		run(['add', '-A']);
		run(['commit', '-m', 'chore: seed trunk']);

		expect(() => {
			const adapter = new CodexAdapter();
			const actual = adapter.buildSpawnArgv('reviewer', { uuid: SAMPLE_UUID, cwd: dir });
			const written = readFileSync(extractInstructionsFile(actual), 'utf8');
			expect(written).toContain('[diff-unavailable:');
		}).not.toThrow();
	});

	test.skipIf(!gitAvailable)('a diff larger than the cap is truncated with a visible marker, never a silent cut (AC5)', () => {
		const { dir, run } = makeTmpRepo('cam-codex-diff-truncate-');

		writeFileSync(join(dir, 'seed.txt'), 'seed content\n');
		run(['add', '-A']);
		run(['commit', '-m', 'chore: seed main']);

		run(['checkout', '-b', 'feature/huge-change']);
		// Comfortably over the 200_000-char cap once diffed.
		const hugeContent = `${'x'.repeat(250_000)}\n`;
		writeFileSync(join(dir, 'huge.txt'), hugeContent);
		run(['add', '-A']);
		run(['commit', '-m', 'feat: huge change']);

		const adapter = new CodexAdapter();
		const actual = adapter.buildSpawnArgv('reviewer', { uuid: SAMPLE_UUID, cwd: dir });
		const written = readFileSync(extractInstructionsFile(actual), 'utf8');

		expect(written).toContain('[diff truncated at');
		expect(written).toContain('huge.txt');
	});
});
