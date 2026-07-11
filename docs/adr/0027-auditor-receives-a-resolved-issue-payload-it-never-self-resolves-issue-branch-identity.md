# ADR 0027: Auditor receives a resolved issue payload; it never self-resolves issue/branch identity

## Context

Planning CAM-156 (issue_system=local) escalated on a false-critical BLOCK: the auditor took the bare PRD issueNumber 156, resolved it against GitHub, matched an unrelated PR #156, and declared 100% scope-creep plus a branch collision. Root cause: the auditor re-derived WHICH issue the PRD targets, and its resolution path was backend-blind, so a coincident GitHub PR number produced a deterministic false-BLOCK.

## Decision

The deterministic plan runner (runPlanPhase) resolves the target issue and branch via the configured issue_system and passes the resolved issue record into the auditor spawn input. The auditor audits the PRD against that provided record and never re-resolves identity against any backend (no gh identity query in local mode). Branch-collision is checked against real git refs only. Prior-art/duplication remains a legitimate audit concern but is sourced from git history and emitted non-blocking.

## Consequences

Removes the identity-resolution responsibility from the LLM auditor (where it is unreliable) and pins it to deterministic code, eliminating the entire numeric-coincidence false-BLOCK class and aligning with CAM-197 (deterministic CLI owns identity; the agent reasons over structured input). Cost: changes the runner->auditor spawn contract, a larger change than making the auditor backend-aware, but the robust root-cause fix.
