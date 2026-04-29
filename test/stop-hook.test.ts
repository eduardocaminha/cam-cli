// test/stop-hook.test.ts
//
// Tests for the vendored Stop hook's SECONDARY prd.json completion check
// (the defense-in-depth fallback added in US-003 for Bug 3 + Bug 4).
//
// Each test:
//   1. Creates a temp project dir with:
//       - .claude/ralph-loop.local.md  (minimal state file, iteration 1)
//       - .claude/sessions/<id>.jsonl  (minimal valid transcript)
//       - scripts/ralph/prd.json       (from a fixture under test/fixtures/)
//   2. Calls Bun.spawnSync(['bash', hookPath], { stdin: hookInput, cwd: dir })
//   3. Asserts on exit code + stdout content.
//
// Branch coverage for the secondary check:
//   A) no prd.json  → hook falls through (block decision, exit 0 with JSON)
//   B) all passes + CLEAN verdict  → hook removes state file, exits 0 (complete)
//   C) all passes + FIXES_PENDING verdict → hook falls through (block decision)
//   D) mixed (operator-only passes:false + all non-operator pass) + CLEAN → complete
//
// The PRIMARY <promise> path is NOT exercised here — this file is laser-focused
// on the secondary check. The distinction: we deliberately omit any
// <promise>COMPLETE</promise> text from the transcript in all tests.

import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Path resolution ─────────────────────────────────────────────────────────

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const HOOK_PATH = join(REPO_ROOT, 'vendor', 'ralph-loop-stop-hook.sh');
const FIXTURES_DIR = join(REPO_ROOT, 'test', 'fixtures');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A minimal JSONL transcript line that represents one assistant text turn.
 * The <promise> tag is intentionally absent so only the secondary PRD check
 * can trigger completion in these tests.
 */
function makeMinimalTranscript(text = 'Working on the next story.'): string {
	return (
		JSON.stringify({
			role: 'assistant',
			message: { content: [{ type: 'text', text }] },
		}) + '\n'
	);
}

/**
 * Minimal ralph-loop.local.md frontmatter.
 * session_id must match the session_id we send in hook stdin so the hook
 * doesn't skip (session isolation check).
 */
function makeStateFile(sessionId: string, completionPromise = 'COMPLETE'): string {
	return [
		'---',
		'iteration: 1',
		'max_iterations: 30',
		`completion_promise: "${completionPromise}"`,
		`session_id: ${sessionId}`,
		'---',
		'/ralph-next',
	].join('\n');
}

interface SetupResult {
	dir: string;
	transcriptPath: string;
	statePath: string;
}

/**
 * Sets up a minimal project directory for one hook invocation.
 * Returns the temp dir path, transcript path, and state file path.
 *
 * @param prdFixtureName  Filename under test/fixtures/ to copy into
 *                        scripts/ralph/prd.json, or null to skip (no prd.json).
 */
function setupProjectDir(prdFixtureName: string | null): SetupResult {
	const dir = mkdtempSync(join(tmpdir(), 'ralph-hook-test-'));

	// .claude/ directory
	mkdirSync(join(dir, '.claude', 'sessions'), { recursive: true });

	// Transcript
	const transcriptPath = join(dir, '.claude', 'sessions', 'test-session.jsonl');
	writeFileSync(transcriptPath, makeMinimalTranscript());

	// State file (session id matches what we send in stdin)
	const statePath = join(dir, '.claude', 'ralph-loop.local.md');
	writeFileSync(statePath, makeStateFile('test-session-id'));

	// prd.json (optional)
	if (prdFixtureName !== null) {
		mkdirSync(join(dir, 'scripts', 'ralph'), { recursive: true });
		const fixtureContent = readFileSync(join(FIXTURES_DIR, prdFixtureName), 'utf8');
		writeFileSync(join(dir, 'scripts', 'ralph', 'prd.json'), fixtureContent);
	}

	return { dir, transcriptPath, statePath };
}

/**
 * Builds the hook stdin JSON.
 * The hook reads: { session_id, transcript_path }
 */
function makeHookStdin(sessionId: string, transcriptPath: string): string {
	return JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath });
}

/**
 * Invokes the Stop hook in the given project dir and returns the result.
 */
