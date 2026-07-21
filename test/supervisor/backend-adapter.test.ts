// test/supervisor/backend-adapter.test.ts
//
// Golden characterization tests for ClaudeAdapter.buildSpawnArgv (US-001,
// CAM-341, following CAM-339/US-003's seam inversion, ADR-0047). For each of
// the four worker actors, asserts that ClaudeAdapter.buildSpawnArgv(actor,
// opts) produces an exact, hardcoded literal argv string. These goldens are
// pinned directly, not compared against the four per-actor wrapper functions
// that now thinly delegate to this same method: since US-003 made those
// wrappers thin delegations, asserting against their output would be
// tautological (the adapter compared to itself). Pinning literal strings
// makes this a real behavior lock instead.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ClaudeAdapter, CodexAdapter, selectAdapter } from '../../src/supervisor/backend-adapter.ts';

const SAMPLE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SAMPLE_PROMPT = "Implement it's US-002; use $HOME and `backtick`.";
const SAMPLE_MODE = 'bypassPermissions';

describe('ClaudeAdapter.buildSpawnArgv golden characterization (US-001)', () => {
	test('implementer: matches pinned golden (defaults)', () => {
		const adapter = new ClaudeAdapter();
		const opts = { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
		const actual = adapter.buildSpawnArgv('implementer', opts);
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_OAUTH_TOKEN CAM_WORKER=1 claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'sonnet' --agent subagent-implementer 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	test('implementer: matches pinned golden with agentName, model, and container isolation set', () => {
		const adapter = new ClaudeAdapter();
		const opts = {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			agentName: 'custom-implementer',
			model: 'claude-sonnet-4-6',
			isolation: 'container' as const,
		};
		const actual = adapter.buildSpawnArgv('implementer', opts);
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION CAM_WORKER=1 claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'claude-sonnet-4-6' --agent custom-implementer 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	test('planner: matches pinned golden (defaults)', () => {
		const adapter = new ClaudeAdapter();
		const opts = { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
		const actual = adapter.buildSpawnArgv('planner', opts);
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_OAUTH_TOKEN claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'opus' --agent subagent-planner 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	test('planner: matches pinned golden with agentName, model, and host isolation set', () => {
		const adapter = new ClaudeAdapter();
		const opts = {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			agentName: 'custom-planner',
			model: 'claude-opus-4-8',
			isolation: 'host' as const,
		};
		const actual = adapter.buildSpawnArgv('planner', opts);
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_OAUTH_TOKEN claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'claude-opus-4-8' --agent custom-planner 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	test('auditor: matches pinned golden (defaults)', () => {
		const adapter = new ClaudeAdapter();
		const opts = { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
		const actual = adapter.buildSpawnArgv('auditor', opts);
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_OAUTH_TOKEN claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'opus' --agent subagent-auditor 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	test('auditor: matches pinned golden with agentName, model, and container isolation set', () => {
		const adapter = new ClaudeAdapter();
		const opts = {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
			agentName: 'custom-auditor',
			model: 'claude-sonnet-4-6',
			isolation: 'container' as const,
		};
		const actual = adapter.buildSpawnArgv('auditor', opts);
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'claude-sonnet-4-6' --agent custom-auditor 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	test('reviewer: matches pinned golden (all-defaults path: no taskPrompt/permissionMode)', () => {
		const adapter = new ClaudeAdapter();
		const opts = { uuid: SAMPLE_UUID };
		const actual = adapter.buildSpawnArgv('reviewer', opts);
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_OAUTH_TOKEN claude --permission-mode bypassPermissions --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'opus' --agent subagent-reviewer 'Review all changes on the current branch vs main per your AGENT.md. Run the project quality gates. End your output with the <review> verdict tag on the very last line.'";
		expect(actual).toBe(expected);
	});

	test('reviewer: matches pinned golden with explicit taskPrompt, permissionMode, agentName, model, isolation set', () => {
		const adapter = new ClaudeAdapter();
		const opts = {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: 'acceptEdits',
			agentName: 'custom-reviewer',
			model: 'claude-opus-4-8',
			isolation: 'host' as const,
		};
		const actual = adapter.buildSpawnArgv('reviewer', opts);
		const expected =
			"env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_EXECPATH -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_OAUTH_TOKEN claude --permission-mode acceptEdits --session-id a1b2c3d4-e5f6-7890-abcd-ef1234567890 --model 'claude-opus-4-8' --agent custom-reviewer 'Implement it'\\''s US-002; use $HOME and `backtick`.'";
		expect(actual).toBe(expected);
	});

	// -------------------------------------------------------------------------
	// Adapter-level guards (not builder-golden, but proves the seam contract).
	// -------------------------------------------------------------------------

	test('implementer/planner/auditor throw when taskPrompt is missing (never silently emits a bad argv)', () => {
		const adapter = new ClaudeAdapter();
		for (const actor of ['implementer', 'planner', 'auditor'] as const) {
			expect(() => adapter.buildSpawnArgv(actor, { uuid: SAMPLE_UUID, permissionMode: SAMPLE_MODE })).toThrow();
		}
	});

	test('implementer/planner/auditor throw when permissionMode is missing', () => {
		const adapter = new ClaudeAdapter();
		for (const actor of ['implementer', 'planner', 'auditor'] as const) {
			expect(() => adapter.buildSpawnArgv(actor, { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT })).toThrow();
		}
	});
});

// -----------------------------------------------------------------------------
// selectAdapter (US-002, CAM-350): the factory that maps a resolved
// readPhaseBackend(phase) value to a concrete BackendAdapter.
// -----------------------------------------------------------------------------

describe("selectAdapter(backend) factory (US-002)", () => {
	test("'claude' returns a ClaudeAdapter", () => {
		expect(selectAdapter('claude')).toBeInstanceOf(ClaudeAdapter);
	});

	test("'codex' returns a CodexAdapter", () => {
		expect(selectAdapter('codex')).toBeInstanceOf(CodexAdapter);
	});

	test('an unknown/unrecognized value defaults to ClaudeAdapter', () => {
		expect(selectAdapter('not-a-real-backend')).toBeInstanceOf(ClaudeAdapter);
		expect(selectAdapter('')).toBeInstanceOf(ClaudeAdapter);
	});

	test("back-compat: selectAdapter('claude').buildSpawnArgv is byte-identical to the pre-change ClaudeAdapter argv, for all four actors", () => {
		for (const actor of ['implementer', 'planner', 'auditor'] as const) {
			const opts = { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
			expect(selectAdapter('claude').buildSpawnArgv(actor, opts)).toBe(new ClaudeAdapter().buildSpawnArgv(actor, opts));
		}
		const reviewerOpts = { uuid: SAMPLE_UUID };
		expect(selectAdapter('claude').buildSpawnArgv('reviewer', reviewerOpts)).toBe(
			new ClaudeAdapter().buildSpawnArgv('reviewer', reviewerOpts),
		);
	});
});

// -----------------------------------------------------------------------------
// Fence-breakout hardening for renderReviewerDiffBlock (US-001, CAM-355).
// renderReviewerDiffBlock is private, so it's exercised end-to-end through
// CodexAdapter.buildSpawnArgv('reviewer', ...) against a REAL fixture git
// repo (same pattern as test/supervisor/codex-adapter.test.ts's
// makeTmpRepo/extractInstructionsFile helpers): a unit fake can't prove the
// real `git diff main...HEAD` subprocess boundary feeds a diff containing its
// own triple-backtick line into the wrapper correctly.
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

/** Extracts the path passed to `-c model_instructions_file=<path>`. */
function extractInstructionsFile(argv: string): string {
	const match = argv.match(/-c model_instructions_file=(\S+)/);
	if (!match?.[1]) throw new Error(`no model_instructions_file found in argv: ${argv}`);
	return match[1];
}

describe('renderReviewerDiffBlock fence breakout hardening (US-001, CAM-355)', () => {
	test.skipIf(!gitAvailable)('a diff containing a triple-backtick line does not terminate the wrapper fence early', () => {
		const { dir, run } = makeTmpRepo('cam-fence-breakout-');

		writeFileSync(join(dir, 'seed.txt'), 'seed content\n');
		run(['add', '-A']);
		run(['commit', '-m', 'chore: seed main']);

		run(['checkout', '-b', 'feature/markdown-file']);
		// A changed file whose own content is a fenced markdown code block: its
		// diff (as emitted by `git diff`) will contain a line of exactly three
		// backticks, which a fixed ```diff/``` wrapper would treat as an early
		// closer.
		writeFileSync(join(dir, 'notes.md'), '# Notes\n\n```\nembedded fenced block\n```\n');
		run(['add', '-A']);
		run(['commit', '-m', 'docs: add fenced markdown file']);

		const adapter = new CodexAdapter();
		const actual = adapter.buildSpawnArgv('reviewer', { uuid: SAMPLE_UUID, cwd: dir });
		const written = readFileSync(extractInstructionsFile(actual), 'utf8');

		const diffSectionIndex = written.indexOf('### Diff');
		expect(diffSectionIndex).toBeGreaterThan(-1);
		const afterHeading = written.slice(diffSectionIndex + '### Diff'.length);
		const lines = afterHeading.split('\n').filter((line) => line.length > 0);
		const openerLine = lines[0];
		expect(openerLine).toBeDefined();

		const openerMatch = openerLine?.match(/^(`+)diff$/);
		expect(openerMatch).toBeTruthy();
		const fenceRun = openerMatch?.[1];
		expect(fenceRun).toBeDefined();
		expect((fenceRun ?? '').length).toBeGreaterThan(3);

		// The last non-empty line of the file must be a closer of the SAME run
		// length (no info-string), per CommonMark.
		const closerLine = lines[lines.length - 1];
		expect(closerLine).toBe(fenceRun);

		// The embedded three-backtick lines from notes.md's own diff (each
		// prefixed with `+` since the file is newly added) must survive intact,
		// sandwiched between the wrapper opener and closer, proving they were
		// not mistaken for the wrapper's own closing fence.
		expect(written).toContain('embedded fenced block');
		const embeddedFenceLines = afterHeading.split('\n').filter((line) => line === '+```');
		expect(embeddedFenceLines.length).toBe(2);
	});
});
