# Gateship project handoff

> Last operator checkpoint: 2026-08-20
> Repository: `/Users/eduardo/Documents/Projects/gateship`
> Shipped baseline: `origin/main` at `a5ec156e` (replayable workflow cohorts, PR #519)
> Active implementation branch: `codex/workflow-ratchets`
> Current stage: provider-CLI identity ratchet verified and authorized for publication

## How to use this file

This is the canonical cross-session checkpoint for Codex, Claude Code and the
Gateship orchestrator. Read `AGENTS.md`, `CLAUDE.md` and this file, then inspect
Git and the running service before continuing.

This file records direction and current state. It is not blanket authorization
to execute the roadmap. Continue only the active bounded slice or another slice
the operator explicitly approves. When code and this file disagree, investigate
and update the checkpoint instead of preserving stale prose.

Keep this file short. Git owns historical detail; the handoff owns current
decisions, evidence, open risks and the next safe action.

## Product objective

Gateship should let one operator discuss and approve several well-specified
ideas, then deliver the approved queue with as little attention as correctness
allows. Autonomy is the product. More agents, gates, regexes, retries or tests
are not progress unless they measurably reduce operator attention or failures.

The governing rules are:

- Prefer a small root-cause repair or deletion over a policy layer.
- A human approves the complete executable specification before a run.
- The deterministic runtime owns state, verification, review and shipping.
- An LLM may investigate and propose typed commands; it never becomes the
  source of lifecycle truth.
- Stop honestly on uncertainty. Preserve work and make recovery explicit.
- Same-project runs remain serial. Parallel execution is reserved for
  independent projects after multiproject support exists.
- Focused tests run while editing; `bun run check:all` runs once at the ship
  boundary.

## Current product

Gateship is one Bun web service started by `gship`. There is no `gshipd`, tmux,
send-keys path, terminal UI, sidecar or per-run daemon.

The service:

- serves a React UI on localhost with `/`, `/runs`, `/work` and `/settings`;
- persists run state, events, settings and the provider-neutral orchestrator
  transcript in SQLite;
- reads approved work from fresh `origin/main` without moving local `main`;
- creates one managed worktree per run;
- invokes the selected subscription-backed Claude Code or Codex CLI;
- executes optional specification evidence before provider work and explicit
  verification commands after implementation;
- uses a fresh, mechanically read-only reviewer session;
- allows one bounded automatic fix and otherwise returns judgment to the
  operator;
- commits, opens a pull request, arms squash auto-merge, observes the exact
  head it pushed and releases clean merged workspaces;
- captures out-of-scope implementation discoveries in a proposal inbox. A
  human dismisses or promotes them; promotion never approves or starts them;
- runs optional diagnostics against an exact source SHA in an isolated
  checkout and keeps every finding advisory until a human settles it.
- records the Gateship revision that created each new run and replays factual
  workflow cohorts from the existing durable decision log.

The browser conversation is the primary operator surface. Explicit controls
remain deterministic fallbacks. The right architecture is a typed provider
adapter plus one runtime, not a second orchestration server duplicating domain
logic.

## Active bounded slice

The provider-CLI identity hard ratchet is implemented locally on
`codex/workflow-ratchets`:

- a real Gateship diagnostic scan ran against exact shipped SHA `a5ec156e` and
  completed with 15 advisory findings, no accessibility findings and no
  workspace notices;
- the micro-performance suggestions and two context-dependent React warnings
  remain advisory. Gateship will not edit code merely to improve an analyzer
  score;
- the relevant supply-chain finding showed that the image still installed
  Claude Code through a mutable command. The image now requests exact Claude
  Code `2.1.238`; Codex remains pinned to the verified complete release
  `0.148.0`;
- every Claude child receives `DISABLE_UPDATES=1`, so a provider invocation
  cannot replace its own CLI behind the recorded Gateship workflow revision.
  CLI upgrades remain an explicit image or host maintenance boundary;
- deterministic configuration and child-environment tests prevent either
  provider install from returning to a mutable version.

Focused provider/runtime tests pass: 48 tests, 215 expectations. Both
TypeScript projects, Biome and `git diff --check` pass. A fresh local container
image builds, Claude reports `2.1.238` and Codex reports `0.148.0`. The 15
diagnostic findings remain pending in the real inbox for human settlement; none
was silently dismissed or promoted. The soft ratchet remains dormant because
legacy runs provide zero recorded workflow revisions and therefore no two
comparable terminal cohorts. The full ship-boundary gate passes 768 tests and
3,090 assertions, both TypeScript projects, Biome and Knip; Knip reports only
its two pre-existing configuration hints. The operator authorized publication
of this exact bounded slice on 2026-08-20.

## Previously shipped bounded slices

PR #519 shipped replayable workflow cohorts as squash commit `a5ec156e`. Every
new run records its Gateship build/source revision, and one pure event replay
derives factual outcome, wall time, human attention, provider holds and observed
provider/model/effort. `/runs` compares the latest two observed revision cohorts
inside its existing bounded read. It adds no endpoint, table, collector, queue,
evaluator model, score, causal claim or automatic policy. CI initially exposed
an incomplete mutable Codex npm release; the image now pins verified release
`0.148.0` and a static regression test guards the pin. The final local and CI
gates passed 768 tests and 3,088 assertions. The stable service was rebuilt and
verified on all four routes.

PR #518 shipped bounded diagnostic schedules as squash commit `8a1e4059`.
The persisted schedule is off by default, offers only daily or weekly cadence,
checks once per minute in the existing process and starts at most one overdue
scan while the project is idle. Manual and scheduled scans share the exact-SHA
isolated diagnostic path and reset one cadence without catch-up backlog. No
host cron, daemon, queue, sidecar, new table or diagnostic score was added. The
local and CI gates passed 761 tests and 3,064 assertions; the stable service was
rebuilt and verified on all four routes.

PR #517 shipped the first local telemetry/observability foundation as squash
commit `53d6db28`. `/runs` derives raw outcomes, correction origins and known
provider-reported cost from its existing bounded run read, without a score,
collector or new endpoint. Diagnostics expose complete pending, dismissed,
promoted, cleared and recurring counts, and explicitly avoid equating dismissal
with false-positive classification. The final local and CI gates passed. LSP
was investigated and deferred: making it available to both current provider
CLIs would require an asymmetric plugin or a new MCP/client/sidecar before a
measured navigation failure justifies that complexity.

PR #516 shipped ad hoc Gateship Diagnostics as squash commit `2af5cb42`. One
in-process runtime scans an exact `origin/main` SHA in an isolated detached
worktree, with a pinned React Doctor `0.9.12` adapter, normalized durable
findings, recurrence/clearing semantics, cancellation and preservation of dirty
analyzer workspaces. `/work` exposes a human-settled advisory inbox; diagnostics
never fix, approve, start or block a ship. The final local and CI gates passed.

PR #515 shipped the optional operator profile as squash commit `238ae4f5`.
Name and IANA timezone live in existing settings, are persisted only by an
explicit same-origin write, and reach orchestrator turns as non-authoritative
context. The local and required CI gates passed and the restarted service was
verified on all four routes.

PR #514 shipped deterministic project onboarding as squash commit `65414f46`.
It derives readiness from local Git metadata without fetching, guides existing
and new projects, keeps Settings available for incomplete projects, and adds no
project picker, host supervisor or second service. The same PR carried four
evidence-backed UI audit repairs without adding React Doctor as a dependency or
score gate. CI and the local 735-test gate passed; the restarted service reports
the real repository ready, no stale-service warning and all four routes at 200.

PR #512 shipped six implementation changes as squash commit `ba1004ec`:

1. `69c1d522` — classify provider call failures at the adapter boundary;
2. `1a1c531d` — preserve runs in `waiting-provider`;
3. `f024b8d1` — separate subscription login from observed availability;
4. `ad27fb6d` — harden and document the real container boundary;
5. `9e39716d` — bind evidence commands and recorded output to human approval;
6. `93c43ef1` — tighten unknown-error, timestamp, provider-status and run-scan
   behavior found in the ship review.

### Provider recovery behavior

Provider adapters now produce typed failures:

- `auth-required`
- `usage-limit`
- `rate-limited`
- `overloaded`
- `model-refused`
- `transport-unavailable`
- `protocol-invalid`
- `cancelled`
- `unknown`

Structured provider fields are authoritative when available. One small ordered
message classifier is only a fallback at the adapter boundary.

Availability failures move the run to durable `waiting-provider` instead of
terminal `failed`. The worktree and native session id stay owned by that run.
Explicit resume continues the executor session; if the hold occurred during
review, only a fresh reviewer is started and implementation is not repeated.
Protocol-invalid and unknown errors still fail; cancellation still interrupts.

There is deliberately no blind automatic retry. A write-capable provider call
may have edited files before the client reports failure, so replay is not known
to be idempotent. There is also no automatic provider swap in the middle of a
run. The UI and notifications expose the hold and an explicit resume.

Provider settings distinguish:

- whether the subscription login is connected; and
- whether an active run has observed a temporary hold for that provider.

Absence of a hold never claims a remaining quota balance. Gateship observes
failures; it does not poll or invent provider quota.

### Container boundary

Compose now uses a read-only image filesystem, ephemeral `/tmp`,
`no-new-privileges` and drops every Linux capability except `DAC_OVERRIDE` and
`FOWNER`, retained for bind-mounted repositories with a different host uid.
The project and single `.gship` state volume remain writable.

This is honest host containment for one trusted operator, not multi-tenant
secret isolation. Environment allowlists prevent accidental inheritance, but
the selected provider process necessarily reads the login store owned by its
own CLI. A mode-0600 notification secret on the same filesystem identity is
also not hidden from a hostile child. Moving files to another directory on the
same volume would not change that. A stronger boundary would require a separate
OS identity and credential broker and is deferred until evidence justifies the
complexity.

### Approval correction

The approval fingerprint now covers normalized `scope`, `verify` and every
optional evidence command/output. Evidence runs before the provider and is
therefore executable authority; changing it without invalidating approval was
unsafe.

Specs without evidence keep their existing fingerprint. Existing approved
specs with evidence become stale and require an explicit new approval. This
correctly removes GSHIP-660, GSHIP-661 and GSHIP-662 from the executable queue
without inventing a new `deferred` state or editing issue JSON by hand.

## Earlier shipped verification record

- Focused provider, runtime, web API, UI, notification, approval and container
  configuration tests pass.
- Type checking and lint pass after each bounded change.
- A real container image built successfully.
- Claude and Codex both responded inside the read-only, capability-minimized
  container.
- The real Gateship service booted and served `/api/snapshot` under that same
  Compose boundary.
- Projecting the real backlog through the new fingerprint code yields no
  plannable issues; GSHIP-660/661/662 all project as stale.
- The final `bun run check:all` passed after the ship-review corrections: 725
  tests, typecheck, lint and Knip all clean.
- The source service was restarted after the merge. `/`, `/runs`, `/work` and
  `/settings` return the merged bundle; the live APIs report the chain off, no
  plannable issue and no stale-service warning.
- Automated browser inspection was unavailable in this Codex session. The live
  `/runs` page was opened in the app panel, and API, route, bundle and rendered
  component tests cover the changed surface, but no automated visual assertion
  should be claimed.

Nothing remains to ship for this slice. PR #512 passed required CI and merged
through pinned squash auto-merge on 2026-08-20.

## Queue state and evidence

The chain switch was manually turned off through `PUT /api/chain-runs` on
2026-08-20. The action is reversible and starts nothing by itself.

GSHIP-660 had already started under the old runtime and ended terminal `failed`
when Claude reported: `You've hit your session limit`. Its event log shows the
provider result and usage followed by `run.failed`; the clean worktree was then
released. This is the exact real failure the new `waiting-provider` state fixes.

The approved GSHIP-660 design should not be executed as written. It proposes
executing evidence while an issue is filed or revised, before the human approval
boundary. That would turn a read-only conversational proposal into arbitrary
project command execution. Evidence remains shape-validated at intake, covered
by the later human fingerprint and executed just in time in the run worktree.
If early evidence preview proves necessary, specify it later as an explicit
human-triggered validation action, not as a hidden intake side effect.

GSHIP-661 (external MCP server) is deferred. The internal web orchestrator can
already investigate and call typed runtime commands. A second MCP/HTTP adapter
would add another command registry and authority surface before demand proves
that browser conversation is insufficient.

GSHIP-662 (host-side automatic image updater) is deferred. Self-replacement
requires a host supervisor, rollback and another lifecycle owner, conflicting
with the one-service design. For now updates stay explicit and the stale-service
warning remains the honest mechanism.

Do not reapprove any of these three without reviewing its specification with
the operator.

## Stable architecture decisions

### Agents and subscriptions

- Claude Code and Codex are peers behind `AgentSession` adapters.
- Both implementation and review work on either provider; provider-specific
  protocol remains inside the adapter.
- Subscription CLI login is required. Gateship does not use Agent SDK/API-key
  billing and does not accept provider token fields in the UI.
- A local-model adapter is possible later, but only after a concrete provider
  can satisfy the same session, tool, cancellation and review contract. Do not
  build a generic bus in anticipation.
- Model and reasoning effort are selected per provider and role, validated by
  the CLI and included in usage measurements.

### Specification and autonomous queue

- No planner/auditor convergence loop. The human-approved specification is the
  contract.
- Approval covers all executable commands: evidence and verification.
- Evidence is checked just in time against the run workspace. Approval proves
  intent; evidence checks whether assumptions still match current code.
- Ten or twenty ideas may be specified ahead of time, but each starts only
  after current admission/evidence checks. A divergence pauses the queue instead
  of silently replanning the approved contract.
- Derived ideas go to the existing proposal inbox with provenance. They never
  expand the current issue or auto-enter the executable queue.

### Tests and deterministic gates

- Keep deterministic gates for state transitions, approval, workspace safety,
  explicit verification and shipping identity.
- Remove gates that merely restate registries, wording or obsolete surfaces.
- Run the smallest relevant tests during implementation.
- Run `bun run check:all` once before ship/CI. It is not an inner-loop ritual.
- Add tests for observable behavior, destructive boundaries and reproduced
  failures, not every branch introduced by implementation style.

### Diagnostics and code intelligence

- `Gateship Diagnostics` is provider-neutral and supports manual or persisted
  daily/weekly scans in the same service. Do not introduce host cron or a
  daemon.
- A scheduled scan runs once when overdue, without a catch-up storm, against an
  exact source SHA in an isolated workspace and at low priority while the
  project is idle.
- Normalize analyzer output into rule, severity, file, evidence, tool version
  and source SHA. Deduplicate recurring findings and send them to a diagnostic
  inbox; a human may dismiss or promote one into the existing issue workflow.
  Findings never auto-fix code, auto-approve work or block ship through a score.
- React Doctor is the first adapter for React projects, invoked with
  a pinned version, structured output and telemetry disabled. It is optional,
  not part of `check:all`, and must not silently install into or edit the
  operator's project. Shadscan remains deferred as a narrower optional adapter.
- LSP is deferred: Claude requires a plugin plus binary and Codex currently has
  no native surface. Do not add an asymmetric hidden capability or a universal
  MCP/sidecar without measured need.
- `loss-function-development` is a design reference for the future eval system,
  not a dependency. Reconsider `code-review-graph` only if telemetry shows
  context retrieval, rather than review rounds and human decisions, became the
  measured bottleneck. Do not adopt `better-result`; native discriminated
  results and typed errors already cover the observed need.

### UI and product surface

- `/` is the conversation and current attention surface.
- `/runs` owns run history and detailed event inspection.
- `/work` owns executable work, reviewable specs and derived proposals.
- `/settings` owns providers, model/effort, notifications and scheduler policy.
- Keep default cards readable; details belong behind progressive disclosure,
  not in a mixed right rail.
- shadcn-compatible primitives are acceptable, but Gateship must not contain
  product-specific references or vendored source from the earlier UI kit.
- Keep the CLI small: launch, help, version and packaging needs. Product
  operations belong to the web/runtime contract rather than a second CLI UX.

### Memory, telemetry and community

- Durable orchestrator transcript plus the operator-maintained project brief is
  the current handoff mechanism. Do not add a knowledge graph until measured
  retrieval failures demonstrate need.
- Telemetry should derive from one coherent event model: latency, attention,
  retries, failures, provider/model/effort, verification cost and shipped
  outcome. Privacy-conscious local defaults come first.
- Evals compare workflow changes against a baseline and must reward shipped
  outcomes and reduced attention, not agent activity. The first foundation
  records revision in `run.created` and replays separate observational signals
  from durable events; it deliberately has no evaluator LLM or score.
- Ratchets have two different authority levels. A deterministic defect that is
  reproduced and fixed may become a permanent regression test or invariant
  (`hard ratchet`). An observational cohort regression only creates a sourced
  proposal after enough comparable evidence (`soft ratchet`); it never blocks
  work or changes policy automatically. A human must approve promotion into a
  rule or test, and the original evidence and workflow revision remain linked.
- Never turn the soft ratchet into one composite score or require every metric
  to improve: issue scope, provider, model and effort are confounders. The
  ratchet preserves proven safety and proposes measured workflow improvement;
  it does not optimize activity or accumulate policy by itself.
- Keep the soft ratchet dormant until at least two revisions have comparable
  terminal cohorts. Do not invent a minimum sample or attach cohort evidence
  to one arbitrary run merely to reuse the current run-derived proposal row.
  Generalize proposal provenance only when real cohort evidence requires it.
- Self-improvement produces reviewable proposals from recurring measured
  failures. It never mutates local rules automatically.
- Community input should enter the same proposal inbox with provenance and
  operator promotion. Remote content never receives approval authority.

## Ordered roadmap

Completed foundations:

1. web-first single-service core and provider adapters;
2. durable cross-session transcript and editable project brief;
3. specification revision, approval fingerprint and fail-closed admission;
4. derived-idea proposal inbox;
5. serial approved-run scheduler and pause visibility;
6. container packaging, published image and provider-failure recovery;
7. per-role model/effort selection and usage accounting;
8. ad hoc project diagnostics with a human-settled inbox;
9. local derived workflow observability without scores or a collector;
10. bounded daily/weekly diagnostics inside the existing service;
11. replayable revision cohorts without an evaluator model or composite score.

Next product stages, in current order:

1. finish and publish the provider-CLI identity hard ratchet on the active
   branch, only after explicit operator authorization;
2. accumulate real revision-tagged terminal runs; keep the soft ratchet dormant
   until two comparable cohorts exist;
3. add measured self-improvement and community proposal intake without
   automatic rule mutation;
4. internationalization, accessibility and beta readiness;
5. multiproject selection and parallelism across independent repositories;
6. external-user validation before Product Hunt or a YC-style launch push.

This order is not ceremonial. Change it when product evidence or an
implementation discovery supports a better sequence, and record why.

## Continuation prompt

For a fresh Codex, Claude Code or Gateship orchestrator session:

> Read `AGENTS.md`, `CLAUDE.md` and `HANDOFF.md`; inspect `git status`,
> `origin/main`, the latest commits and the running service. Confirm PR #519 is
> present. If `codex/workflow-ratchets` still contains unshipped work, finish
> only the provider-CLI identity ratchet above: exact provider versions,
> immutable Claude child updates and their deterministic tests. Do not dismiss
> or promote the 15 real diagnostic findings without operator action. Keep the
> soft ratchet dormant until two comparable recorded cohorts exist. Do not add
> an evaluator LLM, synthetic score, remote telemetry, new event pipeline,
> endpoint, table or queue. Do not publish without explicit operator
> authorization. Do not start or reapprove GSHIP-660/661/662. Preserve the
> one-service architecture. Run focused checks while editing and
> `bun run check:all` once at the ship boundary.
