// src/supervisor/ensure-container.ts
//
// Idempotent "ensure-up" helper for the cam worker container (US-003, CAM-150).
//
// Reconciles the cam-worker Docker container to a "running" state by checking
// its current state and executing the minimal action needed:
//
//   running     → reuse (no docker call)
//   stopped     → docker start
//   absent      → build+run (via runWorkerContainer)
//   image-stale → docker rm -f + build+run (via runWorkerContainer)
//
// All Docker calls are routed through injectable spawnFn / probe seams so the
// unit tests can assert each branch without a real Docker daemon.  CI runs on
// macos-latest with no Docker installed.
//
// noUncheckedIndexedAccess: no unguarded array indexing in this file.

import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
	runWorkerContainer,
	resolveHostIds,
	DEFAULT_CONTAINER_NAME,
	DEFAULT_IMAGE_TAG,
	type ContainerSpawnFn,
	type DockerBuildArgvOptions,
} from './worker-container.ts';
import {
	preflightWorkerContainer,
	type DockerProbe,
	type StatFn,
} from './preflight-container.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The action taken by `ensureWorkerContainer` to reach the running state. */
export type EnsureContainerAction = 'reused' | 'started' | 'created' | 'rebuilt';

/** Result returned by `ensureWorkerContainer`. */
export interface EnsureWorkerContainerResult {
	/** Which branch was taken to reconcile the container state. */
	action: EnsureContainerAction;
}

/** Options for `ensureWorkerContainer`. */
export interface EnsureWorkerContainerOptions {
	/**
	 * Injectable spawn function for `docker rm -f`, `docker start`, and all
	 * build+run calls (via `runWorkerContainer`). Never touches a real daemon by
	 * default; tests inject a recording fake.
	 */
	spawnFn: ContainerSpawnFn;

	/**
	 * Injectable docker probe for inspection calls (`docker inspect`,
	 * `docker info`, `docker image inspect`). Shared with
	 * `preflightWorkerContainer` for image-stale detection.
	 */
	probe: DockerProbe;

	/**
	 * Optional stat function for the Dockerfile mtime check inside
	 * `preflightWorkerContainer`. When absent the stale-image check is skipped.
	 */
	statFn?: StatFn;

	/**
	 * Name of the long-lived worker container.
	 * Defaults to `DEFAULT_CONTAINER_NAME` ('cam-worker').
	 */
	containerName?: string;

	/**
	 * Docker image tag.
	 * Defaults to `DEFAULT_IMAGE_TAG` ('cam-worker:latest').
	 */
	imageTag?: string;

	/**
	 * Absolute path to the local workspace folder.  Required for the
	 * `docker run` argv produced by `runWorkerContainer`.
	 */
	workspaceFolder: string;

	/**
	 * Path to the Dockerfile for the stale-image mtime comparison.
	 * Defaults to `'.devcontainer/Dockerfile'`.
	 */
	dockerfilePath?: string;

	/**
	 * Options forwarded to `buildDockerBuildArgv` inside `runWorkerContainer`.
	 * Allows overriding the Dockerfile path and build context for tests.
	 */
	build?: DockerBuildArgvOptions;
}

// ---------------------------------------------------------------------------
// Core reconciliation function
// ---------------------------------------------------------------------------

/**
 * Reconcile the cam-worker container to a running state.
 *
 * Idempotent across four branches:
 *   running     → reuse (returns immediately, no docker call)
 *   stopped     → `docker start <containerName>`
 *   absent      → `docker build` + `docker run -d` via `runWorkerContainer`
 *   image-stale → `docker rm -f` + `runWorkerContainer` (rebuild + recreate)
 *
 * Image-stale detection uses `preflightWorkerContainer` (which calls
 * `docker image inspect --format={{.Created}}` and compares against the
 * Dockerfile mtime via `statFn`).  The stale check is skipped when `statFn`
 * is absent.
 *
 * All docker calls are routed through the injectable `spawnFn` / `probe`
 * seams; no real daemon is touched when fakes are injected.
 */
