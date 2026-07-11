// src/commands/sidecar-gate.ts
//
// Shared sidecar-liveness gate for `cam plan` / `cam next` / `cam ship`
// (US-003, CAM-207). Refuses to write a phase/active signal to the loop
// state file when the sidecar is dead, so the signal is never orphaned
// into a silent hang. Mode-agnostic by construction: no worker_isolation
// branching here, since the hang risk applies identically in host and
// container mode.

import { printError } from '../logging/color.ts';
import { emitTrailingBlank } from '../logging/screen.ts';
import { sidecarAlive } from '../supervisor/sidecar-pid.ts';

/**
 * Returns `true` when the sidecar is alive and the caller should proceed.
 * Returns `false` (after printing the refusal) when the sidecar is dead.
 */
export function sidecarLivenessGate(
	claudeDir: string,
	cmdName: string,
	sidecarAliveFn: (claudeDir: string) => boolean = sidecarAlive,
): boolean {
	if (sidecarAliveFn(claudeDir)) return true;
	printError(
		'sidecar is not running',
		`run \`cam run\` to start the sidecar, then retry \`cam ${cmdName}\`.`,
	);
	emitTrailingBlank();
	return false;
}
