# Gateship current checkpoint

> Updated: 2026-09-01, against the `v0.380.0` tag.
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

The external agent is the primary conversational interface. It may investigate
and return typed Gateship commands; the deterministic runtime alone owns
mutations and lifecycle state. The project brief is the only durable handoff
between external sessions. The browser opens a project's Runs surface,
while keeping Central, Runs, Trabalho and Ajustes available. Approved runs
start from a fresh `origin/main` worktree without moving local `main`, execute
the task's explicit verification, receive an independent mechanically read-only
review, and ship through a squash-merged pull request. Clean merged workspaces
are released; dirty, failed, or uncertain leftovers are preserved and surfaced.

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

The first real Reporter onboarding exposed one checkout hygiene gap: opening an
external project created one untracked `.gship/` entry when the checkout had no
rule for it. Project-owned runtime state now installs an idempotent nested
catch-all immediately before the first state write; `.gateship/project.json`
remains a separate tracked contract.

The same onboarding proved that multistack verification alone was insufficient:
Reporter owns `package-lock.json`, so the former unconditional `bun install
--frozen-lockfile` failed before an agent could start. The versioned project
manifest can now declare ordered preparation commands, including an explicit
empty list, while an absent field preserves the legacy Bun preparation.

Observed Claude and Codex calls also stayed alive through long provider-side
retry loops without useful protocol output. Every agent child now owns one
shared ten-minute inactivity deadline, reset only by stdout protocol lines.
Expiry reaps the process group and becomes a typed transport hold, preserving
the run workspace and provider session without inventing a reset time or
switching executors.

The first real external run then shipped Reporter issue #58 through PR #298.
Its project-owned preparation, executable premise, focused verification,
independent review, one autonomous fix round, three-command full verification,
PR, merge, and Vercel deployment all completed without operator intervention.
The run took 8 minutes 48 seconds and reported USD 2.7158543 of known Claude
cost. The review caught a false concurrency test that passed sequentially and
the executor replaced it with an interleaved test that demonstrably fails when
the lock is removed.

That run also exposed two onboarding boundaries that are now product evidence,
not speculation. Operator issue intake writes control metadata directly to
remote main, so a repository that requires pull requests rejects the intake
before a run can start. Reporter required a temporary metadata PR recovery;
weakening branch protection is not an acceptable default. Shipping also
depends on the repository admitting Gateship's merge strategy, but readiness
does not report whether auto-merge is available. Protected-ref-compatible
intake and typed ship readiness therefore precede more diagnostic breadth.

Operator-facing executor summaries and reconciliation were correctly emitted
in Portuguese. Raw provider activity remained in English. Preserve raw output
as audit evidence; do not claim that the whole event stream is localized until
the UI distinguishes provider-native activity from operator-facing prose.

## Multiproject state and its limits

A global `GATESHIP_HOME` holds a durable, automatically reconciled project
registry. It supports checkout registration, GitHub import and creation, and
removal without deleting project data. Overview lists registered projects, and
the operator surfaces and policies are scoped by the selected project.

Profile and notifications are global. Each project keeps its own runtime
database, worktrees, and history in its resolved project `stateDir`; the global
registry stores only identity and location. There is one active run per project,
with serialization within that project, while the central surface aggregates
project state.

Every run performs technical reconciliation at startup. Technical internal
answers are recorded, CI can be resumed, and handoff between providers is safe.
Projects the registry does not report ready retain their typed unavailable
answer. No physical state migration is planned.

## Current evidence

The beta surface includes the project registry, checkout registration, GitHub
import and creation, removal without data deletion, project-scoped surfaces and
policies, global profile and notifications, run inspection, work
and proposal queues, provider management, technical startup reconciliation,
recorded internal answers, resumable CI, safe provider handoff, advisory React
diagnostics, revision-cohort facts, and bounded native self-update. The current
flow is summarized in `FLOW.md`; provider and credential boundaries are
documented under `docs/`.

The GSHIP-723 to GSHIP-741 cohort, without a score, delivered 19 PRs with green
CI in 4.52 hours of summed terminal wall time, with an 8.67-minute median, 29
fix rounds, 16 internal questions, and 17 of 19 runs without operator
intervention. GSHIP-733 to GSHIP-741 had zero operator intervention and resolved
10 internal questions. The first GSHIP-741 attempt failed typecheck; a new run
shipped without intervention.

Reporter is the first external-project evidence point: one shipped run, one
autonomous fix round, zero attention requests, zero operator interventions,
USD 2.7158543 known cost, full project verification clean, and Vercel green.
Keep it as one observation, not a benchmark or threshold.

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

1. Make issue intake compatible with a protected main without weakening the
   repository, and report merge capability as typed project readiness.
2. Add typed diagnostic and measurement adapters.
3. Validate another external project only when it adds a new stack or hosting
   boundary; Reporter already closes the generic external-onboarding proof.
4. Only then, consider a soft ratchet or statistical policy.

Accumulating comparable revision-tagged terminal runs stays ahead of every
threshold, cohort rule, and self-tuning behaviour in this list. Do not invent a
threshold before the runs exist to derive one.

Change this order only when product evidence supports it and an approved issue
authorizes the bounded next slice.

The explicit versioned multistack verification contract is now delivered in
`.gateship/project.json` with version 1 and `bun run verify`. The end-to-end
JavaScript/Python proof now runs through the real GitFullVerifier runner: the
manifest is read from the immutable run base and its command validates the
current worktree for both Bun and `python3 -m unittest`. Stack-aware readiness
stays deferred until real runs demonstrate that it is needed. Project-defined
commands now cross a closed child-environment boundary: evidence, issue
verification and full verification receive the shared minimum allowlist, not
the service's ambient environment. Provider, GitHub CLI, update and
notification environments remain independently owned.

## Product radar

Comparable projects and tools, what was adopted, what is held pending measured
evidence, and what is rejected in the current design, with sources and verified
licenses, live in `docs/product-radar.md`. That file records decisions only; it
approves nothing and is never surfaced in the product interface.
