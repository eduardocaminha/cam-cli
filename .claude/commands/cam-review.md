---
model: claude-sonnet-4-6
---

Write the `phase:review` signal to trigger the deterministic review runner for the current branch.

**CLI path**: `cam review` (run from a terminal outside the session) writes `phase:review` to `.claude/cam-loop.local.md` and returns immediately. The sidecar detects `phase === 'review'` on its next tick and calls the review dispatch (`makeReviewDispatch`, `src/supervisor/review.ts`, wired in `makeProductionReviewPhaseFn`, `src/commands/sidecar.ts`).

**Slash-command path** (this file): write the same `phase:review` signal, then narrate. Both paths are signal-writers only; the full control-flow (round-cap check against `CAM_MAX_REVIEW_ROUNDS`, reviewer worker respawn in the titled 3rd pane, `<review>` verdict poll, `prd.json.review` update, fix-story materialization on `FIXES_PENDING`) lives entirely in the review dispatch. No in-context Task flow runs anymore: the reviewer worker is dispatched as a TUI pane by the sidecar, exactly one round per `phase:review` tick, never spawned via `Task()` inside the orchestrator's own context.

## Write the signal

Read `.claude/cam-loop.local.md`. Update `phase`, preserving all other fields:

```yaml
phase: review
```

## Narrate

After writing:

```
Review phase signal written (phase:review -> .claude/cam-loop.local.md).
The sidecar will call the review dispatch on the next tick:
  round-cap check -> reviewer worker (titled 3rd pane) -> <review> verdict poll ->
  prd.json.review update (CLEAN / FIXES_PENDING / MAX_ROUNDS_DEBT) ->
  fix-story materialization (FIXES_PENDING only).
A pushed `[cam] review round complete: ...` (or `failed: ...`) summary line
reports the outcome; read scripts/cam/prd.json.review for the structured result.
```
