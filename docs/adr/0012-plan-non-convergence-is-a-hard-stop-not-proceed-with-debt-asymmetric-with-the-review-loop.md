# ADR 0012: Plan non-convergence is a hard-stop, not proceed-with-debt (asymmetric with the review loop)

## Context

The review loop (src/supervisor/loop.ts) lets a FIXES_PENDING cycle reach a MAX_ROUNDS_DEBT terminal that ships the change with recorded debt. The plan-runner BLOCK->re-plan loop (CAM-204) needed a symmetric decision for what happens when a PRD fails to converge after N=2 re-plan rounds.

## Decision

A plan that does not converge (still audit-blocked) after N=2 re-plan rounds terminates as escalated and never auto-proceeds to branch or commit. There is no plan analog of MAX_ROUNDS_DEBT. The orchestrator surfaces the non-convergence, with the last findings, to the operator via a durable event/marker, and the operator decides how to proceed (re-grill, abandon, or manual intervention).

## Consequences

A structurally unsound PRD can never enter implementation, unlike a review-debt change that ships. The cost is that a genuinely stuck plan halts the autonomous meta-loop until the operator acts, rather than degrading gracefully. This is intentional: an unsound plan poisons every downstream story it spawns, whereas review debt is localized to a single change.
