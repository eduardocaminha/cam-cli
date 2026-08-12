// test/supervisor/review-model-resolution.test.ts
//
// Unit tests for US-006 (CAM-398): wiring `resolvePhaseModel` into the
// reviewer dispatch site in src/supervisor/review.ts. Mirrors
// test/supervisor/plan/plan-runner-model-resolution.test.ts's (US-005) and
// test/supervisor/loop-model-resolution.test.ts's (US-004) conventions,
// adapted to the reviewer dispatch's pre-existing CAM-405 configPath seam
// (no chdir required: configPath drives resolution directly).
//
// Coverage:
//   AC1: resolvePhaseModel is invoked at the readPhaseModel call site, before
//        argv build; codexAuthPreflight keeps its position relative to
//        buildSpawnArgv (proven indirectly: the codex-auth regression suite
//        in review.test.ts still passes unmodified, see AC6).
//   AC2: resolution is threaded through the existing configPath seam, no
//        chdir, without disturbing the generic-fixture default.
//   AC3: a codex-backed dispatch whose config carries only a claude-shaped
//        flat model, with an injected cacheReader resolving 'gpt-5.6-sol',
//        spawns argv containing 'gpt-5.6-sol' and never the claude alias.
//   AC4: a not-ok resolution aborts before any spawn: actionable message,
//        escalateFn fires, no respawn-pane invocation recorded.
//   AC5: the cache reader reaches this site through an injectable option seam
//        (codexModelsCacheReaderFn) mirroring codexAuthCheckFn -- defaults to
//        the production reader when omitted, and a claude-backed dispatch
//        never invokes it.

