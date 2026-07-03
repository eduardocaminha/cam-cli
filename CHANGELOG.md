# Changelog

All notable changes to cam-cli are documented here.

Format: `## [version] - YYYY-MM-DD` for releases; `## [Unreleased]

## [0.52.0] - 2026-07-03

### Added

- [US-R1-001] - Export readWrapperPid and resolveChildViaPgrep with injectable seam; add direct unit tests for all parsing guards
- [US-003] - Gitignore the orchestrator-pid marker in both copies and re-embed
- [US-002] - Resolve the orchestrator pid via pgrep -P with a non-silent unresolved-pid event
- [US-001] - Persist the orchestrator wrapper pid to a lifecycle marker

## [0.51.0] - 2026-07-03

### Added

- [US-001] - Exponential-with-jitter retry backoff in the supervisor loop

### Fixed

- [US-R1-001] - update MAX_DEAD_WORKER_RETRIES docstring to reference computeBackoffMs

## [0.50.0] - 2026-07-03

### Added

- [US-003] - Disambiguate the cycle-close self-handoff instruction in both agent-file copies
- [US-002] - Clean any stale recycle marker on cam run boot before spawning the watcher
- [US-001] - Refuse to arm the recycle marker when no live watcher is running

## [0.49.0] - 2026-07-03

### Added

- US-003 - Wire occupancy backstop into the recycle watcher tick (arm marker when over ceiling)
- US-002 - Add model->context-window mapping, backstop fraction, and over-backstop decision
- US-001 - Add parseContextOccupancy primitive (last-request occupancy, not cumulative)

## [0.48.0] - 2026-07-03

### Added

- US-001 - Preserve valid issueId-only merge-watch seed in the sidecar null-state GC

## [0.47.0] - 2026-07-03

### Added

- [US-R2-002] - Review round 2 fix 002: address reviewer finding
- [US-R2-001] - Review round 2 fix 001: address reviewer finding
- [US-R1-001] - Review round 1 fix 001: address reviewer finding
- [US-006] - Update orchestrator agent policy to the deterministic recycle flow
- [US-005] - Explicit rehydrate delivery on respawn (CAM-141 fix) with cold-start safety
- [US-004] - Wire the recycle watcher into cam run and prove SIGTERM+respawn end-to-end
- [US-003] - Recycle watcher module and cam orch-recycle-watch command
- [US-002] - Arm the recycle marker via cam journal append --cycle-close
- [US-001] - Add recycle-marker constant, symmetric gitignore, and stop cleanup

## [0.46.0] - 2026-07-02

### Added

- [US-002] - Emit plan-preflight-failed worker event
- [US-001] - Gitignore cam-plan-out pipe-pane logs

## [0.45.0] - 2026-07-02

### Added

- US-R1-001 - Gate stashFn behind issueSystem=none in finalizeCycleClose
- US-006 - Update cam-ship.md for the relocated post-merge close (both merge modes)
- US-005 - Close the none-backend issue on main in the ci-gated post-merge
- US-004 - Stop closing the issue in ship-finalize; stash the resolved issueId instead
- US-003 - Add closeIssueOnMain on-main commit-tree close primitive
- US-002 - Thread an issueId through the merge-watch state schema
- US-001 - Add resolveIssueId helper (string or numeric issueNumber, never <prefix>-0)

## [0.44.0] - 2026-07-02

### Added

- [US-002] - subagent-planner honors an explicit target issue id (both copies + re-embed)
- [US-001] - Thread the selected issue id into the planner task prompt (runner authoritative)

## [0.43.0] - 2026-07-02

### Added

- [US-001] - Thread plan_issue into the plan-runner issue selection

## [0.42.0] - 2026-07-02

### Added

- [US-005] - Crash-proof the plan phase: try/catch forces phase:idle, sidecar survives any exception
- [US-004] - Guard empty/whitespace branchName in runPostAuditAction (never git checkout -b '')
- [US-003] - Planner-produced-no-prd is a failure: escalate to idle, never spawn the auditor
- [US-002] - Clear stale plan-verdict-report.json and prd.json at plan-phase start
- [US-001] - Ensure a live worker-pane before planner/auditor spawn (+ per-worker out-log)

## [0.41.0] - 2026-07-01

### Added

- [US-R2-001] - Review round 2 fix 001: address reviewer finding
- [US-R1-002] - Review round 1 fix 002: address reviewer finding
- [US-R1-001] - Wire runPostAuditAction into makeProductionPlanPhaseFn
- [US-005] - Reduce cam-plan.md to thin phase-signal stub; regen embed; ADR 0006
- [US-004] - cam plan N thin-proxy writes phase:planning + plan_issue instead of injecting markdown
- [US-003] - runPostAuditAction flips phase:implementing on APPROVE+auto; keeps escalate-on-BLOCK
- [US-002] - Wire phase:planning detection into the sidecar outer loop to invoke runPlanPhase
- [US-001] - Add loop-phase enum as single source of truth; active derives from phase

## [0.40.0] - 2026-07-01

### Added

- [US-007] - ADR: behavioral verification = shared runnable gate + independent reviewer verdict + artifact-of-record
- [US-006] - Attach the reviewer artifact-of-record to the PR at ship (gh pr comment)
- [US-005] - Reviewer gate-fail is a hard-constraint FAIL producing FIXES_PENDING
- [US-004] - Reviewer re-runs the gate at Layer B and writes the artifact-of-record
- [US-003] - Implementer runs the gate at Layer A to self-correct
- [US-002] - Shared runnable behavioral gate: drive real cam in tmux, capture, assert
- [US-001] - Parse the per-story behavioral oracle from a PRD story

## [0.39.0] - 2026-07-01

### Added

- [US-R1-001] - Fix allowlist drift: reconcile ALLOWED_DOMAINS, --ipset directives, runbook, and test REQUIRED_HOSTS as single source of truth
- [US-006] - Docs: recovery-runbook credential + DNS-firewall section and ADR for the containerized substrate + credential model
- [US-005] - Wire preflightWorkerContainer() into the dispatch decision point (result available, gates nothing live)
- [US-004] - DNS-based firewall rewrite (dnsmasq + ipset) in init-firewall.sh; fix LFS host
- [US-003] - Container git HTTPS + token credential configuration (no ~/.ssh, no host cred file)
- [US-002] - Parity test: TS docker-run args match .devcontainer/devcontainer.json (no runtime JSONC parse)
- [US-001] - Add worker-container orchestration module (build + run one long-lived container) with credential env threading

## [0.38.0] - 2026-07-01

### Added

- [US-006] - Wire auto-mode post-audit action: commit PRD, create branch, flip active:true; escalate on BLOCK
- [US-005] - Add the deterministic plan-runner driver (pick-issue, spawn planner, spawn auditor, read verdict)
- [US-004] - Add deterministic plan pre-flight in TS
- [US-003] - Add pure argv builders for planner and auditor worker panes
- [US-002] - Auditor writes structured verdict file (self-hosting agent-prompt edit)
- [US-001] - Add plan-verdict-report module (auditor structured exit file)

### Fixed

- [US-R1-001] - add readPlannerReportFn to break planner poll on prd.json written

## [0.37.0] - 2026-07-01

### Added

- [US-R1-004] - Review round 1 fix 004: address reviewer finding
- [US-R1-003] - Review round 1 fix 003: address reviewer finding
- [US-R1-002] - Review round 1 fix 002: address reviewer finding
- [US-R1-001] - Review round 1 fix 001: address reviewer finding
- [US-005] - Add ADR 0003 and recovery-runbook container section
- [US-004] - Add tested Docker preflight helper (uncalled)
- [US-003] - Add devcontainer.json wiring the image, firewall, and non-root user
- [US-002] - Add egress default-deny firewall script
- [US-001] - Add pinned non-root worker Dockerfile

## [0.36.0] - 2026-07-01

### Added

- [US-002] - Add a parity test asserting the clause in the 3 embedded shipped copies
- [US-001] - Insert the merit-over-cost clause into all 3 surfaces and regenerate the embed

## [0.35.0] - 2026-06-30

### Added

- US-004 - Unit tests for end-state prune classification and coalesced narration
- US-003 - Coalesce post-merge narration + prune sub-status into one notifyOrchestrator line
- US-002 - Classify local prune by end-state and force-delete with git branch -D
- US-001 - Classify remote prune by end-state in runPostMerge

## [0.34.0] - 2026-06-30

### Added

- [US-R1-001] - correct ADR 0002 WSJF section to match overridable-default contract
- [US-004] - ADR documenting the two-door plan-readiness decision
- [US-003] - /cam-plan spec-sourcing by specSource + honest non-grilled signal
- [US-002] - Filing flags --fast-track / --derived-from with hard guardrails + WSJF resolution
- [US-001] - specSource/derivedFrom schema + hand-rolled validators

## [0.33.0] - 2026-06-30

### Added

- US-001 - Sync the worktree after writeIssueFile CAS success

## [0.32.0] - 2026-06-30

### Added

- [US-R1-001] - correct false duplicate-key pattern entry from US-002
- [US-003] - build-release.sh soft-check distinguishes missing-claude from init-crash
- [US-002] - Fix the duplicate React key in the init/setup Ink render
- [US-001] - Gate init/setup interactivity on stdin raw-mode, not only stdout.isTTY

## [0.31.0] - 2026-06-29

### Added

- [US-002] - Real-tmux integration test proving deterministic worker-pane geometry on recreate
- [US-001] - Target the orchestrator pane with an explicit size in openPaneInSession

## [0.30.0] - 2026-06-29

### Added

- US-001 - Remove dead buildMergeDescription function

## [0.29.0] - 2026-06-29

### Added

- [US-001] - Repoint stale lessons.md comment to lessons.archive.md

## [0.28.0] - 2026-06-29

### Added

- [US-002] - Wire auth preflight into runRun before session + sidecar spawn
- [US-001] - Add checkClaudeAuth preflight with injectable spawn

## [0.27.0] - 2026-06-29

### Added

- [US-R1-002] - Review round 1 fix 002: address reviewer finding
- [US-R1-001] - Review round 1 fix 001: address reviewer finding
- [US-004] - Add durable-ownership contract one-liner to cam-ship.md (both copies) and re-embed
- [US-003] - Wire one-step-per-tick into the sidecar outer loop and remove eager-delete (closes CAM-103)
- [US-002] - Persist merge-watch state durably across ticks in .cam-merge-watch.json
- [US-001] - Replace blocking poll loop with pure stepMergeWatch tick

## [0.26.0] - 2026-06-29

### Added

- [US-002] - Lock the downstream grill-with-docs skill install against regression
- [US-001] - Route and count the skills/ subtree in the cam init install routine

## [0.25.0] - 2026-06-29

### Added

- [US-005] - Notify-on-drain via a drain-specific Resend message (reuse client, not the escalateFn)
- [US-004] - Wire observe drainer into the sidecar idle-tick (off byte-identical)
- [US-003] - Pure injectable observe decide-fn with dedup + drained detection
- [US-002] - Add 'meta-loop-observe' WorkerEventKind and detail type
- [US-001] - Add readMetaLoop config reader (off default | observe, fail-safe)

## [0.24.0] - 2026-06-29

### Added

- US-003 - Unit test: injected failing sync subprocess keeps commitTreeToMain non-throwing and sha-stable
- US-002 - Real-git integration suite: on-main add/mod/del worktree coherence plus off-main regression
- US-001 - Add syncWorktreeIfOnMain helper and wire it as the final step of commitTreeToMain

## [0.23.0] - 2026-06-29

### Added

- US-001 - Surface branch-prune outcome in post-merge-done event and warn on prune failure

## [0.22.0] - 2026-06-29

### Added

- [US-002] - Persist MAX_ROUNDS_DEBT promotion in runSupervisor so cap-reentry exits terminal and ship accepts it
- [US-001] - Signal MAX_ROUNDS_DEBT promotion from decideNextAction at the cap boundary

## [0.21.0] - 2026-06-29

### Added

- US-001 - Narrate supervisor block outcome at terminal-blocked notify sites

## [0.20.0] - 2026-06-29

### Added

- US-004 - Correct stale no-linter claim in subagent-reviewer verify step (.claude/agents)
- US-003 - Correct stale no-linter claim in subagent-implementer quality gates (.claude/agents)
- US-002 - Correct stale no-linter claim in subagent-auditor item 19 (.claude/agents)
- US-001 - Correct stale no-linter claim in scripts/cam/CLAUDE.md Quality Gates

## [0.19.0] - 2026-06-29

### Added

- US-001 - Surface active:true write failure in cam next

## [0.18.0] - 2026-06-29

### Added

- US-002 - Mirror the guard into the template copy and re-embed the vendor
- US-001 - Add fail-closed jq-absence guard to the runtime hook + deny-without-jq test

## [0.17.0] - 2026-06-29

### Added

- [US-004] - Persona: agir no sinal, escrever reason=cycle-close, remover cadencia advisory
- [US-003] - Resetar cap de respawn por progresso no wrapper do cam run
- [US-002] - Emitir sinal incondicional de handoff no journal append
- [US-001] - Registrar tokens-por-ciclo no event log no cycle-close

## [0.16.0] - 2026-06-28

### Added

- [US-R2-001] - Review round 2 fix 001: address reviewer finding
- [US-R1-002] - Review round 1 fix 002: address reviewer finding
- [US-R1-001] - Remove orphaned writeFileSync import and dead writeFile local
- [US-003] - Remove the orphaned commitOnMain helper and its tests
- [US-002] - Make journal-append and triage on-main writers ref-only
- [US-001] - Make issue-specify on-main writers ref-only (specify/abandon/merge)

## [0.15.0] - 2026-06-28

### Added

- [US-010] - Real-git integration tests: migration, CAS, allocateId race, cross-branch read
- [US-009] - No-vestiges verification + full gate spine green
- [US-008] - Docs sweep to file-per-issue (dual-copy + embed)
- [US-007] - Migrate branch tree to file-per-issue + per-file schema (both copies) + embed
- [US-006] - Idempotent atomic migration: array to dir, delete issues.local.json
- [US-005] - Convert the readers to readBacklogFromMain
- [US-004] - Convert the 4 writers to the file-per-issue dir
- [US-003] - allocateId (max-on-main + 1, CAS re-allocation) and per-file write primitive
- [US-002] - readBacklogFromMain primitive (ls-tree + single cat-file --batch, numeric sort)
- [US-001] - Multi-file atomic on-main commit with compare-and-swap update-ref

### Fixed

- [US-R1-001] - byte-vs-char bug in parseBatchOutput (git cat-file --batch size is bytes)

## [0.14.0] - 2026-06-28

### Added

- [US-005] - Real-git integration test + full gate spine green
- [US-004] - `cam triage` deterministic CLI writing rank to main
- [US-003] - Graph gate: Kahn cycle detection + referential-integrity reuse
- [US-002] - Pure Kahn topo-sort + WSJF ranking module (src/issues/rank.ts)
- [US-001] - Extract shared on-main commit-tree helper from 3 verbatim copies

## [0.13.0] - 2026-06-28

### Added

- US-004 - Fix live stale lessons.md references in agents, patterns.md, and HANDOFF.md
- US-003 - Reconcile CONTEXT.md auto-exists claims to the CAM-118 deterministic writer
- US-002 - Add routing, naming, and location convention rules to scripts/cam/CLAUDE.md
- US-001 - Retire lessons.md to lessons.archive.md with deprecation header

## [0.12.0] - 2026-06-28

### Added

- [US-R4-001] - add title to journal REQUIRED_FIELDS
- [US-R3-001] - extract dispatchJournal + parseJournalArgs, replace tautological sentinel test
- [US-003] - Docs, help text, and gate green
- [US-002] - Validation, optional fields, em-dash normalization, duplicate rejection
- [US-001] - cam journal append end-to-end (tracer bullet)

### Fixed

- [US-R2-002] - check git show status in appendJournalEntryOnMain, correct runbook
- [US-R2-001] - correct doc strings: em-dash normalises to colon not hyphen-space
- [US-R1-002] - correct decisions/blockers/followups type doc from arrays to strings
- [US-R1-001] - align render labels with canonical journal corpus

## [0.11.0] - 2026-06-27

### Added

- [US-R2-001] - raise setup.ts file-size ceiling 816->818 after US-R1-001 growth
- [US-R1-001] - mirror escalation gate in warnIfResendUnconfigured
- [US-010] - Refactor runSidecar and ConfigScreen under biome complexity/line limits (pure refactor)
- [US-009] - Doc + dead-code cleanup for round-3 WARNING and three suggestions
- [US-008] - Fix auto-chain defeating the MAX_ROUNDS_DEBT non-convergence terminal
- [US-R2-001] - Review round 2 fix 001: address reviewer finding
- [US-R1-002] - Read RESEND_API_KEY from env instead of project.toml
- [US-R1-001] - Wire production escalateFn through RunSidecarLoopOptions into RunSupervisorOptions
- [US-007] - Best-effort Resend escalation + plan_approval/Resend config surface + runbook
- [US-006] - Non-convergence hard terminal: maxRounds=3 and auditor-no-APPROVE both terminate cleanly
- [US-005] - Auto-chaining: in auto mode, flip active:true after branch and auto-dispatch ship on review CLEAN
- [US-004] - Deterministic plan_approval branch decision wired into cam-plan
- [US-003] - subagent-planner: vertical-slicing + stop emitting requires:operator stories
- [US-002] - cam-plan: replace the MVP-vs-launch-ready fork with one proportional plan that reads the grilled spec
- [US-001] - Add [plan] plan_approval accessor (readPlanApproval) defaulting to auto

## [0.10.0] - 2026-06-27

### Added

- US-R1-002 - Review round 1 fix 002: address reviewer finding
- US-R1-001 - Review round 1 fix 001: address reviewer finding
- US-008 - Recovery-runbook entry for the grill / spec flow
- US-007 - Production-wired spec-written / stage-promoted observability event
- US-006 - Terminal paths: abandon + merge-into modes in the spec writer
- US-005 - CONTEXT.md / ADR location convention for the durable domain model
- US-004 - /cam-spec command markdown (both trees) + CLI seam
- US-003 - Deterministic spec writer specifyIssueOnMain (promote idea->specified on main)
- US-002 - Typed Spec schema + validators in src/issues/spec.ts
- US-001 - Vendor grill-with-docs skill chain into .claude/ and templates/, re-embed

## [0.9.0] - 2026-06-27

### Added

- US-006 - Rewrite cam-plan Step 2 to delegate to the gate (three-copy sync + embed)
- US-005 - Idempotent migration script for the live issues.local.json
- US-004 - Adopt new schema in issue writer and ship-finalize reader
- US-003 - Selection function selectPlannableIssue (the PRD-readiness gate)
- US-002 - Pure graph helpers: isBlocked, deriveBlocks, referential-integrity check
- US-001 - Add typed issue schema (stage/status/blockedBy/wsjf?/rank?/spec?) + issues.schema.json

### Fixed

- US-R1-002 - correct ADR graph helper names, migration path, and hardcoded count
- US-R1-001 - correct sort direction docs to rank ascending

## [0.8.0] - 2026-06-27

### Added

- [US-004] - Document the non-interactive-init / readline-EOF pattern in patterns.md
- [US-003] - Deterministic guard test: readline collection flow resolves init defaults on EOF, never hangs
- [US-002] - Pass --merge-mode immediate in the build-release AC4 init smoke
- [US-001] - Resolve ask()/askChoice() to a default on readline EOF/close

### Fixed

- [US-R1-001] - address reviewer finding: readableEnded short-circuit in ask()

## [0.7.0] - 2026-06-26

### Added

- US-004 - Anchor implementer dispatch to issue-bound PRD in both orchestrator personas
- US-002 - Propagate identical hook change to template and re-embed
- US-001 - Rewrite runtime hook to capability policy gated by CAM_SESSION

## [0.6.0] - 2026-06-26

### Added

- [US-001] - Quiet-gate printAutomergeNotice via printHint

## [0.5.0] - 2026-06-26

### Added

- [US-R3-002] - address reviewer finding: extract helpers to remove grandfather lint overrides
- [US-R3-001] - address reviewer finding: raise file-size ceilings and grandfather lint overrides
- [US-008] - Structured merge-watch observability events
- [US-007] - Sidecar merge-watch state: poll PR for MERGED then run post-merge + narrate
- [US-006] - Deterministic post-merge invocable (pull origin main + tag-on-main + prune local/remote)
- [US-005] - cam-ship.md ci-gated branching: hand off after auto-merge, skip inline post-merge
- [US-004] - cam config merge_mode change + branch-protection setup
- [US-003] - cam init merge_mode selector + branch-protection setup on ci-gated
- [US-002] - Branch-protection helper module (gh api PUT/GET, configure + verify + verify-and-warn fallback)
- [US-001] - Add [ship] merge_mode config schema + typed read accessor

### Fixed

- [US-R1-005] - correct ci-gated post-merge claim in cam-ship.md
- [US-R1-004] - wire logEvent into runMergeWatch production call in sidecar.ts
- [US-R1-003] - distinguish BLOCKED+pending from BLOCKED+failed in merge-watch
- [US-R1-002] - checkout main before pull in runPostMerge
- [US-R1-001] - write .cam-merge-watch.json in ci-gated ship step

## [0.4.0] - 2026-06-26

### Added

- US-004 - Add auto-merge recovery scenario to the recovery runbook
- US-003 - Print the shared auto-merge prerequisite notice from cam config
- US-002 - Define shared auto-merge prerequisite-notice constant and print it from cam init
- US-001 - Add best-effort auto-merge step to cam-ship.md (markdown + template + embed)

## [0.3.0] - 2026-06-26

### Added

- US-002 - Add cam-init adaptation marker to cam-ship.md template and re-embed
- US-001 - Add check:all adaptation guidance to buildSetupPrompt

## [0.2.0] - 2026-06-26

### Added

- US-R1-004 - add --bump dispatch coverage to ship-args tests
- US-007 - Structured observability event + result line for the bump
- US-006 - Auto-generate CHANGELOG release-section body from classified branch commits
- US-005 - cam tag: deterministic post-merge tag command on main
- US-004 - CHANGELOG release-section roll (Unreleased -> versioned, fresh Unreleased)
- US-003 - Wire the deterministic bump step into cam ship before push
- US-002 - Compute next version (0.x convention) and atomically write version.ts + package.json
- US-001 - Deterministic Conventional-Commits bump parser

### Fixed

- US-R1-002 - wire writeEvent in production _buildBumpOpts
- US-R1-001 - guard git add/commit exit status in runShipBump

## [Unreleased]

### Added

- Supervisor now verifies each worker pass actually landed on origin (HEAD == origin/<branch>) before continuing, so an unpushed claim cannot mark a story complete on local-only commits; a failed verification blocks the loop (CAM-33).
- Structured `pushed` event in `.claude/cam-worker-events.jsonl` recording each push verification (`sha`, `pushed`, `ok`, `detail`) for audit (CAM-33).

### Changed

- Retired the stop-hook loop driver; workers are now real per-story claude sessions in a single reused tmux pane (CAM-22, closes CAM-29).
