// src/supervisor/container-firewall.ts
//
// Firewall application helper for the cam-worker container (US-001, CAM-176).
//
// Exports:
//   buildFirewallExecArgv  - pure builder: returns the `docker exec` argv to
//                            run init-firewall.sh inside the cam-worker container.
//   applyContainerFirewall - drives the docker exec call through an injectable
//                            FirewallSpawnFn; returns a discriminated result
//                            (never throws).
//   FirewallError          - typed Error subclass; thrown by callers (not here)
//                            when applyContainerFirewall returns {ok:false}.
//
// Design:
//   applyContainerFirewall never throws.  The throw of FirewallError lives in
//   the caller (ensure-container.ts: ensureWorkerContainer when firewallSpawnFn
//   is provided) so unit tests of the pure helper stay throw-free and the
//   production path can catch the typed error with instanceof.
//
// Dockerfile sudoers grant (CAM-176 gotcha):
//   bun ALL=(root) NOPASSWD: /bin/bash /workspace/.devcontainer/init-firewall.sh
//   sudo resolves "bash" to /bin/bash via PATH; the NOPASSWD grant is on the
//   ABSOLUTE path, so the exec argv must use absolute path.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable spawn function for the firewall exec call.
 * Unlike ContainerSpawnFn, this also captures stderr so the caller can
 * include a stderrTail in the FirewallError for operator diagnosis.
 */
export type FirewallSpawnFn = (
	cmd: string,
	args: string[],
) => { stdout: string; stderr: string; exitCode: number };

/** Successful firewall application. */
export interface ApplyFirewallOk {
	ok: true;
}

/** Failed firewall application — never thrown; returned for the caller to handle. */
export interface ApplyFirewallFail {
	ok: false;
	exitCode: number;
	/** Last N lines of the container's stderr, for operator diagnosis. */
	stderrTail: string;
}

export type ApplyFirewallResult = ApplyFirewallOk | ApplyFirewallFail;

// ---------------------------------------------------------------------------
// buildFirewallExecArgv
// ---------------------------------------------------------------------------

/**
 * Return the `docker exec` argument vector to run init-firewall.sh inside
 * the named container.
 *
 * Shape: `['exec', containerName, 'sudo', 'bash', '/workspace/.devcontainer/init-firewall.sh']`
 *
 * Why `bash` not `sh`:
 *   The Dockerfile sudoers grant is exactly:
 *     `bun ALL=(root) NOPASSWD: /bin/bash /workspace/.devcontainer/init-firewall.sh`
 *   sudo resolves "bash" to /bin/bash via PATH before matching rules, so this
 *   argv is equivalent to specifying /bin/bash directly.
 */
export function buildFirewallExecArgv(containerName: string): string[] {
	return ['exec', containerName, 'sudo', 'bash', '/workspace/.devcontainer/init-firewall.sh'];
}

// ---------------------------------------------------------------------------
// applyContainerFirewall
// ---------------------------------------------------------------------------

/**
 * Run `init-firewall.sh` inside `containerName` via `docker exec`, driven
 * through the injectable `spawnFn`.
 *
 * Returns `{ok:true}` when the script exits 0, or
 * `{ok:false, exitCode, stderrTail}` on non-zero exit.
 *
 * NEVER throws.  The throw of FirewallError is the caller's responsibility.
 */
export function applyContainerFirewall(
	containerName: string,
	spawnFn: FirewallSpawnFn,
): ApplyFirewallResult {
	const argv = buildFirewallExecArgv(containerName);
	const result = spawnFn('docker', argv);

	if (result.exitCode === 0) {
		return { ok: true };
	}

	// Trim the stderr to a short tail for the operator message.
	const lines = result.stderr.split('\n').filter((l) => l.length > 0);
	const stderrTail = lines.slice(-5).join('\n');

	return { ok: false, exitCode: result.exitCode, stderrTail };
}

// ---------------------------------------------------------------------------
// FirewallError
// ---------------------------------------------------------------------------

/**
 * Typed error thrown by `ensureWorkerContainer` when the firewall init script
 * exits non-zero.  Caught specifically (instanceof check) in `runSidecar` to
 * log the stderrTail and abort the sidecar boot without entering
 * `runSidecarLoop`.
 */
export class FirewallError extends Error {
	/** Last N lines of the container's stderr, for operator diagnosis. */
	stderrTail: string;

	constructor(stderrTail: string) {
		super(`cam-worker container firewall init failed: ${stderrTail}`);
		this.name = 'FirewallError';
		this.stderrTail = stderrTail;
	}
}
