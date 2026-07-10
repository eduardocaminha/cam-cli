# ADR 0022: File-size ceiling raise happens in the implementer story, not at ship time

## Context

Workers run only typecheck+test per story for speed; the file-size ratchet lives in check:all, which runs at ship (ship-runner.ts) and CI. A file a story legitimately grew therefore surfaces its ceiling breach late, as a gates-failed ship, and gets a manual ceiling raise by the orchestrator. The journal records this recurring across many cycles.

## Decision

The implementer runs check:file-size after coding and, for a file its own story legitimately grew, raises that file's ceiling to the gate's measured actual with the tracker-ref in _ref, committed in the same story commit. The reviewer backstops that each raise is justified (legitimate growth vs the file should have been split), issuing REQUEST CHANGES otherwise. The gate mechanism (check-file-sizes.ts, check:all wiring) is unchanged; only the actor and point of the raise shift left into the story.

## Consequences

The miss surfaces during the story instead of at ship, and the manual orchestrator raise is eliminated. The ratchet keeps its friction because an unjustified raise is caught in review. Rejected alternatives: auto-raise at ship time (rubber-stamps growth and guts the gate's purpose) and retiring the gate entirely (loses the bloat signal). Cost: one extra gate in the per-story worker loop and a new reviewer responsibility. The sibling ratchets (coverage, debt, dead-code, dup) share the same late-catch gap and are deferred to a separate follow-up.
