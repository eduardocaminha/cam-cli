# Product radar

> Reviewed: 2026-08-23 against Gateship v0.342.0.

This file records product decisions taken while looking at comparable projects.
It keeps competitive detail out of the durable checkpoint in `HANDOFF.md`.

Rules for this file:

- It records decisions, not architectures. Nothing here approves a feature; only
  an operator-approved issue specification authorizes a change.
- No third-party code, text, or identity is copied. Entries describe the
  observed behaviour in our own words and link to the source.
- Licenses are the ones each source declared on the review date above.
  BSL/BUSL, AGPL, FSL, and sources without a declared license are reference
  only: read for direction, never vendored, adapted, or quoted.
- These names never appear in the product interface, catalogs, or operator
  prose.

## Adopt now

Directions already decided. Each is a Gateship rule; the reference is only where
the shape was observed.

- **Durable facts as the single state source.** A run state is derived from
  recorded facts, and worker, pull request, and CI detail are read in one place
  instead of three. Observed in
  [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)
  (Apache-2.0).
- **Evidence receipt attached to the review.** A review returns verified, gaps,
  or not verified, so a clean verdict states what it actually checked. Observed
  in [Loki Mode](https://github.com/asklokesh/loki-mode) (BSL 1.1; reference
  only).
- **Environment profile separate from quality profile.** Whether the toolchain
  can run is a different question from whether the change is acceptable.
  Observed in [Galley](https://github.com/shinpr/galley) (MIT).
- **Repeat only the failed criterion, when the runtime supports it.** A passing
  verification stays passed; the next attempt targets what is unresolved, not
  the whole contract. Also from Galley. This depends on our verification
  contract exposing per-criterion results; until it does, the whole command
  reruns.
- **Auditable handoff.** Decisions carry rationale and rejected alternatives,
  and context moves between stages as a record rather than as reconstructed
  memory. Cross-repository dependency ordering belongs to the same record.
  Observed in [Relay](https://github.com/jcast90/relay) (MIT).
- **Ceremony proportional to risk, plus retrospectives.** A one-line fix does
  not pay for a full pipeline, and each run can record what worked, what broke,
  and where the operator had to intervene. Observed in
  [Firebreak](https://github.com/firebreak-ai/firebreak) (MIT).
- **Simple onboarding and multiplatform distribution.** Registering a repository
  and installing the runtime stay one step each, across platforms. Observed in
  [Aperant](https://github.com/AndyMik90/Aperant) (AGPL-3.0; reference only).
  Gateship already ships native binaries and one container image; the open item
  is repository onboarding.
- **Canonical instruction with generated adapters and documentation impact.**
  One source of agent instructions, adapters generated from it, and a change
  that names the documents it invalidates. Observed in
  [Buildwright](https://github.com/raunakkathuria/buildwright) (no declared
  license; reference only).

## Keep, conditional on measured evidence

Each entry needs a measured bottleneck before it becomes an issue.

- **Run replay, routing provenance, outcome cohorts, and budget.**
  [Pilot](https://github.com/qf-studio/pilot) (BSL 1.1; reference only) records
  executions for playback and enforces daily and weekly cost limits. Condition:
  operators cannot explain a finished run from its existing events, or provider
  cost becomes an observed constraint.
- **Atomic checkout, governance, and multiproject aggregation.**
  [Paperclip](https://github.com/paperclipai/paperclip) (MIT). Condition: more
  than one registered project is actually in daily use.
- **Isolation and independent reproduction of a failure.**
  [Zeroshot](https://github.com/the-open-engine/zeroshot) (MIT) separates
  executor from verifier so the verifier reproduces the failure on its own.
  Condition: reviews are observed accepting an implementer's self-report.
- **Bounded-cycle benchmarks.** [Kodo](https://github.com/ikamensh/kodo) (MIT)
  compares runtimes over a limited number of cycles. Condition: comparable
  revision-tagged terminal runs exist to benchmark against.
- **Self-hosted control plane across machines.**
  [Warren](https://github.com/jayminwest/warren) (MIT). Condition: a single
  local service stops being enough. Its self-improvement side is rejected below.
- **Named preview URLs instead of ports.**
  [Portless](https://github.com/vercel-labs/portless) (Apache-2.0). Condition:
  concurrent project previews exist and port collisions are observed. No
  privileged proxy or local certificate lifecycle before then.
- **Code graph for review context.**
  [code-review-graph](https://github.com/tirth8205/code-review-graph) (MIT) and
  [Greptile](https://www.greptile.com) (proprietary SaaS) index a repository so
  reviews read less. Condition: review context, not review judgment, is the
  measured bottleneck. code-review-graph ships as an MCP server, which the
  rejection list below constrains.
- **Repository readiness reporting.**
  [Factory Agent Readiness](https://factory.ai/agent-readiness) (proprietary)
  scores repositories across fixed axes. Useful as a checklist of signals to
  look for; the score itself is rejected as a gate.
- **Additional advisory diagnostics.**
  [shadscan](https://github.com/TheOrcDev/shadscan) (MIT) for shadcn UI
  fundamentals. Condition: UI regressions that review keeps missing.
- **Cross-runtime language servers in the image.** The
  [Language Server Protocol](https://github.com/microsoft/language-server-protocol)
  (spec, CC-BY-4.0) is the portable way to give an agent real symbol
  information. Condition: a multistack proof exists, so the capability is
  justified for more than JavaScript.
- **Evaluation loop as an explicit objective.**
  [loss-function-development](https://github.com/elvisun/loss-function-development)
  (MIT) is kept as a future reference for how to shape evals. No dependency is
  added.

### jscpd

[jscpd](https://github.com/kucherenko/jscpd) (MIT) detects copy-paste across a
repository. It is a candidate advisory analyzer, on cron or ad hoc only. It does
not belong in `check:all`: duplication is a judgment signal, and a blocking
duplication threshold would fail honest changes.

### React Doctor

[React Doctor](https://github.com/millionco/react-doctor) (Modified MIT) is
already integrated as an advisory analyzer, pinned and run with telemetry
disabled. It stays advisory: it may produce a reviewable proposal and never
approves, starts, fixes, or blocks work.

## Reject in the current design

Rejecting these is a design decision, not a quality judgment of the sources.

- **Routing by regex or task size.** Pilot auto-detects task complexity to pick
  a model and a thinking depth. Gateship keeps executor selection explicit and
  operator-owned; a size heuristic silently changes the contract the operator
  approved.
- **A score as a gate.** Factory Agent Readiness places a repository on a
  maturity level from fixed axes. A composite number hides which signal moved
  and invites optimizing the number instead of the software.
- **Self-learning that mutates rules.**
  [Tenet](https://github.com/JeiKeiLim/tenet) (MIT stated in its README, with no
  LICENSE file in the repository; reference only) folds learnings back into its
  doctrine, and Warren advertises self-improvement. Gateship keeps an immutable
  baseline: evidence-backed proposals, human approval, version history, and
  rollback. Never online self-modification.
- **An agent org chart.** Loki Mode orchestrates dozens of specialized roles.
  Extra agents are justified only by reduced operator attention or fewer
  observed failures.
- **Universal TDD.** A test-first mandate on every task is ceremony that
  reversible work does not pay for. The approved verification contract is the
  gate, and it can require tests when the change warrants them.
- **Parallelism inside the same repository.**
  [Forge Orchestrator](https://github.com/nxtg-ai/forge-orchestrator)
  (FSL-1.1-ALv2; reference only) adds file locking and drift detection so
  several agents can share one checkout. Gateship keeps same-repository runs
  serial; parallelism belongs only across independent repositories.
- **Fixed pipelines of many phases.**
  [Claude Lights Out](https://github.com/DreamChaserEric/claude-lights-out)
  (MIT) runs a fixed nine-phase pipeline where every phase runs; Tenet
  structures every run through eight. Ceremony stays proportional to risk.
- **Multiplied critics.** Tenet runs several evaluators per job. One independent
  read-only review, with a material-defect contract, is the gate.
- **Unlimited retry.** Tenet defaults to no retry cap, and
  [Ralph Orchestrator](https://github.com/mikeyobrien/ralph-orchestrator) (MIT)
  loops until the task reports done. Gateship bounds attempts and returns to the
  operator instead of burning tokens on a stuck run.
- **A daemon or MCP server per workspace.**
  [no-mistakes](https://github.com/kunchenguid/no-mistakes) (MIT) adds a daemon,
  a Git proxy, hooks, and a duplicate validation pipeline; code-review-graph
  ships as a per-workspace MCP server. One Bun process owns HTTP, SQLite, child
  processes, and cancellation.
- **Permission bypass.** Running the provider CLI with its safety prompts
  disabled is how most unattended harnesses reach zero intervention. Gateship
  reaches it through worktree isolation, an explicit child-environment
  allowlist, and a mechanically read-only reviewer instead.
- **A broad adapter catalog.** Kodo, Loki Mode, and Aperant each support four or
  more agent CLIs. Gateship supports the two subscription-backed providers it
  can authenticate credential-blind and verify; each additional adapter is
  surface without evidence.
