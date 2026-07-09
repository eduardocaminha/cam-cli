// test/release/ship-pr.test.ts
//
// Unit tests for runShipPrStep (src/release/ship-pr.ts), US-003 CAM-149.
//
// Coverage:
//   1.  Happy path: composes title/body, writes body to a temp file, creates
//       the PR, resolves the PR number, enables auto-merge, returns ok with
//       prNumber + mergeMode.
//   2.  gh pr create failure: ok:false with detail; no view/merge/comment/
//       merge-mode-branching calls.
//   3.  gh pr view non-numeric output: ok:false.
//   4.  gh pr merge failure: emits the auto-merge settings hint via emitHint;
//       still returns ok:true (best-effort, PR already created).
//   5.  gh pr merge success: no hint emitted.
//   6.  GITHUB_TOKEN stripped from mutation calls (create/merge/comment/issue
//       close); kept ambient on the read-only gh pr view call.
//   7.  Reviewer artifact-of-record: posted as a PR comment with the heading
//       when present; not posted when absent; a comment failure is best-effort.
//   8.  Merge-mode branching: ci-gated enriches merge-watch (exactly one
//       write, preserving a stashed issueId); immediate closes the issue per
//       backend (none/github/linear) and cleans up the watch file for none.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runShipPrStep, type RunShipPrStepOptions, type ShipPrSpawnFn } from '../../src/release/ship-pr.ts';
import type { PrdSnapshot } from '../../src/release/pr-body.ts';
import type { MergeWatchState } from '../../src/release/merge-watch.ts';
import type { CloseIssueOnMainOutcome } from '../../src/commands/issue-specify.ts';
import { AUTOMERGE_NOTICE } from '../../src/logging/notices.ts';

const PRD_SNAPSHOT: PrdSnapshot = {
	project: 'cam-cli',
	description: 'Deterministic ship runner',
	issueNumber: 149,
	userStories: [
		{ id: 'US-001', title: 'PR body composer', passes: true, requires: null },
		{ id: 'US-002', title: 'Ship runner', passes: true, requires: null },
		{ id: 'US-003', title: 'PR-create step', passes: true, requires: null },
	],
};

interface SpawnCall {
	cmd: string;
	args: string[];
	env?: Record<string, string>;
}

interface SpawnConfig {
	createStatus?: number;
	createOutput?: string;
	viewStdout?: string;
	mergeStatus?: number;
	commentStatus?: number;
	issueCloseStatus?: number;
}

interface MakeOptsConfig extends SpawnConfig {
	issueId?: string | null;
	issueBackend?: string;
	mergeMode?: 'immediate' | 'ci-gated';
	reviewArtifact?: string | null;
	existingMergeWatchState?: MergeWatchState | null;
	closeIssueOutcome?: CloseIssueOnMainOutcome;
}

function makeOpts(cfg: MakeOptsConfig = {}) {
	const calls: SpawnCall[] = [];
	const hints: string[] = [];
	const warnings: Array<{ msg: string; hint?: string }> = [];
	const tempFiles: string[] = [];
	const writeMergeWatchCalls: MergeWatchState[] = [];
	let removeMergeWatchCalls = 0;
	const closeIssueOnMainCalls: string[] = [];

	const spawnFn: ShipPrSpawnFn = (cmd, args, options) => {
		calls.push({ cmd, args, env: options.env });
		if (args[0] === 'pr' && args[1] === 'create') {
			return {
				status: cfg.createStatus ?? 0,
				stdout: cfg.createOutput ?? 'https://github.com/acme/cam-cli/pull/42\n',
				stderr: cfg.createStatus && cfg.createStatus !== 0 ? 'permission denied' : '',
			};
		}
		if (args[0] === 'pr' && args[1] === 'view') {
			return { status: 0, stdout: cfg.viewStdout ?? '42\n', stderr: '' };
		}
		if (args[0] === 'pr' && args[1] === 'merge') {
			return { status: cfg.mergeStatus ?? 0, stdout: '', stderr: cfg.mergeStatus ? 'blocked' : '' };
		}
		if (args[0] === 'pr' && args[1] === 'comment') {
			return { status: cfg.commentStatus ?? 0, stdout: '', stderr: '' };
		}
		if (args[0] === 'issue' && args[1] === 'close') {
			return { status: cfg.issueCloseStatus ?? 0, stdout: '', stderr: '' };
		}
		return { status: 0, stdout: '', stderr: '' };
	};

	const opts: RunShipPrStepOptions = {
		branchName: 'cam/pr-149-ship-runner-deterministic',
		prdSnapshot: PRD_SNAPSHOT,
		issueId: cfg.issueId === undefined ? 'CAM-149' : cfg.issueId,
		issueBackend: cfg.issueBackend ?? 'none',
		spawnFn,
		writeTempFile: (content) => {
			tempFiles.push(content);
			return `/tmp/cam-ship-pr-${tempFiles.length}.md`;
		},
		readReviewArtifact: () => (cfg.reviewArtifact === undefined ? null : cfg.reviewArtifact),
		readMergeModeFn: () => cfg.mergeMode ?? 'immediate',
		readMergeWatchStateFn: () => (cfg.existingMergeWatchState === undefined ? null : cfg.existingMergeWatchState),
		writeMergeWatchStateFn: (state) => {
			writeMergeWatchCalls.push(state);
		},
		removeMergeWatchStateFn: () => {
			removeMergeWatchCalls++;
		},
		closeIssueOnMainFn: (id) => {
			closeIssueOnMainCalls.push(id);
			return cfg.closeIssueOutcome ?? { ok: true, id, committedTo: 'main', sha: 'abc123', branchWasMain: false };
		},
		emitHint: (msg) => {
			hints.push(msg);
		},
		emitWarning: (msg, hint) => {
			warnings.push({ msg, hint });
		},
	};

	return {
		opts,
		calls,
		hints,
		warnings,
		tempFiles,
		writeMergeWatchCalls,
		removeMergeWatchCalls: () => removeMergeWatchCalls,
		closeIssueOnMainCalls,
	};
}

