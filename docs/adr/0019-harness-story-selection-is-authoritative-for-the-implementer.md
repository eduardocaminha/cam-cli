# ADR 0019: Harness story selection is authoritative for the implementer

## Context

Historically the supervisor computed decideNextAction's storyId as advisory (loop.ts documented 'the worker self-selects its story; the storyId is advisory, logging only'), and the implementer agent self-selected by reading the entire prd.json to pick the highest-priority passes:false non-operator story. This duplicated the selection logic in two places (the harness decideNextAction and the agent's AGENT.md steps) and cost the agent context by loading every story just to choose one.

## Decision

The harness-selected story becomes authoritative. The supervisor injects the full selected-story record (id, title, acceptance criteria, priority, requires) plus the branchName directly into the implementer spawn prompt, and the agent implements that exact story without independently re-selecting. The existing outcome.storyId-vs-selected reconciliation is retained as a safety net, and the agent still performs a targeted passes:true update on completion (the isolation contract is unchanged).

## Consequences

Positive: the agent no longer reads the full prd.json to select (context diet), and story selection has a single source of truth (decideNextAction). Trade-off: the agent no longer self-corrects a bad harness selection; this is mitigated by the deterministic decideNextAction ordering and the retained reconciliation net. The alternative considered (keep selection advisory, inject only for information) was rejected because it leaves the duplicate agent-side selection and its full-prd read in place, defeating the diet.
