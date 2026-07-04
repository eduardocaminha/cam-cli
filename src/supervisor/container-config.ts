// src/supervisor/container-config.ts
//
// Config repair helper for the cam-worker container (US-002, CAM-185).
//
// Exports:
//   buildChownExecArgv       - pure builder: returns the docker exec argv to
//                              chown /home/bun/.claude inside the named container
//   buildConfigAssertArgv    - pure builder: returns the docker exec argv to
//                              merge the 5 CAM-179 config keys into
//                              /home/bun/.claude.json via in-container node
//   applyContainerConfig     - drives both exec steps through an injectable
//                              ConfigSpawnFn; returns a discriminated result
//                              (never throws)
//   ContainerConfigError     - typed Error subclass; thrown by callers (not here)
//                              when applyContainerConfig returns {ok:false}
//
// Design:
//   applyContainerConfig never throws. The throw of ContainerConfigError lives
//   in the caller (US-003 ensureWorkerContainer) so unit tests of the pure
//   helper stay throw-free and the production path can catch the typed error
//   with instanceof.
//
// The two exec steps are DISTINCT:
//   1. chown -R bun:bun /home/bun/.claude  - repairs directory ownership
//   2. node -e <merge-script> on /home/bun/.claude.json - repairs file content
//   Chowning the .claude DIR does NOT repair the sibling FILE content.
//   The merge is a read-modify-write that preserves claude-owned fields
//   (machineID, userID, etc.) while re-asserting the 5 CAM-179 keys.
//
// GOTCHA: reused containers built before CAM-185 have NO jq; the cam-worker
// image has always shipped nodejs, so the config assert goes through node.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable spawn function for the config exec calls.
 * Captures stderr so the caller can include a stderrTail in ContainerConfigError.
 */
export type ConfigSpawnFn = (
	cmd: string,
	args: string[],
) => { stdout: string; stderr: string; exitCode: number };

/** Successful config application. */
export interface ApplyConfigOk {
	ok: true;
}

/** Failed config application — never thrown; returned for the caller to handle. */
export interface ApplyConfigFail {
	ok: false;
	exitCode: number;
	/** Last N lines of the container's stderr, for operator diagnosis. */
	stderrTail: string;
}

export type ApplyConfigResult = ApplyConfigOk | ApplyConfigFail;

// ---------------------------------------------------------------------------
// buildChownExecArgv
// ---------------------------------------------------------------------------

/**
 * Return the `docker exec` argument vector to chown /home/bun/.claude inside
 * the named container (runs as root to repair stale root-owned volumes).
 *
 * When `uid` and `gid` are both provided (from `resolveHostIds`), the chown
 * target is the numeric `uid:gid` form so it is correct even if the bun
 * username is not yet in the container's /etc/passwd.  Falls back to the
 * named `bun:bun` form when either value is absent.
 *
 * Shape: `['exec', '-u', 'root', containerName, 'chown', '-R', '<owner>', '/home/bun/.claude']`
 */
export function buildChownExecArgv(containerName: string, uid?: number, gid?: number): string[] {
	const owner = uid !== undefined && gid !== undefined ? `${uid}:${gid}` : 'bun:bun';
	return ['exec', '-u', 'root', containerName, 'chown', '-R', owner, '/home/bun/.claude'];
}

// ---------------------------------------------------------------------------
// buildConfigAssertArgv
// ---------------------------------------------------------------------------

/**
 * Inline node script that merges the 5 CAM-179 config keys into
 * /home/bun/.claude.json without clobbering claude-owned state
 * (machineID, userID, and any other fields claude writes).
 *
 * The script:
 *   1. Reads the existing file (or starts from {} on ENOENT/parse error).
 *   2. Sets/overwrites the 5 CAM-179 keys.
 *   3. Writes the merged result back (preserving all other fields).
 */
