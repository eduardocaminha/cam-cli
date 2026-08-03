// src/util/hub-bootstrap.ts
//
// Shared hub-autostart bootstrap for the six thin-proxy subcommands (plan,
// next, issue, spec, review, ship). Each proxy needs to boot the hub
// (`<self> run --no-attach`) when no live orchestrator is detected. All six
// previously spawned the literal binary name off PATH via node:child_process's
// synchronous spawn, hardcoding the product-name literal and risking booting a
// stale PATH binary instead of the exact binary the operator just invoked
// (US-003, CAM-482). Consolidated here into ONE shared argv builder +
// bootstrap function so the six sites never drift back out of sync (they were
// already byte-identical duplicates before this change).

import process from 'node:process';

import { buildSelfSpawnArgv } from './self-invoke.ts';

/**
 * Build the argv for autostarting the hub (`<self> run --no-attach`) from an
 * injected execPath/argv1 pair. Thin wrapper over `buildSelfSpawnArgv`
 * (US-002, CAM-482) fixed to the `run --no-attach` subcommand: never falls
 * back to a literal PATH-resolvable binary name, always re-invokes the exact
 * running binary/script.
 */
export function buildHubAutostartArgv(execPath: string, argv1: string | undefined): string[] {
	return buildSelfSpawnArgv(execPath, argv1, 'run', '--no-attach');
}

/**
 * Shared fallback bootstrap for the six thin-proxy subcommands: spawn the
 * hub synchronously via the exact binary running THIS process (never a
 * literal PATH-resolvable name), and report success by exit status.
 * `spawnSync` never throws on a non-zero exit; `result.status` is `null` only
 * when the process was killed by a signal, hence the `?? 1` fallback.
 */
export async function bootstrapHub(cwd: string): Promise<boolean> {
	const { spawnSync } = await import('node:child_process');
	const argv = buildHubAutostartArgv(process.execPath, process.argv[1]);
	const cmd = argv[0];
	// buildHubAutostartArgv always returns at least [execPath, 'run',
	// '--no-attach']; this guard only exists to satisfy noUncheckedIndexedAccess.
	if (cmd === undefined) return false;
	const result = spawnSync(cmd, argv.slice(1), { cwd, stdio: 'ignore' });
	return (result.status ?? 1) === 0;
}
