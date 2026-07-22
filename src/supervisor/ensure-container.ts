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
import {
	applyContainerFirewall,
	FirewallError,
	type FirewallSpawnFn,
} from './container-firewall.ts';
import {
	applyContainerConfig,
	ContainerConfigError,
	type ConfigSpawnFn,
} from './container-config.ts';
import {
	applyContainerAuthCheck,
	ContainerAuthError,
	type AuthCheckSpawnFn,
} from './container-auth.ts';
import {
	assertContainerToolchain,
	ToolchainMismatchError,
	type ToolchainExecFn,
} from './toolchain-assert.ts';
import type { ReadFileFn } from '../config/toolchain.ts';

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

	/**
	 * Injectable spawn function for the firewall exec call.
	 *
	 * When provided, `ensureWorkerContainer` calls `applyContainerFirewall`
	 * UNCONDITIONALLY after the 4-branch reconcile returns, regardless of which
	 * action was taken.  If the firewall exits non-zero, a `FirewallError` is
	 * thrown so the caller (sidecar boot) can abort fail-closed.
	 *
	 * Unlike `ContainerSpawnFn`, this type also captures stderr so the
	 * `stderrTail` is available for operator diagnosis.
	 *
	 * When absent, no firewall call is made (host-mode / legacy tests).
	 */
	firewallSpawnFn?: FirewallSpawnFn;

	/**
	 * Injectable spawn function for the config repair exec calls.
	 *
	 * When provided, `ensureWorkerContainer` calls `applyContainerConfig`
	 * UNCONDITIONALLY after the 4-branch reconcile (and after the firewall
	 * apply), regardless of which action was taken.  This ensures that a
	 * reused container (which persists a corrupted .claude.json across sidecar
	 * ticks) has its config repaired on every boot.
	 *
	 * The HOST_UID/HOST_GID resolved by `resolveHostIds` (already present in
	 * `opts.build`) are threaded into the chown step so the chown target is
	 * the numeric `uid:gid` form rather than a hardcoded named user.
	 *
	 * If either exec step exits non-zero, a `ContainerConfigError` is thrown
	 * so the caller (sidecar boot) can abort fail-closed.
	 *
	 * When absent, no config call is made (host-mode / legacy callers).
	 */
	configSpawnFn?: ConfigSpawnFn;

	/**
	 * Injectable spawn function for the in-container claude auth check exec
	 * call (US-003, CAM-241).
	 *
	 * When provided, `ensureWorkerContainer` calls `applyContainerAuthCheck`
	 * UNCONDITIONALLY after `applyConfigIfPresent`, regardless of which action
	 * was taken. This ensures a reused running container (no docker reconcile
	 * call at all) that has silently lost its OAuth token is still caught
	 * before a worker is dispatched into it.
	 *
	 * If the probe reports `loggedIn !== true` (or exits non-zero, or its
	 * stdout is unparsable), a `ContainerAuthError` is thrown so the caller
	 * (sidecar boot) can abort fail-closed.
	 *
	 * When absent, no auth check call is made (host-mode / legacy callers).
	 */
	authCheckSpawnFn?: AuthCheckSpawnFn;

	/**
	 * Injectable exec seam for the US-006/US-007 toolchain assert (two cheap
	 * `docker exec <containerName> bun|node --version` calls).
	 *
	 * When provided, `ensureWorkerContainer` calls `assertContainerToolchain`
	 * UNCONDITIONALLY after the 4-branch reconcile returns, regardless of which
	 * action was taken. On a mismatch it tears down the container (`docker rm -f`)
	 * and rebuilds via `runWorkerContainer` (same `--build-arg BUN_VERSION` /
	 * `HOST_UID` / `HOST_GID` path as the image-stale branch), then re-asserts.
	 *
	 * A rebuild failure (non-zero build/run exit) or a still-mismatching
	 * re-assert throws `ToolchainMismatchError` so the caller (sidecar boot /
	 * per-cycle dispatch guard) can abort fail-closed: dispatch is allowed only
	 * after a passing re-assert.
	 *
	 * The docker build is triggered ONLY on an actual mismatch (never
	 * unconditionally per ensure call): a reused+matching container produces
	 * zero build/rm calls, just the two cheap toolchain-probe execs.
	 *
	 * When absent, no toolchain assert is made (host-mode / legacy callers).
	 */
	toolchainExecFn?: ToolchainExecFn;

	/**
	 * Override the `.bun-version` path forwarded to `assertContainerToolchain`.
	 * Tests use this (paired with `toolchainReadFileFn`) to avoid depending on
	 * the real repo-root pin file contents.
	 */
	toolchainBunVersionPath?: string;

	/** Override the `.tool-versions` path forwarded to `assertContainerToolchain`. */
	toolchainToolVersionsPath?: string;

	/** Injectable file reader forwarded to `assertContainerToolchain`'s pin readers. */
	toolchainReadFileFn?: ReadFileFn;
}

