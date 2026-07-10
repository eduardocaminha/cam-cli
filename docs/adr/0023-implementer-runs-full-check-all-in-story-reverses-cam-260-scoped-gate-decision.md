# ADR 0023: Implementer runs full check:all in-story (reverses CAM-260 scoped-gate decision)

## Context

CAM-260 deliberately kept the implementer off the full check:all spine: it ran only typecheck + test + the single check-file-sizes.ts gate, explicitly documented (subagent-implementer.md ~line 100) as a scoped exception and NOT a switch to running check:all in-story. As a result the sibling ratchets (coverage, debt-markers, dead-code/knip, dup/jscpd) only fired at Layer B (reviewer) or CI, so a legitimate change that tripped one surfaced late as a ship/CI failure and got a manual loosening after the fact.

## Decision

The implementer runs the full `bun run check:all` spine in-story after coding and resolves each of the four sibling ratchets inline per a per-gate rubric (coverage: lower the global floor with a tracker-ref in _ref; debt: cite inline; dead-code: remove or justified knip ignore; dup: deduplicate or justified jscpd threshold/ignore). The reviewer backstops every loosening across all four gates, not just file-size.

## Consequences

Early-catch of the entire ratchet class is traded for a measurably slower per-story worker loop (adds bun test --coverage + knip + jscpd every iteration). Only coverage carries the CAM-260 _ref/tracker machinery, and only over 2 global floors, not per-file; knip and jscpd have no _ref channel, so their suppressions rely solely on the reviewer backstop. Rejected alternatives: coverage-only (leaves three gates in the late-catch gap) and introducing new per-unit budget files + _ref gates for knip/jscpd (new machinery the reviewer diff already covers).
