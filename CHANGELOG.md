# Changelog

All notable changes to cam-cli are documented here.

Format: `## [version] - YYYY-MM-DD` for releases; `## [Unreleased]

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
