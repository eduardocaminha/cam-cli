# Changelog

All notable changes to CAM Runtime are documented here.

Format: `## [version] - YYYY-MM-DD` for releases; a single `[Unreleased]` heading at the top collects pending work.

## [Unreleased]

## [0.201.0] - 2026-07-18

### Added

- US-001 - Log a durable event on non-ok pattern-outcome append

## [0.200.0] - 2026-07-18

### Added

- US-R1-001 - Review round 1 fix 001: address reviewer finding
- US-003 - Route the four worker builders through ClaudeAdapter and de-dup shellEscape, zero behavior change
- US-002 - Introduce BackendAdapter interface + ClaudeAdapter with per-actor golden characterization tests
- US-001 - Write the design-spike ADR for the BackendAdapter seam

## [0.199.0] - 2026-07-17

### Added

- US-002 - Migrate remaining sidecar.ts spawnSync sites and drop the node:child_process import
- US-001 - Migrate checkoutMainFn + proceedBranchFn to Bun.spawnSync with real-git coverage

## [0.198.0] - 2026-07-17

### Added

- US-003 - Rebrand package name, README, and CHANGELOG to CAM Runtime
- US-002 - Rebrand in-app product display strings to CAM Runtime
- US-001 - Uppercase CAM wordmark + Runtime line + Fir Green accent in the splash

## [0.197.0] - 2026-07-17

### Added

- US-001 - Codify the CAM Runtime brand palette as named design tokens

## [0.196.0] - 2026-07-17

### Added

- US-006 - Supervisor records pattern outcomes at cycle-close
- US-005 - appliedPatternIds reporting field on worker-report and handoff
- US-004 - cam patterns prune decay/demotion gate
- US-003 - Outcome-append writer with WorkerOutcomeKind mapping
- US-002 - On-main ref-only append-record writer + reader + dedup for the typed store
- US-001 - Typed pattern-record schema, hand-rolled guard, and confirmation-scoring

## [0.195.0] - 2026-07-17

### Added

- US-005 - Wire operator-decision moments to the file-based gate; keep AskUserQuestion disallowed
- US-004 - Bring cam-review triage guardrails to reporter parity (hardening)
- US-003 - Add setup-checklist section to composePrBody
- US-002 - Deterministic plan scope-proposal artifact (hand-rolled TS guard) emitted by planner and narrated
- US-001 - Extend docs-fetch shapes with channel table, anti-over-fetch guard, conflict detection

## [0.194.0] - 2026-07-17

### Added

- US-002 - Make per-issue token aggregation marker-aware (delta sum vs legacy collapse)
- US-001 - Emit cycle-tokens orchTokens as per-cycle delta with a mode marker

## [0.193.0] - 2026-07-17

### Added

- US-001 - Correct outer-timeout comment arithmetic in orch-recycle-watch test

## [0.192.0] - 2026-07-17

### Added

- US-R1-001 - Review round 1 fix 001: address reviewer finding
- US-001 - Add direct TabBar unit test for the suspended prop contract

## [0.191.0] - 2026-07-17

### Added

- US-001 - Cover notify-sender (fieldFocus===4) TabBar suppression with a dedicated test

## [0.190.0] - 2026-07-17

### Added

- US-001 - Read Dashboard width via Ink useWindowSize()

## [0.189.0] - 2026-07-17

### Added

- US-001 - Suppress TabBar Left/Right while a ConfigScreen TextInput is focused

## [0.188.0] - 2026-07-17

### Added

- US-001 - Delegate stats --help to dispatchStats

## [0.187.0] - 2026-07-17

### Added

- US-001 - Surface failed abandon-path checkout-main to the operator

## [0.186.0] - 2026-07-17

### Added

- US-001 - Surface failed plan-approval branch creation instead of silently entering 'implementing'

## [0.185.0] - 2026-07-16

### Added

- US-001 - Trim vestigial node-era options param from the SpawnFn seam type

## [0.184.0] - 2026-07-16

### Added

- US-001 - Correct absent-specSource comment characterization

## [0.183.0] - 2026-07-16

### Added

- US-001 - Replace fixed timing budgets with generous waitForCondition/per-test timeouts in the two load-sensitive e2e tests

## [0.182.0] - 2026-07-16

### Added

- US-R1-001 - Review round 1 fix 001: address reviewer finding (handoff)
- US-R1-001 - Review round 1 fix 001: address reviewer finding
- US-001 - Insert frontmatterBody verbatim in rewriteFrontmatterEffort (patterns)
- US-001 - Insert frontmatterBody verbatim in rewriteFrontmatterEffort (handoff)
- US-001 - Insert frontmatterBody verbatim in rewriteFrontmatterEffort

## [0.181.0] - 2026-07-16

### Added

- US-002 - Migrate check-coverage.ts and validate-agents-md.ts spawn call sites to Bun.spawnSync
- US-001 - Migrate check-all.ts gate-runner spawn seam to Bun.spawnSync

## [0.180.0] - 2026-07-16

### Added

- US-001 - Clear frame on width-change in dashboard poll re-render path

## [0.179.0] - 2026-07-16

### Added

- US-001 - Merge off-convention orch-recycle-watch tests into the canonical file and delete the original

