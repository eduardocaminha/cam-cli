import type { SpawnFn } from '../../src/supervisor/loop.ts';

/**
 * Decorate a plan-runner unit-test spawn fake with realistic pane_pid changes.
 *
 * The wrapped fake still observes every command. Empty successful pane_pid
 * reads get a deterministic synthetic identity, and each successful
 * respawn-pane advances it. Non-empty/failed reads from specialized fakes are
 * preserved so failure-path tests can override the identity behavior.
 */
export function withVerifiedPanePid(spawnFn: SpawnFn, initialPid = 10_000): SpawnFn {
	let panePid = initialPid;
	return (cmd, args, opts) => {
		const result = spawnFn(cmd, args, opts);
		if (args[2] === 'display-message' && args.includes('#{pane_pid}')) {
			if ((result.exitCode ?? 1) !== 0 || result.stdout.trim() !== '') return result;
			return { ...result, stdout: `${panePid}\n` };
		}
		if (args[2] === 'respawn-pane' && (result.exitCode ?? 1) === 0) {
			panePid++;
		}
		return result;
	};
}
