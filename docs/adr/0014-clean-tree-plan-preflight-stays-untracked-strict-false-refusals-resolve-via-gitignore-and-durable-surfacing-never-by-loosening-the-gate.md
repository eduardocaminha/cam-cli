# ADR 0014: Clean-tree plan preflight stays untracked-strict; false-refusals resolve via gitignore and durable surfacing, never by loosening the gate

## Context

The plan preflight includes a clean-tree check that refuses to dispatch a plan when git status --porcelain reports any output, including untracked files. In the CAM-115 cycle, an untracked runtime file (.claude/.cam-sidecar-session.json, written by the sidecar and not gitignored) made the check refuse. The refusal path reverted phase to idle while writing only a flight-recorder event: no durable marker, no operator narration. To the operator it looked like the plan signal never fired. One considered alternative was to loosen the check to git status --porcelain -uno so untracked files stop blocking.

## Decision

Keep the clean-tree preflight untracked-sensitive (strict --porcelain). An unexpected untracked file is a real signal, since it would otherwise be carried into a fresh branch, so the gate stays strict. The two legitimate causes of a false refusal are addressed instead: (1) runtime artifacts that should never appear in git status are gitignored (the sidecar-session file and its untracked siblings, including the ship-stalled marker), and (2) any preflight failure now writes a durable marker (.claude/.cam-plan-preflight-failed.json), fires a best-effort pane notify, and is read at orchestrator boot as an opening blocker.

## Consequences

A genuinely dirty or untracked tree still blocks planning, preserving the branch-hygiene guarantee. Runtime junk no longer triggers false refusals because it is gitignored. When the preflight does refuse, the operator sees it at boot even across an orchestrator recycle, because the durable marker survives independently of the volatile send-keys narration. The cost is a third durable marker file and boot-read step, extending the ship-stalled and plan-escalated surfacing pattern to a third silent terminal.
