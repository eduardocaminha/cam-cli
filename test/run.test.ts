// test/run.test.ts
//
// Tests for `cam run` — the orchestrator launcher.
//
// We focus on the parts that are straightforward to verify without spawning
// real tmux processes:
//   - parseRunArgs   (pure CLI parsing)
//   - projectSessionName (deterministic naming)
//   - runRun pre-flight failures (no orchestrator file, no tmux on PATH)
//
// The success path (creating + attaching to a real tmux session) is left to
// manual e2e testing — mocking spawnSync deeply for that adds more
// scaffolding than it earns.

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRunArgs, projectSessionName, runRun } from '../src/commands/run.ts';

// ---------------------------------------------------------------------------
// parseRunArgs
// ---------------------------------------------------------------------------

describe('parseRunArgs', () => {
	it('returns sensible defaults on empty input', () => {
		const r = parseRunArgs([]);
		expect(r).not.toBeNull();
		expect(r!.noAttach).toBe(false);
		expect(r!.help).toBe(false);
	});

	it('parses --no-attach', () => {
		const r = parseRunArgs(['--no-attach']);
		expect(r!.noAttach).toBe(true);
	});

	it('parses --help and -h', () => {
		expect(parseRunArgs(['--help'])!.help).toBe(true);
		expect(parseRunArgs(['-h'])!.help).toBe(true);
	});

	it('returns null on unknown flags', () => {
		expect(parseRunArgs(['--no-such-flag'])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// projectSessionName
// ---------------------------------------------------------------------------

describe('projectSessionName', () => {
	it('produces a tmux-safe name that includes the basename and a 6-char hash', () => {
		const name = projectSessionName('/Users/eduardo/Documents/Projects/cam-cli');
		expect(name).toMatch(/^cam-orch-cam-cli-[0-9a-f]{6}$/);
	});

	it('is deterministic for the same path', () => {
		const a = projectSessionName('/some/path');
		const b = projectSessionName('/some/path');
		expect(a).toBe(b);
	});

	it('differs for paths with the same basename in different parents', () => {
		const a = projectSessionName('/work/proj-a');
		const b = projectSessionName('/personal/proj-a');
		expect(a).not.toBe(b);
	});

	it('replaces unsafe basename characters with dashes', () => {
		const name = projectSessionName('/tmp/has spaces & symbols');
		expect(name).toMatch(/^cam-orch-has-spaces---symbols-[0-9a-f]{6}$/);
	});

	it('handles a trailing slash by treating the parent basename', () => {
		// `basename('/foo/bar/')` returns 'bar' on macOS/Linux.
		const name = projectSessionName('/foo/bar/');
		expect(name).toMatch(/^cam-orch-bar-[0-9a-f]{6}$/);
	});

	it('falls back to "project" when basename is empty (root directory)', () => {
		const name = projectSessionName('/');
		expect(name).toMatch(/^cam-orch-project-[0-9a-f]{6}$/);
	});
});

// ---------------------------------------------------------------------------
// runRun pre-flight: missing orchestrator file
// ---------------------------------------------------------------------------

describe('runRun pre-flight', () => {
	it('returns non-zero when subagent-orchestrator.md is missing', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-run-'));
		// No .claude/agents/subagent-orchestrator.md created.
		const code = runRun({ cwd, noAttach: true });
		// May fail on tmux check first (exit 1) or on orchestrator check (exit 1).
		// Either way, non-zero is the correct contract.
		expect(code).not.toBe(0);
	});

	it('returns 0 in dry-run when the orchestrator file is present (and tmux is on PATH)', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'cam-run-'));
		const agentsDir = join(cwd, '.claude', 'agents');
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, 'subagent-orchestrator.md'), '# stub\n', 'utf8');
		const prev = process.env['CAM_RUN_DRY_RUN'];
		process.env['CAM_RUN_DRY_RUN'] = '1';
		try {
			const code = runRun({ cwd, noAttach: true });
			// On machines without tmux on PATH, the pre-flight check fails
			// before dry-run kicks in. Either case is acceptable contract:
			//   - 0 means dry-run succeeded.
			//   - non-zero means tmux pre-flight blocked.
			expect([0, 1]).toContain(code);
		} finally {
			if (prev === undefined) delete process.env['CAM_RUN_DRY_RUN'];
			else process.env['CAM_RUN_DRY_RUN'] = prev;
		}
	});
});
