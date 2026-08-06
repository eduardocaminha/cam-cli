// test/integration/issue-file-spec-channel.test.ts
//
// Integration test (REAL git + REAL `bun index.ts` subprocess): the
// filing-time spec channel on the derived/fast-track path (US-002, CAM-449).
//
// An issue filed via --derived-from (or --fast-track) is born stage:
// 'specified' (alloc.ts buildIssueEntry), so it must always carry its
// oracle forms: a supplied spec is REQUIRED and validated through the
// existing validateSpec helper (src/issues/spec.ts) before any commit.
//
// Two cases, driving the REAL CLI end to end (not just
// createLocalIssueOnMain's in-process return value), so the exit code and
// the CAM_ISSUE_RESULT machine line are measured exactly as an operator or
// orchestrator would observe them:
//
//   Happy path: filing with --derived-from and a valid spec commits an
//     issue on main whose spec.acceptanceCriteria is non-empty, and that
//     issue satisfies isPlannable (src/issues/plannable.ts, ADR-0051).
//   Refusal path: filing with --derived-from and a missing spec exits
//     non-zero, prints the literal machine line
//     `CAM_ISSUE_RESULT=ERROR reason=guardrail-failed`, and leaves the
//     tmpdir main's scripts/cam/issues listing byte-identical to its
//     pre-filing listing.
//
// Mirrors test/integration/issue-file-on-main.test.ts's tmpdir-repo harness
// (mkdtempSync + real `git init` + seeded scripts/cam/project.toml + a
// seeded parent issue on main + test.skipIf(!gitAvailable) + afterEach
// cleanup), but drives the compiled CLI as a subprocess via Bun.spawnSync
// (Bun.spawnSync's `stdin` option accepts a TypedArray -- there is no
// node-style `input` option name; see officialDocsValidated in handoff.json
// for the exact Bun API shape) instead of calling createLocalIssueOnMain
// in-process.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';

import type { IssueEntry } from '../../src/issues/types.ts';
import { isPlannable } from '../../src/issues/plannable.ts';
import { gitAvailable } from '../helpers/test-deps.ts';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, '..', '..');
const INDEX_TS = join(REPO_ROOT, 'index.ts');

// ---------------------------------------------------------------------------
// Tmp-dir lifecycle
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_TOML = 'issue_prefix = "CAM"\nissue_system = "local"\n';

function toJson(entry: IssueEntry): string {
	return JSON.stringify(entry, null, 2) + '\n';
}

interface RepoHandles {
	dir: string;
	run: (args: string[]) => ReturnType<typeof spawnSync>;
}

/**
 * Create a fresh, isolated git repo in an OS temp dir, seeded with
 * scripts/cam/project.toml and one parent issue (CAM-5, stage:specified,
 * carrying a wsjf so --derived-from's WSJF-inheritance guardrail resolves).
 */
function makeTmpRepo(): RepoHandles {
	const dir = createTestTmpdir('cam-issue-spec-channel-');
	dirsToCleanup.push(dir);

	const run = (args: string[]) =>
		spawnSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

	run(['init']);
	run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
	run(['config', 'user.email', 'test@example.com']);
	run(['config', 'user.name', 'Test User']);

	const camDir = join(dir, 'scripts', 'cam');
	const issuesDir = join(camDir, 'issues');
	mkdirSync(issuesDir, { recursive: true });
	writeFileSync(join(camDir, 'project.toml'), PROJECT_TOML);

	const parentEntry: IssueEntry = {
		id: 'CAM-5',
		title: 'Parent issue',
		stage: 'specified',
		status: 'open',
		blockedBy: [],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		wsjf: { value: 8, timeCriticality: 5, riskReduction: 3, jobSize: 4 },
	};
	writeFileSync(join(issuesDir, 'CAM-0005.json'), toJson(parentEntry));

	run(['add', '-A']);
	run(['commit', '-m', 'chore: initial harness state']);

	return { dir, run };
}

/**
 * Run the REAL `bun index.ts issue --file-local <extraArgs...>` CLI as a
 * subprocess, with cwd pinned to the tmpdir repo and stdinPayload piped in
 * as JSON. Bun.spawnSync's `stdin` option takes a TypedArray, not a string.
 */
function runFileLocal(cwd: string, extraArgs: string[], stdinPayload: unknown) {
	const encodedStdin = new TextEncoder().encode(JSON.stringify(stdinPayload));
	return Bun.spawnSync(['bun', INDEX_TS, 'issue', '--file-local', ...extraArgs], {
		cwd,
		stdin: encodedStdin,
		stdout: 'pipe',
		stderr: 'pipe',
	});
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'happy path: --derived-from with a valid spec commits an issue whose spec.acceptanceCriteria is non-empty and satisfies isPlannable',
	() => {
		const { dir, run } = makeTmpRepo();

		const result = runFileLocal(dir, ['--derived-from', 'CAM-5'], {
			title: 'Child issue derived from CAM-5',
			description: 'A fix derived from CAM-5',
			spec: {
				acceptanceCriteria: ['The child issue behaves correctly'],
				scope: 'A small, well-bounded change',
				gotchas: [],
				domainTerms: [],
			},
		});

		const stdout = result.stdout.toString();
		expect(result.exitCode).toBe(0);
		expect(stdout).toMatch(/CAM_ISSUE_RESULT=CAM-\d+/);

		const idMatch = /CAM_ISSUE_RESULT=(CAM-\d+)/.exec(stdout);
		expect(idMatch).not.toBeNull();
		const newId = idMatch?.[1] ?? '';
		const padded = newId.replace('CAM-', '').padStart(4, '0');

		const showResult = run(['show', `main:scripts/cam/issues/CAM-${padded}.json`]);
		expect(showResult.status as number).toBe(0);
		const entry = JSON.parse(showResult.stdout as string) as IssueEntry;

		// Born stage:specified (--derived-from), carrying its oracle forms.
		expect(entry.stage).toBe('specified');
		expect(entry.spec).toBeDefined();
		expect(entry.spec?.acceptanceCriteria.length ?? 0).toBeGreaterThan(0);

		// The freshly-filed issue is plannable in isolation (open, specified,
		// carries acceptance criteria, and blockedBy is empty so it cannot be
		// blocked by itself or any other entry not present in the backlog).
		expect(isPlannable(entry, [entry])).toBe(true);
	},
	{ timeout: 20_000 },
);

// ---------------------------------------------------------------------------
// Refusal path
// ---------------------------------------------------------------------------

test.skipIf(!gitAvailable)(
	'refusal path: --derived-from with a missing spec exits non-zero, prints the exact machine line, and leaves scripts/cam/issues/ unchanged',
	() => {
		const { dir, run } = makeTmpRepo();

		const before = run(['ls-tree', '-r', '--name-only', 'main', 'scripts/cam/issues/']);
		const beforeListing = before.stdout as string;

		const result = runFileLocal(dir, ['--derived-from', 'CAM-5'], {
			title: 'Child issue with no spec',
			description: 'A fix derived from CAM-5',
			// spec omitted entirely -- refusal expected
		});

		expect(result.exitCode).not.toBe(0);
		const stdout = result.stdout.toString();
		// Literal assertion (not paraphrased): the test cannot pass while
		// asserting a different machine line than the CLI actually emits.
		expect(stdout).toContain('CAM_ISSUE_RESULT=ERROR reason=guardrail-failed');

		const after = run(['ls-tree', '-r', '--name-only', 'main', 'scripts/cam/issues/']);
		const afterListing = after.stdout as string;
		expect(afterListing).toBe(beforeListing);
	},
	{ timeout: 20_000 },
);