function invokeHook(dir: string, transcriptPath: string): { exitCode: number; stdout: string; stderr: string } {
	const stdin = makeHookStdin('test-session-id', transcriptPath);
	const result = Bun.spawnSync(['bash', HOOK_PATH], {
		cwd: dir,
		stdin: new TextEncoder().encode(stdin),
	});
	return {
		exitCode: result.exitCode ?? -1,
		stdout: result.stdout ? new TextDecoder().decode(result.stdout) : '',
		stderr: result.stderr ? new TextDecoder().decode(result.stderr) : '',
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('stop-hook secondary PRD completion check', () => {
	// Branch A: no prd.json — hook falls through to normal loop-continue behaviour.
	test('Branch A: no prd.json → hook falls through (re-injects prompt, exits 0)', () => {
		const { dir, transcriptPath, statePath } = setupProjectDir(null);
		try {
			const { exitCode, stdout } = invokeHook(dir, transcriptPath);

			// Hook exits 0 (successful hook execution), but the state file STAYS
			// (iteration counter bumped) because the loop was NOT stopped.
			expect(exitCode).toBe(0);
			// The hook outputs a JSON block with "decision":"block" to re-inject.
			const parsed = JSON.parse(stdout);
			expect(parsed.decision).toBe('block');
			// State file must still exist (loop not terminated).
			expect(existsSync(statePath)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Branch B: all stories pass, review verdict CLEAN → loop must terminate.
	test('Branch B: all passes + CLEAN verdict → state file removed, loop ends', () => {
		const { dir, transcriptPath, statePath } = setupProjectDir('prd-all-passes-clean.json');
		try {
			const { exitCode, stdout } = invokeHook(dir, transcriptPath);

			// Hook exits 0 (success) and removes the state file.
			expect(exitCode).toBe(0);
			// stdout confirms the prd.json completion path fired (not the JSON block).
			expect(stdout).toContain('prd.json completion confirmed');
			expect(stdout).toContain('CLEAN');
			// State file must be gone.
			expect(existsSync(statePath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Branch B2: MAX_ROUNDS_DEBT also counts as terminal.
	test('Branch B2: all passes + MAX_ROUNDS_DEBT verdict → loop ends', () => {
		const { dir, transcriptPath, statePath } = setupProjectDir(
			'prd-all-passes-max-rounds-debt.json',
		);
		try {
			const { exitCode, stdout } = invokeHook(dir, transcriptPath);

			expect(exitCode).toBe(0);
			expect(stdout).toContain('prd.json completion confirmed');
			expect(stdout).toContain('MAX_ROUNDS_DEBT');
			expect(existsSync(statePath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Branch B3: all passes + no review block (null) → loop ends (no review needed yet).
	test('Branch B3: all passes + no review block → loop ends', () => {
		const { dir, transcriptPath, statePath } = setupProjectDir('prd-all-passes-no-review.json');
		try {
			const { exitCode, stdout } = invokeHook(dir, transcriptPath);

			expect(exitCode).toBe(0);
			expect(stdout).toContain('prd.json completion confirmed');
			expect(existsSync(statePath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Branch C: all stories pass but verdict is FIXES_PENDING → hook falls through.
	test('Branch C: all passes + FIXES_PENDING verdict → hook falls through (keep looping)', () => {
		const { dir, transcriptPath, statePath } = setupProjectDir(
			'prd-all-passes-fixes-pending.json',
		);
		try {
			const { exitCode, stdout } = invokeHook(dir, transcriptPath);

			expect(exitCode).toBe(0);
			// Block decision means loop continues.
			const parsed = JSON.parse(stdout);
			expect(parsed.decision).toBe('block');
			// State file stays.
			expect(existsSync(statePath)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Branch D: operator-only story with passes:false exists, all non-operator
	// stories pass, verdict CLEAN → loop terminates (operator stories don't block).
	test('Branch D: operator-only incomplete + all non-operator pass + CLEAN → loop ends', () => {
		const { dir, transcriptPath, statePath } = setupProjectDir(
			'prd-operator-only-incomplete.json',
		);
		try {
			const { exitCode, stdout } = invokeHook(dir, transcriptPath);

			expect(exitCode).toBe(0);
			expect(stdout).toContain('prd.json completion confirmed');
			expect(existsSync(statePath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Negative: non-operator story still incomplete → hook falls through.
	test('Negative: non-operator story incomplete → hook falls through', () => {
		const { dir, transcriptPath, statePath } = setupProjectDir('prd-incomplete-story.json');
		try {
			const { exitCode, stdout } = invokeHook(dir, transcriptPath);

			expect(exitCode).toBe(0);
			const parsed = JSON.parse(stdout);
			expect(parsed.decision).toBe('block');
			expect(existsSync(statePath)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
