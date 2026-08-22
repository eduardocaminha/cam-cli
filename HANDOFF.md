# Gateship current checkpoint

> Updated: 2026-08-21
> Source metadata remains `0.0.0-dev` by design; release builds receive their
> version and source revision at build time.

## Product objective

Gateship lets one operator discuss, approve, and deliver a queue of
well-specified software changes with as little attention as correctness allows.
Autonomy is the product: activity, extra agents, and extra gates are useful only
when they reduce operator attention or observed failures.

## Present architecture

Gateship is one Bun web service, distributed as native binaries and one
container image. It serves a React/Vite-built UI, stores durable state and
events in SQLite, and supervises subscription-authenticated Claude Code or
Codex CLI children through provider adapters.

The browser conversation is the primary operator surface. A read-only
orchestrator may investigate and return one typed command; the deterministic
runtime alone owns mutations and lifecycle state. Approved runs start from a
fresh `origin/main` worktree without moving local `main`, execute the task's
explicit verification, receive an independent mechanically read-only review,
and ship through a squash-merged pull request. Clean merged workspaces are
released; dirty, failed, or uncertain leftovers are preserved and surfaced.

There is no tmux path, terminal UI, sidecar, second daemon, message broker, or
separate database service. The container is the native deployment's isolation
boundary; provider and GitHub authentication happens inside it and persists on
the single state volume.

## Current evidence

The public beta surface includes a global `GATESHIP_HOME` with a durable
project registry, conversation, run inspection, work and
proposal queues, provider/settings management, deterministic onboarding,
optional notifications, advisory React diagnostics, revision-cohort facts,
complete `en-US` and `pt-BR` catalogs, and bounded native self-update. The
current flow is summarized in `FLOW.md`; provider and credential boundaries are
documented under `docs/`.

Use the tag, commit graph, and the running service's `/api/snapshot` as factual
evidence for an installed version. Git history and GitHub Releases own older
release and decision detail; this checkpoint intentionally does not duplicate
run-by-run history.

## Governing decisions

- Prefer deletion or a small root-cause repair over a policy layer,
  compatibility path, daemon, or speculative abstraction.
- The operator-approved specification is the execution contract. Approval
  covers scope and every evidence or verification command.
- Run state, admission, verification, review, shipping, and cleanup remain
  deterministic runtime responsibilities.
- Keep provider authentication credential-blind and subscription-backed. Do
  not add provider or GitHub token fields to the UI or SQLite.
- Keep implementer work isolated to its assigned worktree and keep each fresh
  review session mechanically read-only.
- Keep same-project runs serial. Parallelism belongs only across independent
  projects after multiproject support exists.
- Keep operator prose provider-neutral: same language as the operator, concise,
  plain, organized by topic when needed, and without emojis or em dashes. A
  request to explain again must preserve the facts and cause no runtime action.
- Diagnostics, cohort observations, and derived ideas remain advisory. They may
  create reviewable proposals but never approve, start, fix, or block work.
- Run focused checks while editing. The project `verify` spine runs once at the
  ship boundary rather than inside every implementation loop.

## Approval boundary

This file records current direction; it grants no execution authority. Only an
operator-approved issue specification authorizes a bounded change. Discoveries
outside that scope return as proposals, and unresolved product judgment returns
to the operator. Publishing, merging, changing lifecycle state, or starting a
different roadmap stage requires its own authorization.

## Next ordered stages

1. Accumulate comparable revision-tagged terminal runs before activating any
   soft-ratchet proposal behavior.
2. Add measured self-improvement and community proposal intake without
   automatic rule mutation or approval. Use an immutable baseline, small
   evidence-backed supplemental proposals, version history, human approval and
   rollback rather than online self-modification.
3. Continue the approved multiproject sequence from the global home and
   automatically reconciled project registry now in place: add explicit
   selection and project-scoped routes before allowing runtime switching, then
   add parallelism only across independent repositories. Each registered
   project keeps its existing runtime database, worktrees, notifications and
   history in its resolved project `stateDir`; the global registry stores only
   project identity and location. The current stage is registry adoption and
   read-only discovery, with no manual registration, removal, picker, runtime
   switching or physical state migration.
4. Validate the external beta with real users before a broader launch push.

Change this order only when product evidence supports it and an approved issue
authorizes the bounded next slice.

## Evaluation radar

- Keep one specification and approval contract whose depth scales with delivery
  risk, not two workflows. Simple, reversible work may carry a minimal contract;
  shipped AI behavior, sensitive data, security boundaries or irreversible
  effects require proportionate evaluation cases, limits, observable success,
  containment or rollback and stronger evidence. Agent-assisted implementation
  alone does not make an otherwise simple task high risk.
- Type evaluation evidence by origin: deterministic check, human judgment or
  model evaluation. Preserve provenance and review; for model evaluations also
  record provider, model, effort and known cost. Keep the signals separate and
  never collapse them into one composite score.
- Make project verification multistack through detection and approved project
  commands, not by bundling every language or ML tool into Gateship. Confirm the
  required runtime is available, then execute the project's own explicit
  evidence and verification contract. A JavaScript-and-Python proof remains the
  first portability benchmark.
- Shape the build in the pre-approval conversation: help the operator make the
  objective, tradeoffs, risk and observable success explicit, then approve that
  result as the executable brief. Do not recreate planner/auditor convergence
  or let shaping mutate an approved run.
- Feed real failures and traces into error analysis. Workflow changes remain
  small, versioned, evidence-backed proposals compared with an immutable
  baseline; a human approves them and rollback remains possible. Never perform
  online self-modification.
- Let production evidence drive roadmap priority: real usage, provider
  failures, latency, known cost, operator attention and regressions. Accumulate
  comparable real runs before enabling a soft ratchet or inventing thresholds.
- Benchmark worktree ownership against per-acquisition leases, fail-closed
  recycling, state recovery, machine-readable status and safe pruning before
  multiproject work. Gateship keeps ownership of its lifecycle.
- Use `no-mistakes` only as a competitive checklist for deterministic agent
  control, evidence and telemetry. Do not copy its daemon, Git proxy, hooks,
  TUI or duplicate validation pipeline.
- Consider a concise evidence-derived change digest only after real users show
  that run inspection remains hard. It never replaces a diff or review.
- Defer named worktree preview URLs until concurrent project previews exist.
  Do not introduce a privileged proxy or local certificate lifecycle early.
- Do not adopt living specs that silently re-slice an approved run. Derived
  work remains a new proposal. Do not add a symbolic memory engine without a
  measured retrieval failure, and do not adopt noncommercial code.
