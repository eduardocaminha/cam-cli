// src/supervisor/plan-preflight-spawn.ts
//
// Production factory for the PlanPreflightSpawnFn seam (US-002, CAM-368).
//
// Extracted out of the sidecar's makeProductionPlanPhaseFn closure so the
// exact seam where CAM-363's stderr drop hid (a Bun.spawnSync wrapper that
// forgot to decode+return stderr) is covered by a real-subprocess test and
// can no longer regress undetected.

import type { PlanPreflightSpawnFn } from './plan-preflight.ts';

/**
 * Build the production PlanPreflightSpawnFn: wraps Bun.spawnSync with `cwd`
 * closed over, decoding both stdout and stderr.
 *
 * PRESERVE THE BUFFER GUARD EXACTLY: Bun's SyncSubprocess types stdout/stderr
 * as `Buffer | undefined`, so the non-Buffer branch is reachable per Bun's
 * own types and `.toString()` would throw there. Do not "simplify" this to
 * `r.stdout.toString()`.
 */
export function makePreflightSpawnFn(cwd: string): PlanPreflightSpawnFn {
	return (bin, args) => {
		const r = Bun.spawnSync([bin, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
		return {
			stdout: r.stdout instanceof Buffer ? new TextDecoder().decode(r.stdout) : '',
			stderr: r.stderr instanceof Buffer ? new TextDecoder().decode(r.stderr) : '',
			exitCode: r.exitCode,
		};
	};
}
