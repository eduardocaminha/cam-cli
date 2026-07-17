# ADR 0046: Codex backend: spike-first, per-subagent, via a BackendAdapter at the report/sentinel boundary

## Context

CAM-54 makes the OpenAI Codex CLI a complete alternative to claude. CAM-53 shipped only a single-key backend string + a runtime guard; no abstraction exists and every spawn path hardcodes claude. The operator requires claude and codex to be usable alone OR mixed, chosen PER-SUBAGENT. The claude/codex integration differs across six axes (spawn argv, session/transcript + the context-budget/recycle backstop, completion detection, the --agent prompt mechanism, permission/sandbox+env, model-id namespace), and the report/sentinel/JSON contract is already parsed backend-agnostically.

## Decision

Spike-first: land a design ADR resolving the six mismatches before any codex dispatch code. Introduce a per-actor BackendAdapter seam whose boundary is the report/sentinel/JSON contract, so a codex worker and a claude worker are interchangeable within one run. Make backend a PER-PHASE (per-subagent) config mirroring the existing per-phase model config, upgrading the single-key readBackend to a per-phase accessor -- backends are mixable. Codex runs as a TUI pane like claude workers. Scope this issue to the worker actors (implementer/planner/auditor/reviewer); defer orchestrator-persona, retry launcher, and auth-preflight codex parity to follow-ups; ship stays zero-LLM.

## Consequences

Mixed-backend runs are supported and gated on every actor emitting the identical report/sentinel contract; the single global backend key becomes per-phase; the claude path is refactored behind the adapter with no behavior change; the context-budget/recycle backstop (claude-transcript-shaped, mostly in the deferred orchestrator path) needs a codex equivalent or documented degradation; the effort is epic-scale and will be sliced across multiple PRs; the follow-up actors run claude-only until their own issues land.
