# ADR 0035: Supervisor is the sole writer of story passes:true, with an independent per-story gate re-run

## Context

Historically the worker (subagent-implementer) flipped its own passes:true in prd.json and also supplied the gates.tests evidence the supervisor read back. The worker thus both produced and judged its own acceptance oracle, and nothing mechanically prevented a false pass; the supervisor only read passes as an integrity check (loop.ts:24, result.ts:16), writing it solely on the incomplete path via finalizeStory after runGates().

## Decision

Move passes ownership entirely to the deterministic supervisor (variant A-i): the supervisor re-runs its own gates (typecheck + bun test) per story and flips passes only when they are green, generalizing finalizeStory across both the pass and incomplete paths; the worker loses prd.json write authority (the orch-agent-allowlist hook denies worker-actor Write to scripts/cam/prd.json) and only signals done via worker-report.json. Rejected A-ii (gate passes on reviewer CLEAN) because review runs per-branch not per-story and would reorder the whole loop, and rejected the weak variant (trust the worker-report gates) because it moves the write without removing the gaming vector.

## Consequences

The independent oracle is now the supervisor's own gate run, not worker-authored evidence, closing the self-gaming vector. Cost: every happy-path story pays a second typecheck + full-suite run on the supervisor side. The pass/incomplete distinction collapses for the flip. Reversing this means restoring worker write authority to prd.json and the passes flip, which is why it is recorded here.