describe('runShipPrStep', () => {
	describe('happy path', () => {
		test('composes title/body, writes to a temp file, creates the PR, resolves the number, returns ok', () => {
			const { opts, calls, tempFiles } = makeOpts();
			const result = runShipPrStep(opts);

			expect(result).toEqual({ ok: true, prNumber: 42, mergeMode: 'immediate' });
			expect(tempFiles[0]).toContain('## Summary');
			expect(tempFiles[0]).toContain('Deterministic ship runner');

			const createCall = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
			expect(createCall?.args).toEqual([
				'pr', 'create', '--title', 'feat: Deterministic ship runner (CAM-149)', '--body-file', '/tmp/cam-ship-pr-1.md', '--base', 'main',
				'--label', 'enhancement',
			]);
		});

		test('gh pr view is called read-only after a successful create', () => {
			const { opts, calls } = makeOpts();
			runShipPrStep(opts);

			const viewCall = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'view');
			expect(viewCall?.args).toEqual(['pr', 'view', '--json', 'number', '--jq', '.number']);
		});

		test('enables auto-merge with --auto --squash', () => {
			const { opts, calls } = makeOpts();
			runShipPrStep(opts);

			const mergeCall = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
			expect(mergeCall?.args).toEqual(['pr', 'merge', '--auto', '--squash']);
		});
	});

	describe('type-derived --label on pr create (US-006)', () => {
		test.each([
			['feat', 'enhancement'],
			['fix', 'bug'],
			['docs', 'documentation'],
		])('type=%s appends --label %s exactly once', (type, expectedLabel) => {
			const { opts, calls } = makeOpts();
			opts.prdSnapshot = { ...PRD_SNAPSHOT, type };
			runShipPrStep(opts);

			const createCall = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
			const labelArgs = createCall?.args.filter((a) => a === '--label') ?? [];
			expect(labelArgs).toHaveLength(1);
			expect(createCall?.args).toContain(expectedLabel);
			expect(createCall?.args.slice(-2)).toEqual(['--label', expectedLabel]);
		});

		test('type=chore produces no --label flag', () => {
			const { opts, calls } = makeOpts();
			opts.prdSnapshot = { ...PRD_SNAPSHOT, type: 'chore' };
			runShipPrStep(opts);

			const createCall = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
			expect(createCall?.args).not.toContain('--label');
		});

		test('absent type behaves as feat (--label enhancement)', () => {
			const { opts, calls } = makeOpts();
			opts.prdSnapshot = { ...PRD_SNAPSHOT, type: undefined };
			runShipPrStep(opts);

			const createCall = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
			expect(createCall?.args.slice(-2)).toEqual(['--label', 'enhancement']);
		});
	});

	describe('gh pr create failure', () => {
		test('returns ok:false with detail; no view/merge/comment/merge-mode calls', () => {
			const { opts, calls, hints, writeMergeWatchCalls, removeMergeWatchCalls, closeIssueOnMainCalls } = makeOpts({
				createStatus: 1,
			});
			const result = runShipPrStep(opts);

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.detail).toContain('gh pr create failed');
			expect(result.detail).toContain('permission denied');
			expect(calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'view')).toBe(false);
			expect(calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge')).toBe(false);
			expect(calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'comment')).toBe(false);
			expect(hints).toHaveLength(0);
			expect(writeMergeWatchCalls).toHaveLength(0);
			expect(removeMergeWatchCalls()).toBe(0);
			expect(closeIssueOnMainCalls).toHaveLength(0);
		});
	});

	describe('gh pr view non-numeric output', () => {
		test('returns ok:false', () => {
			const { opts } = makeOpts({ viewStdout: 'not-a-number\n' });
			const result = runShipPrStep(opts);

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.detail).toContain('non-numeric');
		});
	});

	describe('gh pr merge (auto-merge) best-effort', () => {
		test('failure emits the auto-merge settings hint but still returns ok:true', () => {
			const { opts, hints } = makeOpts({ mergeStatus: 1 });
			const result = runShipPrStep(opts);

			expect(result.ok).toBe(true);
			expect(hints).toEqual([AUTOMERGE_NOTICE]);
		});

		test('success emits no hint', () => {
			const { opts, hints } = makeOpts({ mergeStatus: 0 });
			runShipPrStep(opts);

			expect(hints).toHaveLength(0);
		});
	});

	describe('GITHUB_TOKEN stripping', () => {
		const ORIGINAL_TOKEN = process.env['GITHUB_TOKEN'];

		beforeEach(() => {
			process.env['GITHUB_TOKEN'] = 'super-secret-pat';
		});

		afterEach(() => {
			if (ORIGINAL_TOKEN === undefined) {
				delete process.env['GITHUB_TOKEN'];
			} else {
				process.env['GITHUB_TOKEN'] = ORIGINAL_TOKEN;
			}
		});

		test('mutation calls (create, merge, comment, issue close) strip GITHUB_TOKEN', () => {
			const { opts, calls } = makeOpts({
				reviewArtifact: 'oracle output',
				issueBackend: 'github',
				issueId: 'CAM-149',
			});
			runShipPrStep(opts);

			const mutationCalls = calls.filter((c) =>
				(c.args[0] === 'pr' && (c.args[1] === 'create' || c.args[1] === 'merge' || c.args[1] === 'comment')) ||
				(c.args[0] === 'issue' && c.args[1] === 'close'),
			);
			expect(mutationCalls.length).toBeGreaterThan(0);
			for (const call of mutationCalls) {
				expect(call.env).toBeDefined();
				expect(call.env?.['GITHUB_TOKEN']).toBeUndefined();
				// The stripped env is a filtered copy of the ambient env, not empty.
				expect(Object.keys(call.env ?? {}).length).toBeGreaterThan(0);
			}
		});

		test('the read-only gh pr view call keeps the ambient env (no env override)', () => {
			const { opts, calls } = makeOpts();
			runShipPrStep(opts);

			const viewCall = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'view');
			expect(viewCall?.env).toBeUndefined();
		});
	});

	describe('reviewer artifact-of-record PR comment', () => {
		test('posts the artifact as a PR comment prefixed with the heading when present', () => {
			const { opts, calls, tempFiles } = makeOpts({ reviewArtifact: '<review>CLEAN</review>\noracle output' });
			runShipPrStep(opts);

			const commentCall = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'comment');
			expect(commentCall?.args[2]).toBe('42');
			const commentFileContent = tempFiles.find((t) => t.includes('artifact-of-record'));
			expect(commentFileContent).toContain('**artifact-of-record**');
			expect(commentFileContent).toContain('oracle output');
		});

		test('does not post a PR comment when the artifact file is absent', () => {
			const { opts, calls } = makeOpts({ reviewArtifact: null });
			runShipPrStep(opts);

			expect(calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'comment')).toBe(false);
		});

		test('a comment failure is best-effort: does not abort the step', () => {
			const { opts } = makeOpts({ reviewArtifact: 'oracle output', commentStatus: 1 });
			const result = runShipPrStep(opts);

			expect(result.ok).toBe(true);
		});
	});

	describe('merge-mode branching: ci-gated', () => {
		test('enriches the merge-watch state with prNumber + mergedBranch, preserving the stashed issueId', () => {
			const { opts, writeMergeWatchCalls, removeMergeWatchCalls, closeIssueOnMainCalls } = makeOpts({
				mergeMode: 'ci-gated',
				issueBackend: 'none',
				issueId: 'CAM-149',
				existingMergeWatchState: null,
			});
			const result = runShipPrStep(opts);

			expect(result).toEqual({ ok: true, prNumber: 42, mergeMode: 'ci-gated' });
			expect(writeMergeWatchCalls).toEqual([
				{ prNumber: 42, mergedBranch: 'cam/pr-149-ship-runner-deterministic', issueId: 'CAM-149' },
			]);
			// Exactly one write; never re-writes; no immediate-mode side effects.
			expect(writeMergeWatchCalls).toHaveLength(1);
			expect(removeMergeWatchCalls()).toBe(0);
			expect(closeIssueOnMainCalls).toHaveLength(0);
		});

		test('preserves an issueId already present on a full existing state (idempotent re-run)', () => {
			const { opts, writeMergeWatchCalls } = makeOpts({
				mergeMode: 'ci-gated',
				issueBackend: 'none',
				issueId: 'CAM-149',
				existingMergeWatchState: { prNumber: 0, mergedBranch: '', issueId: 'CAM-149', pollCount: 0 },
			});
			runShipPrStep(opts);

			expect(writeMergeWatchCalls).toHaveLength(1);
			expect(writeMergeWatchCalls[0]?.issueId).toBe('CAM-149');
			expect(writeMergeWatchCalls[0]?.prNumber).toBe(42);
			expect(writeMergeWatchCalls[0]?.mergedBranch).toBe('cam/pr-149-ship-runner-deterministic');
		});

		test('does not carry an issueId when the backend is github (never stashed for non-none backends)', () => {
			const { opts, writeMergeWatchCalls } = makeOpts({
				mergeMode: 'ci-gated',
				issueBackend: 'github',
				issueId: 'CAM-149',
				existingMergeWatchState: null,
			});
			runShipPrStep(opts);

			expect(writeMergeWatchCalls).toEqual([
				{ prNumber: 42, mergedBranch: 'cam/pr-149-ship-runner-deterministic' },
			]);
		});
	});

	describe('merge-mode branching: immediate, backend none', () => {
		test('closes the issue via closeIssueOnMainFn then removes the watch file', () => {
			const { opts, closeIssueOnMainCalls, removeMergeWatchCalls, writeMergeWatchCalls } = makeOpts({
				mergeMode: 'immediate',
				issueBackend: 'none',
				issueId: 'CAM-149',
			});
			const result = runShipPrStep(opts);

			expect(result).toEqual({ ok: true, prNumber: 42, mergeMode: 'immediate' });
			expect(closeIssueOnMainCalls).toEqual(['CAM-149']);
			expect(removeMergeWatchCalls()).toBe(1);
			expect(writeMergeWatchCalls).toHaveLength(0);
		});

		test('skips closeIssueOnMainFn when issueId is null, but still removes the watch file', () => {
			const { opts, closeIssueOnMainCalls, removeMergeWatchCalls } = makeOpts({
				mergeMode: 'immediate',
				issueBackend: 'none',
				issueId: null,
			});
			runShipPrStep(opts);

			expect(closeIssueOnMainCalls).toHaveLength(0);
			expect(removeMergeWatchCalls()).toBe(1);
		});

		test('a close failure emits a warning but still returns ok:true', () => {
			const { opts, warnings } = makeOpts({
				mergeMode: 'immediate',
				issueBackend: 'none',
				issueId: 'CAM-149',
				closeIssueOutcome: { ok: false, reason: 'not-found' },
			});
			const result = runShipPrStep(opts);

			expect(result.ok).toBe(true);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.msg).toContain('CAM-149');
			expect(warnings[0]?.msg).toContain('not-found');
		});
	});

	describe('merge-mode branching: immediate, backend github', () => {
		test('closes the issue via gh issue close with the numeric id extracted from issueId', () => {
			const { opts, calls } = makeOpts({
				mergeMode: 'immediate',
				issueBackend: 'github',
				issueId: 'CAM-149',
			});
			runShipPrStep(opts);

			const closeCall = calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'close');
			expect(closeCall?.args).toEqual([
				'issue', 'close', '149', '--reason', 'completed', '--comment', 'Shipped via PR #42',
			]);
		});

		test('skips gh issue close when issueId is null', () => {
			const { opts, calls } = makeOpts({
				mergeMode: 'immediate',
				issueBackend: 'github',
				issueId: null,
			});
			runShipPrStep(opts);

			expect(calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'close')).toBe(false);
		});

		test('a close failure emits a warning but still returns ok:true', () => {
			const { opts, warnings } = makeOpts({
				mergeMode: 'immediate',
				issueBackend: 'github',
				issueId: 'CAM-149',
				issueCloseStatus: 1,
			});
			const result = runShipPrStep(opts);

			expect(result.ok).toBe(true);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.msg).toContain('149');
		});
	});

	describe('merge-mode branching: immediate, backend linear', () => {
		test('emits a hint telling the operator to close the issue manually; no gh issue close call', () => {
			const { opts, calls, hints } = makeOpts({
				mergeMode: 'immediate',
				issueBackend: 'linear',
				issueId: 'ENG-42',
			});
			runShipPrStep(opts);

			expect(calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'close')).toBe(false);
			expect(hints.some((h) => h.includes('ENG-42') && h.toLowerCase().includes('manually'))).toBe(true);
		});
	});
});
