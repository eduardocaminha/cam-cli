# Gateship project handoff

> Last operator checkpoint: 2026-08-16
> Repository: `/Users/eduardo/Documents/Projects/gateship`
> Product baseline: `main` at `7dcfe4b9` (GSHIP-629 shipped through PR #468)
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

It records problems, decisions and evidence, not habits. A workaround that asks a
human to remember something is a defect with no owner: state it as an unsolved
problem so it can be fixed in the product, rather than as a rule to follow.

## Current stage

**Stage 5 of 15 — the serial autonomous scheduler is next, and GSHIP-629 just
handed it the mechanism its revalidation needed. Stage 9 closed with per-role
model and effort live and validated against the CLI, the operator running Opus 5
at `high` for the orchestrator and the reviewer and Sonnet 5 at `xhigh` for the
executor, and the cost of each role now recorded. Fourteen slices shipped in this
cycle, GSHIP-614 through GSHIP-629, and three of them are measured: a clean run
cost about seven expected dollars, and a run that needed five rounds cost about
forty-seven. No draft is open.**

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

GSHIP-612 shipped Stage 4's backend through PR #442. `run-proposal.ts` defines
the proposal shape, its limits of at most three items with bounded `title` and
`evidence`, and the normalizer that trims, clamps and drops unusable items. The
shared Claude and Codex execution schema now requires a `proposals` array, and
the work prompt tells the executor to keep the current issue closed to its scope
and use proposals only for future work discovered while implementing. Proposals
are parsed for a `completed` result only; `waiting-user` drops them and a missing
or malformed array degrades to empty. `RunStore` gained a `run_proposals` table
with stable ids, `derived-from` provenance and deterministic reads. `RunRuntime`
persists them right after the accepted work-completed transition, emitting
`run.proposals-captured` or `run.proposals-failed` so a capture failure can never
change run state.

GSHIP-613 then shipped Stage 4's operator surface through PR #444. Proposal
status widened to `pending | dismissed | promoted`, a proposal now carries the
issue it became, and `decodeProposal` reads status and relationship from the row
instead of returning constants. `/api/proposals` lists pending proposals and the
dismiss and promote routes settle one with a status-guarded update. Promotion
takes an operator-authored title, scope and verification command, calls the
existing intake with approval withheld, and only then marks the proposal
promoted; a failing intake leaves it pending. `/work` shows the inbox as a third
disclosure card beside plannable work and reviewable drafts.

The inbox did not open empty. The GSHIP-613 run itself captured three proposals,
because it executed with the schema GSHIP-612 had already shipped: a snapshot
that does not refresh on capture, a promoted proposal whose issue is stored but
never shown, and duplicated refusal responses across the web handlers.

Both repairs shipped. GSHIP-614 made the issue file's ownership explicit:
`RunRuntime.findActiveRunForIssue` answers whether a run still owns an issue, the
revise and approve routes and the typed specify, approve and abandon commands
refuse with 409 `issue-run-active` before any git work, approving a fingerprint
that already matches returns the published entry without committing, and `/work`
explains itself instead of offering those controls during a run. The abandon
route named in the specification does not exist in this tree, so the guard was
placed on the writer where it is actually reachable.

GSHIP-615 made the ship refuse a merge whose head the service did not push. It
stores the pushed sha, re-reads the pull request's `headRefOid` on every poll,
ends the ship explicitly on divergence without merging, re-arming or deleting the
branch, and reports merged only while the observed head is still the pushed one.
An unreported head counts as divergence. The file comment that claimed
`--match-head-commit` alone would refuse such a merge now documents the re-check.

### Proposed next bounded slice

GSHIP-616 shipped through PR #449, completing the inbox's first full circuit: a
run captured a proposal about its own fix, the operator promoted it, and the
promoted issue executed and merged. The ship now disarms the auto-merge before
ending as a failure on a divergent head, so GitHub can no longer land that head
later, unwatched.

GSHIP-617 shipped Stage 9's first slice through PR #451. Gateship now owns model
and effort per provider and per role, stored in `runtime_settings` and edited in
`/settings`, consulted at each spawn rather than at boot, with the resolved pair
emitted in the run's spawn event. An unset slot passes no flag, and every slot is
still unset, so behavior is unchanged until the operator chooses.

GSHIP-619 then deleted the suggestion lists GSHIP-617 had shipped, because they
were already wrong on the day they landed: the Claude list omitted `fable` and the
Codex list omitted the very effort level the operator's own configuration uses.
Each provider now links its official model documentation instead, and the fields
stay free text. Gateship cannot track vendor releases, and a suggestion that lies
is worse than none.

GSHIP-618 shipped the stale-service warning through PR #453. The service records
the `origin/main` sha it booted from, compares it to the current one on every
snapshot read, and reports the divergence with both shas. It never blocks an
operation and never invents a divergence when either sha fails to resolve.

GSHIP-622 then corrected GSHIP-618 the same day: comparing any movement of `main`
kept the warning permanently lit, because filing, approving and closing an issue
all commit to `main` continuously. It now fires only when the diff between the two
shas touches something outside `.gateship/`.

GSHIP-621 released the worktree and branch of a run that ends `failed`, which
until then were left behind, with one condition the merged path does not need: it
releases only when the worktree is clean *and* the branch holds no commit missing
from the base ref. A failed run often fails after committing, and that commit may
be the thing worth inspecting. This also closes the factor GSHIP-611 flagged and
deliberately left out.

GSHIP-620 validates a typed model and effort by probing the CLI itself at save,
for changed slots only. A slot the CLI refuses is not stored; an inconclusive
probe stores the slot and warns, because refusing on ambiguity would lock the
operator out of settings while offline. The Codex probe carries
`--skip-git-repo-check` beside `--ignore-user-config`: without it the probe fails
on directory trust before reaching the model check and would refuse a valid model.
No catalog, no scheduled refresh, no network of Gateship's own.

### Proposed next bounded slice

GSHIP-626 made the Claude reviewer's verdict a mechanism instead of a request.
`REVIEW_RESULT_SCHEMA` existed but only the Codex reviewer passed it; the Claude
reviewer asked for JSON in prose and a salvage parser scanned the reply for any
object that parsed. On a review whose subject was JSON payloads, the reviewer
ended without the verdict object, the parser promoted an inline example, and the
run failed after the work was already implemented and verified. The schema now
rides the argv like the executor's, and the prose scan is gone.

GSHIP-623 then records what each role costs. Measured on the real stream, the
`result` event carries `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens` and
`output_tokens_details.thinking_tokens`, plus a `modelUsage` breakdown with a
`costUSD` per model. Three rules hold. The dollar figure is always the expected
cost of the same usage through the API, never an amount charged, because the
operator pays a subscription. The total includes auxiliary model calls the
configuration does not name, so the breakdown is per model rather than attributed
to the configured one. And the total is aggregated server-side from the complete
event history: the first attempt summed it in the browser, where two independent
caps of 200 events would have under-reported a long run without saying so.

GSHIP-625 separates provider unavailability from provider decision in the ship. A
transient `HTTP 503` is retried with backoff instead of ending the ship, and a
merge that cannot be observed is reported as unconfirmed rather than failed, while
a divergent head still fails immediately.

GSHIP-627 split the event log by lifetime. Measured before the change, 92.8% of
16006 events were the four provider-stream kinds and only 1153 carried a decision;
the largest run held 1144 events of which 35 were decisions, most of them outside
the newest 200 the live read returns. Class is written at emit time and never
inferred at read time, the default is durable so a new kind that forgets to
declare itself shows up rather than vanishing, and the suffix rule that described
the old rows was used once by the migration and is not live logic.

GSHIP-628 completed the cost surface, and its two rounds were both modelling
errors in the specification rather than in the implementation. Effort and thinking
tokens are properties of an invocation, not of a model: the CLI reports thinking
once per invocation and never inside `modelUsage`, and matching a model name is
impossible anyway because the operator's slot holds a free-text alias while the
CLI reports resolved ids. Both are now reported per role, and an effort that
differs between a role's invocations is reported as absent rather than guessed.

GSHIP-629 gave a specification an executable premise. `evidence` holds up to three
command-and-observed-output pairs, checked in the run's own workspace after it is
prepared and before any provider work, with a divergence ending the run and
naming the command, the recorded output and the current one. It runs through the
same owned-command path as verification, with timeout and process-group
termination, because an operator-authored command deserves the same containment
whether it proves a premise or a result.

### Proposed next bounded slice

Stage 5's serial scheduler. GSHIP-629 already answers the part that needed design:
revalidating a queued issue is re-running its recorded evidence and comparing, so
the queue pauses honestly when the premise moved rather than trusting a
fingerprint that only sees the specification's own text.

Three smaller slices are identified and unfiled. Operator decisions never reach
the reviewer, so a ratified deviation is re-reported on every later round: each
review is a fresh session and the review prompt carries no record of what the
operator already settled. The legacy `Spec` fields can now go, since `gotchas` and
`domainTerms` were already dead in code and retiring the CAM backlog made the
`acceptanceCriteria` fallback dead in data. And provider errors should be
classified at their source in each adapter, following the shape GSHIP-625 settled,
with the Claude CLI's own `--fallback-model` wired as an optional per-role slot.
Polling vendor status pages was considered and rejected, because a status page
lagged reality in both directions during the outage this cycle.

### Recent process evidence

- GSHIP-608 generated a nonexistent verification path. It was cancelled before
  edits and abandoned rather than silently changing an approved contract.
- The interrupted GSHIP-608 run initially remained resumable and blocked new
  work; GSHIP-611 records that derived lifecycle proposal rather than expanding
  another issue's scope.
- Codex reached its subscription usage limit during the final Stage 3 pass and
  Claude was also temporarily unavailable. PR #438 was therefore an explicit
  local bootstrap repair: separate PR, full `bun run check:all`, CI, and browser
  validation, but no provider review. Provider availability is a moving condition
  that the checkpoint cannot record accurately.
- Codex then exhausted its credit entirely and the operator continued on Claude
  Code from commit `9dbd8d55`. Nothing about the product direction, the stage or
  the approval discipline changed with the provider. If a Claude session goes
  wrong, resume from this checkpoint rather than reconstructing the state from a
  transcript.
- GSHIP-611 then ran end to end on Claude, from operator approval to squash
  merge, in about thirteen minutes with no fix round. The provider swap is
  therefore validated on the real loop, not only in principle.
- A stale `gship` binary in `~/.local/bin` served a UI seven hours older than
  the repository and read as a product regression. GSHIP-618 later covered the
  running service, but nothing covers the installed binary: it can be arbitrarily
  older than the repository and says so nowhere, and on arm64 it also needs
  re-signing with `codesign` after every build. Unsolved.
- GSHIP-612 then shipped the same way in about eleven minutes with no fix round,
  making two consecutive unattended Claude runs. Both released their worktree and
  branch automatically after merge.
- A schema added by a run does not exist in an already-running service. The
  `run_proposals` table only appeared after restarting the process, because the
  store creates its schema at startup.
- Branch and worktree hygiene is only automatic for runs that merge. Hand-made
  pull requests and runs that end `failed` leave their branch and worktree
  behind, and one such leftover was a superseded GSHIP-605 attempt whose diff
  against `main` was an earlier shape of an already-shipped feature.
- Approving GSHIP-613 a second time while its run was in flight wrote `main` on
  the same file the branch would commit, and the ship stalled on a conflicting
  pull request. The fingerprint was identical, so the second approval carried no
  new decision at all. The branch was rebased by hand, keeping the branch's
  shipped stage and the newer approval, and the run then completed. GSHIP-614
  records the durable repair.
- That hand repair force-pushed the run's branch, and the auto-merge armed with
  `--match-head-commit` did not refuse the moved head as the shipper's own
  comment says it would. The merged code was verified locally before the push,
  but by discipline rather than by the mechanism. GSHIP-615 records that repair.
- Four consecutive Claude runs shipped unattended with no fix round: GSHIP-612,
  613, 614 and 615. Every one released its worktree and branch after merge.
- The inbox paid for itself on its first day. Seven proposals were captured from
  four runs, and the sharpest one came from the run that had just shipped the
  fix it criticised: GSHIP-615's own divergence failure leaves the auto-merge
  armed. That became GSHIP-616 through promotion rather than by hand.
- A hand-made pull request goes `BEHIND` whenever `main` advances while it waits
  for CI, and needs `gh pr update-branch`. A run hits this too, whenever anything
  merges during its window: a checkpoint pull request landed while GSHIP-617 was
  working and left the run's own pull request behind.
- Killing the service does not lose a run, but it does strand one. GSHIP-616's
  run survived the restart in `ready-to-ship` with verification and review
  already recorded, and finished from `POST /api/runs/:runId/ship` without
  repeating any provider work. Nothing resumes a stranded ship on its own.
- The operator's own Codex configuration selects an expensive model at a high
  reasoning effort, and Gateship never used it, because the Codex adapter passes
  `--ignore-user-config`. Reading a personal configuration file is not evidence
  about what the runtime spent.
- Fixing that `BEHIND` from outside the service proved GSHIP-615 on its first
  real occurrence: moving the head emitted `ship.head-diverged` and ended the
  ship without merging. GSHIP-616's disarm did not run, because the service
  process predated it, so the armed auto-merge landed the head while the runtime
  still believed the run had not shipped. `POST /api/runs/:runId/ship` reconciled
  it, since the shipper recognises an already-merged pull request.
- That is the third distinct way one stale process bit in a single day: a missing
  table, a missing route, and a safety fix silently absent. GSHIP-618, GSHIP-622
  and GSHIP-624 turned that into a warning the service raises itself, so the
  operator no longer carries the rule. Restarting is still manual, and whether it
  should stay manual is open.
- A model or effort the operator mistypes is not caught by Gateship at all. Both
  CLIs refuse an unknown model with a message covering existence and account
  access, so validation belongs in a probe against the CLI rather than in any
  catalog Gateship would maintain.
- The per-role split is confirmed in use, not only in argv: run events now carry
  `provider.model` as Sonnet 5 at `xhigh` and `review.model` as Opus 5 at `high`.
- Those were also the session's first two fix rounds, after six consecutive runs
  with none on the previous defaults, and both were the design working rather than
  failing. The Opus reviewer caught a real defect the Sonnet executor had shipped,
  naming file and line: a dead Codex process would have been reported as a refused
  model and silently reverted the operator's choice, the exact lockout that issue
  forbade. The other round caught `README.md` still documenting the old cleanup
  contract. Both were fixed inside the run, with no operator involvement.
- Whether the cheaper executor is actually cheaper is unknown and unmeasurable
  today. Sonnet 5 costs roughly two and a half times less per token than Opus 5,
  while `xhigh` is documented for long-horizon work with far larger token budgets,
  and Gateship keeps no token accounting. Two extra fix rounds are a cost the
  price-per-token comparison does not include.
- Specifying a signal from reasoning without checking it against the repository's
  real traffic has now misfired three times in one day: the model suggestion lists,
  the always-lit stale warning, and the refusal classification GSHIP-620 needed a
  fix round to correct. Each was cheap to repair and each was found by something
  other than the specification.
- A draft written before the previous run finishes goes stale, and the approval
  fingerprint does not notice, because the specification's text is unchanged while
  the code it describes moved. GSHIP-619 could not have been written before
  GSHIP-617 shipped a wrong suggestion list, and GSHIP-622 could not have been
  written before GSHIP-618's warning stayed permanently lit. Working one slice at
  a time avoids this by hand and is not a rule worth keeping: it is a workaround
  for revalidation that only checks the fingerprint, and Stage 5 is where that
  gets fixed.
- Three attempts to ship GSHIP-624 during a GitHub partial outage produced two
  `HTTP 503` failures at different steps, and the second one armed the auto-merge
  that landed the pull request one second after reporting failure. The service was
  right to refuse to claim a merge it could not observe, and wrong to call an
  unavailable provider a failed merge. GSHIP-625 records that repair.
- A provider status page is not the authoritative signal. GitHub's page still
  reported a partial outage while pushes from this repository were already
  succeeding, so the call the runtime just made is a better source than the page.
- Three of the four agent paths enforced their structured result with a schema
  flag and the Claude reviewer did not, which is how a finished, verified run
  died at its verdict. The asymmetry survived because the salvage parser hid it:
  it worked on every review until one whose subject was JSON.
- A run whose merge happens outside the shipper leaves its remote branch behind.
  The release path deletes the local remote-tracking ref with `update-ref -d` and
  never pushes a delete, so the leftover is invisible until the next
  `fetch --prune`. Both branches found this way came from ships reconciled by
  hand after the outage.
- Eleven issues shipped in this cycle, GSHIP-614 through GSHIP-626, nine of them
  with no fix round. The two fix rounds and the one failed run were all found by
  the reviewer or by the mechanism, never by the operator reading code.
- The first measured costs, all expected API-equivalent and none of them charged:
  GSHIP-627 cost about seven dollars with no round, GSHIP-628 about twenty-two
  with three, and GSHIP-629 about forty-seven with five. Rounds, not the model,
  dominate what a run costs, because every round pays the executor and the
  reviewer again.
- Of the nine operator decisions those two runs needed, seven corrected a premise
  the specification had stated wrongly and two corrected the implementation. The
  bottleneck this cycle was specification quality, not execution, and GSHIP-629
  exists because of it.
- The reviewer never sees an operator decision. Each review is a fresh session
  with no resume, and the review prompt carries no record of what was settled, so
  the same ratified deviation was reported twice on GSHIP-629 and cost a round
  each time.
- Moving a run's pull request from outside is now safe: on GSHIP-629 the head
  moved, GSHIP-615 detected it, GSHIP-616 disarmed the auto-merge, and nothing
  landed unwatched. The day before, with the disarm missing from a stale process,
  the same sequence merged a head the service never verified.
- Retiring the CAM-era backlog removed 80 open issues that no run referenced and
  that carried the legacy `acceptanceCriteria` contract, which cut the directory
  the snapshot parses from 120 open issues to 40.

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
- Gateship owns its own model and effort configuration and keeps ignoring the
  operator's personal provider configuration. Inheriting it would let personal
  MCP servers, instructions and sandbox policy govern an unattended executor
  that already runs with approvals and sandbox bypassed, and would make a run's
  behavior change because an interactive preference changed between two days.
  The defect worth fixing is not the separation: it is that Gateship discards
  the operator's configuration without yet having one of its own, so nobody
  chooses. Choice belongs in `/settings`, per provider and per role, and an
  unset value means the flag is not passed at all.
- Both providers must be told the model explicitly once it is configured. Today
  they disagree about what a default is: `--ignore-user-config` cuts the whole
  inheritance on Codex, while `--safe-mode` on Claude disables customizations
  but not the model preference. Any comparison between providers is meaningless
  until both are explicit.
- No planner stage inside a run. The plan is the operator-approved specification,
  produced by the orchestrator investigating with the operator and closed by the
  approval; that is what lets the executor run a weaker model on closed scope.
  A planner inside the run would re-derive what the specification already fixed,
  and anything it decided beyond that would be scope expansion without approval.
  Revisit only if measurement shows fix rounds rise because specifications were
  underspecified, which is a different cause from a weak executor and needs the
  telemetry stage to tell the two apart.
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
4. **Derived-idea inbox — complete.** Implementation discoveries are captured as
   proposals with provenance, shown to the operator, and dismissed or promoted by
   hand. Promotion never approves or starts the issue it creates.
5. **Serial autonomous scheduler — next.** Queue approved work, revalidate just in time,
   handle dependencies/conflicts, pause honestly, and resume without replanning
   everything. Revalidation must cover a specification's assumptions, not only
   its approval fingerprint: a draft written before the previous run goes stale
   because that run changed the code it described, and the fingerprint still
   matches. GSHIP-629 supplies the mechanism, since a specification's premise is
   now recorded as commands with their observed output, so revalidating a queued
   issue is re-running them and comparing.
6. **Robust sandbox.** Tighten filesystem, process, network, secret, cancellation,
   and cleanup boundaries around provider work without restoring container-era
   orchestration complexity.
7. **Onboarding.** Separate flows for an existing repository and a new project;
   discover scripts and repository facts, then ask the operator to confirm the
   proposed setup.
8. **Project and operator configuration.** Name, timezone, repository identity,
   notification preferences, and other minimal durable settings.
9. **Provider, model, and effort policy — pulled forward, shipped.** Per-role
   choice, its validation against the CLI, and the per-role cost record landed as
   GSHIP-617 through GSHIP-626, because the executor does not need the strongest
   model and the cost was already being paid. Subscription availability detection
   and graceful fallback stay in this stage for later; the Claude CLI's own
   `--fallback-model` covers the overloaded case with one flag when it is wired.
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
> bounded slice. Stages 1 through 4 are complete, Stage 9 shipped ahead of Stage 5
> as GSHIP-617 through GSHIP-626, and GSHIP-627 through GSHIP-629 followed. No
> draft is open and Stage 5 is next.
> Report the current state, including the pending proposals in the inbox, and wait
> for the operator's explicit approval before starting anything.
