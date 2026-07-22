// src/supervisor/container-auth.ts
//
// In-container claude auth probe for the cam-worker container (US-002, CAM-241).
//
// Exports:
//   buildAuthCheckExecArgv  - pure builder: returns the `docker exec` argv to
//                             run `claude auth status --json` inside the
//                             cam-worker container.
//   applyContainerAuthCheck - drives the docker exec call through an
//                             injectable AuthCheckSpawnFn; returns a
//                             discriminated result (never throws).
//   ContainerAuthError      - typed Error subclass; thrown by callers (not
//                             here) when applyContainerAuthCheck returns
//                             {ok:false}.
//
// Design:
//   applyContainerAuthCheck never throws. The throw of ContainerAuthError
//   lives in the caller (US-003: ensureWorkerContainer / the sidecar boot
//   path) so unit tests of the pure helper stay throw-free and the
//   production path can catch the typed error with instanceof.
//
//   Mirrors src/supervisor/container-firewall.ts structurally, but the probe
//   is NON-INTERACTIVE and requires no privilege escalation: no `-it`, no
//   `sudo`. The exec target is `claude`, not a firewall script.
//
//   The JSON parse/loggedIn convention is reused from
//   src/commands/run-auth-preflight.ts (parseAuthJson): `loggedIn !== true`
//   is treated as not-authenticated, fail-closed on any parse failure.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable spawn function for the in-container auth check exec call.
 * Captures stderr so the caller can include a stderrTail in the
 * ContainerAuthError for operator diagnosis (mirrors FirewallSpawnFn).
 */
export type AuthCheckSpawnFn = (
	cmd: string,
	args: string[],
) => { stdout: string; stderr: string; exitCode: number };

/** Successful in-container auth check. */
export interface ApplyAuthCheckOk {
	ok: true;
}

/** Failed in-container auth check — never thrown; returned for the caller to handle. */
export interface ApplyAuthCheckFail {
	ok: false;
	exitCode: number;
	/** Last N lines of the container's stderr, for operator diagnosis. */
	stderrTail: string;
}

export type ApplyAuthCheckResult = ApplyAuthCheckOk | ApplyAuthCheckFail;

// ---------------------------------------------------------------------------
// buildAuthCheckExecArgv
// ---------------------------------------------------------------------------

/**
 * Return the `docker exec` argument vector to run the non-interactive claude
 * auth status probe inside the named container.
 *
 * Shape: `['exec', containerName, 'claude', 'auth', 'status', '--json']`
 *
 * No `-it` (non-interactive: this is a scripted probe, not a tmux pane) and
 * no `sudo` (the probe reads the bun user's own claude auth state; unlike
 * buildFirewallExecArgv it needs no privilege escalation).
 */
export function buildAuthCheckExecArgv(containerName: string): string[] {
	return ['exec', containerName, 'claude', 'auth', 'status', '--json'];
}

// ---------------------------------------------------------------------------
// parseAuthJson (convention reused from src/commands/run-auth-preflight.ts)
// ---------------------------------------------------------------------------

/**
 * Parse the raw stdout string from `claude auth status --json`.
 * Returns `null` when parsing fails or the JSON is not a plain object.
 */
function parseAuthJson(raw: string): { loggedIn: unknown } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const p = parsed as Record<string, unknown>;
	return { loggedIn: p['loggedIn'] };
}

// ---------------------------------------------------------------------------
// applyContainerAuthCheck
// ---------------------------------------------------------------------------

/**
 * Run the non-interactive `claude auth status --json` probe inside
 * `containerName` via `docker exec`, driven through the injectable `spawnFn`.
 *
 * Returns `{ok:true}` when the exec exits 0 and the parsed JSON reports
 * `loggedIn === true`, or `{ok:false, exitCode, stderrTail}` otherwise
 * (non-zero exit, unparsable stdout, or `loggedIn !== true`). Fail-closed.
 *
 * NEVER throws. The throw of ContainerAuthError is the caller's responsibility.
 */
export function applyContainerAuthCheck(
	containerName: string,
	spawnFn: AuthCheckSpawnFn,
): ApplyAuthCheckResult {
	const argv = buildAuthCheckExecArgv(containerName);
	const result = spawnFn('docker', argv);

	const stderrLines = result.stderr.split('\n').filter((l) => l.length > 0);
	const stderrTail = stderrLines.slice(-5).join('\n');

	if (result.exitCode !== 0) {
		return { ok: false, exitCode: result.exitCode, stderrTail };
	}

	const authJson = parseAuthJson(result.stdout);
	if (authJson === null || authJson.loggedIn !== true) {
		return { ok: false, exitCode: result.exitCode, stderrTail };
	}

	return { ok: true };
}

// ---------------------------------------------------------------------------
// ContainerAuthError
// ---------------------------------------------------------------------------

/**
 * Typed error thrown by the container ensure path when the in-container
 * claude auth probe fails (mirrors FirewallError). Caught specifically
 * (instanceof check) so the caller can log the stderrTail and abort before
 * dispatching a worker against an unauthenticated container.
 */
export class ContainerAuthError extends Error {
	/** Last N lines of the container's stderr, for operator diagnosis. */
	stderrTail: string;

	constructor(stderrTail: string) {
		super(`cam-worker container auth check failed: ${stderrTail}`);
		this.name = 'ContainerAuthError';
		this.stderrTail = stderrTail;
	}
}
