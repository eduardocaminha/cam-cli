# Gateship project handoff

> Last operator checkpoint: 2026-08-20
> Repository: `/Users/eduardo/Documents/Projects/gateship`
> Shipped baseline: `origin/main` at `65414f46` (onboarding, PR #514)
> Active implementation branch: `codex/operator-profile`
> Current stage: operator identity/timezone verified; publication pending

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
  human dismisses or promotes them; promotion never approves or starts them.

The browser conversation is the primary operator surface. Explicit controls
remain deterministic fallbacks. The right architecture is a typed provider
adapter plus one runtime, not a second orchestration server duplicating domain
logic.

## Active bounded slice

The minimal operator profile is implemented on `codex/operator-profile`:

- one optional `{ name, timezone }` record lives in existing
  `runtime_settings`; no table, account or remote identity was added;
- `/api/operator-profile` exposes a same-origin-protected whole-record write;
- the web suggests the browser timezone but persists nothing until the operator
  explicitly saves; the runtime validates and canonicalizes IANA identifiers;
- every orchestrator turn receives the profile as non-authoritative context,
  using the name naturally and timezone only to interpret dates;
- malformed persisted data degrades to an empty profile rather than blocking
  boot or conversation.

Focused verification passed 187 tests, both TypeScript projects and Biome lint.
The one ship-boundary `bun run check:all` passed 743 tests, both typechecks,
Biome and Knip; Knip reported only its two pre-existing configuration hints.

## Previously shipped bounded slice

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

## Verification already completed on this branch

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

- Build a provider-neutral `Gateship Diagnostics` capability after onboarding
  and operator identity/timezone. It runs ad hoc first and later on a schedule
  persisted by the existing service; do not introduce host cron or a daemon.
- A scheduled scan runs once when overdue, without a catch-up storm, against an
  exact source SHA in an isolated workspace and at low priority while the
  project is idle.
- Normalize analyzer output into rule, severity, file, evidence, tool version
  and source SHA. Deduplicate recurring findings and send them to a diagnostic
  inbox; a human may dismiss or promote one into the existing issue workflow.
  Findings never auto-fix code, auto-approve work or block ship through a score.
- React Doctor is the first candidate adapter for React projects, invoked with
  a pinned version, structured output and telemetry disabled. It is optional,
  not part of `check:all`, and must not silently install into or edit the
  operator's project. Shadscan remains deferred as a narrower optional adapter.
- LSP is the other strong direction: detect and expose language servers by
  project profile, beginning with TypeScript where appropriate. Do not install
  every language server in one universal image or pretend Gateship controls
  whether a third-party agent client actually uses one.
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
  outcomes and reduced attention, not agent activity.
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
7. per-role model/effort selection and usage accounting.

Next product stages, in current order:

1. finish and ship minimal operator identity/timezone (active branch;
   repository facts already shipped with onboarding);
2. ad hoc diagnostics foundation and project-aware LSP availability;
3. coherent telemetry and operator-facing observability, including diagnostic
   usefulness and false-positive measurements;
4. persisted diagnostic schedules owned by the existing service;
5. replayable evals and self-benchmarking;
6. measured self-improvement and community proposal intake;
7. internationalization, accessibility and beta readiness;
8. multiproject selection and parallelism across independent repositories;
9. external-user validation before Product Hunt or a YC-style launch push.

This order is not ceremonial. Change it when product evidence or an
implementation discovery supports a better sequence, and record why.

## Continuation prompt

For a fresh Codex, Claude Code or Gateship orchestrator session:

> Read `AGENTS.md`, `CLAUDE.md` and `HANDOFF.md`; inspect `git status`,
> `origin/main`, the latest commits and the running service. Confirm PR #514 is
> present. If `codex/operator-profile` still contains unshipped work, finish
> only the active profile slice from the evidence above; do not restart
> onboarding or provider recovery. Do not start GSHIP-660/661/662 or reapprove
> them. Preserve the simple one-service architecture. Run focused checks while
> editing and `bun run check:all` once at the ship boundary.
