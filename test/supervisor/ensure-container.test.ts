// test/supervisor/ensure-container.test.ts
//
// Unit tests for src/supervisor/ensure-container.ts.
//
// All Docker calls are driven through recording fake spawnFn / probe pairs;
// no real Docker daemon is touched.  CI runs on macos-latest with no Docker
// daemon installed.
//
// Coverage:
//   AC1 - four branches: running->reuse, stopped->start, absent->created,
//         image-stale->rebuilt; each DI-tested with injected fakes
//   AC2 - reconciliation reuses runWorkerContainer (build+run) and
//         preflightWorkerContainer (image-stale detection)
//   AC3 - host mode produces zero docker calls (tested via sidecar wiring)
//   AC4 - cam stop has no docker references (grep oracle, not tested here)

import { describe, expect, test } from 'bun:test';
import {
	ensureWorkerContainer,
	type EnsureWorkerContainerOptions,
	type EnsureWorkerContainerResult,
} from '../../src/supervisor/ensure-container.ts';
import type { ContainerSpawnFn } from '../../src/supervisor/worker-container.ts';
import type { DockerProbe, StatFn } from '../../src/supervisor/preflight-container.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const WORKSPACE = '/home/bun/workspace';

interface FakeCall {
	cmd: string;
	args: string[];
}

/**
 * Build a recording ContainerSpawnFn that captures all calls.
 * All invocations succeed (exit 0) by default.
 */
function makeRecordingSpawnFn(exitCode = 0): { fn: ContainerSpawnFn; calls: FakeCall[] } {
	const calls: FakeCall[] = [];
	const fn: ContainerSpawnFn = (cmd, args) => {
		calls.push({ cmd, args });
		return { stdout: '', exitCode };
	};
	return { fn, calls };
}

/**
 * Build a DockerProbe that returns the given stdout/exitCode for every call.
 * Also records each call.
 */
function makeSimpleProbe(
	stdout: string,
	exitCode: number,
): { fn: DockerProbe; calls: string[][] } {
	const calls: string[][] = [];
	const fn: DockerProbe = (args) => {
		calls.push(args);
		return { stdout, exitCode };
	};
	return { fn, calls };
}

/**
 * Build a DockerProbe with per-args-prefix routing.
 *
 * The routes map is checked in order; the first route whose prefix matches
 * args[0] wins.  The `_default` key matches everything else.
 */
function makeRoutedProbe(
	routes: Record<string, { stdout: string; exitCode: number }>,
): { fn: DockerProbe; calls: string[][] } {
	const calls: string[][] = [];
	const fn: DockerProbe = (args) => {
		calls.push(args);
		const first = args[0] ?? '';
		const match = routes[first] ?? routes['_default'] ?? { stdout: '', exitCode: 0 };
		return match;
	};
	return { fn, calls };
}

/** Build options for ensureWorkerContainer with the given probe + spawnFn. */
function makeOpts(
	probe: DockerProbe,
	spawnFn: ContainerSpawnFn,
	extra: Partial<EnsureWorkerContainerOptions> = {},
): EnsureWorkerContainerOptions {
	return { probe, spawnFn, workspaceFolder: WORKSPACE, ...extra };
}

// ---------------------------------------------------------------------------
// Branch 1: running → reuse
// ---------------------------------------------------------------------------

