// test/supervisor/loop-model-resolution.test.ts
//
// Unit tests for US-004 (CAM-398): wiring `resolvePhaseModel` into the
// implementer dispatch call site in src/supervisor/loop.ts.
//
// Coverage:
//   AC1: resolvePhaseModel invoked at the readPhaseModel call site, before
//        argv build; codexAuthPreflight's position relative to buildSpawnArgv
//        is unchanged -- covered by the grep oracle + the pre-existing
//        loop.test.ts / worker-argv-model.test.ts suites (AC5/AC6), not
//        re-asserted here.
//   AC2: codex-backed dispatch, config carries only a claude-shaped flat
//        model, injected cacheReader resolves 'gpt-5.6-sol' -> argv contains
//        'gpt-5.6-sol', never the claude alias.
//   AC3: not-ok resolution aborts before any spawn: existing abort shape
//        (blocked lastOutcome with actionable message), escalateFn fires,
//        no respawn-pane invocation recorded.
//   AC4: the cache reader reaches the dispatch site through an injectable
//        option seam mirroring codexAuthCheckFn (defaults to the production
//        reader when omitted); a claude-backed dispatch never invokes it.

import { describe, expect, test, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSupervisor } from '../../src/supervisor/loop.ts';
import type { RunSupervisorOptions } from '../../src/supervisor/loop.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import { withVerifiedPanePid } from '../helpers/verified-pane-pid-spawn.ts';
import type { WorkerReport } from '../../src/supervisor/worker-report.ts';
import type { CodexModelsCacheReader } from '../../src/config/codex-models-cache.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';

// ---------------------------------------------------------------------------
// Fake builder helpers (mirrors test/supervisor/loop.test.ts's conventions)
// ---------------------------------------------------------------------------

function makePrd(opts: {
	stories: Array<{ id: string; priority: number; passes: boolean; requires?: string }>;
	review?: PrdSnapshot['review'];
}): PrdSnapshot {
	return {
		userStories: opts.stories.map((s) => ({
			id: s.id,
			priority: s.priority,
			passes: s.passes,
			requires: s.requires ?? null,
		})),
		review: opts.review,
	};
}

function makeHandoff(storyId: string) {
	return {
		lastCompletedStory: { id: storyId, title: `Story ${storyId}` },
		branchName: 'cam/test',
		timestamp: '2026-06-08T00:00:00Z',
	};
}

function donePane(storyId: string): string {
	return `Implemented something\nCAM_IMPLEMENTER_STATUS=DONE story=${storyId}\n`;
}

const PRD_PATH = '/fake/prd.json';
const HANDOFF_PATH = '/fake/handoff.json';
const WORKER_PANE_ID = '%3';

let uuidCounter = 0;
function fakeGenUuid(): string {
	uuidCounter++;
	return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
}

/**
 * Shared implementer-backend/model resolution fixture (US-004, CAM-420),
 * mirroring loop.test.ts's GENERIC_SUPERVISOR_CONFIG_PATH idiom (US-003):
 * decouples this file's tests from the repo's live scripts/cam/project.toml.
 */
const GENERIC_SUPERVISOR_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cam-loop-model-resolution-generic-config-'));
const GENERIC_SUPERVISOR_CONFIG_PATH = join(GENERIC_SUPERVISOR_CONFIG_DIR, 'project.toml');
writeFileSync(GENERIC_SUPERVISOR_CONFIG_PATH, '[backend]\nimplementer = "claude"\n');

afterAll(() => {
	rmSync(GENERIC_SUPERVISOR_CONFIG_DIR, { recursive: true, force: true });
});