// ---------------------------------------------------------------------------
// Step helpers (extracted to keep ensureWorkerContainer under biome complexity 15)
// ---------------------------------------------------------------------------

/**
 * Apply the container egress firewall unconditionally.
 * No-op when `firewallSpawnFn` is absent (host mode / legacy callers).
 * Throws `FirewallError` when the firewall script exits non-zero.
 */
function applyFirewallIfPresent(
	containerName: string,
	firewallSpawnFn: FirewallSpawnFn | undefined,
): void {
	if (firewallSpawnFn === undefined) return;
	const fwResult = applyContainerFirewall(containerName, firewallSpawnFn);
	if (!fwResult.ok) {
		throw new FirewallError(fwResult.stderrTail);
	}
}

/**
 * Apply both config-repair steps (chown + node merge) unconditionally.
 * No-op when `configSpawnFn` is absent (host mode / legacy callers).
 * Throws `ContainerConfigError` when either exec step exits non-zero.
 *
 * `hostUid`/`hostGid` come from `resolveHostIds` (via `opts.build`) in the
 * production factory and are threaded into `buildChownExecArgv` so the chown
 * target is the numeric uid:gid form, not a hardcoded named user.
 */
function applyConfigIfPresent(
	containerName: string,
	configSpawnFn: ConfigSpawnFn | undefined,
	hostUid: number | undefined,
	hostGid: number | undefined,
): void {
	if (configSpawnFn === undefined) return;
	const cfgResult = applyContainerConfig(containerName, configSpawnFn, {
		uid: hostUid,
		gid: hostGid,
	});
	if (!cfgResult.ok) {
		throw new ContainerConfigError(cfgResult.stderrTail);
	}
}

/**
 * Run the in-container claude auth check unconditionally (US-003, CAM-241).
 * No-op when `authCheckSpawnFn` is absent (host mode / legacy callers).
 * Throws `ContainerAuthError` when the probe reports the container as
 * unauthenticated (non-zero exit, unparsable stdout, or `loggedIn !== true`).
 */
function applyAuthCheckIfPresent(
	containerName: string,
	authCheckSpawnFn: AuthCheckSpawnFn | undefined,
): void {
	if (authCheckSpawnFn === undefined) return;
	const authResult = applyContainerAuthCheck(containerName, authCheckSpawnFn);
	if (!authResult.ok) {
		throw new ContainerAuthError(authResult.stderrTail);
	}
}

/**
 * Run the US-006/US-007 toolchain assert unconditionally, auto-rebuilding on
 * a mismatch. No-op when `toolchainExecFn` is absent (host mode / legacy
 * callers). Returns `'rebuilt'` when a rebuild was triggered (so the caller
 * can update `action`), or `null` when no rebuild was needed (assert absent
 * or already passing).
 *
 * Throws `ToolchainMismatchError` when the rebuild itself fails to converge
 * (non-zero build/run exit) or the re-assert after a successful rebuild still
 * reports a mismatch. Dispatch is allowed only after a passing re-assert.
 */
function applyToolchainIfPresent(
	containerName: string,
	imageTag: string,
	toolchainExecFn: ToolchainExecFn | undefined,
	opts: Pick<EnsureWorkerContainerOptions, 'spawnFn' | 'workspaceFolder' | 'build'> & {
		toolchainBunVersionPath?: string;
		toolchainToolVersionsPath?: string;
		toolchainReadFileFn?: ReadFileFn;
	},
): EnsureContainerAction | null {
	if (toolchainExecFn === undefined) return null;

	const assertOpts = {
		containerName,
		execFn: toolchainExecFn,
		bunVersionPath: opts.toolchainBunVersionPath,
		toolVersionsPath: opts.toolchainToolVersionsPath,
		readFileFn: opts.toolchainReadFileFn,
	};
	const first = assertContainerToolchain(assertOpts);
	if (first.ok) return null;

	// Mismatch: tear down and rebuild (mirrors the image-stale branch), then
	// re-assert. The docker build is triggered ONLY here (on an actual
	// mismatch), never unconditionally.
	opts.spawnFn('docker', ['rm', '-f', containerName]);
	const rebuildResult = runWorkerContainer({
		spawnFn: opts.spawnFn,
		build: opts.build,
		run: { containerName, workspaceFolder: opts.workspaceFolder, imageTag },
	});
	if (rebuildResult.buildExitCode !== 0 || rebuildResult.runExitCode !== 0) {
		throw new ToolchainMismatchError(first.mismatches, 'rebuild-failed');
	}

	const second = assertContainerToolchain(assertOpts);
	if (!second.ok) {
		throw new ToolchainMismatchError(second.mismatches, 'still-mismatched');
	}

	return 'rebuilt';
}