describe('ensureWorkerContainer: running -> reuse', () => {
	test('returns action=reused when container is running', () => {
		// preflightWorkerContainer: info ok, image inspect ok, created-check ok
		// The statFn is absent so stale check is skipped.
		// probe(['info']) -> exit 0 (daemon up)
		// probe(['image', 'inspect', ...]) -> exit 0 (image present)
		// probe(['inspect', '-f', '{{.State.Running}}', ...]) -> "true" + exit 0
		const probe = makeRoutedProbe({
			info: { stdout: 'daemon ok', exitCode: 0 },
			image: { stdout: '', exitCode: 0 },
			inspect: { stdout: 'true\n', exitCode: 0 },
		});
		const spawn = makeRecordingSpawnFn();
		const result = ensureWorkerContainer(makeOpts(probe.fn, spawn.fn));

		expect(result.action).toBe('reused');
		// No docker build/run/start/rm-f calls via spawnFn
		expect(spawn.calls).toHaveLength(0);
	});

	test('no spawnFn calls in the running branch', () => {
		const probe = makeRoutedProbe({
			info: { stdout: '', exitCode: 0 },
			image: { stdout: '', exitCode: 0 },
			inspect: { stdout: 'true', exitCode: 0 },
		});
		const spawn = makeRecordingSpawnFn();
		ensureWorkerContainer(makeOpts(probe.fn, spawn.fn));
		expect(spawn.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Branch 2: stopped → docker start
// ---------------------------------------------------------------------------

describe('ensureWorkerContainer: stopped -> docker start', () => {
	test('returns action=started and calls docker start when container is stopped', () => {
		// inspect returns "false" + exit 0 → stopped
		const probe = makeRoutedProbe({
			info: { stdout: '', exitCode: 0 },
			image: { stdout: '', exitCode: 0 },
			inspect: { stdout: 'false\n', exitCode: 0 },
		});
		const spawn = makeRecordingSpawnFn();
		const result = ensureWorkerContainer(makeOpts(probe.fn, spawn.fn));

		expect(result.action).toBe('started');
		// spawnFn must have been called with 'docker start cam-worker'
		const startCall = spawn.calls.find(
			(c) => c.cmd === 'docker' && c.args[0] === 'start',
		);
		expect(startCall).toBeDefined();
		expect(startCall?.args).toContain('cam-worker');
	});

	test('docker start is called exactly once in stopped branch', () => {
		const probe = makeRoutedProbe({
			info: { stdout: '', exitCode: 0 },
			image: { stdout: '', exitCode: 0 },
			inspect: { stdout: 'false', exitCode: 0 },
		});
		const spawn = makeRecordingSpawnFn();
		ensureWorkerContainer(makeOpts(probe.fn, spawn.fn));
		const startCalls = spawn.calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'start');
		expect(startCalls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Branch 3: absent → build + run (via runWorkerContainer)
// ---------------------------------------------------------------------------

describe('ensureWorkerContainer: absent -> created (build+run)', () => {
	test('returns action=created when container is absent', () => {
		// probe(['inspect', ...]) exits non-zero → absent
		// preflight: info ok, image inspect ok (image present but no stale check)
		const probe = makeRoutedProbe({
			info: { stdout: '', exitCode: 0 },
			image: { stdout: '', exitCode: 0 },
			inspect: { stdout: '', exitCode: 1 }, // non-zero → absent
		});
		const spawn = makeRecordingSpawnFn();
		const result = ensureWorkerContainer(makeOpts(probe.fn, spawn.fn));

		expect(result.action).toBe('created');
	});

	test('calls docker build then docker run in the absent branch', () => {
		const probe = makeRoutedProbe({
			info: { stdout: '', exitCode: 0 },
			image: { stdout: '', exitCode: 0 },
			inspect: { stdout: '', exitCode: 1 },
		});
		const spawn = makeRecordingSpawnFn();
		ensureWorkerContainer(makeOpts(probe.fn, spawn.fn));

		const buildCall = spawn.calls.find(
			(c) => c.cmd === 'docker' && c.args[0] === 'build',
		);
		const runCall = spawn.calls.find(
			(c) => c.cmd === 'docker' && c.args[0] === 'run',
		);
		expect(buildCall).toBeDefined();
		expect(runCall).toBeDefined();
	});

	test('docker run includes the workspaceFolder bind mount', () => {
		const probe = makeRoutedProbe({
			info: { stdout: '', exitCode: 0 },
			image: { stdout: '', exitCode: 0 },
			inspect: { stdout: '', exitCode: 1 },
		});
		const spawn = makeRecordingSpawnFn();
		ensureWorkerContainer(makeOpts(probe.fn, spawn.fn));

		const runCall = spawn.calls.find(
			(c) => c.cmd === 'docker' && c.args[0] === 'run',
		);
		// workspaceFolder appears in the mount source
		const hasMount = (runCall?.args ?? []).some((a) => a.includes(WORKSPACE));
		expect(hasMount).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Branch 4: image-stale → docker rm -f + rebuild (via runWorkerContainer)
// ---------------------------------------------------------------------------

describe('ensureWorkerContainer: image-stale -> rebuilt', () => {
	/**
	 * Build a StatFn that reports the Dockerfile as NEWER than the image
	 * (triggering the stale-image branch).
	 *
	 * We fake the image Created timestamp to be in the past, and the Dockerfile
	 * mtime to be "now" (or effectively newer).
	 */
	function makeStaleStatFn(): StatFn {
		// Dockerfile mtime = very recent (epoch + a large number)
		return (_path) => ({ mtimeMs: Date.now() });
	}

	test('returns action=rebuilt when the image is stale', () => {
		// preflight: daemon ok, image present, stale (statFn returns recent mtime,
		// image Created is old)
		const OLD_DATE = new Date(0).toISOString(); // 1970-01-01
		const probe = makeRoutedProbe({
			info: { stdout: '', exitCode: 0 },
			// image inspect (presence check) → exit 0
			// The routed probe hits 'image' for both 'image inspect' and
			// 'image inspect --format={{.Created}}'; we return the old date for
			// the format call via stdout.
			image: { stdout: OLD_DATE, exitCode: 0 },
			inspect: { stdout: 'true', exitCode: 0 }, // running (would reuse if not stale)
		});
		const spawn = makeRecordingSpawnFn();
		const result = ensureWorkerContainer(
			makeOpts(probe.fn, spawn.fn, { statFn: makeStaleStatFn() }),
		);

		expect(result.action).toBe('rebuilt');
	});

	test('calls docker rm -f then docker build + run in the image-stale branch', () => {
		const OLD_DATE = new Date(0).toISOString();
		const probe = makeRoutedProbe({
			info: { stdout: '', exitCode: 0 },
			image: { stdout: OLD_DATE, exitCode: 0 },
			inspect: { stdout: 'true', exitCode: 0 },
		});
		const spawn = makeRecordingSpawnFn();
		ensureWorkerContainer(makeOpts(probe.fn, spawn.fn, { statFn: makeStaleStatFn() }));

		const rmCall = spawn.calls.find(
			(c) => c.cmd === 'docker' && c.args[0] === 'rm',
		);
		const buildCall = spawn.calls.find(
			(c) => c.cmd === 'docker' && c.args[0] === 'build',
		);
		const runCall = spawn.calls.find(
			(c) => c.cmd === 'docker' && c.args[0] === 'run',
		);
		expect(rmCall).toBeDefined();
		expect(rmCall?.args).toContain('-f');
		expect(buildCall).toBeDefined();
		expect(runCall).toBeDefined();
	});

	test('docker rm -f is called before docker build in rebuilt branch', () => {
		const OLD_DATE = new Date(0).toISOString();
		const probe = makeRoutedProbe({
			info: { stdout: '', exitCode: 0 },
			image: { stdout: OLD_DATE, exitCode: 0 },
			inspect: { stdout: 'true', exitCode: 0 },
		});
		const spawn = makeRecordingSpawnFn();
		ensureWorkerContainer(makeOpts(probe.fn, spawn.fn, { statFn: makeStaleStatFn() }));

		const rmIdx = spawn.calls.findIndex(
			(c) => c.cmd === 'docker' && c.args[0] === 'rm',
		);
		const buildIdx = spawn.calls.findIndex(
			(c) => c.cmd === 'docker' && c.args[0] === 'build',
		);
		expect(rmIdx).toBeGreaterThanOrEqual(0);
		expect(buildIdx).toBeGreaterThan(rmIdx);
	});

	test('no docker start call in rebuilt branch (rm+run replaces it)', () => {
		const OLD_DATE = new Date(0).toISOString();
		const probe = makeRoutedProbe({
			info: { stdout: '', exitCode: 0 },
			image: { stdout: OLD_DATE, exitCode: 0 },
			inspect: { stdout: 'true', exitCode: 0 },
		});
		const spawn = makeRecordingSpawnFn();
		ensureWorkerContainer(makeOpts(probe.fn, spawn.fn, { statFn: makeStaleStatFn() }));

		const startCalls = spawn.calls.filter(
			(c) => c.cmd === 'docker' && c.args[0] === 'start',
		);
		expect(startCalls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Custom container name
// ---------------------------------------------------------------------------

describe('ensureWorkerContainer: custom containerName', () => {
	test('uses the custom container name in docker start', () => {
		const probe = makeRoutedProbe({
			info: { stdout: '', exitCode: 0 },
			image: { stdout: '', exitCode: 0 },
			inspect: { stdout: 'false', exitCode: 0 },
		});
		const spawn = makeRecordingSpawnFn();
		ensureWorkerContainer(
			makeOpts(probe.fn, spawn.fn, { containerName: 'my-cam-worker' }),
		);

		const startCall = spawn.calls.find(
			(c) => c.cmd === 'docker' && c.args[0] === 'start',
		);
		expect(startCall?.args).toContain('my-cam-worker');
	});
});

// ---------------------------------------------------------------------------
// Type-level sanity
// ---------------------------------------------------------------------------

describe('ensureWorkerContainer: type sanity', () => {
	test('result satisfies EnsureWorkerContainerResult type', () => {
		const probe = makeSimpleProbe('true\n', 0);
		const spawn = makeRecordingSpawnFn();
		const result: EnsureWorkerContainerResult = ensureWorkerContainer(
			makeOpts(probe.fn, spawn.fn),
		);
		expect(['reused', 'started', 'created', 'rebuilt']).toContain(result.action);
	});
});
