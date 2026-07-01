Write the `phase:planning` signal to trigger the deterministic plan runner for a given issue.

**CLI path**: `cam plan [N]` writes `phase:planning + plan_issue=N` to `.claude/cam-loop.local.md` and returns immediately. The sidecar detects `phase === 'planning'` on its next tick and calls `runPlanPhase` (`src/supervisor/plan-runner.ts`).

**Slash-command path** (this file): write the same `phase:planning + plan_issue` signal, then narrate. Both paths are signal-writers only; the full control-flow (pre-flight, planner pane, auditor pane, post-audit branching) lives entirely in `runPlanPhase`. The state machine is documented in `docs/adr/0006-phase-enum-loop-state-machine.md`.

## Resolve the issue

- **No argument**: list files via `git ls-tree -r --name-only main scripts/cam/issues/ 2>/dev/null || ls scripts/cam/issues/`, read each, find the top entry where `stage === 'specified' && status === 'open' && !blocked`, sorted by `rank` asc then numeric id asc. Stop with a clear error if none qualifies.
- **Argument N** (e.g. `/cam-plan 151`): use the issue at `scripts/cam/issues/<prefix>-<N-padded>.json`. Stop with a clear error if the file is missing, not open, or not plannable.

## Write the signal

Read `.claude/cam-loop.local.md`. Update `phase` and `plan_issue`, preserving all other fields:

```yaml
phase: planning
plan_issue: "<resolved-issue-id>"
```

## Narrate

After writing:

```
Plan phase signal written for <issue-id> (phase:planning -> .claude/cam-loop.local.md).
The sidecar will call runPlanPhase on the next tick:
  pre-flight -> planner pane -> prd.json -> auditor pane -> APPROVE/BLOCK -> post-audit.
```
