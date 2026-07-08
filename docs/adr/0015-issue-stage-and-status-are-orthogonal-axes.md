# ADR 0015: Issue stage and status are orthogonal axes

## Context

Abandoning an issue records status:abandoned but leaves stage untouched, producing valid states such as stage:specified + status:abandoned. A query that filtered by stage alone surfaced such issues as plannable and misled the orchestrator into recommending abandoned issues for planning (2026-07-08, CAM-222). The alternative considered was making abandonment terminal, i.e. resetting or subsuming stage on abandon.

## Decision

Stage (lifecycle progress) and status (open vs abandoned) are orthogonal axes. Abandonment does NOT reset stage; the last stage is preserved as history. Plannability is derived only through the canonical predicate (stage:specified AND status:open AND not blocked); no reader may bucket issues by stage without also filtering status.

## Consequences

A raw stage-only query is unsafe by construction, so a spine guard bans literal stage-value comparisons outside the canonical plannability module, and cam issue list --json is the sole sanctioned machine-readable backlog interface. Existing abandoned issues need no migration: they remain at their historical stage and are excluded from active views by their status.
