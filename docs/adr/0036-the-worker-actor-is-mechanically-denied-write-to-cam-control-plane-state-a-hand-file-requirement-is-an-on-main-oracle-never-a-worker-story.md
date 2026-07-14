# ADR 0036: The worker actor is mechanically denied Write to cam control-plane state; a hand-file requirement is an on-main oracle, never a worker story

## Context

In CAM-162, AC13 required the operator ceremony issue to be hand-filed via /cam-issue by the orchestrator before ship. The US-004 worker instead satisfied the AC by writing scripts/cam/issues/CAM-0164.json directly in its working tree; the orch-agent-allowlist hook blocked Task/Agent spawns but not file Write. That branch write collided (add/add) with the CAM-0164 the orchestrator had filed on main via `cam issue --file-local`, forcing manual conflict resolution at ship. CAM-63 (US-006) had already introduced a CAM_WORKER-gated worker Write-deny, but scoped to a single hard-coded suffix (scripts/cam/prd.json); scripts/cam/issues/ was unprotected, and the planner had no rule against emitting a hand-file requirement as a worker implementation story.

## Decision

Harden the boundary on two independent layers. (a) Mechanical: extend the worker-actor Write-deny so CAM_WORKER (with CAM_SESSION) is denied Write/Edit/MultiEdit to scripts/cam/issues/ as well as scripts/cam/prd.json, converting the single suffix conditional into a small structured deny-set across all three synced hook copies. (b) Process: the planner encodes a hand-file-via-/cam-issue requirement as an on-main file-assert oracle acceptance criterion (verified by the reviewer's existing behavioral gate), never as a worker implementation story; no new reviewer machinery is added. Rejected: (a)-only (leaves the malformed AC being emitted) and (b)-only (leaves the collision mechanically possible).

## Consequences

Only the orchestrator/supervisor mutate cam control-plane state, and an implementer worker cannot collide with an on-main issue or PRD write. The deny-set stays a single small structured check that must be kept identical across the .claude/hooks/, templates/.claude/hooks/, and src/vendor/_generated.ts embed copies. The planner and reviewer treat hand-file requirements as verifiable on-main oracles, so the ceremony is checked, not implemented. The guard is fail-closed on missing jq and scoped by CAM_WORKER + CAM_SESSION, so interactive dev sessions, the planner, and the reviewer are unaffected.
