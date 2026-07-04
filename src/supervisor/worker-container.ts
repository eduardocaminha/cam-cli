// src/supervisor/worker-container.ts
//
// Worker-container substrate: builds the cam-worker Docker image from
// .devcontainer/Dockerfile and starts ONE long-lived named container.
//
// Exports:
//   buildDockerBuildArgv  - pure builder for `docker build` argv
//   buildDockerRunArgv    - pure builder for `docker run -d --name` argv
//   runWorkerContainer    - orchestration fn that drives build+run through an
//                           injectable spawnFn (never touches a real daemon at
//                           import time)
//
// Credential threading: GITHUB_TOKEN and CLAUDE_CODE_OAUTH_TOKEN are passed
// by NAME only (`-e GITHUB_TOKEN`, `-e CLAUDE_CODE_OAUTH_TOKEN`) so Docker
// inherits the values from the sidecar process.env at run time. Bun auto-loads
// .env on startup, so any values set there are already in the sidecar env.
// No token value is ever hardcoded or written to stdout/stderr.
//
// This module is intentionally NOT wired into any dispatch path in B-1
// (loop.ts / plan-runner.ts are unchanged). It is a tested-but-inert substrate
// for B-2 Half-B wiring (CAM-150).
//
// noUncheckedIndexedAccess: no unguarded array indexing in this file.

/** Default Docker image tag built and run by this module. */
export const DEFAULT_IMAGE_TAG = 'cam-worker:latest';

/** Default name for the long-lived worker container. */
export const DEFAULT_CONTAINER_NAME = 'cam-worker';

// ---------------------------------------------------------------------------
// Injectable SpawnFn seam
// ---------------------------------------------------------------------------

/**
 * Injectable spawn function for `runWorkerContainer`.
 *
 * Accepts the binary name (e.g. `'docker'`) and its argv; returns the combined
 * stdout string and the process exit code. This seam keeps `runWorkerContainer`
 * testable on CI runners with no Docker daemon (macos-latest has none). A
 * production caller wraps `spawnSync`; tests inject a recording fake.
 */
export type ContainerSpawnFn = (cmd: string, args: string[]) => { stdout: string; exitCode: number };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for `buildDockerBuildArgv`. */
export interface DockerBuildArgvOptions {
	/**
	 * Path to the Dockerfile passed via `-f`.
	 * Defaults to `'.devcontainer/Dockerfile'`.
	 */
	dockerfilePath?: string;

	/**
	 * Image tag applied with `-t`.
	 * Defaults to `'cam-worker:latest'`.
	 */
	imageTag?: string;

	/**
	 * Build context path (the directory Docker sends to the daemon).
	 * Defaults to `'.'` (repo root).
	 */
	buildContext?: string;

	/**
	 * Host UID to pass as the HOST_UID build-arg, re-homing the bun user so the
	 * container process uid matches the bind-mounted /workspace owner.
	 * Must be paired with `hostGid`; if either is absent no --build-arg is emitted.
	 */
	hostUid?: number;

	/**
	 * Host GID to pass as the HOST_GID build-arg.
	 * Must be paired with `hostUid`; if either is absent no --build-arg is emitted.
	 */
	hostGid?: number;
}

/** Options for `buildDockerRunArgv`. */
export interface DockerRunArgvOptions {
	/**
	 * Container name passed to `--name`. Must be unique on the Docker host.
	 * Defaults to `'cam-worker'`.
	 */
	containerName?: string;

	/**
	 * Docker image tag to run.
	 * Defaults to `'cam-worker:latest'`.
	 */
	imageTag?: string;

	/**
	 * Absolute path to the local workspace folder. Bind-mounted read-write to
	 * `/workspace` inside the container (mirrors `workspaceMount` in
	 * `.devcontainer/devcontainer.json`).
	 */
	workspaceFolder: string;
}

/** Options for `runWorkerContainer`. */
export interface RunWorkerContainerOptions {
	/**
	 * Injectable spawn function. Never shells out by default.
	 * Production callers wrap `spawnSync`; tests inject a recording fake.
	 */
	spawnFn: ContainerSpawnFn;

	/** Options forwarded to `buildDockerBuildArgv`. */
	build?: DockerBuildArgvOptions;

	/** Options forwarded to `buildDockerRunArgv`. */
	run: DockerRunArgvOptions;
}

// ---------------------------------------------------------------------------
// resolveHostIds
// ---------------------------------------------------------------------------

/** The resolved host uid/gid used to re-home the bun user in the worker image. */
export interface HostIds {
	uid: number;
	gid: number;
}

const FALLBACK_ID = 1000;

/**
 * Resolve the host user's uid and gid by calling `id -u` / `id -g` through the
 * injectable `spawnFn`.
 *
 * Falls back to `{ uid: 1000, gid: 1000 }` (or per-component) when:
 *   - the command exits with a non-zero code
 *   - stdout is empty or undefined
 *   - the parsed value is NaN (non-numeric output)
 *
 * noUncheckedIndexedAccess: stdout is guarded with a trim + empty-check before
 * parseInt so the undefined/empty case is handled explicitly.
 */