## [0.178.0] - 2026-07-16

### Added

- US-006 - Rename grill vocabulary in CLAUDE.md, README.md, CONTEXT.md
- US-005 - Rename grill vocabulary in recovery-runbook and patterns.md
- US-004 - Rename grill vocabulary in index.ts CLI surface strings
- US-003 - Rename skill dir grill-with-docs -> spec-with-docs (both copies) + cam-spec.md + embed + embedded.test.ts
- US-002 - Rename residual grill code/test comments in otherwise-untouched files
- US-001 - Rename specSource enum value grill -> interview across schema + code + tests

## [0.177.0] - 2026-07-16

### Added

- US-003 - Wire plan-approval gate production write seam + resolver into the sidecar
- US-002 - Wire the plan-approval gate write-side into the plan-runner pause-operator path
- US-001 - Add plan-approval gate module (identity, context builder, resolver)

## [0.176.0] - 2026-07-16

### Added

- US-004 - Emit the split advisory at plan-time (non-gating)
- US-003 - Split-advisory heuristic + plan-split-advisory event kind
- US-002 - cam stats tokens command + dispatch wiring
- US-001 - Pure tokens-per-issue aggregation module

## [0.175.0] - 2026-07-16

### Added

- US-004 - Refactor ConfigScreen to tabbed UI with per-tab model + effort selects
- US-003 - Add TabBar chip component
- US-002 - Add rewriteFrontmatterEffort + wire into save, sync agent files and re-embed
- US-001 - Add effort config read/write plumbing (no UI)

## [0.174.0] - 2026-07-16

### Added

- US-005 - Orchestrator boot surfaces active gate as opening blocker line
- US-004 - In-progress-work conflict gate at plan start
- US-003 - Sidecar generic gate lifecycle: write+notify, poll+resolve+clear+flip
- US-002 - `cam decide <decision>` CLI thin-proxy
- US-001 - Gate file schema + fail-closed I/O module

## [0.173.0] - 2026-07-16

### Added

- US-002 - Wire the linter into the plan-runner audit path, folding findings into the re-plan loop
- US-001 - Build the pure PRD-oracle linter module (named-rules scanner + PRD walk)
- US-001 - Build the pure PRD-oracle linter module (named-rules scanner + PRD walk)

## [0.172.0] - 2026-07-16

### Added

- US-R1-001 - Review round 1 fix 001: address reviewer finding
- US-R1-001 - Review round 1 fix 001: address reviewer finding
- US-001 - Pass --plan-approval operator to the hermetic init smoke

## [0.171.0] - 2026-07-16

### Added

- US-002 - Make the auditor BLOCK on the -q + -L/-l oracle antipattern
- US-001 - Add absence/presence oracle idiom to the planner Oracle Contract

## [0.170.0] - 2026-07-16

### Added

- US-004 - Persist notify fields to [notify], never the API key
- US-003 - Add notify recipient/from steps + API-key status to config wizard
- US-002 - Plumb configured from through sidecar escalation call sites
- US-001 - Read resend_from into ResendConfig

## [0.169.0] - 2026-07-16

### Added

- US-003 - Route the post-merge makeRealIssueSpawnFn close/abandon/demote path through the shared helper, test the ship auto-close path, and audit all remaining consumers
- US-002 - Route file-local, triage, and suggestions-promote wrappers through the shared helper with >1 MiB regression test
- US-001 - Add shared spread-forwarding spawnSync helper and harden on-main SpawnFn option surface

## [0.168.0] - 2026-07-15

### Added

- US-001 - Fail-closed maxBuffer fix for readBacklogFromMain batch read

## [0.167.0] - 2026-07-15

### Added

- US-007 - Wire check-test-sleeps as gate #13 and bump both gate-count freeze tests
- US-006 - Migrate unit-tier promisified setTimeout sleeps + suppress the flush-ink macrotask yield
- US-005 - Migrate integration sleeps to waitForCondition (group D: ensure-worker-pane-selfheal, sendkeys-submit, plan-runner-target-obey, plan-runner-no-prd)
- US-004 - Migrate integration sleeps to waitForCondition (group C: plan-runner-pane-spawn, orch-recycle-watch, orch-recycle-pid-resolve)
- US-003 - Migrate integration sleeps to waitForCondition (group B: review-verdict-handback, worker-pane-geometry)
- US-002 - Migrate integration sleeps to waitForCondition (group A: tmux-introspect, stop-sidecar-real)
- US-001 - Add check-test-sleeps scanner core + unit tests

## [0.166.0] - 2026-07-15

### Added

- US-004 - On-demand record-golden harness + record:golden alias + patterns bullet
- US-003 - Self-authored artifact shape-pin fixtures + replay against guards
- US-002 - Transcript-usage golden fixture + replay against usage parsers
- US-001 - Establish golden-fixture dir + sentinel/review-tag replay tests

## [0.165.0] - 2026-07-15

### Added

- US-004 - Add durable test-quality convention to cam knowledge files
- US-003 - Mirror the rubric guidance into the generic reviewer template and re-embed
- US-002 - Add test-quality rubric guidance to the cam reviewer agent (.claude copy)
- US-001 - Create waitForCondition poll-until-true test helper