import { describe, expect, test } from 'bun:test';
import { writeFileSync, rmSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';
import { makeReviewDispatch } from '../../src/supervisor/review.ts';
import type { MakeReviewDispatchOptions } from '../../src/supervisor/review.ts';
import type { PrdSnapshot } from '../../src/supervisor/decide.ts';
import { withVerifiedPanePid } from '../helpers/verified-pane-pid-spawn.ts';
import type { SpawnFn, CapturePane, ReadPrd, WritePrd } from '../../src/supervisor/loop.ts';
import type { CodexModelsCacheReader } from '../../src/config/codex-models-cache.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';

const SAMPLE_UUID = 'model5eed-c0de-4a11-9999-000011112222';

/** Minimal empty PrdSnapshot; the reviewer poll loop resolves before touching it. */
function makePrd(): PrdSnapshot {
	return { userStories: [] };
}

/**
 * Build a MakeReviewDispatchOptions with injectable fakes. Mirrors
 * review.test.ts's makeDispatchOpts, trimmed to only what this file's
 * model-resolution tests need. The reviewer pane text resolves to CLEAN
 * immediately so the poll loop exits on the first tick when a spawn does
 * happen; tests asserting an abort never reach the poll loop at all.
 */
function makeOpts(
	overrides: Partial<MakeReviewDispatchOptions> = {},
	spawnCalls: string[][] = [],
): MakeReviewDispatchOptions {
	const spawn: SpawnFn = (_cmd, args) => {
		spawnCalls.push([...args]);
		return { stdout: '', exitCode: 0 };
	};
	const capturePane: CapturePane = () => '<review>CLEAN</review>';
	const readPrd: ReadPrd = () => makePrd();
	const writePrd: WritePrd = () => {};

	return {
		spawn: withVerifiedPanePid(overrides.spawn ?? spawn),
		capturePane: overrides.capturePane ?? capturePane,
		readPrd: overrides.readPrd ?? readPrd,
		writePrd: overrides.writePrd ?? writePrd,
		workerPaneId: overrides.workerPaneId ?? '%7',
		isPaneAlive: overrides.isPaneAlive ?? (() => true),
		sleepFn: overrides.sleepFn ?? (() => {}),
		permissionMode: overrides.permissionMode ?? 'bypassPermissions',
		pollIntervalMs: overrides.pollIntervalMs ?? 1,
		timeoutMs: overrides.timeoutMs ?? 60_000,
		codexAuthCheckFn: overrides.codexAuthCheckFn ?? (() => ({ authenticated: true })),
		configPath: overrides.configPath,
		codexModelsCacheReaderFn: overrides.codexModelsCacheReaderFn,
		escalateFn: overrides.escalateFn,
	};
}

/** Extract all respawn-pane args arrays from recorded spawn calls. */
function respawnCalls(calls: string[][]): string[][] {
	return calls.filter((a) => a[2] === 'respawn-pane');
}

/**
 * Stage a temp project.toml resolving the reviewer backend to 'codex' with a
 * claude-SHAPED flat model, WITHOUT chdir (AC2): the fixture path is passed
 * straight through MakeReviewDispatchOptions.configPath, exercising the
 * pre-existing CAM-405 seam. `.claude/agents/subagent-reviewer.md` is read
 * from the real repo cwd (unaffected by configPath), which already exists
 * committed at the repo root, so no agent-file staging is required.
 */
function claudeShapedCodexConfigPath(): { path: string; cleanup: () => void } {
	const dir = createTestTmpdir('cam-review-model-resolution-');
	const path = join(dir, 'project.toml');
	writeFileSync(path, '[backend]\nreviewer = "codex"\n\n[models]\nreviewer = "sonnet"\n');
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// AC2 + AC3: configPath seam drives resolution (no chdir); resolved slug
// reaches argv, never the claude alias.
// ---------------------------------------------------------------------------

describe('review model resolution: AC2/AC3 - configPath seam, resolved slug reaches argv', () => {
	test('codex-backed dispatch with a claude-shaped flat model resolves via the injected cacheReader; argv contains the slug, never the claude alias', async () => {
		const fixture = claudeShapedCodexConfigPath();
		try {
			let cacheReaderCalled = false;
			const spawnCalls: string[][] = [];
			const opts = makeOpts(
				{
					configPath: fixture.path,
					codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => {
						cacheReaderCalled = true;
						return { ok: true, slug: 'gpt-5.6-sol' };
					},
				},
				spawnCalls,
			);

			const dispatch = makeReviewDispatch(opts);
			const result = await dispatch(SAMPLE_UUID);

			expect(result.status).toBe('ok');
			expect(cacheReaderCalled).toBe(true);
			const calls = respawnCalls(spawnCalls);
			expect(calls.length).toBe(1);
			const dispatchedCmd = calls[0]?.[calls[0].length - 1] ?? '';
			expect(dispatchedCmd).toContain('gpt-5.6-sol');
			expect(dispatchedCmd).not.toMatch(/\bsonnet\b/i);
			expect(dispatchedCmd).not.toMatch(/\bopus\b/i);
		} finally {
			fixture.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// AC4: not-ok resolution aborts before any spawn.
// ---------------------------------------------------------------------------

describe('review model resolution: AC4 - not-ok resolution aborts before spawn', () => {
	test('actionable message, escalateFn fires, no respawn-pane invocation recorded', async () => {
		const fixture = claudeShapedCodexConfigPath();
		try {
			let escalateCalled = false;
			const spawnCalls: string[][] = [];
			const opts = makeOpts(
				{
					configPath: fixture.path,
					codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => ({
						ok: false,
						reason: 'models_cache.json missing',
					}),
					escalateFn: async () => { escalateCalled = true; },
				},
				spawnCalls,
			);

			const dispatch = makeReviewDispatch(opts);
			const result = await dispatch(SAMPLE_UUID);

			expect(result.status).toBe('error');
			expect(result.detail).toContain('model-resolution-failed');
			expect(result.detail).toContain('models_cache.json missing');
			expect(respawnCalls(spawnCalls).length).toBe(0);
			await waitForCondition(() => escalateCalled);
			expect(escalateCalled).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// AC5: injectable seam mirrors codexAuthCheckFn; defaults when absent;
// claude-backed dispatch never invokes it.
// ---------------------------------------------------------------------------

describe('review model resolution: AC5 - injectable seam, default fallback, claude-backend bypass', () => {
	test('absent codexModelsCacheReaderFn on a codex dispatch with a non-claude-shaped pin never crashes (falls back to the production reader)', async () => {
		const dir = createTestTmpdir('cam-review-model-resolution-pin-');
		const path = join(dir, 'project.toml');
		writeFileSync(path, '[backend]\nreviewer = "codex"\n\n[models.codex]\nreviewer = "gpt-5-codex"\n');
		try {
			const spawnCalls: string[][] = [];
			const opts = makeOpts({ configPath: path }, spawnCalls); // codexModelsCacheReaderFn intentionally absent

			const dispatch = makeReviewDispatch(opts);
			const result = await dispatch(SAMPLE_UUID);

			expect(result.status).toBe('ok');
			expect(respawnCalls(spawnCalls).length).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('claude-backed dispatch (generic fixture) never invokes the injected cacheReader', async () => {
		const dir = createTestTmpdir('cam-review-model-resolution-claude-');
		const path = join(dir, 'project.toml');
		writeFileSync(path, '[backend]\nreviewer = "claude"\n');
		try {
			let cacheReaderCalled = false;
			const spawnCalls: string[][] = [];
			const opts = makeOpts(
				{
					configPath: path,
					codexModelsCacheReaderFn: (): ReturnType<CodexModelsCacheReader> => {
						cacheReaderCalled = true;
						return { ok: true, slug: 'gpt-5.6-sol' };
					},
				},
				spawnCalls,
			);

			const dispatch = makeReviewDispatch(opts);
			const result = await dispatch(SAMPLE_UUID);

			expect(result.status).toBe('ok');
			expect(respawnCalls(spawnCalls).length).toBe(1);
			expect(cacheReaderCalled).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
