# Gateship current checkpoint

> Updated: 2026-09-06, against the `v0.435.0` tag.
> Source metadata remains `0.0.0-dev` by design; release builds receive their
> version and source revision at build time.

## Product objective

Gateship lets one operator discuss, approve, and deliver well-specified
software changes with as little attention as correctness allows. Autonomy is
useful only when it reduces operator attention or observed failures.

## Present architecture

Gateship is one Bun web service, distributed as native binaries and one
container image. It serves a React/Vite-built UI, stores durable run state and
events in SQLite, and supervises subscription-authenticated Claude Code or
Codex CLI children through provider adapters. Authentication stays
credential-blind: no provider or GitHub token reaches the UI or SQLite.

O agente conversacional externo escolhido pelo operador é a interface
primária. Ele pode investigar o projeto, refinar a intenção e invocar comandos
Gateship tipados. Gateship é o control plane persistente e determinístico,
acessível por agent CLI, MCP ou HTTP tipado, sem backend conversacional próprio.
O project brief é o único handoff durável entre sessões externas. O runtime
determinístico detém mutações, estado da run, verificação, review, shipping e
cleanup.

Approved runs start from a fresh `origin/main` worktree without moving local
`main`, execute the task's explicit verification, receive an independent
mechanically read-only review, and ship through a squash-merged pull request.
Clean merged workspaces are released; dirty, failed, or uncertain leftovers
are preserved and surfaced. There is one active run per project: work is
serialized within a repository and may run in parallel only across independent
projects.

There is no tmux path, terminal UI, sidecar, second daemon, message broker,
separate database service, or conversational backend. The container is the
isolation boundary; provider and GitHub authentication happens inside it and
persists on the single state volume.

The multiproject control center is organized as Agora at `/overview`,
Execuções at `/overview/runs`, Filas at `/overview/queues`, and Insights at
`/overview/insights`. `/projects` is project management; project context lives
at `/projects/:projectId/{runs,work,settings}` and global configuration at
`/settings`. Project selection persists when the operator visits the Control
center and remains navigation context rather than an implicit API scope.

## Current evidence

By `v0.435.0`, Gateship has delivered project-declared multistack verification
and a JavaScript/Python proof; the minimum environment for project commands;
protected-main-compatible intake; merge without an auto-merge dependency;
global defaults and per-project overrides with per-run telemetry; typed
diagnostics and a soft ratchet; the redesign and real routes; internal
resolution of technical questions; navigation-preserved state; removal of the
internal conversation; a compact operational sidebar; and shared spacing for
cards, grids, and forms.

The explicit versioned multistack contract lives in `.gateship/project.json`.
Project-defined commands run with the shared minimum child-environment
allowlist rather than the service's ambient environment. Provider, GitHub CLI,
update, and notification environments remain independently owned.

The control plane reports independent operational metrics and evidence types;
it does not collapse them into a composite score. Autonomous adaptation must
preserve the approved objective, behavior, risk and verification. A change to
any of those dimensions returns to the operator as a proposal.

Use the tag, commit graph, and the running service's `/api/snapshot` as factual
evidence for an installed version. Git history and GitHub Releases own older
release and decision detail; this checkpoint is not a changelog and does not
duplicate issue-by-issue history.

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
  projects.
- Keep the control center focused on project state, executions, queues and
  independent insights. Do not add a global agent page, generic memory,
  generic Kanban, primary event explorer or AI-decided merge.
- Keep one specification and approval contract whose depth scales with delivery
  risk. Shipped AI behavior, sensitive data, security boundaries, or
  irreversible effects require proportionate evaluation cases, limits,
  observable success, containment or rollback, and stronger evidence.
- Type evidence by origin: deterministic check, human judgment, or model
  evaluation. Preserve provenance and review; never collapse the signals into
  one composite score.
- Diagnostics, cohort observations, and derived ideas remain advisory. They
  may create reviewable proposals but never approve, start, fix, or block work.
- Run focused checks while editing. The project `verify` spine runs once at the
  ship boundary rather than inside every implementation loop.
- Let production evidence drive priorities: real usage, provider failures,
  latency, known cost, operator attention, and regressions.

## Approval boundary

This file records current direction; it grants no execution authority. Only an
operator-approved issue specification authorizes a bounded change. Discoveries
outside that scope return as proposals, and unresolved product judgment returns
to the operator. Publishing, merging, changing lifecycle state, or starting a
different roadmap stage requires its own authorization.

## Next ordered seams

No next seam is approved. Use the current evidence to identify the next bounded
proposal only when it is justified by observed product need and receives an
operator-approved specification.

## Product radar

Comparable projects and tools, adopted and rejected decisions, and items held
pending evidence live in `docs/product-radar.md`. The radar is conditional on
evidence, approves nothing, and is never execution authorization.

The radar records Warren only as a reference for operational density and Aperant
only as a reference for onboarding and distribution. Third-party names do not
enter the interface or catalogs.
