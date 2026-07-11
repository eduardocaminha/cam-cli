# ADR 0025: Post-merge divergence recovers via git pull --rebase, never automatic reset --hard; a merged-but-incomplete post-merge is a durable stalled state

## Context

When an unpushed commit sits on local main before a feature branch squash-merges, the squash recreates that content at a new SHA and local main diverges from origin/main. The sidecar post-merge git pull then refuses (pull-failed). Two compounding defects followed: (1) a pull-failed still returns a merged (terminal) outcome, so the merge-watch marker is deleted and updateShipStalledMarker's merged branch removes the ship-stalled marker, leaving zero durable record that the cycle half-completed; (2) the issue floated git reset --hard origin/main as auto-recovery, but nothing in the codebase proves the local commit is subsumed (the divergence guard is a bare SHA-inequality with no merge-base/rev-list ancestry check), so an unconditional reset --hard could silently drop un-squashed local work.

## Decision

Recover non-destructively: replace the plain post-merge pull with git pull --rebase, which drops a subsumed local commit via patch-id and replays (or cleanly conflicts on) genuine un-squashed work. On a clean rebase, continue tag/prune/close in the same run. On any rebase failure, fail loud by writing a durable .cam-post-merge-stalled.json marker (recording completed and remaining steps) surfaced at orchestrator boot. git reset --hard origin/main is never an automatic action; it remains an operator runbook step for the subsumed case only. A merged-but-incomplete post-merge is modelled as its own durable stalled state, distinct from ship-stalled.

## Consequences

The subsumed-commit case (the common one) self-heals without proving subsumption, because the rebase either drops the redundant patch or preserves real work. No automatic path can lose un-squashed commits. The orchestrator always learns of a half-done cycle via a durable marker, even across a recycle. Rejected alternative: auto reset --hard gated on a net-new subsumption check (merge-base + rev-list of paths) - buildable but fragile to define precisely, and the downside of a wrong subsumption verdict is silent data loss, whereas pull --rebase yields the same happy-path result with a safe failure mode. Lock contention (a separate pull-failed cause, CAM-228) is explicitly out of scope.
