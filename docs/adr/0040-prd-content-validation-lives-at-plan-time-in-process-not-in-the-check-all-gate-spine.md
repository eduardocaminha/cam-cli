# ADR 0040: PRD content validation lives at plan time in-process, not in the check:all gate spine

## Context

Every deterministic check in cam (typecheck, tests, file-size, test-sleeps, debt-markers, etc.) is a check:all gate that globs and reads the committed working-tree source. When adding a deterministic PRD-oracle linter (CAM-310), the natural instinct is to add another check:all gate. But prd.json is an ephemeral in-process artifact: the planner writes it, executeGitProceedBranch commits it to the feature branch, and cam ship --finalize git rm's it. In the normal repo state that check:all runs against (CI, per-story implementer), there is no prd.json on disk to inspect. It exists only transiently, in-process, during the plan phase.

## Decision

Structured PRD content validation (starting with the CAM-310 oracle-shell linter) runs in the plan-runner audit path in-process, after the planner writes prd.json and before the LLM auditor spawns, NOT as a check:all gate. A finding is folded into the existing audit-BLOCK re-plan loop (deterministic BLOCK with lint findings as re-plan feedback), escalating via the same .cam-plan-escalated.json marker on round exhaustion.

## Consequences

PRD validation is cheap (runs before the expensive auditor subagent) and fails closed at plan time. Future PRD content validators follow this placement, not the check:all spine. The cost: the plan phase needs a content-reading prd.json seam (previously it only checked presence), and PRD validators are not exercised by the working-tree gate spine, so they need their own plan-runner integration tests. Reversing this (moving PRD checks into check:all) would require prd.json to become a durable committed artifact, which it deliberately is not.