function makeBaseOpts(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisorOptions {
	const merged: RunSupervisorOptions = {
		spawn: (_cmd, _args) => ({ stdout: '', exitCode: 0 }),
		capturePane: (_paneId) => '',
		readPrd: () => null,
		writePrd: (_prd) => {},
		readHandoff: () => null,
		clock: () => '2026-06-08T00:00:00Z',
		genUuid: fakeGenUuid,
		reviewDispatch: (_uuid) => ({ status: 'ok', detail: 'review ok' }),
		writeSessionMarker: (_storyId, _uuid) => {},
		isPaneAlive: (_paneId) => true,
		workerPaneId: WORKER_PANE_ID,
		prdPath: PRD_PATH,
		handoffPath: HANDOFF_PATH,
		permissionMode: 'bypassPermissions',
		taskPrompt: 'Implement the next story from the PRD.',
		sleepFn: (_ms: number) => {},
		nowMs: () => 0,
		...overrides,
		// US-004 (CAM-420): defaults to the shared generic fixture, isolated
		// from the live project.toml (mirrors loop.test.ts's US-003 idiom).
		configPath: 'configPath' in overrides ? overrides.configPath : GENERIC_SUPERVISOR_CONFIG_PATH,
	};
	merged.spawn = withVerifiedPanePid(overrides.spawn ?? merged.spawn);
	return merged;
}

/**
 * Shared helper: build a one-story PRD + matching report that drives the loop
 * to 'complete' in one iteration (mirrors loop.test.ts's oneStoryBase).
 */
function oneStoryBase(): Partial<RunSupervisorOptions> {
	const prd_impl = makePrd({ stories: [{ id: 'US-001', priority: 1, passes: false }] });
	const prd_done = makePrd({
		stories: [{ id: 'US-001', priority: 1, passes: true }],
		review: { roundsCompleted: 1, lastVerdict: 'CLEAN' },
	});
	const fakeReport: WorkerReport = {
		outcome: 'DONE',
		story: 'US-001',
		gates: { typecheck: 'ok', tests: '1 pass / 0 fail' },
		notes: 'none',
	};
	let prdCall = 0;
	return {
		readPrd: () => {
			prdCall++;
			return prdCall <= 1 ? prd_impl : prd_done;
		},
		readHandoff: () => makeHandoff('US-001'),
		capturePane: (_paneId) => donePane('US-001'),
		readWorkerReport: () => fakeReport,
	};
}

/**
 * Stage a temp cwd with a project.toml resolving the implementer backend to
 * 'codex' with a claude-SHAPED flat model (so the codex-auto-resolution
 * cacheReader path fires, per resolvePhaseModel's precedence). Also stages a
 * stub .claude/agents/subagent-implementer.md so CodexAdapter.buildSpawnArgv
 * can read it on the authenticated (proceed) path -- mirrors loop.test.ts's
 * withCodexBackendCwd helper. readPhaseBackend/readPhaseModel ARE now
 * fixture-injectable via RunSupervisorOptions.configPath (CAM-420, US-004
 * added this seam project-wide); this helper deliberately opts OUT of the
 * shared fixture (passing an explicit `configPath: undefined` at its call
 * sites below) so it keeps exercising real cwd-relative resolution against
 * its own staged project.toml, per scripts/cam/patterns.md's CAM-350 US-003
 * bullet.
 */
async function withClaudeShapedCodexCwd<T>(fn: () => T | Promise<T>): Promise<T> {
	const tmpDir = mkdtempSync(join(tmpdir(), 'cam-loop-model-resolution-'));
	const camDir = join(tmpDir, 'scripts', 'cam');
	mkdirSync(camDir, { recursive: true });
	writeFileSync(join(camDir, 'project.toml'), '[backend]\nimplementer = "codex"\n\n[models]\nimplementer = "sonnet"\n');
	const agentsDir = join(tmpDir, '.claude', 'agents');
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, 'subagent-implementer.md'), '# stub\n');
	const prevCwd = process.cwd();
	process.chdir(tmpDir);
	try {
		return await fn();
	} finally {
		process.chdir(prevCwd);
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSupervisor US-004 (CAM-398): resolvePhaseModel wired into implementer dispatch', () => {
	test('AC2: codex backend + claude-shaped flat model + injected cacheReader -> argv carries the resolved slug, never the claude alias', async () => {
		await withClaudeShapedCodexCwd(async () => {
			let cacheReaderCalled = false;
			const dispatchedCmds: string[] = [];
			const opts = makeBaseOpts({
				...oneStoryBase(),
				// Opt out of the shared fixture: this helper stages its own
				// cwd-relative project.toml (US-004, CAM-420).
				configPath: undefined,
				codexAuthCheckFn: () => ({ authenticated: true }),
				codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => {
					cacheReaderCalled = true;
					return { ok: true, slug: 'gpt-5.6-sol' };
				},
				spawn: (_cmd, args) => {
					if (args.includes('respawn-pane')) {
						const lastArg = args[args.length - 1];
						if (typeof lastArg === 'string') dispatchedCmds.push(lastArg);
					}
					return { stdout: '', exitCode: 0 };
				},
			});

			const result = await runSupervisor(opts);

			expect(cacheReaderCalled).toBe(true);
			expect(result.status).toBe('complete');
			expect(dispatchedCmds.length).toBeGreaterThanOrEqual(1);
			const dispatchedCmd = dispatchedCmds[0] ?? '';
			expect(dispatchedCmd).toContain('gpt-5.6-sol');
			expect(dispatchedCmd).not.toMatch(/\bsonnet\b/i);
			expect(dispatchedCmd).not.toMatch(/\bopus\b/i);
		});
	});

	test('AC3: not-ok resolution aborts before any spawn -- actionable message, escalateFn fires, no respawn-pane call', async () => {
		await withClaudeShapedCodexCwd(async () => {
			let respawnCalled = false;
			let escalateCalled = false;
			let authCheckCalled = false;
			const opts = makeBaseOpts({
				...oneStoryBase(),
				// Opt out of the shared fixture: this helper stages its own
				// cwd-relative project.toml (US-004, CAM-420).
				configPath: undefined,
				codexAuthCheckFn: () => {
					authCheckCalled = true;
					return { authenticated: true };
				},
				codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => ({
					ok: false,
					reason: 'models_cache.json missing',
				}),
				escalateFn: async () => {
					escalateCalled = true;
				},
				spawn: (_cmd, args) => {
					if (args.includes('respawn-pane')) respawnCalled = true;
					return { stdout: '', exitCode: 0 };
				},
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('blocked');
			expect(result.lastOutcome?.detail).toContain('model-resolution-failed');
			expect(result.lastOutcome?.detail).toContain('models_cache.json missing');
			await waitForCondition(() => escalateCalled);
			expect(escalateCalled).toBe(true);
			expect(respawnCalled).toBe(false);
			// The abort fires before codexAuthPreflight ever runs its authCheck,
			// since resolvePhaseModel now resolves BEFORE the argv build that
			// precedes codexAuthPreflight in this same dispatch.
			expect(authCheckCalled).toBe(false);
		});
	});

	test('AC4: absent codexModelsCacheReaderFn falls back to the production reader (no throw, no crash) on a codex dispatch with a non-claude-shaped pin', async () => {
		// A codex dispatch whose config already pins a non-claude-shaped model
		// (per resolveCodexModel's precedence) never reaches the cacheReader at
		// all, so the default production reader (which would read the real
		// ~/.codex/models_cache.json) is never invoked here either -- this proves
		// the seam is optional/backward-compatible without depending on host state.
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-loop-model-resolution-pin-'));
		const camDir = join(tmpDir, 'scripts', 'cam');
		mkdirSync(camDir, { recursive: true });
		writeFileSync(join(camDir, 'project.toml'), '[backend]\nimplementer = "codex"\n\n[models]\nimplementer = "gpt-5-codex"\n');
		const agentsDir = join(tmpDir, '.claude', 'agents');
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, 'subagent-implementer.md'), '# stub\n');
		const prevCwd = process.cwd();
		process.chdir(tmpDir);
		try {
			let respawnCalled = false;
			const opts = makeBaseOpts({
				...oneStoryBase(),
				// Opt out of the shared fixture: this test stages its own
				// cwd-relative project.toml (US-004, CAM-420).
				configPath: undefined,
				codexAuthCheckFn: () => ({ authenticated: true }),
				// codexModelsCacheReaderFn intentionally absent.
				spawn: (_cmd, args) => {
					if (args.includes('respawn-pane')) respawnCalled = true;
					return { stdout: '', exitCode: 0 };
				},
			});

			const result = await runSupervisor(opts);

			expect(result.status).toBe('complete');
			expect(respawnCalled).toBe(true);
		} finally {
			process.chdir(prevCwd);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('AC4: claude-backed dispatch never invokes the injected cacheReader', async () => {
		// No cwd chdir: the repo's own scripts/cam/project.toml resolves the
		// implementer backend to 'claude' by default.
		let cacheReaderCalled = false;
		let respawnCalled = false;
		const opts = makeBaseOpts({
			...oneStoryBase(),
			codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => {
				cacheReaderCalled = true;
				return { ok: true, slug: 'gpt-5.6-sol' };
			},
			spawn: (_cmd, args) => {
				if (args.includes('respawn-pane')) respawnCalled = true;
				return { stdout: '', exitCode: 0 };
			},
		});

		const result = await runSupervisor(opts);

		expect(result.status).toBe('complete');
		expect(respawnCalled).toBe(true);
		expect(cacheReaderCalled).toBe(false);
	});
});