export function ensureWorkerContainer(
	opts: EnsureWorkerContainerOptions,
): EnsureWorkerContainerResult {
	const { spawnFn, probe, statFn } = opts;
	const containerName = opts.containerName ?? DEFAULT_CONTAINER_NAME;
	const imageTag = opts.imageTag ?? DEFAULT_IMAGE_TAG;
	const dockerfilePath = opts.dockerfilePath ?? '.devcontainer/Dockerfile';

	// --- Branch 4: image-stale detection ---
	// preflightWorkerContainer checks daemon reachability, image existence, and
	// Dockerfile mtime.  When it returns `image-stale` the existing container
	// (if any) must be torn down so the rebuilt image can replace it.
	const preflight = preflightWorkerContainer({
		probe,
		statFn,
		imageTag,
		dockerfilePath,
	});
	if (preflight.ready === false && preflight.reason === 'image-stale') {
		// Remove the stale container (best-effort; ignore exit code in case it
		// is already absent).
		spawnFn('docker', ['rm', '-f', containerName]);
		runWorkerContainer({
			spawnFn,
			build: opts.build,
			run: { containerName, workspaceFolder: opts.workspaceFolder, imageTag },
		});
		return { action: 'rebuilt' };
	}

	// --- Branches 1-3: probe container running state ---
	// `docker inspect -f {{.State.Running}} <name>` returns:
	//   stdout "true"  + exit 0 → container is running
	//   stdout "false" + exit 0 → container exists but is stopped
	//   exit non-zero           → container is absent (no such object)
	const inspect = probe(['inspect', '-f', '{{.State.Running}}', containerName]);

	if (inspect.exitCode !== 0) {
		// Branch 3: absent → build + run
		runWorkerContainer({
			spawnFn,
			build: opts.build,
			run: { containerName, workspaceFolder: opts.workspaceFolder, imageTag },
		});
		return { action: 'created' };
	}

	if (inspect.stdout.trim() === 'true') {
		// Branch 1: running → reuse (no-op)
		return { action: 'reused' };
	}

	// Branch 2: stopped → docker start
	spawnFn('docker', ['start', containerName]);
	return { action: 'started' };
}

// ---------------------------------------------------------------------------
// Production factory
// ---------------------------------------------------------------------------

/**
 * Build the production `ensureContainerFn` closure for the sidecar boot path.
 *
 * Returns a zero-argument thunk that calls `ensureWorkerContainer` with:
 *   - a `spawnSync`-backed `ContainerSpawnFn`
 *   - a `spawnSync`-backed `DockerProbe` (docker binary, no sudo)
 *   - a `statSync`-backed `StatFn` for Dockerfile mtime comparison
 *   - `workspaceFolder` set to `cwd`
 *
 * Called by `runSidecar` when `readWorkerIsolation() === 'container'`.
 * Tests inject `options.ensureContainerFn` directly (never go through this
 * factory) so no real Docker daemon is required in CI.
 */
export function makeProductionEnsureContainerFn(cwd: string): () => void {
	return (): void => {
		const spawnFn: ContainerSpawnFn = (cmd, args) => {
			const r = spawnSync(cmd, args, { encoding: 'utf8' });
			return {
				stdout: typeof r.stdout === 'string' ? r.stdout : '',
				exitCode: r.status ?? 1,
			};
		};
		const probe: DockerProbe = (args) => {
			const r = spawnSync('docker', args, { encoding: 'utf8' });
			return {
				stdout: typeof r.stdout === 'string' ? r.stdout : '',
				exitCode: r.status ?? 1,
			};
		};
		const statFn: StatFn = (path) => {
			try {
				return statSync(path);
			} catch {
				return null;
			}
		};
		const { uid: hostUid, gid: hostGid } = resolveHostIds(spawnFn);
		ensureWorkerContainer({
			spawnFn,
			probe,
			statFn,
			workspaceFolder: cwd,
			build: { hostUid, hostGid },
		});
	};
}
