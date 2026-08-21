# Gateship current checkpoint

> Updated: 2026-08-21
> Latest release evidence: `v0.310.0` points to commit `824eac8e`, the merged
> GSHIP-681 change. Source metadata remains `0.0.0-dev` by design; release
> builds receive their version and source revision at build time.

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

The public beta surface includes conversation, run inspection, work and
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
   automatic rule mutation or approval.
3. Add multiproject selection and parallelism only across independent
   repositories.
4. Validate the external beta with real users before a broader launch push.

Change this order only when product evidence supports it and an approved issue
authorizes the bounded next slice.
