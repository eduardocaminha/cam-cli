# Gateship current checkpoint

> Updated: 2026-08-23, against the `v0.342.0` tag.
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
Codex CLI children through provider adapters. Authentication stays
credential-blind: no provider or GitHub token ever reaches the UI or SQLite.

The browser conversation is the primary operator surface. A read-only
orchestrator may investigate and return one typed command; the deterministic
runtime alone owns mutations and lifecycle state. Approved runs start from a
fresh `origin/main` worktree without moving local `main`, execute the task's
explicit verification, receive an independent mechanically read-only review,
and ship through a squash-merged pull request. Clean merged workspaces are
released; dirty, failed, or uncertain leftovers are preserved and surfaced.

Two boundaries are narrower than they look. A provider hold is a schedule, not
a dead end: the run resumes by itself when the refusal's own `retryAt` arrives,
and a repeated `retryAt` never buys a second wake-up. A Claude subscription
limit reached before any verdict buys exactly one Codex attempt at the review
boundary only; every other failure keeps the run on its own provider, and the
run's provider, session, and worktree are never rewritten by the fallback.

Review returns material defects. `CLEAN` means the change carries no material
defect, not that no improvement remains; style preference and speculation are
out of contract, and comments or documentation qualify only when they hide a
real gap in behaviour.

The visible brand is the definitive wordmark, and the product speaks complete
`en-US` and `pt-BR` catalogs in the operator's own language.

There is no tmux path, terminal UI, sidecar, second daemon, message broker, or
separate database service. The container is the native deployment's isolation
boundary; provider and GitHub authentication happens inside it and persists on
the single state volume.

## Multiproject state and its limits

A global `GATESHIP_HOME` holds a durable, automatically reconciled project
registry. Overview lists registered projects, and Runs and Work are operational
for any registered project the registry reports ready, reading and commanding
that project's own runtime.

The rest is still boot-project only, and saying so precisely matters more than
the headline:

- conversation, the operator-owned brief, settings, and every runtime control
  belong to the boot project alone;
- a project the registry does not report ready keeps its typed unavailable
  answer;
- there is no project onboarding, no registration, and no removal;
- same-repository runs remain serial, and there is no parallelism across
  projects yet.

Each registered project keeps its own runtime database, worktrees,
notifications, and history in its resolved project `stateDir`; the global
registry stores only identity and location. No physical state migration is
planned.

## Current evidence

The beta surface includes the project registry, conversation, run inspection,
work and proposal queues, provider and settings management, deterministic
onboarding of the boot project, optional notifications, advisory React
diagnostics, revision-cohort facts, and bounded native self-update. The current
flow is summarized in `FLOW.md`; provider and credential boundaries are
documented under `docs/`.

Recent runs that changed direction rather than surface: GSHIP-711 made provider
holds self-resuming; GSHIP-709 added the review-only Codex fallback; GSHIP-712
made Work operational per selected project; GSHIP-713 replaced the visible
brand; GSHIP-714 restricted review findings to material defects. Two of these
are evidence about the process itself. GSHIP-712 showed the cost of an
immaterial finding: a true remark that changed no behaviour still bought a fix
round. GSHIP-714 then shipped with no fix round at all.

Use the tag, commit graph, and the running service's `/api/snapshot` as factual
evidence for an installed version. Git history and GitHub Releases own older
release and decision detail; this checkpoint is not a changelog and
intentionally does not duplicate run-by-run history.

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
- Keep one specification and approval contract whose depth scales with delivery
  risk, not two workflows. Simple, reversible work may carry a minimal contract;
  shipped AI behavior, sensitive data, security boundaries or irreversible
  effects require proportionate evaluation cases, limits, observable success,
  containment or rollback and stronger evidence.
- Type evidence by origin: deterministic check, human judgment or model
  evaluation. Preserve provenance and review, and never collapse the signals
  into one composite score.
- Make project verification multistack through detection and approved project
  commands, not by bundling every language or ML tool into Gateship. A
  JavaScript-and-Python proof remains the first portability benchmark.
- Shape the build in the pre-approval conversation, then approve that result as
  the executable brief. Do not let shaping mutate an approved run, and do not
  adopt living specs that silently re-slice one.
- Feed real failures into error analysis as small, versioned, evidence-backed
  proposals against an immutable baseline, approved by a human and reversible.
  Never perform online self-modification.
- Keep operator prose provider-neutral: same language as the operator, concise,
  plain, organized by topic when needed, and without emojis or em dashes. A
  request to explain again must preserve the facts and cause no runtime action.
- Diagnostics, cohort observations, and derived ideas remain advisory. They may
  create reviewable proposals but never approve, start, fix, or block work.
- Run focused checks while editing. The project `verify` spine runs once at the
  ship boundary rather than inside every implementation loop.
- Let production evidence drive roadmap priority: real usage, provider
  failures, latency, known cost, operator attention and regressions.

## Approval boundary

This file records current direction; it grants no execution authority. Only an
operator-approved issue specification authorizes a bounded change. Discoveries
outside that scope return as proposals, and unresolved product judgment returns
to the operator. Publishing, merging, changing lifecycle state, or starting a
different roadmap stage requires its own authorization.

## Next ordered seams

1. Onboarding: deterministic registration of an existing or a new repository,
   plus removal. Without it the registry only ever reflects what discovery
   found.
2. Project scope for the operator surfaces that are still boot-only:
   conversation, brief, settings, and operational credentials.
3. Concurrency across independent repositories only, with a global limit and a
   per-provider limit. Same-repository runs stay serial.
4. Then, in this order: a per-project visual harness; derived documentation and
   changelog from the change itself; ntfy configuration; an optional and
   auditable executor policy by subscription, model, and effort; a measured
   beta; and a soft ratchet.

Accumulating comparable revision-tagged terminal runs stays ahead of every
threshold, cohort rule, and self-tuning behaviour in this list. Do not invent a
threshold before the runs exist to derive one.

Change this order only when product evidence supports it and an approved issue
authorizes the bounded next slice.

## Product radar

Comparable projects and tools, what was adopted, what is held pending measured
evidence, and what is rejected in the current design, with sources and verified
licenses, live in `docs/product-radar.md`. That file records decisions only; it
approves nothing and is never surfaced in the product interface.
