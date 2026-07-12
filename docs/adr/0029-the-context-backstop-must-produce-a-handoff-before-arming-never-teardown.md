# ADR 0029: The context backstop must produce a handoff before arming, never teardown

## Context

checkBackstop armed the recycle marker unconditionally on occupancy, without the handoff-exists guard that the cycle-close path has. With no handoff on disk, the wrapper SIGTERM fell into the else-branch and did tmux kill-session: the orchestrator died with total context loss, worse than Claude's own autocompact which preserves a summary. Also, writeOrchHandoff had no production caller.

## Decision

On backstop, signal the agent to write an authored handoff and arm; if none appears within 30s, the watcher writes a deterministic minimal handoff and arms itself. Never SIGTERM without a handoff. The terminal always resolves to respawn + rehydrate, never kill-session. Considered always-deterministic (simpler) but rejected it: the authored handoff preserves narrative quality, and the deterministic path is only the fallback.

## Consequences

Both recycle triggers share one never-arm-without-handoff invariant. A production caller for writeOrchHandoff now exists. Respawn may wait up to 30s for the authored handoff before falling back, a bounded cost that guarantees no teardown.
