// test/commands/run.test.ts
//
// US-002/CAM-172 AC6: the context-backstop handoff must resolve to the
// wrapper's RESPAWN branch (rehydrate via CAM_ORCH_REHYDRATE, counter
// increment), never the teardown/kill-session branch — same as any other
// non-cycle-close handoff reason. This runs the REAL bash decision logic
// (buildOrchestratorPaneCommand's assembled script) with the claude
// invocation itself stubbed out, so the branch/counter semantics are proven
// by actual execution rather than string matching alone.

import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildOrchestratorPaneCommand } from '../../src/commands/run.ts';

test('context-backstop handoff takes the respawn branch: increments n, never reaches kill-session', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'cam-backstop-run-'));
	try {
		const claudeDir = join(cwd, '.claude');
		mkdirSync(claudeDir, { recursive: true });

		const handoffMarker = join(claudeDir, '.cam-orch-handoff.json');
		writeFileSync(
			handoffMarker,
			JSON.stringify({ schemaVersion: 1, writtenAt: 'x', reason: 'context-backstop' }),
			'utf8',
		);
		const promptFile = join(claudeDir, 'prompt.txt');
		writeFileSync(promptFile, 'noop', 'utf8');

		const cmd = buildOrchestratorPaneCommand({
			sessionName: 'cam-orch-test-nonexistent-session',
			sessionId: 'aaaa-bbbb',
			promptFile,
			sessionIdMarker: join(claudeDir, '.cam-orch-session'),
			handoffMarker,
			stateFile: join(claudeDir, 'cam-loop.local.md'),
			readyMarker: join(claudeDir, '.cam-orch-ready'),
			pidMarker: join(claudeDir, '.cam-orch-pid'),
			maxRespawns: 3,
		});

		// Replace the actual `claude ...` invocation with a stub that just prints
		// a marker and exits immediately, standing in for "claude exited because
		// the context backstop fired". This proves the wrapper's own branch
		// decision (handoff present + reason != cycle-close) without spinning up
		// a real tmux session or the claude binary. After the mv (consume-once),
		// the handoff no longer exists on the second loop iteration, so the
		// wrapper naturally falls into the teardown branch and `break`s — no
		// external process needed to terminate the test.
		const stubbed = `${cmd.replace(/claude --permission-mode[^;]*;/, 'echo stub-claude-exit;')}; echo "FINAL_N=$n";`;

		const result = spawnSync('bash', ['-c', stubbed], {
			encoding: 'utf8',
			timeout: 8_000,
		});

		expect(result.stdout).toContain('FINAL_N=1');
		// n=1, never reset to 0 — a context-backstop reason is NOT 'cycle-close',
		// so it takes the exact same increment path as any other respawn reason.
		expect(result.stdout).not.toContain('FINAL_N=0');
		expect(result.stdout).toContain('stub-claude-exit');
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