export function resolveHostIds(spawnFn: ContainerSpawnFn): HostIds {
	const parseId = (result: { stdout: string; exitCode: number }): number => {
		if (result.exitCode !== 0) return FALLBACK_ID;
		const trimmed = result.stdout.trim();
		if (!trimmed) return FALLBACK_ID;
		const parsed = Number.parseInt(trimmed, 10);
		return Number.isNaN(parsed) ? FALLBACK_ID : parsed;
	};
	const uidResult = spawnFn('id', ['-u']);
	const gidResult = spawnFn('id', ['-g']);
	return {
		uid: parseId(uidResult),
		gid: parseId(gidResult),
	};
}

// ---------------------------------------------------------------------------
// Pure argv builders
// ---------------------------------------------------------------------------

/**
 * Build the argv for `docker build` (without the leading `'docker'` binary).
 *
 * Default resulting command:
 *
 *   docker build -t cam-worker:latest -f .devcontainer/Dockerfile .
 */
export function buildDockerBuildArgv(opts?: DockerBuildArgvOptions): string[] {
	const dockerfilePath = opts?.dockerfilePath ?? '.devcontainer/Dockerfile';
	const imageTag = opts?.imageTag ?? DEFAULT_IMAGE_TAG;
	const buildContext = opts?.buildContext ?? '.';
	const argv = ['build', '-t', imageTag, '-f', dockerfilePath];
	if (opts?.hostUid !== undefined && opts?.hostGid !== undefined) {
		argv.push('--build-arg', `HOST_UID=${opts.hostUid}`, '--build-arg', `HOST_GID=${opts.hostGid}`);
	}
	argv.push(buildContext);
	return argv;
}

/**
 * Build the argv for `docker run -d --name <container>` (without the leading
 * `'docker'` binary). The resulting argv mirrors `.devcontainer/devcontainer.json`
 * exactly:
 *
 *   - `--cap-add=NET_ADMIN`, `--cap-add=NET_RAW`  (from `runArgs`)
 *   - workspace bind-mount to `/workspace`          (from `workspaceMount`)
 *   - named `claude-code-config` volume at `/home/bun/.claude` (from `mounts`)
 *   - `--user bun`                                  (from `remoteUser`)
 *   - `-e DISABLE_AUTOUPDATER=1`                   (from `containerEnv`)
 *   - `-e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (from `containerEnv`)
 *   - `-e GITHUB_TOKEN`             (name-only: inherits from sidecar env)
 *   - `-e CLAUDE_CODE_OAUTH_TOKEN`  (name-only: inherits from sidecar env)
 *
 * The name-only `-e VAR` form (no `=` suffix) instructs Docker to read the
 * value from the host process environment at `docker run` time. Bun auto-loads
 * `.env`, so the sidecar env already contains these values.
 */
export function buildDockerRunArgv(opts: DockerRunArgvOptions): string[] {
	const containerName = opts.containerName ?? DEFAULT_CONTAINER_NAME;
	const imageTag = opts.imageTag ?? DEFAULT_IMAGE_TAG;
	return [
		'run',
		'-d',
		'--name',
		containerName,
		// runArgs from devcontainer.json
		'--cap-add=NET_ADMIN',
		'--cap-add=NET_RAW',
		// workspaceMount (bind the local workspace into /workspace)
		'--mount',
		`source=${opts.workspaceFolder},target=/workspace,type=bind`,
		// mounts[0]: named volume for claude config persistence
		'--mount',
		'source=claude-code-config,target=/home/bun/.claude,type=volume',
		// remoteUser
		'--user',
		'bun',
		// containerEnv (literal key=value is correct for non-secret config)
		'-e',
		'DISABLE_AUTOUPDATER=1',
		'-e',
		'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
		// Credential env vars: NAME-ONLY form so Docker inherits the value
		// from the sidecar process.env. Never embed a literal token value.
		'-e',
		'GITHUB_TOKEN',
		'-e',
		'CLAUDE_CODE_OAUTH_TOKEN',
		imageTag,
		// Keep the container alive for future `docker exec` dispatch
		'sleep',
		'infinity',
	];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Result returned by `runWorkerContainer`. */
export interface RunWorkerContainerResult {
	/** Exit code of `docker build`. 0 on success. */
	buildExitCode: number;
	/**
	 * Exit code of `docker run -d`. 0 on success.
	 * `-1` when the build step failed and the run step was skipped.
	 */
	runExitCode: number;
}

/**
 * Build the cam-worker image and start the long-lived named container.
 *
 * Steps:
 *   1. Invoke `docker build` via the injectable `spawnFn`.
 *   2. If build exits 0, invoke `docker run -d --name`.
 *   3. Return both exit codes.
 *
 * The function is side-effect-free unless explicitly called; no Docker call is
 * made at module import time. Pass a recording fake as `spawnFn` in tests.
 */
export function runWorkerContainer(opts: RunWorkerContainerOptions): RunWorkerContainerResult {
	const buildArgv = buildDockerBuildArgv(opts.build);
	const buildResult = opts.spawnFn('docker', buildArgv);

	if (buildResult.exitCode !== 0) {
		return { buildExitCode: buildResult.exitCode, runExitCode: -1 };
	}

	const runArgv = buildDockerRunArgv(opts.run);
	const runResult = opts.spawnFn('docker', runArgv);

	return { buildExitCode: 0, runExitCode: runResult.exitCode };
}
