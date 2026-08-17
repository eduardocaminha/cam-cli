# Gateship project handoff

> Last operator checkpoint: 2026-08-16
> Repository: `/Users/eduardo/Documents/Projects/gateship`
> Product baseline: `main` at `f3a58546` (GSHIP-611 shipped through PR #441)
> Active provider: Claude Code. Codex exhausted its subscription credit on
> 2026-08-16 mid-stage, so continuation moved provider without changing scope,
> direction or stage. This file is the resume point if the Claude side degrades.

## How to use this file

This is the canonical cross-agent continuation checkpoint for Codex, Claude
Code, and the Gateship orchestrator. It records product direction, decisions,
current stage, and the ordered roadmap.

It is not an executable specification and does not authorize an agent to start
the whole roadmap. Before implementation, turn only the current proposed slice
into a bounded specification and obtain explicit operator approval. If code and
this file disagree, investigate the repository and update the checkpoint rather
than silently assuming either is current.

## Current stage

**Stage 4 of 15 — derived-idea inbox (specified as GSHIP-612; awaiting operator
approval, no implementation started). GSHIP-611 shipped in the meantime and
closed the interrupted-run lifecycle gap.**

Stages 1 and 2 are complete. GSHIP-602 through GSHIP-604 added and dogfooded the
generated cross-provider handoff plus the separate operator-maintained project
brief and its `/settings` editor.

Stage 3 is complete. GSHIP-605 binds approval to a
deterministic SHA-256 fingerprint of `{ scope, verify }`; only
`create_and_start_issue` records approval at creation, and run preflight rejects
missing or stale approval. A full-CI failure also proved the intended test
boundary: focused tests run during implementation and the complete suite runs
before merge. The production invariant stayed strict; only an obsolete fixture
was corrected.

Dogfooding the Codex subscription fallback then exposed two orchestration
integration defects. GSHIP-606 retries a failed native session resume once with
a fresh read-only session while reusing the durable transcript. GSHIP-607 made
the shared command envelope compatible with strict Structured Outputs and
preserves JSONL provider errors instead of masking them behind empty stderr.
The same real conversation that had failed then succeeded without losing the
cross-provider transcript or executing a command.

GSHIP-609 added deterministic operations to revise an existing specified draft,
always invalidating approval, and to approve its current fingerprint without
starting it. GSHIP-610 exposed those operations on `/work` as a progressively
disclosed review form with an explicit human confirmation. Visual dogfooding
then caught one shared-domain mismatch: an unapproved draft was also projected
as plannable. PR #438 moved the approval-fingerprint check into `isPlannable`;
the final browser check showed zero executable issues, one reviewable draft, and
an approval button enabled only after confirmation.

GSHIP-611 is complete and shipped through PR #441. The operator approved its
fingerprint on `/work`, the run executed on Claude and merged with no fix round.
Run state gains a terminal `cancelled` reachable only from `interrupted`, plus
`abandonRun`, `POST /api/runs/:runId/abandon`, the typed `abandon_run` command
and an "Abandonar" control rendered only when eligible. Abandoning never reopens
the provider session, releases only the run's own clean worktree and branch,
preserves and surfaces a dirty one, and stops blocking the next issue. That run
was also the first end-to-end proof of the full loop on the Claude provider
after the Codex credit ran out.

The executor flagged one non-blocking factor worth capturing later: abandon
reuses the merged-run release contract, so a clean worktree whose branch still
holds unmerged commits loses that branch. Uncommitted work makes the worktree
dirty and is therefore preserved. No new gate was added because destructive
cleanup was out of that slice's scope.

GSHIP-612 is the Stage 4 slice already specified and also still an **unapproved
draft**. It extends the shared Claude/Codex structured result with a required
`proposals` array, empty by default and capped at 3 items, each carrying a
non-empty `title` and `evidence`. On an accepted `completed` result the
`RunRuntime` persists every item in the `RunStore` as a `pending` proposal with a
stable id, `derived-from` relationship, `sourceRunId` and `sourceIssueId`.
Proposals change no run state, issue, spec, approval, backlog or execution order.
Out of scope in this slice: HTTP API, UI, dismiss, promotion to draft,
deduplication, ranking, embeddings, graph, scheduler and reviewer changes.

### Proposed next bounded action

No implementation slice is pending specification. The next action belongs to the
operator: review GSHIP-612 on `/work` and approve or revise it. Only after an
explicit approval may an agent start the corresponding run. Verification command
already recorded in GSHIP-612:

```
bun test test/runtime/run-store.test.ts test/runtime/claude-cli-executor.test.ts test/runtime/codex-cli-executor.test.ts test/runtime/run-runtime.test.ts && bun run typecheck
```

### Recent process evidence

- GSHIP-608 generated a nonexistent verification path. It was cancelled before
  edits and abandoned rather than silently changing an approved contract.
- The interrupted GSHIP-608 run initially remained resumable and blocked new
  work; GSHIP-611 records that derived lifecycle proposal rather than expanding
  another issue's scope.
- Codex reached its subscription usage limit during the final Stage 3 pass and
  Claude was also temporarily unavailable. PR #438 was therefore an explicit
  local bootstrap repair: separate PR, full `bun run check:all`, CI, and browser
  validation, but no provider review. Recheck provider availability instead of
  assuming this temporary condition persists.
- Codex then exhausted its credit entirely and the operator continued on Claude
  Code from commit `9dbd8d55`. Nothing about the product direction, the stage or
  the approval discipline changed with the provider. If a Claude session goes
  wrong, resume from this checkpoint rather than reconstructing the state from a
  transcript.
- GSHIP-611 then ran end to end on Claude, from operator approval to squash
  merge, in about thirteen minutes with no fix round. The provider swap is
  therefore validated on the real loop, not only in principle.
- A stale `gship` binary in `~/.local/bin` served a UI seven hours older than
  the repository and read as a product regression. While iterating, run the
  service from the repository; reinstall the compiled binary only at the end of
  a cycle, and re-sign it with `codesign` on arm64.

## Product objective

Gateship should let an operator turn ideas into reviewed specifications, approve
them deliberately, and then leave a queue of work executing as autonomously as
is safely possible. Human judgment belongs at intent, specification, exceptions,
and final product decisions. Deterministic code owns lifecycle, isolation,
verification, and shipping.

Autonomy is measured by useful work completed without attention, not by the
number of agents, gates, regexes, policies, or tests. Prefer a smaller reliable
loop over recreating the former harness in the browser.

## Decisions already made

- Gateship is web-first: one local Bun service, React UI, SQLite, and provider
  adapters. Do not add tmux, send-keys, a sidecar, container workers, a terminal
  UI, or a second `gshipd` process.
- Use the operator's authenticated subscription CLIs. Claude Code and Codex are
  the first providers; provider-specific credentials remain in their own local
  stores. Never copy OAuth tokens or API keys into Gateship or expose token
  fields in the web UI.
- A provider adapter is the portability seam. Model and reasoning-effort choice
  should eventually be configurable and measured. A local-model adapter is a
  later option only if real demand justifies it.
- The conversational orchestrator may investigate the repository, clarify
  intent, and invoke typed commands. The deterministic runtime owns state,
  worktrees, verification, cancellation, and shipping.
- The operator-approved specification is the execution contract. Do not require
  planner/auditor convergence. Specifications are mutable drafts whose explicit
  approval fingerprint is invalidated by later executable changes.
- Derived ideas never silently expand a running issue. Capture them as proposed
  follow-ups, deduplicate and relate them, then require human validation before
  they enter the executable queue.
- Multiple approved issues in one project execute serially by default. Before
  each starts, revalidate it against current `origin/main`, dependencies, and
  assumptions. Parallelism is initially for independent projects, not branches
  that can invalidate each other's specifications.
- Review is an independent read-only session. It may trigger one bounded fix
  attempt; unresolved judgment returns to the operator rather than creating an
  unbounded reviewer/fixer loop.
- Run worktrees start from fresh `origin/main`. After confirmed merge, Gateship
  removes only clean owned worktrees/branches and reports dirty or unknown
  leftovers. Local and remote branch hygiene is a product responsibility.
- While editing, run the smallest relevant tests. Run `bun run check:all` once
  at the ship/CI boundary. Do not multiply gates or tests for wording and
  implementation details.
- UI information architecture should favor a calm conversational workspace,
  progressive disclosure, and dedicated routes for materially different jobs.
  Run cards must show decisions and outcomes first, with raw detail on demand.
- The UI may use shadcn primitives, but the product and source must not name or
  depend on COSS. Do not vendor third-party product identity or copy a product's
  proprietary presentation.
- Secrets for GitHub remain in `gh`; optional notification credentials remain
  server-side environment configuration. Add concrete integrations only when
  needed rather than designing a universal secrets or notification bus.
- Prefer bounded structured memory and evidence-backed retrieval. Do not build a
  knowledge graph until observed workflows demonstrate that simpler project
  context, decisions, links, and search are insufficient.

## Ordered roadmap

1. **Invariant baseline — complete.** Web-first single-process core,
   subscription provider bus, deterministic typed runtime, no terminal proxy,
   and simplified review/spec boundaries.
2. **Cross-session continuity — complete.** Generated handoff and the editable
   operator-maintained brief are separate, provider-neutral, and dogfooded.
3. **Specification lifecycle — complete.** Draft, revision, approval
   invalidation, explicit reapproval, fail-closed start, and web confirmation
   share one approval-fingerprint contract.
4. **Derived-idea inbox — next.** Capture implementation discoveries as
   proposals with provenance and relationships; never auto-promote them into
   scope.
5. **Serial autonomous scheduler.** Queue approved work, revalidate just in time,
   handle dependencies/conflicts, pause honestly, and resume without replanning
   everything.
6. **Robust sandbox.** Tighten filesystem, process, network, secret, cancellation,
   and cleanup boundaries around provider work without restoring container-era
   orchestration complexity.
7. **Onboarding.** Separate flows for an existing repository and a new project;
   discover scripts and repository facts, then ask the operator to confirm the
   proposed setup.
8. **Project and operator configuration.** Name, timezone, repository identity,
   notification preferences, and other minimal durable settings.
9. **Provider, model, and effort policy.** Per-role choices with sensible
   defaults, subscription availability detection, graceful fallback, and usage
   attribution.
10. **Telemetry.** A coherent event model for latency, attention, retries,
    failures, provider/model/effort, test cost, and shipped outcomes, with
    privacy-conscious defaults.
11. **Evals and self-benchmarking.** Replayable scenarios and product-level
    success measures that compare workflow changes against the baseline rather
    than rewarding more activity.
12. **Self-improvement and community.** Turn measured recurring failures and
    successful patterns into reviewable proposals; let the community share
    improvements without allowing remote rules to mutate local behavior
    automatically.
13. **Observability and insights.** Operator-facing traces and periodic,
    evidence-backed recommendations at a cadence derived from available data,
    not noisy dashboards.
14. **Internationalization and beta readiness.** Externalize UI language,
    harden accessibility and first-run experience, document support boundaries,
    and prepare a credible public beta.
15. **Multiproject and external validation.** Project switcher and safe parallel
    execution across independent repositories, followed by real-user validation
    before Product Hunt or a broader launch.

This order is intentional but not immutable. Change it when user evidence,
measurements, or implementation discoveries justify a better sequence; record
the reason rather than preserving the roadmap ceremonially.

## Current product

Gateship is one local web service started by `gship`. It serves the React UI,
stores durable runs, events, and the orchestrator transcript in SQLite, creates
an isolated worktree from fresh `origin/main`, invokes the selected signed-in
Claude or Codex CLI, runs the task's explicit verification commands, asks a
fresh read-only session from the same provider to review, and ships through a
squash-merged pull request.
After a confirmed merge it releases the clean managed worktree and local branch;
dirty or unowned leftovers stay visible for operator inspection.

The operator specification is the contract. There is no planner/auditor
convergence phase and no terminal proxy on the execution path.

The `/work` route separately projects currently executable issues and specified
drafts awaiting review. A draft cannot appear as plannable unless its persisted
approval fingerprint still matches its executable contract.

## Boundaries to preserve

- Keep one process and one owner for HTTP, SQLite, children, and cancellation;
  do not add `gshipd` or a sidecar.
- Do not reintroduce tmux, send-keys, container workers, terminal UI, installed
  personas, or control-file protocols.
- Keep the conversational orchestrator read-only. It may investigate and return
  at most one typed command; only the deterministic service mutates lifecycle.
- Use authenticated subscription CLIs, not an Agent SDK or API-key billing.
- Review is a new read-only session. One bounded automatic fix attempt is
  allowed; remaining judgment returns to the operator.
- Runtime work starts from `refs/remotes/origin/main`; never move the user's
  local `main` branch.
- Prefer deleting obsolete surface over adding a policy or gate to govern it.

## Where to look

- `README.md` and `FLOW.md`: public behavior and end-to-end flow.
- `src/commands/web.ts`: HTTP composition.
- `src/runtime/run-runtime.ts`: durable run state machine.
- `src/runtime/run-store.ts`: SQLite state and events.
- `src/runtime/conversational-orchestrator.ts`: durable chat and typed commands.
- `src/runtime/agent-session.ts`: Claude/Codex provider bus.
- `src/runtime/*-cli-executor.ts`: resumable implementation sessions.
- `src/runtime/*-cli-reviewer.ts`: independent review.
- `src/runtime/github-shipper.ts`: commit, PR, auto-merge, and source refresh.

## Verification

Run `bun run check:all`. CI invokes the same manifest on one Ubuntu host job.

## Continuation prompt

For a fresh Claude Code or Codex session:

> Read `AGENTS.md`, `CLAUDE.md`, and `HANDOFF.md`, inspect `git status` and the
> latest commits, then summarize the current stage and any mismatch you find.
> Do not implement the full roadmap. Continue only the next operator-approved
> bounded slice. Stage 3 is complete and the Stage 4 backend slice is already
> specified as GSHIP-612. GSHIP-611 already shipped, and GSHIP-612 is still an
> unapproved draft, so do not start, implement, expand or implicitly approve it.
> Report the current state and wait for the operator's explicit approval.
