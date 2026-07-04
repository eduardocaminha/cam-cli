// src/supervisor/docker-exec.ts
//
// Pure chokepoint helper that wraps a worker shell string in a `docker exec`
// prefix so container routing lives in a single tested place instead of being
// duplicated across dispatch sites (loop.ts, review.ts, plan-runner.ts).
//
// Design:
//   - Pure function; no I/O, no spawning.
//   - Mirrors the discipline of worker-argv.ts and plan-argv.ts.
//   - Reuses DEFAULT_CONTAINER_NAME from worker-container.ts (no duplicate literal).
//   - The inner shell string is preserved byte-for-byte: the CAM-43 env -u prefix,
//     CAM-23 lowercase --session-id, --model quoting, and the single-quoted prompt
//     all run INSIDE the container as intended.
//   - `docker exec -it` execs argv directly (no shell interpolation by Docker);
//     the host pane shell tokenizes the full wrapped string, so no inner `sh -c`
//     is needed.

import { DEFAULT_CONTAINER_NAME } from './worker-container.ts';

/**
 * Wrap an existing worker shell string in `docker exec -it <containerName> ...`.
 *
 * The resulting string has the form:
 *
 *   docker exec -it cam-worker env -u CLAUDECODE -u ... claude --permission-mode ...
 *
 * The inner shell string is preserved byte-for-byte. The containerName defaults
 * to DEFAULT_CONTAINER_NAME ('cam-worker') when absent.
 *
 * @param shellString   The existing worker shell string (e.g. output of
 *                      buildImplementerWorkerArgv).
 * @param containerName The target container name. Defaults to DEFAULT_CONTAINER_NAME.
 */
export function dockerExecWrap(shellString: string, containerName?: string): string {
	const name = containerName ?? DEFAULT_CONTAINER_NAME;
	return `docker exec -it ${name} ${shellString}`;
}