## [0.164.0] - 2026-07-15

### Added

- US-004 - Route review-report readers in host.ts and review.ts through parseReviewReport
- US-003 - Route result.ts worker-report sites through parseWorkerReport and delete WorkerReportFallback
- US-002 - Route worker-report readers in host.ts and loop.ts through parseWorkerReport
- US-001 - Add shared report parse module and relax WorkerReport optional fields

## [0.163.0] - 2026-07-15

### Added

- US-004 - Enable noUnusedLocals and noUnusedParameters in tsconfig.json
- US-003 - Clean remaining unused locals/params/types in test/**
- US-002 - Clean unused locals/params in test/supervisor, test/release, test/integration
- US-001 - Clean unused locals/params/imports in src/ and scripts/

## [0.162.0] - 2026-07-15

### Added

- US-002 - Route append/dismiss/promote pen writers through per-attempt recompute
- US-001 - Add per-attempt content recompute to the CAS commit-tree writers

## [0.161.0] - 2026-07-15

### Added

- US-001 - Verify Node tarball sha256 against SHASUMS256.txt with retrying curls

## [0.160.0] - 2026-07-15

### Added

- US-001 - Throw on git spawn failure in makeGetTrackedFiles/makeIsIgnored

## [0.159.0] - 2026-07-14

### Added

- US-R2-002 - Close the shipped-tree gap: full-path KNOWN_MISSING for scripts/cam/handoff.json + shipped-tree regression test
- US-R2-001 - Resolve doc path-claims against the git-tracked tree (deterministic gate) + tracked-tree regression test
- US-R1-002 - address reviewer finding on dropped .githooks/** guardrail
- US-R1-001 - address reviewer finding on review-report.json/review-artifact.txt allowlist gap
- US-003 - Wire validate-agents-md as check:all gate #12 and update gate-count freezes
- US-002 - Freeze COMMANDS array exact count and membership
- US-001 - Add validate-agents-md.ts doc-as-code checker with unit tests

## [0.158.0] - 2026-07-14

### Added

- US-002 - Planner rule: a hand-file-via-/cam-issue requirement is an on-main oracle, never a worker story
- US-001 - Extend worker-actor Write-deny to scripts/cam/issues/ via a structured deny-set

## [0.157.0] - 2026-07-14

### Added

- US-R1-001 - append patterns.md bullet for next story
- US-R1-001 - write handoff for next story
- US-R1-001 - Review round 1 fix 001: address reviewer finding
- US-006 - write handoff and patterns bullet for next story
- US-006 - Extend the allowlist hook + settings matcher to deny worker-actor Write to prd.json
- US-005 - flip passes:true, write handoff and patterns bullet for next story
- US-005 - Remove the passes:true flip instruction from both implementer prompt copies
- US-004 - write handoff and patterns bullet for next story
- US-004 - Add an empty-push (ahead_by>=1) gate on the worker pass path
- US-003 - write handoff for next story
- US-003 - Make the supervisor the sole writer of story passes:true via a generalized finalizeStory
- US-002 - flip passes:true, write handoff, record patterns bullet
- US-002 - Inject a worker-actor env marker into the spawned implementer worker (host + container)
- US-001 - flip passes:true and write handoff
- US-001 - Add orchestrator-surface contract test pinning the supervisor<->worker protocol shape

## [0.156.0] - 2026-07-13

### Added

- US-002 - Make promoteSuggestionOnMain a single atomic on-main commit
- US-001 - Extend writeIssueFile CAS primitive to co-commit extra files

## [0.155.0] - 2026-07-13

### Added

- US-001 - Alias dated model id in cam claude help example

## [0.154.0] - 2026-07-13

### Added

- US-001 - Assert closeIssueOnMain bumps updatedAt on close

## [0.153.0] - 2026-07-13

### Added

- US-001 - Sweep orphaned implement-blocked marker at plan-phase dispatch

## [0.152.0] - 2026-07-12

### Added

- US-001 - Remove vestigial writeFile? field from on-main writer interfaces and obsolete tests

## [0.151.0] - 2026-07-12

### Added

- US-001 - Document [loop] keys with commented examples in project.toml

## [0.150.0] - 2026-07-12

### Added

- US-003 - Expose updatedAt in cam issue list --json
- US-002 - Stamp updatedAt on every issue-mutation writer
- US-001 - Add required updatedAt field: schema + type + creation stamp + backfill

## [0.149.0] - 2026-07-12

### Added

- US-001 - Emit createdAt on cam issue list --json rows

## [0.148.0] - 2026-07-12

### Added

- US-001 - Remove dead-for-help guards in config, claude, and triage switch cases

## [0.147.0] - 2026-07-12

### Added

- US-001 - Enforce command-set exhaustiveness at compile time

## [0.146.0] - 2026-07-12

### Added

- US-R1-001 - Review round 1 fix 001: address reviewer finding
- US-001 - Consolidate boot-marker removal boilerplate in orchestrator agent doc

## [0.145.0] - 2026-07-12

### Added

- US-002 - Add a free-text 'custom / enter id' passthrough to the config model picker
- US-001 - Adopt CLI tier aliases as the static model set (DEFAULTS + MODEL_OPTIONS + dogfood project.toml)

## [0.144.0] - 2026-07-12

### Added

- US-002 - cam init scaffolds a commented [loop] section in project.toml
- US-001 - Add comment emission to stringifyToml (parser stays comment-tolerant)

## [0.143.0] - 2026-07-12

### Added

- US-006 - Update orchestrator agent docs to describe the suggestions pen + triage
- US-005 - Add cam suggestions promote + dismiss subcommands
- US-004 - Add cam suggestions list CLI (parser + dispatch skeleton + help)
- US-003 - Redirect the terminal-verdict hook sink from issue-filing to the pen
- US-002 - Seed empty suggestions.jsonl in cam init + bootstrap this repo's main
- US-001 - Add suggestions-pen data model + on-main JSONL append/read writer

## [0.142.0] - 2026-07-12

### Added

- [US-R2-001] - Review round 2 fix 001: address reviewer finding
- [US-R1-001] - Review round 1 fix 001: address reviewer finding
- [US-003] - Give ship a single documented model source and stop the dead planner/auditor frontmatter rewrite
- [US-002] - Strip the inert frontmatter model: lines from the 5 pane/root agent files (dual-copy)
- [US-001] - Reconcile DEFAULTS map and config-picker MODEL_OPTIONS to the effective model ids

## [0.141.0] - 2026-07-12

### Added

- US-002 - Sweep orphaned implement-blocked markers whose issueId is a closed/shipped issue
- US-001 - Gitignore the implement-blocked marker so it stops tripping the clean-tree gate

## [0.140.0] - 2026-07-12

### Added

- US-001 - Close the CREATE-on-main worktree-coherence invariant for absent paths

## [0.139.0] - 2026-07-12

### Added

- US-002 - Wire `cam issue demote <id>` CLI surface (parse + dispatch + help)
- US-001 - Add demoteIssueOnMain core writer + default wiring

## [0.138.0] - 2026-07-12

### Added

- US-002 - List internal commands in cam --help and document the deterministic flags
- US-001 - Central --help/-h short-circuit guard at the dispatch layer covering every command

## [0.137.0] - 2026-07-12

### Added

- US-003 - Config-driven orchestrator window: default 200k, replace 1M model-prefix derivation
- US-002 - Backstop produces a handoff: signal the agent, then deterministic minimal fallback, then respawn
- US-001 - Guard: checkBackstop never arms without a handoff on disk

## [0.136.0] - 2026-07-11

### Added

- US-002 - Tighten @biomejs/biome from caret to exact pin
- US-002 - Tighten @biomejs/biome from caret to exact pin
- US-001 - Pin knip and jscpd as exact devDependencies and de-tokenize the gate invocations
- US-001 - Pin knip and jscpd as exact devDependencies and de-tokenize the gate invocations

## [0.135.0] - 2026-07-11

### Added

- US-001 - Rewrite ensurePushed to compare-first (read-only ls-remote) before pushing

## [0.134.0] - 2026-07-11

### Added

- US-002 - Auditor audits the provided record only; identity/collision checks use git refs, prior-art is git-log and non-blocking
- US-001 - Embed the resolved issue record + derived branch into the auditor spawn payload

## [0.133.0] - 2026-07-11

### Added

- US-001 - Accept any conventional-commit type prefix in the commit-existence gate

## [0.132.0] - 2026-07-11

### Added

- US-004 - Root-cause port-53 fail-safe: container teardown at session exit + init-firewall reap-and-retry
- US-003 - cam plan / next / ship refuse the signal-write when the sidecar is dead
- US-002 - Sidecar-liveness watcher with sidecarAlive() composite, bounded respawn, and escalate-on-exhaustion
- US-001 - Durable sidecar-stalled marker written on firewall-init failure and surfaced at orchestrator boot

## [0.131.0] - 2026-07-11

### Added

- US-001 - Tear down plan panes at a single unconditional exit in runPlanPhaseWithReplan

## [0.130.0] - 2026-07-11

### Added

- US-003 - Wire the sidecar report pusher to sendKeysVerified
- US-002 - Extract sendKeysVerified with composer-emptied verify + bounded retry
- US-001 - Add push-undelivered event kind to the flight recorder

## [0.129.0] - 2026-07-11

### Added

- US-004 - Surface post-merge-stalled at boot + document operator recovery
- US-003 - Write post-merge-stalled marker on merged-but-failed post-merge
- US-002 - Recover post-merge via git pull --rebase, never reset --hard
- US-001 - Add durable post-merge-stalled marker module

## [0.128.0] - 2026-07-11

### Added

- US-004 - Surface the circuit-broken blocker in the orchestrator boot-read
- US-003 - Halt the auto-dispatch chain when the marker is escalated
- US-002 - Wire the counter + PRD content-hash into the marker writer
- US-002 - Wire the counter + PRD content-hash into the marker writer
- US-001 - Extend blocked-marker schema with dedup-key + consecutive-count logic

## [0.127.0] - 2026-07-11

### Added

- US-007 - Event every dispatch refusal and add a per-issue pending-guard
- US-006 - Surface the implement-blocked marker in the orchestrator boot-read
- US-005 - Write and consume a durable implement-blocked marker
- US-004 - Emit a structured event on every supervisor terminal
- US-003 - Re-arm implementing at sidecar boot and idle-tick for in-flight PRDs
- US-002 - Stop the orchestrator-exit wrapper deleting the live state file
- US-001 - Make renderStateFile/clearActive preserve the loop phase

## [0.126.0] - 2026-07-10

### Added

- US-001 - Guard toml read behind non-empty candidates

## [0.125.0] - 2026-07-10

### Added

- US-001 - Set derivedFrom on auto-filed SUGGESTION follow-ups from the parent issue id

## [0.124.0] - 2026-07-10

### Added

- US-002 - Reviewer backstops raises/suppressions across all four sibling ratchets
- US-001 - Implementer runs full check:all in-story with a per-gate resolution rubric

## [0.123.0] - 2026-07-10

### Added

- US-003 - Fix stale cam-ship Step 3 pointer in patterns.md
- US-002 - Reviewer backstops every file-size-budget ceiling raise
- US-001 - Implementer runs file-size gate and raises its own ceilings in-story

## [0.122.0] - 2026-07-10

### Added

- US-002 - Require ci-container in branch protection and update the runbook oracle
- US-001 - Add always-run, path-filtered ci-container ubuntu job to ci.yml

## [0.121.0] - 2026-07-10

### Added

- US-001 - Add umbrella manual-path scoping header before Step 0

## [0.120.0] - 2026-07-10

### Added

- US-001 - Remove dead 'reviewer' member from AnySentinelSource union

## [0.119.0] - 2026-07-10

### Added

- US-001 - Add count-agnostic real-file smoke test for the patterns.md parser

## [0.118.0] - 2026-07-10

### Added

- US-002 - Update the stale quoted implementer task-prompt in cam-next.md
- US-001 - Reconcile implementer agent SYSTEM PROMPT to the injected-story model

## [0.117.0] - 2026-07-10

### Added

- US-001 - Derive officialDocsValidated status enum and allowed keys from handoff.schema.json

## [0.116.0] - 2026-07-10

### Added

- US-001 - Strip CLAUDE_CODE_OAUTH_TOKEN from host workers only

## [0.115.0] - 2026-07-10

### Added

- US-001 - Split auditor item C.8 into lead line + sub-bullets

## [0.114.0] - 2026-07-10

### Added

- US-001 - Assert semver format (not literal pin) in the two real-file toolchain tests

## [0.113.0] - 2026-07-10

### Added

- US-R1-001 - Review round 1 fix 001: address reviewer finding
- US-001 - Correct the stale tools enumeration in ADR 0020

## [0.112.0] - 2026-07-10

### Added

- US-001 - Grant the Skill tool to the orchestrator and repoint dispatch references from SlashCommand to Skill

## [0.111.0] - 2026-07-10

### Added

- US-001 - Drop SlashCommand from the orchestrator tools list and reconcile the mirror + embed

## [0.110.0] - 2026-07-09

### Added

- US-002 - Spawn the orchestrator root persona under `claude --agent` with a meta_loop-aware boot nudge
- US-001 - Reconcile orchestrator tools list to real runtime usage and fold boot-imperatives + meta_loop-aware boot into the agent body

## [0.109.0] - 2026-07-09

### Added

- US-007 - Complete README command table and note CLEAN-with-SUGGESTIONs in scripts CLAUDE.md
- US-006 - Fix subagent-implementer PRD_COMPLETE row and truth-up cam-review section
- US-005 - Correct cam-plan and cam-spec command docs (templated)
- US-004 - Add supersession banners to ADRs 0004, 0006, 0008
- US-003 - Remove stale merge-watch comment and dead CAM_REVIEWER_STATUS branch
- US-002 - Fix version.ts comment and add package.json parity assert
- US-001 - Fix cam binary HELP for next and plan

## [0.108.0] - 2026-07-09

### Added

- US-002 - Seed missing template files: patterns.md stub + orch-handoff.schema.json
- US-001 - Sync stale existing template seeds (issues.schema spec-source + CLAUDE.md pointer)

## [0.107.0] - 2026-07-09

### Added

- US-001 - Re-frame Cross-Repo PRD docs as agent-self-executed (unvalidated)

## [0.106.0] - 2026-07-09

### Added

- US-004 - Retrofit 2026-06 build-notes markers + document marking convention
- US-003 - Best-effort patterns archive on the --cycle-close path
- US-002 - cam patterns archive CLI wiring + help + sentinel
- US-001 - archivePatternsOnMain core logic (marker-based, on-main commit-tree)

## [0.105.0] - 2026-07-09

### Added

- US-003 - Fix cam-plan.md selection description to champion-vs-champion
- US-002 - Fix subagent-auditor.md Step 8 description to the deterministic plan runner
- US-001 - Fix subagent-planner.md: model align, Step 7 description, dead Spec Sourcing

## [0.104.0] - 2026-07-09

### Added

- US-002 - Update scripts/cam/CLAUDE.md 'Your Task' steps to drop full-prd self-select; re-embed vendor
- US-001 - Inject selected story record + branchName into implementer spawn; make storyId authoritative

## [0.103.0] - 2026-07-09

### Added

- US-002 - Add warn-level runtime guard for handoff.officialDocsValidated
- US-001 - Fix Step 5.5 example + cut NotebookEdit in implementer (both copies) and re-embed

## [0.102.0] - 2026-07-09

### Added

- US-001 - Fix auditor prompt C.8 and B.5 for cam-cli terminal reality

## [0.101.0] - 2026-07-09

### Added

- US-001 - Align orchestrator Write grant and mark frontmatter advisory-only

## [0.100.0] - 2026-07-09

### Added

- US-004 - Truth-up handoff required fields + close-on-ship
- US-003 - Truth-up boot section: rehydrate step-0, meta_loop=auto, SUGGESTIONs, journal tail
- US-002 - Truth-up dispatch protocol + sidecar loop + issueNumber
- US-001 - Truth-up allowlist + reviewer-worker description

## [0.99.0] - 2026-07-09

### Added

- US-002 - Accept --issue-system none as deprecated alias in cam init and restore the build-release smoke to green
- US-001 - Normalize legacy issue_system 'none' to 'local' in readIssueSystem

## [0.98.0] - 2026-07-09

### Added

- US-R2-001 - Review round 2 fix 001: address reviewer finding
- US-R1-001 - Review round 1 fix 001: address reviewer finding
- US-004 - Migrate project.toml, docs, templates and CHANGELOG none->local
- US-003 - Wire issue-list to readIssueSystem and sweep remaining 'none' fixtures
- US-002 - Add central readIssueSystem reader and wire ship-finalize + ship-pr to 'local'
- US-001 - Rename IssueSystem enum and setup prompts none->local

## [0.97.0] - 2026-07-09

### Added

- US-006 - ship-pr applies the type-derived GitHub label on PR creation
- US-005 - composePrTitle emits <type>: <text> (CAM-<N>)
- US-004 - Planner carries type from the issue into the PRD (both planner agent copies)
- US-003 - Capture/confirm type in the /cam-spec grill (both command copies)
- US-002 - Accept and persist type through cam spec --persist
- US-001 - Add optional type field to the issue schema (both copies) and IssueEntry

## [0.96.0] - 2026-07-09

### Added

- US-002 - Update planner and auditor templates to the cam/issue-<N> contract and re-embed vendor
- US-001 - Derive branch name in code as cam/issue-<N> with checkout -B and missing-issueNumber gate

## [0.95.0] - 2026-07-09

### Added

- US-004 - Docs: mandate backlog derivation via cam issue list --json only
- US-003 - Spine guard test banning inline === 'specified' outside the canonical module
- US-002 - Add cam issue list --json machine mode
- US-001 - Extract layered plannability predicate and route all inline call sites

## [0.94.0] - 2026-07-08

### Added

- US-005 - Context-diet consistency sweep across all agent docs
- US-004 - Reviewer agent: re-point retired lessons.archive.md citation to the invariants block
- US-003 - Planner agent: drop journal.md and integral patterns.md from Project Context, remove AGENTS.md refs
- US-002 - Implementer agent: patterns.md grep-on-demand, drop AGENTS.md ref and CLAUDE.md re-read
- US-001 - Add curated invariants block to scripts/cam/CLAUDE.md and demote patterns.md to grep-on-demand there

## [0.93.0] - 2026-07-08

### Added

- US-003 - File SUGGESTION follow-ups at the terminal verdict in runSidecarLoop
- US-002 - Add suggestion fingerprint, follow-up builder, and dedup helpers
- US-001 - Carry SUGGESTION findings through the reviewer CLEAN exit report

## [0.92.0] - 2026-07-08

### Added

- US-004 - Replace the manual archive rule in templates and agent file
- US-003 - Auto-invoke the archive check on the --cycle-close path
- US-002 - Wire cam journal archive [--threshold N] CLI subcommand
- US-001 - Add archiveJournalOnMain core logic (pure move, atomic on-main commit)

## [0.91.0] - 2026-07-08

### Added

- US-003 - Refactor runKahn under the cognitive-complexity budget and drop the rank.ts biome override
- US-002 - Make RunTriageOptions.clock optional, mirroring the unused-clock command pattern
- US-001 - Unify triage warnings source between no-op and commit paths

## [0.90.0] - 2026-07-08

### Added

- US-003 - Ratchet the jscpd threshold down to 4
- US-002 - Extract shared subcommand arg-parse helper in index.ts
- US-001 - Extract shared ratchet-diff helpers for the check scripts

## [0.89.0] - 2026-07-08

### Added

- US-002 - Add the exit-3 refuse-to-arm case to subagent-orchestrator.md (both copies) and regenerate the embed
- US-001 - Document --cycle-close and the exit-code contract in JOURNAL_HELP with a static help-text test

## [0.88.0] - 2026-07-08

### Added

- US-005 - Orchestrator boot step 9: read the preflight-failed marker
- US-004 - Marker removal on any non-preflight-failed plan result (Option B)
- US-003 - preflight-failed arm in runPostAuditAction with marker write and notify
- US-002 - Durable plan-preflight-failed marker module
- US-001 - Gitignore the three untracked runtime artifacts

## [0.87.0] - 2026-07-08

### Added

- US-R1-001 - address reviewer finding: guard the auto-dispatch selector seams
- US-004 - Clear stale review findings on a CLEAN verdict
- US-003 - Remove dead clock/ClockFn from ship-finalize
- US-002 - Align cam-plan prose with the read-from-main backlog seam
- US-001 - Propagate real backlog read errors from the select seams

## [0.86.0] - 2026-07-08

### Added

- US-001 - Dedupe inline notifyOrchestrator blocks in loop.ts behind private helpers and lower the file-size ceiling

## [0.85.0] - 2026-07-08

### Added

- US-002 - Accumulate session worker-token total from the event log and render it in the dashboard header
- US-001 - Track sidecar session start and render total session elapsed in the dashboard header

## [0.84.0] - 2026-07-07

### Added

- US-002 - Harden the Loop-header ghost against resize/reflow storms
- US-001 - Truncate long story titles in the Stories list rows

## [0.83.0] - 2026-07-07

### Added

- US-001 - Add allowlist .dockerignore for the cam-worker image build context

## [0.82.0] - 2026-07-07

### Added

- US-002 - Discriminated GhPollFn result and edge-triggered poll-error emit in stepMergeWatch
- US-001 - Add merge-watch-poll-error event vocabulary and consecutiveNullPolls state persistence

## [0.81.0] - 2026-07-07

### Added

- US-001 - Gate meta_loop=auto dispatcher arming on worker_isolation=container

## [0.80.0] - 2026-07-07

### Added

- US-002 - Real-writer regression test: phase:shipping survives the terminal teardown
- US-001 - Move auto-ship dispatch from runSupervisor to runSidecarLoop post-clearActive

## [0.79.0] - 2026-07-07

### Added

- US-002 - Regression-lock cam issue list as CAM_ISSUE_RESULT-free by design
- US-001 - Emit CAM_ISSUE_RESULT machine line on cam issue --file-local (all outcomes)

## [0.78.0] - 2026-07-07

### Added

- US-R1-001 - Review round 1 fix 001: address reviewer finding
- US-002 - Rewrite /cam-spec persist final step to pipe JSON into cam spec --persist (both copies)
- US-001 - Add cam spec --persist <id> in-process CLI mode with CAM_SPEC_RESULT handback

## [0.77.0] - 2026-07-07

### Added

- US-003 - Wire cam issue abandon <id> positional subcommand
- US-002 - Wire cam issue close <id> positional subcommand
- US-001 - Add already-closed idempotency guard to closeIssueOnMain

## [0.76.0] - 2026-07-07

### Added

- US-R3-002 - Fix claude-off-PATH regression in worker Dockerfile (US-003)
- US-R3-001 - Add ARG BUN_VERSION/NODE_VERSION literal defaults to the worker Dockerfile
- US-008 - Add Renovate config auto-updating the toolchain pins
- US-007 - Auto-rebuild worker image on toolchain mismatch; escalate on rebuild failure
- US-006 - Add fail-closed container toolchain assert to the preflight layer
- US-005 - Add check:all guard gate forbidding toolchain-version-conditioned skips
- US-004 - Drop bun-version-conditioned skips; make Ink stdin tests version-agnostic
- US-003 - Feed the worker Dockerfile toolchain from the pins
- US-002 - Pin CI bun via bun-version-file and enforce it in ci-parity
- US-001 - Pin bun and Node versions with a shared toolchain reader

## [0.75.0] - 2026-07-06

### Added

- US-004 - Meta-loop auto-dispatcher honors a pending explicit plan_issue
- US-003 - Sidecar surfaces plan-target-invalid: notify, event, idle exit, stale plan_issue cleared
- US-002 - Plan-runner terminal for invalid explicit target + explicit-target-wins regression test
- US-001 - Unranked issues compete by WSJF in plannable selection

## [0.74.0] - 2026-07-06

### Added

- US-001 - Stub runInit subprocess spawns via injectable spawnFn seam

## [0.73.0] - 2026-07-06

### Added

- US-R1-001 - address reviewer finding (plan-escalated event emission)
- US-005 - Orchestrator derives the plan escalation on wake (boot doc + vendor regen)
- US-004 - Wire the re-plan loop, pane teardown, and durable escalation into the sidecar
- US-003 - Implement the BLOCK->re-plan loop with capped rounds and teardown seam
- US-002 - Add durable plan-escalation marker module and event kind
- US-001 - Add re-plan prompt builder and round-cap constant to the plan-runner

## [0.72.0] - 2026-07-06

### Added

- US-001 - Ignore worker-out and plan-out logs in templates/.gitignore and regenerate embed

## [0.71.0] - 2026-07-06

### Added

- [US-003] - Encode the no-flaky-evasion hard-stop rule in subagent-reviewer.md
- [US-002] - Encode the no-flaky-evasion hard-stop rule in subagent-implementer.md
- [US-001] - Add red-gate guard to readWorkerOutcome: refuse DONE on recorded failing test

## [0.70.0] - 2026-07-06

### Added

- US-004 - Wire the domain-docs write into the /cam-spec final step
- US-003 - Expose cam spec --write-docs stdin-JSON entrypoint
- US-002 - Add writeDomainDocsOnMain ref-only deterministic writer
- US-001 - Add DomainDocsPayload types, validation, and deterministic renderers

### Fixed

- update GATES manifest test for pinned knip@6.24.0
- pin knip@6.24.0 and ignore cam self-spawn binary

## [0.69.0] - 2026-07-06

### Added

- [US-002] - Repair the corrupted live CHANGELOG.md and lock the single-[Unreleased] invariant

### Fixed

- [US-001] - Line-anchor the [Unreleased] heading match in rollChangelog

## [0.68.0] - 2026-07-06

### Added

- US-005 - nextActions ephemeral-only: schema + persona hard rule + doc-gate
- US-004 - Boot prompt + persona derive backlog via cam issue list; greeting counts line
- US-003 - CLI surface: parse cam issue list, route in dispatchIssue, help text
- US-002 - runIssueList command core: deterministic read + render + backend branch
- US-001 - Pure backlog list-view derivation in src/issues/list.ts

## [0.67.0] - 2026-07-06

### Added

- US-006 - Reduce cam-ship.md to a thin phase-signal and record the ADR
- US-005 - Convert the cam ship CLI to a phase-signal writer
- US-004 - Wire the shipping phase into the sidecar loop and make the CLEAN trigger deterministic
- US-003 - Implement the PR-create and merge-mode step (gh integration)
- US-002 - Implement the deterministic pre-PR ship sequence (runShipPhase)
- US-001 - Add deterministic PR title/body composer from the PRD snapshot

## [0.66.0] - 2026-07-05

### Added

- US-003 - Orchestrator boot surfaces the ship-stalled marker
- US-002 - Durable stalled escalation: merge-watch-stalled event + marker, consumed on merge
- US-001 - Auto-recover OPEN+BEHIND merge-watch via bounded gh pr update-branch

## [0.65.0] - 2026-07-05

### Added

- [US-R1-003] - Add real-git integration test for commitExistsForStory
- [US-R1-002] - Scope commitExistsForStory git log to this branch's own commits
- [US-R1-001] - Support the bracketed feat commit convention in commitSubjectMatchesStory
- [US-003] - Worker-isolation-aware per-worker sentinel timeout ceiling
- [US-002] - Wire commitExistsForStory from host + loop with anchored git detection
- [US-001] - Add commit-existence gate to readWorkerOutcome

## [0.64.0] - 2026-07-05

### Added

- [US-001] - Tear down the lingering worker pane on every supervisor terminal exit

## [0.63.0] - 2026-07-05

### Added

- [US-001] - Re-anchor auto-ship to terminal complete+CLEAN with a persisted fire-once marker

## [0.62.0] - 2026-07-05

### Added

- [US-005] - Judgment point: park the drain and escalate on a blocked cycle
- [US-004] - Wire the auto-dispatcher into the sidecar idle-tick
- [US-003] - Fail-closed hard-precondition gate for the drain
- [US-002] - Runtime drain kill-switch: marker primitive + cam drain command
- [US-001] - Extend meta_loop enum with 'auto'

## [0.61.0] - 2026-07-05

### Added

- [US-001] - Build the on-demand in-container test harness

### Fixed

- [US-R1-002] - parseBunOutput now matches real bun non-TTY (fail)/todo format
- [US-R1-001] - address reviewer finding: bump three file-size budget ceilings

## [0.60.0] - 2026-07-04

### Added

- US-003 - Wire container-config into ensure-up + fail-closed in runSidecar
- US-002 - New src/supervisor/container-config.ts mirroring container-firewall.ts
- US-001 - Build-time Dockerfile: pre-create bun-owned /home/bun/.claude and install jq

## [0.59.0] - 2026-07-04

### Added

- [US-001] - Apply init-firewall.sh in ensure-up container path, fail-closed

## [0.58.0] - 2026-07-04

### Added

- US-001 - Rewrite re-home block with getent gid-collision branch

## [0.57.0] - 2026-07-04

### Added

- [US-001] - Bake claude onboarding + /workspace trust config into the cam-worker image

## [0.56.0] - 2026-07-04

### Added

- US-002 - Resolve host uid/gid and thread build-args through the production ensure-up path
- US-001 - Re-home the bun user to HOST_UID/HOST_GID build-args in the worker image

## [0.55.0] - 2026-07-04

### Added

- [US-006] - Flip the planner + auditor spawns through the container + add plan-runner preflight seam (fail-closed)
- [US-005] - Flip the reviewer spawn through the container (fail-closed)
- [US-004] - Flip the implementer spawn through the container (fail-closed) + ADR
- [US-003] - Ensure-up idempotent container lifecycle at supervisor boot
- [US-002] - Add dockerExecWrap() shared chokepoint helper
- [US-001] - Add fail-closed [loop] worker_isolation config reader

## [0.54.0] - 2026-07-03

### Added

- [US-002] - Remove inert eslint-disable no-constant-condition directives
- [US-001] - Resolve orchestrator pid via ps ppid-walk (drop pgrep)

## [0.53.0] - 2026-07-03

### Added

- [US-001] - Bump retry cap 3->4 to realize the 240s backoff window

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
