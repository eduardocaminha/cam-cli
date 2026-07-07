// src/supervisor/preflight-container.ts
//
// Docker preflight helper for the cam worker container.
//
// Checks two conditions before dispatching a worker into the container:
//   1. The Docker daemon is reachable (`docker info` exits 0).
//   2. The worker image exists and is not stale relative to the Dockerfile.
//
// Design: all Docker calls are routed through an injectable `probe` function
// so the unit tests can assert behavior with a fake and never shell out to a
// real daemon. CI runs on macos-latest with no Docker installed.
//
// This helper is intentionally NOT wired into the dispatch path. It is a
// tested-but-uncalled exported helper (Half-B wiring is CAM-150). knip treats
// test files as entry points, so the export is reachable via the test.
//
// noUncheckedIndexedAccess: no array indexing in this file; guard is noted.

/**
 * Injectable docker probe. Accepts an argv array (without the leading "docker"
 * binary name) and returns the stdout string plus exit code.
 *
 * Example: `probe(['info'])` is equivalent to running `docker info` and
 * capturing its combined output + exit status.
 */
export type DockerProbe = (args: string[]) => { stdout: string; exitCode: number };

/**
 * Optional filesystem stat seam used for the image-stale check.
 * Returns `{ mtimeMs: number }` on success, or `null` when the path is absent
 * or stat fails. Keeping this separate from `probe` isolates the file-I/O
 * surface from the Docker-I/O surface.
 */
export type StatFn = (path: string) => { mtimeMs: number } | null;

/**
 * Discriminated union returned by `preflightWorkerContainer`.
 *
 *   - `{ ready: true }` — daemon is reachable and the image is present and
 *     current.
 *   - `{ ready: false; reason: 'daemon-unreachable' }` — the Docker daemon is
 *     not reachable (socket absent, dockerd not running, permission error, …).
 *   - `{ ready: false; reason: 'image-missing' }` — the daemon is reachable
 *     but the worker image does not exist locally.
 *   - `{ ready: false; reason: 'image-stale' }` — the image exists but was
 *     built before the Dockerfile was last modified (stale image).
 *   - `{ ready: false; reason: 'toolchain-mismatch' }` — the running
 *     container's bun/node version has drifted from the repo pins (see
 *     `assertContainerToolchain` in `toolchain-assert.ts`, US-006/CAM-201).
 *     Reserved here so callers can branch on a distinct reason; the actual
 *     computation of this branch inside `preflightWorkerContainer` is wired
 *     by US-007 (this story lands the assert helper tested-but-inert, same
 *     as this file did before its own CAM-150 wiring).
 */
export type PreflightResult =
	| { ready: true }
	| {
			ready: false;
			reason: 'daemon-unreachable' | 'image-missing' | 'image-stale' | 'toolchain-mismatch';
	  };

/** Options for `preflightWorkerContainer`. */
export interface PreflightWorkerContainerOptions {
	/** Injectable docker probe (required). Never shells out by default. */
	probe: DockerProbe;

	/**
	 * Docker image tag to inspect.
	 * Defaults to `'cam-worker:latest'`.
	 */
	imageTag?: string;

	/**
	 * Optional stat function for the Dockerfile mtime check.
	 * When omitted the image-stale check is skipped.
	 */
	statFn?: StatFn;

	/**
	 * Path to the Dockerfile whose mtime is compared against the image
	 * creation timestamp. Defaults to `'.devcontainer/Dockerfile'`.
	 */
	dockerfilePath?: string;
}

/**
 * Run the Docker preflight checks for the cam worker container.
 *
 * 1. Probe daemon reachability via `docker info`.
 * 2. Probe image existence via `docker image inspect <imageTag>`.
 * 3. (Optional) Detect a stale image by comparing the image creation timestamp
 *    to the Dockerfile mtime via `statFn`.
 *
 * All Docker calls are routed through the injectable `probe`; no real daemon
 * is touched at import time or when the options omit the dependency.
 */
export function preflightWorkerContainer(
	opts: PreflightWorkerContainerOptions,
): PreflightResult {
	const {
		probe,
		imageTag = 'cam-worker:latest',
		statFn,
		dockerfilePath = '.devcontainer/Dockerfile',
	} = opts;

	// --- Step 1: daemon reachable? ---
	// `docker info` exits 0 when the daemon is running and reachable.
	// Any non-zero exit (socket absent, permission denied, timeout, …) means
	// the daemon is unreachable.
	const daemonCheck = probe(['info']);
	if (daemonCheck.exitCode !== 0) {
		return { ready: false, reason: 'daemon-unreachable' };
	}

	// --- Step 2: image present? ---
	// `docker image inspect <tag>` exits 0 when the image exists locally.
	// Exit 1 (or any non-zero) means the image is missing.
	const imageCheck = probe(['image', 'inspect', imageTag]);
	if (imageCheck.exitCode !== 0) {
		return { ready: false, reason: 'image-missing' };
	}

	// --- Step 3: image stale? (optional) ---
	// When `statFn` is provided, compare the image creation timestamp reported
	// by `docker image inspect --format={{.Created}}` against the Dockerfile
	// mtime. If the Dockerfile is newer, the image is stale.
	if (statFn !== undefined) {
		const createdCheck = probe(['image', 'inspect', imageTag, '--format={{.Created}}']);
		const dockerfileStat = statFn(dockerfilePath);
		if (createdCheck.exitCode === 0 && dockerfileStat !== null) {
			const createdRaw = createdCheck.stdout.trim();
			const imageCreatedMs = createdRaw.length > 0 ? new Date(createdRaw).getTime() : NaN;
			if (!Number.isNaN(imageCreatedMs) && dockerfileStat.mtimeMs > imageCreatedMs) {
				return { ready: false, reason: 'image-stale' };
			}
		}
	}

	return { ready: true };
}
