// test/integration/orch-exit-preserves-state.test.ts
//
// Integration test (REAL bash wrapper, no tmux/session required): proves the
// orchestrator-pane exit wrapper's teardown branch never deletes the live
// cycle-state signal (Defect 3, US-002).
//
// Mechanism under test:
//   buildOrchestratorPaneCommand's teardown ("clean /exit", no handoff file
//   present) branch removes readyMarker and pidMarker, then kill-sessions and
//   breaks out of the respawn loop. Before US-002 it also removed stateFile
//   (cam-loop.local.md); that rm has been deleted so a sidecar reading the
//   live cycle signal never sees it vanish out from under it on a recycle.
//
// What this test does:
//   1. Creates a tmpdir as a fake project cwd with a real .claude/ dir.
//   2. Seeds cam-loop.local.md (the live cycle signal), plus the ready and
//      pid markers, with real content on disk.
//   3. Creates a fake `claude` shell script that exits 0 immediately WITHOUT
//      writing a handoff file, forcing the wrapper into its teardown branch
//      on the very first loop iteration (mirrors a clean `/exit`).
//   4. Runs the real bash wrapper (buildOrchestratorPaneCommand) directly via
//      `bash -c` (no tmux session needed: kill-session is allowed to fail
//      harmlessly, since the script has no `set -e`).
//   5. Asserts: cam-loop.local.md still exists with its original content
//      (the live cycle signal survived the recycle/teardown).
//   6. Asserts: readyMarker and pidMarker WERE removed (unaffected US-006 /
//      CAM-173 behavior, proving the fix is surgical).

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildOrchestratorPaneCommand } from '../../src/commands/run.ts';

let tmpCwd: string;

beforeEach(() => {
	tmpCwd = mkdtempSync(join(tmpdir(), 'cam-orch-exit-'));
});

afterEach(() => {
	try { rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test('orchestrator teardown branch preserves cam-loop.local.md while still clearing ready/pid markers', () => {
	const claudeDir = join(tmpCwd, '.claude');
	mkdirSync(claudeDir, { recursive: true });

	const stateFile = join(claudeDir, 'cam-loop.local.md');
	const readyMarker = join(claudeDir, '.cam-orch-ready');
	const pidMarker = join(claudeDir, '.cam-orch-pid');
	const handoffMarker = join(claudeDir, '.cam-orch-handoff.json');
	const sessionIdMarker = join(claudeDir, '.cam-orch-session');
	const promptFile = join(claudeDir, '.cam-orchestrator-prompt.txt');

	const originalStateContent = '---\nphase: implementing\n---\n# live cycle signal\n';
	writeFileSync(stateFile, originalStateContent, 'utf8');
	writeFileSync(readyMarker, '', 'utf8');
	writeFileSync(pidMarker, '', 'utf8');
	writeFileSync(promptFile, 'test prompt', 'utf8');

	// Fake claude: exits immediately without writing a handoff file, so the
	// wrapper's `if [ -f handoffMarker ] ...` guard is false on the very first
	// iteration and control falls straight into the teardown ("else") branch.
	const fakeBinDir = join(tmpCwd, 'fake-bin');
	mkdirSync(fakeBinDir, { recursive: true });
	const fakeClaudeScript = join(fakeBinDir, 'claude');
	writeFileSync(fakeClaudeScript, '#!/bin/bash\nexit 0\n');
	chmodSync(fakeClaudeScript, 0o755);

	const sessionName = 'cam-orch-exit-preserves-test';
	const sessionId = `cam-exit-test-${Date.now()}`;

	const agentCmd = buildOrchestratorPaneCommand({
		sessionName,
		sessionId,
		promptFile,
		sessionIdMarker,
		handoffMarker,
		stateFile,
		readyMarker,
		pidMarker,
		maxRespawns: 3,
	});

	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	const fullCmd = [`export PATH=${q(fakeBinDir)}:$PATH`, agentCmd].join('; ');

	const result = spawnSync('bash', ['-c', fullCmd], { cwd: tmpCwd, stdio: 'pipe' });
	// The wrapper itself has no `set -e`; tmux kill-session may fail harmlessly
	// (no real tmux session exists here), but the loop must still complete.
	expect(result.error).toBeUndefined();

	// The live cycle signal must survive, byte-for-byte.
	expect(existsSync(stateFile)).toBe(true);
	expect(readFileSync(stateFile, 'utf8')).toBe(originalStateContent);

	// Ready/pid markers are still deliberately cleared on teardown (US-006 / CAM-173).
	expect(existsSync(readyMarker)).toBe(false);
	expect(existsSync(pidMarker)).toBe(false);
});