const CONFIG_ASSERT_SCRIPT = [
	"const fs=require('fs');",
	"const p='/home/bun/.claude.json';",
	'let c={};',
	"try{c=JSON.parse(fs.readFileSync(p,'utf8'))||{};}catch(e){}",
	'c.hasCompletedOnboarding=true;',
	"c.theme='dark';",
	'c.bypassPermissionsModeAccepted=true;',
	'c.projects=Object.assign({},c.projects);',
	"c.projects['/workspace']=Object.assign({},c.projects['/workspace']);",
	"c.projects['/workspace'].hasTrustDialogAccepted=true;",
	"c.projects['/workspace'].hasCompletedProjectOnboarding=true;",
	"fs.writeFileSync(p,JSON.stringify(c,null,2));",
].join('');

/**
 * Return the `docker exec` argument vector to run a jq-free node merge-script
 * inside the named container, asserting the 5 CAM-179 config keys into
 * /home/bun/.claude.json without clobbering claude-owned fields.
 *
 * Shape: `['exec', containerName, 'node', '-e', '<inline-script>']`
 *
 * Why node (not jq): reused containers built before CAM-185 have NO jq;
 * the cam-worker image has always shipped nodejs.
 */
export function buildConfigAssertArgv(containerName: string): string[] {
	return ['exec', containerName, 'node', '-e', CONFIG_ASSERT_SCRIPT];
}

// ---------------------------------------------------------------------------
// applyContainerConfig
// ---------------------------------------------------------------------------

function stderrTailOf(stderr: string): string {
	const lines = stderr.split('\n').filter((l) => l.length > 0);
	return lines.slice(-5).join('\n');
}

/**
 * Run both config-repair steps inside `containerName` via `docker exec`,
 * driven through the injectable `spawnFn`:
 *   1. chown -R <uid>:<gid> /home/bun/.claude  (directory ownership)
 *   2. node -e <merge-script>                   (file content merge)
 *
 * The optional `ids` bag carries the HOST_UID/HOST_GID resolved by
 * `resolveHostIds` in the caller.  When provided, `buildChownExecArgv` uses
 * the numeric `uid:gid` form; otherwise it falls back to `bun:bun`.
 *
 * Returns `{ok:true}` when both steps exit 0, or
 * `{ok:false, exitCode, stderrTail}` on the first non-zero exit.
 *
 * NEVER throws. The throw of ContainerConfigError is the caller's responsibility.
 */
export function applyContainerConfig(
	containerName: string,
	spawnFn: ConfigSpawnFn,
	ids?: { uid?: number; gid?: number },
): ApplyConfigResult {
	// Step 1: chown (repair directory ownership)
	const chownArgv = buildChownExecArgv(containerName, ids?.uid, ids?.gid);
	const chownResult = spawnFn('docker', chownArgv);
	if (chownResult.exitCode !== 0) {
		return {
			ok: false,
			exitCode: chownResult.exitCode,
			stderrTail: stderrTailOf(chownResult.stderr),
		};
	}

	// Step 2: config assert (repair file content)
	const configArgv = buildConfigAssertArgv(containerName);
	const configResult = spawnFn('docker', configArgv);
	if (configResult.exitCode !== 0) {
		return {
			ok: false,
			exitCode: configResult.exitCode,
			stderrTail: stderrTailOf(configResult.stderr),
		};
	}

	return { ok: true };
}

// ---------------------------------------------------------------------------
// ContainerConfigError
// ---------------------------------------------------------------------------

/**
 * Typed error thrown by `ensureWorkerContainer` when either config-repair
 * step exits non-zero. Caught specifically (instanceof check) in `runSidecar`
 * to log the stderrTail and abort the sidecar boot without entering
 * `runSidecarLoop`.
 */
export class ContainerConfigError extends Error {
	/** Last N lines of the container's stderr, for operator diagnosis. */
	stderrTail: string;

	constructor(stderrTail: string) {
		super(`cam-worker container config repair failed: ${stderrTail}`);
		this.name = 'ContainerConfigError';
		this.stderrTail = stderrTail;
	}
}
