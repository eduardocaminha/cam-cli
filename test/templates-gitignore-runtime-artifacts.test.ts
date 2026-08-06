// test/templates-gitignore-runtime-artifacts.test.ts
//
// US-003, CAM-502: durable behavioral test that the shipped `.gitignore`
// (the EMBEDDED copy in src/vendor/_generated.ts, materialized by
// materializeTemplates -- NOT templates/.gitignore read directly off disk)
// actually makes git ignore every cam runtime artifact fixed by US-001 (3
// artifacts, uncovered in the repo's own .gitignore) and US-002 (13
// DIVERGE lines the derived parity script found on main), on both
// materialization paths of src/templates/embedded.ts:
//   1. verbatim-write path: the target project has no `.gitignore` yet.
//   2. merge path: the target project already has its own `.gitignore`
//      (mergeGitignore appends only missing non-comment lines).
//
// Modeled on test/templates-gitignore-dotenv.test.ts (CAM-499), but the
// check-ignore helper here is STRICT (GOTCHA 2 in this story's notes): any
// exit code above 1 is treated as an ERROR (thrown), never folded into
// "not ignored", so a negative control can never pass for the wrong
// reason.
//
// Negative controls in both blanket directions, so the parity fixed by
// US-002 cannot be faked by a blanket rule: `.claude/agents/subagent-planner.md`
// must stay unignored (catches a blanket `.claude/*`) and
// `scripts/cam/patterns.md` must stay unignored (catches a blanket
// `scripts/cam/*`). Both ship as real template content, so they exist on
// disk immediately after materializeTemplates runs; no need to synthesize
// them.
//
// GOTCHA 3 (CAM-499, reincident): materializeTemplates reads the EMBEDDED
// copy in src/vendor/_generated.ts, not templates/.gitignore on disk.
// Mutating the disk template and seeing this test stay green proves
// nothing except that the mutation landed in the wrong file -- always run
// `bun run embed-vendor` before re-running this test during a sweep.
//
// GOTCHA 4 (CAM-495 and CAM-499, twice reincident): a deletion mutation
// alone does not cover a substitution mutation; the blanket direction is
// exactly what the two negative controls above exist to catch.

import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createTestTmpdir } from './helpers/test-tmpdir';
import { join } from 'node:path';

import { materializeTemplates } from '../src/templates/embedded.ts';

// US-001, CAM-502: the 3 artifacts uncovered in the repo's own .gitignore
// before that story (sidecar-liveness-watcher log/pid, merge-watch state).
const US001_ARTIFACTS = [
	'.claude/cam-sidecar-liveness-watcher.log',
	'.claude/.cam-sidecar-liveness-watcher.pid',
	'.claude/.cam-merge-watch.json',
] as const;

// US-002, CAM-502: the 13 DIVERGE lines the derived parity script found
// between the repo's own .gitignore and templates/.gitignore on main.
const US002_ARTIFACTS = [
	'.claude/.cam-gate.json',
	'.claude/.cam-implement-blocked.json',
	'.claude/.cam-orch-session',
	'.claude/.cam-plan-preflight-failed.json',
	'.claude/.cam-post-merge-stalled.json',
	'.claude/.cam-ship-stalled.json',
	'.claude/.cam-sidecar-session.json',
	'.claude/.cam-supervisor.lock',
	'.claude/.cam-worker-pane',
	'.claude/cam-gate-history.jsonl',
	'.claude/cam-supervisor.log',
	'.claude/cam-worker-events.jsonl',
	'gate-results.json',
] as const;

const RUNTIME_ARTIFACTS = [...US001_ARTIFACTS, ...US002_ARTIFACTS] as const;

// Negative controls in both blanket directions: durable, tracked template
// files that must stay committable.
const NOT_IGNORED_FILES = ['.claude/agents/subagent-planner.md', 'scripts/cam/patterns.md'] as const;

/**
 * Real `git check-ignore -q <file>`; true iff git actually ignores it.
 * Per `git check-ignore` docs, exit 0 = ignored, 1 = not ignored, 128 =
 * fatal error. Anything above 1 is NEVER a verdict (GOTCHA 2): it throws,
 * so a negative control can never pass for the wrong reason.
 */
function isIgnored(cwd: string, file: string): boolean {
	const r = Bun.spawnSync(['git', '-C', cwd, 'check-ignore', '-q', file]);
	if (r.exitCode > 1) {
		throw new Error(`git check-ignore errored for ${file}: ${new TextDecoder().decode(r.stderr)}`);
	}
	return r.exitCode === 0;
}

function makeTmpRepo(): string {
	const cwd = createTestTmpdir('cam-gitignore-runtime-');
	const init = Bun.spawnSync(['git', '-C', cwd, 'init', '-q']);
	if (init.exitCode !== 0) throw new Error(`git init failed: ${new TextDecoder().decode(init.stderr)}`);
	return cwd;
}

function assertGitignoreCoversRuntimeArtifacts(cwd: string): void {
	for (const file of RUNTIME_ARTIFACTS) {
		writeFileSync(join(cwd, file), '', 'utf8');
		expect(isIgnored(cwd, file)).toBe(true);
	}
	for (const file of NOT_IGNORED_FILES) {
		expect(existsSync(join(cwd, file))).toBe(true);
		expect(isIgnored(cwd, file)).toBe(false);
	}
}

describe('templates gitignore ignores every cam runtime artifact', () => {
	test('verbatim path: no pre-existing .gitignore, the materialized template ignores every runtime artifact', () => {
		const cwd = makeTmpRepo();
		try {
			expect(existsSync(join(cwd, '.gitignore'))).toBe(false);
			materializeTemplates(cwd);
			expect(existsSync(join(cwd, '.gitignore'))).toBe(true);
			assertGitignoreCoversRuntimeArtifacts(cwd);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('merge path: pre-existing .gitignore is preserved and the merged file still ignores every runtime artifact', () => {
		const cwd = makeTmpRepo();
		try {
			writeFileSync(join(cwd, '.gitignore'), 'node_modules\n', 'utf8');
			materializeTemplates(cwd);
			assertGitignoreCoversRuntimeArtifacts(cwd);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
