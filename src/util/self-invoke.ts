// src/util/self-invoke.ts
//
// Single canonical fix site for the compiled-binary self-invoke bug class
// (US-R1-001, CAM-425; hardened in US-001, CAM-426).
//
// `process.execPath` + `process.argv[1]` is a reliable `[binary, script]`
// self-invoke pair ONLY when running interpreted (`bun index.ts ...`), where
// `execPath` is bun itself and `argv[1]` is the real script path bun can be
// re-invoked against. It breaks on the compiled distribution cam actually
// ships (`bun build --compile`, scripts/build-release.sh): inside a compiled
// single-file executable, `execPath` IS the standalone binary (self-contained,
// no separate bun runtime to invoke), and `argv[1]` is bun's internal virtual
// embedded-entry path (observed as `/$bunfs/root/<outfile>` on bun 1.3.13) --
// not a real script argument the compiled binary's own command dispatch
// understands.
//
// Detection is keyed on the ONE positive signal that is actually true in both
// modes: `argv1 !== undefined && argv1.startsWith('/$bunfs/')`. The former
// second signal, a negative check comparing execPath's basename against the
// literal string "bun", was a NEGATIVE heuristic that misclassifies any
// interpreted run under a version-managed bun shim (e.g. a version manager
// exposing the runtime as `bun-1.3` rather than literally `bun`) as compiled,
// dropping the real script argv1 and breaking the self-invoke.
// Positive-signal-only means a future change to bunfs's exact virtual-path
// prefix degrades to orch-resolve's loud fail-safe fallback (a failed/absent
// resolver leaves the last known-good model/effort in place and the loop
// still respawns) rather than propagating a silent dead-child failure from a
// wrongly-collapsed argv.

/**
 * Decide the self-invoke argv for re-running this same binary/script,
 * keyed only on the positive `/$bunfs/` virtual-entry signal:
 *   - compiled mode (`argv1` starts with `/$bunfs/`): `[execPath]`.
 *   - degenerate interpreted mode (`argv1` undefined): `[execPath]` alone --
 *     `execPath` is always defined, so this is the honest answer with no
 *     PATH-resolvable name required.
 *   - interpreted mode with a real script path: `[execPath, argv1]`.
 */
export function resolveSelfInvokeArgv(execPath: string, argv1: string | undefined): string[] {
	const isCompiled = argv1 !== undefined && argv1.startsWith('/$bunfs/');
	if (isCompiled || argv1 === undefined) {
		return [execPath];
	}
	return [execPath, argv1];
}

/**
 * Build a self-spawn argv for a background child that re-invokes THIS same
 * binary/script (compiled or interpreted) against a given subcommand, e.g.
 * `cam run`'s sidecar/watcher spawns and the sidecar-liveness watcher's own
 * sidecar respawn (US-002, CAM-482).
 *
 * Thin wrapper over {@link resolveSelfInvokeArgv}: spreads the resolved
 * execPath/argv1 pair, then appends `subcommandArgs` verbatim. Never falls
 * back to a literal PATH-resolvable binary name: a long-lived session must
 * always respawn the exact binary that is running it, not a possibly-stale
 * `gship` on PATH.
 */
export function buildSelfSpawnArgv(
	execPath: string,
	argv1: string | undefined,
	...subcommandArgs: string[]
): string[] {
	return [...resolveSelfInvokeArgv(execPath, argv1), ...subcommandArgs];
}
