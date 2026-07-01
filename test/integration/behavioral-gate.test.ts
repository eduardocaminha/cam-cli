// test/integration/behavioral-gate.test.ts
//
// Integration test (REAL tmux): proves runBehavioralGate drives a real tmux
// session, captures the pane, and correctly asserts satisfied / unsatisfied
// named-command oracles.
//
// Isolation: runBehavioralGate accepts a socketName parameter. Tests inject
// TEST_SOCK so the gate never touches the live 'cam' orchestrator session.
// The beforeEach/afterEach kill-server pattern mirrors tmux-introspect.test.ts.
//
// Skips when tmux is absent on the host (test.skipIf pattern).

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';

import {
	runBehavioralGate,
	BEHAVIORAL_GATE_SOCKET,
	type RunBehavioralGateOpts,
} from '../../src/supervisor/behavioral-gate.ts';

const TEST_SOCK = 'cam-it-gate';

const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

/** Run tmux directly on the private test socket (for setup/teardown). */
function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync('tmux', ['-L', TEST_SOCK, ...args], { stdio: 'pipe' });
}

beforeEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
});

afterEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
});

// ---------------------------------------------------------------------------
// Oracle isolation guard: default socket is never bare 'cam'
// ---------------------------------------------------------------------------

test('BEHAVIORAL_GATE_SOCKET is not bare "cam"', () => {
	expect(BEHAVIORAL_GATE_SOCKET).not.toBe('cam');
	expect(BEHAVIORAL_GATE_SOCKET.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Non-runnable oracles (no real tmux needed)
// ---------------------------------------------------------------------------

test('reviewer-judgment oracle returns passed:false without touching tmux', () => {
	const result = runBehavioralGate({ kind: 'reviewer-judgment' });
	expect(result.passed).toBe(false);
	expect(result.capturedPane).toBe('');
	expect(result.detail).toContain('reviewer-judgment');
});

test('no-oracle directive returns passed:false without touching tmux', () => {
	const result = runBehavioralGate({ kind: 'no-oracle', raw: 'some raw text' });
	expect(result.passed).toBe(false);
	expect(result.capturedPane).toBe('');
	expect(result.detail).toContain('no-oracle');
});

test('tmux-pty oracle returns passed:false without touching tmux', () => {
	const result = runBehavioralGate({ kind: 'tmux-pty', toolName: 'tmux-pty', artifactRef: 'artifacts/pane.txt' });
	expect(result.passed).toBe(false);
	expect(result.capturedPane).toBe('');
	expect(result.detail).toContain('tmux-pty');
});

// ---------------------------------------------------------------------------
// Real-tmux integration: satisfied oracle
// ---------------------------------------------------------------------------

test.skipIf(!tmuxAvailable)(
	'satisfied named-command oracle returns passed:true and captures pane text',
	() => {
		const opts: RunBehavioralGateOpts = { socketName: TEST_SOCK, timeoutMs: 10_000 };
		const result = runBehavioralGate({ kind: 'named-command', command: 'echo "cam-gate-hello"' }, opts);

		expect(result.passed).toBe(true);
		expect(result.detail).toContain('exited 0');
		// The pane must have been captured (non-empty)
		expect(result.capturedPane.length).toBeGreaterThan(0);
		// The echo output must appear in the captured pane
		expect(result.capturedPane).toContain('cam-gate-hello');
	},
);

// ---------------------------------------------------------------------------
// Real-tmux integration: unsatisfied oracle
// ---------------------------------------------------------------------------

test.skipIf(!tmuxAvailable)(
	'unsatisfied named-command oracle returns passed:false',
	() => {
		// 'false' is a POSIX command that always exits 1; keeps the shell alive.
		const opts: RunBehavioralGateOpts = { socketName: TEST_SOCK, timeoutMs: 10_000 };
		const result = runBehavioralGate({ kind: 'named-command', command: 'false' }, opts);

		expect(result.passed).toBe(false);
		expect(result.detail).toContain('exited 1');
	},
);

// ---------------------------------------------------------------------------
// Real-tmux integration: file-assert oracle
// ---------------------------------------------------------------------------

test.skipIf(!tmuxAvailable)(
	'file-assert oracle on an existing file returns passed:true',
	() => {
		// test -f on a file that exists must pass
		const opts: RunBehavioralGateOpts = { socketName: TEST_SOCK, timeoutMs: 10_000, cwd: process.cwd() };
		const result = runBehavioralGate(
			{ kind: 'file-assert', command: 'test -f src/supervisor/behavioral-gate.ts' },
			opts,
		);

		expect(result.passed).toBe(true);
		expect(result.capturedPane.length).toBeGreaterThan(0);
	},
);

test.skipIf(!tmuxAvailable)(
	'file-assert oracle on a nonexistent file returns passed:false',
	() => {
		const opts: RunBehavioralGateOpts = { socketName: TEST_SOCK, timeoutMs: 10_000, cwd: process.cwd() };
		const result = runBehavioralGate(
			{ kind: 'file-assert', command: 'test -f /nonexistent/file/that/does/not/exist' },
			opts,
		);

		expect(result.passed).toBe(false);
	},
);

// ---------------------------------------------------------------------------
// Real-tmux integration: capturedPane is always returned as a string
// ---------------------------------------------------------------------------

test.skipIf(!tmuxAvailable)(
	'capturedPane is a string in both pass and fail results',
	() => {
		const opts: RunBehavioralGateOpts = { socketName: TEST_SOCK, timeoutMs: 10_000 };

		const pass = runBehavioralGate({ kind: 'named-command', command: 'echo "pass-test"' }, opts);
		const fail = runBehavioralGate({ kind: 'named-command', command: 'false' }, opts);

		expect(typeof pass.capturedPane).toBe('string');
		expect(typeof fail.capturedPane).toBe('string');
	},
);
