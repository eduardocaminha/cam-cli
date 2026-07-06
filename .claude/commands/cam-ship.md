---
model: claude-sonnet-4-6
---

Write the `phase:shipping` signal to trigger the deterministic ship runner for the current branch.

**CLI path**: `cam ship` (run from a terminal outside the session) writes `phase:shipping` to `.claude/cam-loop.local.md` and returns immediately. The sidecar detects `phase === 'shipping'` on its next tick and calls `runShipPhase` (`src/supervisor/ship-runner.ts`).

**Slash-command path** (this file): write the same `phase:shipping` signal, then narrate. Both paths are signal-writers only; the full control-flow (branch guard, PRD-complete gate, quality gates, version bump, cycle-close finalize, push, PR-create) lives entirely in `runShipPhase` and `runShipPrStep` (`src/release/ship-pr.ts`). No LLM participates in the ship path: the PR title and body are composed deterministically from the PRD snapshot (`composePrTitle`/`composePrBody`, `src/release/pr-body.ts`). The decision to move this control-flow out of markdown is recorded in `docs/adr/0009-ship-phase-deterministic-sidecar-runner.md` (see also `docs/adr/0004-plan-phase-deterministic-sidecar-runner.md` and `docs/adr/0006-phase-enum-loop-state-machine.md`).

## Write the signal

Read `.claude/cam-loop.local.md`. Update `phase`, preserving all other fields:

```yaml
phase: shipping
```

## Narrate

After writing:

```
Ship phase signal written (phase:shipping -> .claude/cam-loop.local.md).
The sidecar will call runShipPhase on the next tick:
  branch guard -> PRD-complete check -> commits-ahead-of-main check ->
  quality gates -> version bump -> cycle-close finalize -> push ->
  PR-create + merge-mode step.
A failed step returns its result kind immediately; no later step runs.
```

<!-- cam-init: adaptation point -- runShipPhase's quality-gate step runs `bun run check:all`, cam-cli's own aggregate quality gate. When installing this command in a downstream project, map it to that project's equivalent aggregate gate (e.g. `make check`, `poe test-all`, `./gradlew check`); degrade to typecheck + test when no aggregate gate exists. -->