/**
 * Run the 4-branch reconcile (running/stopped/absent/image-stale) and return
 * the action taken. Extracted from `ensureWorkerContainer` to keep that
 * function under biome's noExcessiveLinesPerFunction(maxLines=80) limit.
 */
function reconcileContainerAction(
	opts: Pick<EnsureWorkerContainerOptions, 'spawnFn' | 'probe' | 'statFn' | 'workspaceFolder' | 'build'>,
	containerName: string,
	imageTag: string,
	dockerfilePath: string,
): EnsureContainerAction {
	const { spawnFn, probe, statFn } = opts;

	// --- Branch 4: image-stale detection ---
	// preflightWorkerContainer checks daemon reachability, image existence, and
	// Dockerfile mtime.  When it returns `image-stale` the existing container
	// (if any) must be torn down so the rebuilt image can replace it.
	const preflight = preflightWorkerContainer({ probe, statFn, imageTag, dockerfilePath });

	if (preflight.ready === false && preflight.reason === 'image-stale') {
		// Remove the stale container (best-effort; ignore exit code in case it
		// is already absent).
		spawnFn('docker', ['rm', '-f', containerName]);
		runWorkerContainer({
			spawnFn,
			build: opts.build,
			run: { containerName, workspaceFolder: opts.workspaceFolder, imageTag },
		});
		return 'rebuilt';
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
		return 'created';
	}
	if (inspect.stdout.trim() === 'true') {
		// Branch 1: running → reuse (no-op)
		return 'reused';
	}
	// Branch 2: stopped → docker start
	spawnFn('docker', ['start', containerName]);
	return 'started';
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
	const containerName = opts.containerName ?? DEFAULT_CONTAINER_NAME;
	const imageTag = opts.imageTag ?? DEFAULT_IMAGE_TAG;
	const dockerfilePath = opts.dockerfilePath ?? '.devcontainer/Dockerfile';

	// --- Branches 1-4: reconcile to a running state ---
	// (running -> reuse | stopped -> start | absent -> created | image-stale -> rebuilt)
	let action = reconcileContainerAction(opts, containerName, imageTag, dockerfilePath);

	// --- Unconditional toolchain assert (US-006/US-007) ---
	// Runs after the 4-branch reconcile above, regardless of which action was
	// taken, so a merged pin bump is caught even on a `reused` (already-running)
	// container. On mismatch: tear down + rebuild + re-assert (updates `action`
	// to 'rebuilt'). Throws ToolchainMismatchError when the rebuild cannot
	// converge; the caller (sidecar boot / per-cycle dispatch guard) aborts
	// fail-closed. When toolchainExecFn is absent, this is a complete no-op.
	const toolchainAction = applyToolchainIfPresent(containerName, imageTag, opts.toolchainExecFn, {
		spawnFn: opts.spawnFn,
		workspaceFolder: opts.workspaceFolder,
		build: opts.build,
		toolchainBunVersionPath: opts.toolchainBunVersionPath,
		toolchainToolVersionsPath: opts.toolchainToolVersionsPath,
		toolchainReadFileFn: opts.toolchainReadFileFn,
	});
	if (toolchainAction !== null) {
		action = toolchainAction;
	}

	// --- Unconditional firewall apply ---
	// Applies init-firewall.sh inside the container after EVERY reconcile
	// action (reused|started|created|rebuilt).  docker start/run recreates the
	// container netns and drops iptables/ipset rules; init-firewall.sh is
	// idempotent (flushes first), so running it every sidecar boot is safe.
	// When firewallSpawnFn is absent (host mode / legacy callers), this is a
	// complete no-op.
	applyFirewallIfPresent(containerName, opts.firewallSpawnFn);

	// --- Unconditional config apply ---
	// Runs both config-repair steps (chown + node merge) inside the container
	// after EVERY reconcile action (reused|started|created|rebuilt).  A reused
	// container persists a root-owned .claude dir or corrupted .claude.json
	// across sidecar ticks; running the repair on every boot is idempotent and
	// ensures zero EACCES and zero modal prompts.
	//
	// HOST_UID/HOST_GID come from opts.build (set by resolveHostIds in the
	// production factory), so the chown target is the correct numeric uid:gid
	// instead of a hardcoded named user.
	//
	// When configSpawnFn is absent (host mode / legacy callers), this is a
	// complete no-op.
	applyConfigIfPresent(containerName, opts.configSpawnFn, opts.build?.hostUid, opts.build?.hostGid);

	// --- Unconditional auth check apply (US-003, CAM-241) ---
	// Runs the in-container `claude auth status --json` probe after EVERY
	// reconcile action (reused|started|created|rebuilt), including the
	// running->reuse branch where no docker reconcile call happens at all.
	// A reused running container can silently lose its OAuth token between
	// sidecar ticks (e.g. token expiry, operator logout inside the container);
	// running this check on every boot catches that before a worker is
	// dispatched into an unauthenticated container.
	//
	// When authCheckSpawnFn is absent (host mode / legacy callers), this is a
	// complete no-op.
	applyAuthCheckIfPresent(containerName, opts.authCheckSpawnFn);

	return { action };
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
		// firewallSpawnFn wraps spawnSync with stderr capture for stderrTail.
		const firewallSpawnFn: FirewallSpawnFn = (cmd, args) => {
			const r = spawnSync(cmd, args, { encoding: 'utf8' });
			return {
				stdout: typeof r.stdout === 'string' ? r.stdout : '',
				stderr: typeof r.stderr === 'string' ? r.stderr : '',
				exitCode: r.status ?? 1,
			};
		};
		// configSpawnFn wraps spawnSync with stderr capture for stderrTail.
		// Same shape as firewallSpawnFn; kept as a separate closure so the
		// two seams remain independently injectable in tests.
		const configSpawnFn: ConfigSpawnFn = (cmd, args) => {
			const r = spawnSync(cmd, args, { encoding: 'utf8' });
			return {
				stdout: typeof r.stdout === 'string' ? r.stdout : '',
				stderr: typeof r.stderr === 'string' ? r.stderr : '',
				exitCode: r.status ?? 1,
			};
		};
		// toolchainExecFn wraps spawnSync with stderr capture, mirroring
		// firewallSpawnFn/configSpawnFn (US-007).
		const toolchainExecFn: ToolchainExecFn = (cmd, args) => {
			const r = spawnSync(cmd, args, { encoding: 'utf8' });
			return {
				stdout: typeof r.stdout === 'string' ? r.stdout : '',
				stderr: typeof r.stderr === 'string' ? r.stderr : '',
				exitCode: r.status ?? 1,
			};
		};
		// authCheckSpawnFn wraps spawnSync with stderr capture, mirroring
		// firewallSpawnFn/configSpawnFn/toolchainExecFn (US-003, CAM-241).
		const authCheckSpawnFn: AuthCheckSpawnFn = (cmd, args) => {
			const r = spawnSync(cmd, args, { encoding: 'utf8' });
			return {
				stdout: typeof r.stdout === 'string' ? r.stdout : '',
				stderr: typeof r.stderr === 'string' ? r.stderr : '',
				exitCode: r.status ?? 1,
			};
		};
		const { uid: hostUid, gid: hostGid } = resolveHostIds(spawnFn);
		// Throws FirewallError on firewall non-convergence; caught by runSidecar.
		// Throws ContainerConfigError on config repair failure; caught by runSidecar.
		// Throws ToolchainMismatchError on toolchain non-convergence; caught by
		// runSidecar (boot) and the per-cycle dispatch guard in runSupervisor.
		// Throws ContainerAuthError on an unauthenticated container; caught by
		// runSidecar (boot) so a lost token is caught before dispatch.
		ensureWorkerContainer({
			spawnFn,
			probe,
			statFn,
			firewallSpawnFn,
			configSpawnFn,
			authCheckSpawnFn,
			toolchainExecFn,
			workspaceFolder: cwd,
			build: { hostUid, hostGid },
		});
	};
}
