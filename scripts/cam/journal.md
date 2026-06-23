# Cam Journal

This file is the orchestrator's long-term memory for this project. One entry
per completed (or abandoned) cycle, appended in chronological order — newest
at the bottom.

The orchestrator reads this file on startup to rehydrate context. Workers
never read or write to it directly; only the orchestrator appends entries.

---

## Format

Each entry follows this template:

```markdown
## <cycle id> — <short title>

- **Started**: <ISO 8601 date>
- **Closed**: <ISO 8601 date or "abandoned">
- **Branch**: <branch name>
- **Issue**: <Linear ID / GitHub #N / CAM-XXX>
- **Outcome**: shipped | abandoned | blocked
- **Summary**: <1-2 sentences describing what was done>
- **Decisions**: <key architectural choices with rationale; omit if none>
- **Blockers encountered**: <what went wrong, how it was resolved>
- **Follow-ups**: <any debt, known issues, or next-cycle candidates>

```

---

## Guidelines for the orchestrator

- Append a new entry **only after a cycle fully ends** (shipped, abandoned,
  or explicitly closed by the human). Do not append mid-cycle.
- Keep each entry concise — aim for < 200 words. Details live in the PRD,
  PR description, and commit history; the journal is a scannable index.
- When referencing past work in conversation, cite the cycle id
  (e.g. "see LIN-42" or "see cycle cam/pr-12-auth").
- When the journal exceeds ~50 entries, summarize the oldest third into a
  single "Pre-<date> summary" block at the top of this file and archive
  the raw entries to `scripts/cam/journal.archive.md`.

---

## Entries

<!-- Entries are appended below. Do not remove this marker. -->
<!-- ENTRIES_BELOW -->

## cam/cam-run-workspace — cam run persistent workspace

- **Started**: 2026-05-30
- **Closed**: 2026-06-06
- **Branch**: cam/cam-run-workspace
- **Issue**: none
- **Outcome**: shipped
- **Summary**: Introduced `cam run` as the canonical operator entry point. Creates a persistent tmux session with three panes: orchestrator, dashboard, and interactive menu. All subcommands (next, plan, issue) become pane launchers inside the shared session. Four hardening stories (R1-001 to R1-004) fixed stable pane IDs, shell injection, stale help text, and a misleading fallback message.
- **Decisions**: Design tokens for run menu colors (keeps TUI consistent with Ink dashboard); argv-based pane launch to fix shell injection.
- **Blockers encountered**: Bun arm64 binaries need ad-hoc codesign re-signing when installed to /usr/local/bin (amfid kills the process). Documented in lessons.md 2026-06-06.
- **Follow-ups**: Add .claude/.cam-run-menu.sh to .gitignore (generated runtime file). US-010 operator smoke left as manual ceremony.

## cam/CAM-48-responsive-dashboard-pane: responsive cam-run dashboard/menu column

- **Started**: 2026-06-14
- **Closed**: 2026-06-14
- **Branch**: cam/CAM-48-responsive-dashboard-pane
- **Issue**: CAM-48
- **Outcome**: shipped (PR #45)
- **Summary**: The cam-run tmux right column (dashboard + menu) split at a fixed -l 36 against the -x 220 virtual session, collapsing below readable width on narrow clients (observed ~20 cols on a 188-col laptop, reproduced live in the orchestrator's own session). Fix: clampDashboardWidth(w) = clamp(round(w*0.20), 34, 52); born-clamped split (44 at 220) plus a per-session window-resized hook that re-clamps the dashboard pane (the menu pane shares the column) via shell $(()) on every resize.
- **Decisions**: The clamp must use shell arithmetic, not pure tmux format. Verified empirically on tmux 3.6a: resize-pane -x rejects #{...} format expressions, and tmux comparison modifiers (#{>:a,b}) are lexical, not numeric. The hook reads #{window_width} via run-shell (tmux expands it before sh -c) and computes the clamped literal with $(()). Hook is best-effort (|| true) so a failed resize never crashes the session.
- **Blockers encountered**: Review round 1 caught a round-vs-truncate drift: the hook used w*20/100 (floor) while clampDashboardWidth uses Math.round, so window_width 188 gave 37 not 38, violating the code's own single-source-of-truth comment. Fixed in US-R1-001 with round-half-up (w*20+50)/100. Round 2 verdict CLEAN.
- **Follow-ups**: US-004 (operator) verified by objective pane-width measurement (operator-authorized flip), final eyeball deferred to the next post-merge cam run. Cosmetic doc-comment still says "-L cam socket" (skipped, not worth a re-review round). Process note: `git rm a b missing.txt` is atomic, one missing path aborts the whole removal; the ship hygiene step's `git rm prd.json handoff.json progress.txt 2>/dev/null || true` silently dropped nothing because progress.txt was already retired.

## cam/CAM-49-cam-ship-hygiene-ignore-unmatch: cam-ship Step 4b git rm robustness

- **Started**: 2026-06-14
- **Closed**: 2026-06-14
- **Branch**: cam/CAM-49-cam-ship-hygiene-ignore-unmatch
- **Issue**: CAM-49
- **Outcome**: shipped (PR #46)
- **Summary**: Fixes the exact process-note bug logged at the end of the CAM-48 entry. /cam-ship Step 4b dropped per-branch state with `git rm -q prd.json handoff.json progress.txt 2>/dev/null || true`. git rm is atomic over its pathspec list: progress.txt was retired in CAM-31, so every ship since aborted the whole removal touching nothing, and the mask hid it, leaking prd.json/handoff.json to main (defeating CAM-27) and making /cam-plan Step 1 read a stale prd.json on main. Fix: `git rm -q --ignore-unmatch ...` (a missing path is benign, exit 0) with the `2>/dev/null || true` mask dropped so genuine git errors fail loud. Applied to both the templates/ copy (the cam init target) and this repo's .claude/ dogfood copy, plus the regenerated src/vendor/_generated.ts.
- **Decisions**: Keep progress.txt in the pathspec (harmless under --ignore-unmatch, defensive for ancient branches). The ship command is markdown executed by an LLM with no TS code path, so the only automatable regression guard is a test on the embedded templatesContents map (what cam init writes into user projects): that is US-002, which pins the robust form and forbids the masked-atomic pattern.
- **Blockers encountered**: PRD audit BLOCKed once: issueNumber was the string "CAM-49" instead of the bare integer 49, which would make Step 4a construct id "CAM-CAM-49" and silently fail to close the issue. Fixed to 49 (matches every prior shipped PRD and the planner schema); auditor then APPROVEd. Review round 1 verdict CLEAN.
- **Follow-ups**: none. The fix dogfooded itself on its own ship: with progress.txt absent, the fixed Step 4b exited 0 and staged prd.json + handoff.json for deletion (verified via git show --stat), so this cycle's harness state did not leak to main. Closes the CAM-48 process-note loop.

## cam/CAM-56-two-layer-verification: two-layer verification (gates + reviewer binary rubric)

- **Started**: 2026-06-16
- **Closed**: 2026-06-16
- **Branch**: cam/CAM-56-two-layer-verification
- **Issue**: CAM-56
- **Outcome**: shipped (PR #57)
- **Summary**: Two-layer verification modeled on Jaymin West. Layer A (implementer): a gate is a named command + exitCode 0 with a success/partial/failure roll-up, and the implementer is PROHIBITED from declaring a story done before gates pass. Layer B (reviewer): binary PASS/FAIL on a FIXED 8-criterion rubric with per-criterion cited evidence plus a does-not-trust-green-tests clause. Planner pairs each acceptanceCriterion with an oracle (named-command, file-assert, or reviewer-judgment); auditor BLOCKs on any criterion lacking one. Prompt/doc/template/embed/test only, no runtime code. 947 tests.
- **Decisions**: kept the existing gates {typecheck,tests} shape (US-003) instead of extending it; preserved the <review> sentinel + parseReviewVerdict (review path untouched).
- **Blockers encountered**: dogfood blocked on CAM-57 (worker-pane never created post-CAM-55 2-pane mutex). Fixed via PR #55 (sidecar self-heal) + rebuild/reinstall + in-place sidecar respawn, no session restart. CAM-58 (supervisor false-terminals after each correct story: readWorkerOutcome reads handoff.lastCompletedStory.id but the push-model worker writes a string, no worker-report.json fallback) forced manual per-story re-arms, and once all stories passed the review could not be sidecar-dispatched (hasPendingStories=false), so review ran via /cam-review directly. Round 1 FIXES_PENDING:1 (the new rubric caught a real cite error: parseReviewVerdict cited at result.ts vs the real review.ts:151), round 2 CLEAN.
- **Follow-ups**: CAM-58 (filed). Reviewer round-1 backlog: tighten the trivially-satisfied US-002 BLOCK test assertion; em-dash drift in the auditor prompt; the implementer template leaks the cam-cli-specific worker-report.ts path.

## cam/CAM-58-supervisor-outcome-worker-report: supervisor outcome worker-report fallback + review dispatch

- **Started**: 2026-06-17
- **Closed**: 2026-06-17
- **Branch**: cam/CAM-58-supervisor-outcome-worker-report
- **Issue**: CAM-58
- **Outcome**: shipped (PR #59)
- **Summary**: Fixes the CAM-56-dogfood false-terminal. readWorkerOutcome now falls back to the authoritative worker-report.json and tolerates a string lastCompletedStory (US-001); implementer writes lastCompletedStory as the {id,title} object the schema requires (US-002); sidecar makeHasPendingStories counts a non-terminal review as pending so review auto-dispatches when all stories pass (US-003, also exported for tests); staleness guard so the fallback only trusts a report matching the dispatched story, avoiding a false-pass (US-004); structured outcome-fallback event (US-005); real-fs integration regression reproducing the exact failure shape (US-006). The branch was built end-to-end by the cam loop itself: US-001..US-006 ran back-to-back with ZERO manual re-arm, the supervisor auto-dispatched the reviewer when the last non-operator story passed, review returned CLEAN round 1, 976 tests / 0 fail.
- **Decisions**: Launch-ready (7 stories) chosen by the operator over MVP (3). US-007 (operator dogfood) accepted as satisfied by this very run, since the loop demonstrably self-drove story to review with no re-arm.
- **Blockers encountered**: The planner output passed audit (APPROVE) but the auditor flagged 3 important trivially-satisfiable oracles, the exact class CAM-56 two-layer verification exists to catch: US-003 referenced test/commands/sidecar.test.ts (does not exist; canonical is test/supervisor/sidecar-loop.test.ts), makeHasPendingStories was module-private so a unit test could not import it, and US-006's grep did not forbid a shadow re-mock of the functions under test. All six findings (F-01..F-06) were applied before branching; the implemented US-003 landed in the correct canonical test file, confirming the fix took. Honest caveat: the live loop ran on the PRE-FIX binary (cam 0.1.2). The false-terminal is intermittent (fires only when the DONE sentinel escapes capture-pane) and did not trigger this run, so the live run validated the loop UX, not the fix; fix-correctness is carried by US-006's regression test against the real readWorkerOutcome.
- **Follow-ups**: Post-merge rebuild + reinstall so the operator binary carries the CAM-58 fix (US-007 AC #1, deferred). The dogfood ran the whole cycle clean, so the CAM-56 entry's re-arm friction is resolved in practice. The CAM-56 reviewer round-1 backlog (US-002 BLOCK test assertion, auditor em-dash, implementer template worker-report.ts path leak) is still open.

## cam/CAM-67-stop-kills-sidecar: cam stop kills the sidecar + cleans all markers; sidecar self-exit

- **Started**: 2026-06-17
- **Closed**: 2026-06-17
- **Branch**: cam/CAM-67-stop-kills-sidecar
- **Issue**: CAM-67
- **Outcome**: shipped (PR #60)
- **Summary**: Fixes the dogfood sidecar leak (orphan cam sidecar processes survived cam stop and abnormal session exits, polling forever and piling up; one observed at ~11h uptime across sessions). Three mechanisms: cam run persists the sidecar pid at spawn to .claude/.cam-sidecar.pid so cam stop can SIGTERM it under a signal-0 liveness guard (US-001); cam stop now removes the full per-session marker set via the canonical constants (promoting .cam-orch-session to a new ORCH_SESSION_MARKER), idempotently (US-002); the sidecar self-terminates within one idle interval when tmux has-session misses its own session, with a startup grace against the session-creation race (US-003). Plus a structured sidecar-exit event and StopReport teardown fields (US-005), a cwd-scoped fallback kill that reaps sidecars orphaned before this fix (US-006), a recovery-runbook update (US-004), and a real-Bun.spawn + real-tmux integration regression (US-007). 995 tests / 0 fail, review CLEAN round 1.
- **Decisions**: Launch-ready (7 stories) over MVP (4), chosen by the operator. The durable spawn-time pid file is required because .cam-supervisor.lock is held only while the sidecar is mid-supervision (acquired in runSidecarLoop's active branch, released in finally), so an idle orphan holds no lock and the lock pid alone cannot find it. US-006's scoped reaper is what kills the already-loose sidecars; US-001..005 only prevent new ones.
- **Blockers encountered**: None at runtime: the whole 7-story PRD self-drove story to story to review with ZERO manual re-arm, the CAM-58 false-terminal fix holding live end to end (US-007 ran as a normal automated integration test, not an operator ceremony). Plan-time: the auditor returned APPROVE with 1 important + 3 suggestion findings, all applied before branching. The important one (F-01) was an inverted-grep oracle in US-002: a positive grep asserting marker literals are PRESENT where a negative grep forbidding raw literals was meant, which would have rubber-stamped a non-constant implementation. Fixed to a negative grep plus a separate positive constants-imported assertion, and .cam-orch-session was promoted to ORCH_SESSION_MARKER so the negative grep is not self-contradictory.
- **Follow-ups**: Post-merge rebuild + reinstall so the operator binary carries the CAM-67 fix (the live run still drove on cam 0.1.2). CAM-65 (worker-pane closes on completion) still open: the reviewer pane lingers after a CLEAN verdict, harmless but not auto-recycled. The tracked .claude/.cam-orchestrator-prompt.txt churns once per session (cam run rewrites it); candidate to gitignore so it stops showing as a dirty working-tree file every cycle.

## cam/CAM-69-smoke-zero-dep: zero-dep check-agent-frontmatter smoke

- **Started**: 2026-06-23
- **Closed**: 2026-06-23
- **Branch**: cam/CAM-69-smoke-zero-dep
- **Issue**: CAM-69
- **Outcome**: shipped (PR #62)
- **Summary**: The vendored check-agent-frontmatter smoke imported js-yaml as a bare specifier. In a node_modules-less tmpdir Bun auto-installed js-yaml@5 (ESM-only, default export removed), so the smoke died with "Missing 'default' export" and two init.test.ts cases went red (cam init runs the smoke in a tmpdir). Fix: hand-rolled zero-dep frontmatter parser in vendor/check-agent-frontmatter.ts (US-001), a deterministic empty-cache tmpdir regression test that forces any accidental auto-install to fail offline-equivalent (US-002), and the v4/v5-safe named import in status.ts plus a CAM-69 recovery-runbook note (US-003). 996 pass / 0 fail, embed-vendor in parity, review CLEAN round 1.
- **Decisions**: Chose option (c) zero-dep hand-rolled parser over pinning or embedding js-yaml, since the agent frontmatter is intentionally simple (top-level key:scalar plus simple tools/disallowedTools lists). Real correctness oracle is bun test, not typecheck (vendor/ is excluded from tsconfig by design).
- **Blockers encountered**: None at runtime: the loop self-drove US-001 to US-002 to US-003 to reviewer with zero manual re-arm (CAM-58 false-terminal fix holding live). Plan-time: the auditor flagged trivially-satisfiable oracles (F-01..F-06), all applied before branching.
- **Follow-ups**: CAM-68 (gitignore the escaped harness runtime markers) still open: this ship staged selectively to keep .cam-orchestrator-prompt.txt churn and the untracked .cam-orch-*/.cam-sidecar.pid out of the PR. CAM-65 (reviewer pane lingers after CLEAN) still open.

## cam/CAM-68-gitignore-runtime-markers: gitignore the escaped harness runtime markers (repo + template + test)

- **Started**: 2026-06-23
- **Closed**: 2026-06-23
- **Branch**: cam/CAM-68-gitignore-runtime-markers
- **Issue**: CAM-68
- **Outcome**: shipped (PR #63)
- **Summary**: Seven cam runtime markers under .claude/ had escaped the .gitignore covering their siblings, so every cam run dirtied the working tree (and /cam-prune aborts on a dirty tree). Operator approved the full sweep over the 3-marker MVP: the issue named .cam-orchestrator-prompt.txt / .cam-orch-ready / .cam-sidecar.pid and flagged the setup pair as latent; the two handoff markers (.cam-orch-handoff.json, .cam-orch-handoff.consumed.json) were missed by the investigation but are the same class. US-001 added 7 rules to the repo .gitignore + git rm --cached the 3 tracked (.cam-orchestrator-prompt.txt, .cam-setup-menu.sh, .cam-setup-prompt.txt); US-002 mirrored the 7 rules into templates/.gitignore + regenerated src/vendor/_generated.ts (embed-vendor:check parity); US-003 pinned all 7 in the embedded templatesContents map + a git-state guard against re-tracking. 1004 pass / 0 fail, review CLEAN round 1. The fix dogfooded itself: the markers left this session's working tree the moment US-001 landed.
- **Decisions**: Full sweep (3 stories, 7 markers) over MVP (3 markers), chosen by the operator. Cover the class, not the instance (CAM-49 precedent).
- **Blockers encountered**: None at runtime: the cycle self-drove plan-approval to review with ZERO manual re-arm (CAM-58 false-terminal fix holding live again). Ship hygiene hit a NEW variant of the CAM-48/CAM-49 git rm class: prd.json carried the supervisor-written review block as an uncommitted modification at ship time, so Step 4b's `git rm -q --ignore-unmatch` (no -f) refused it on the local-modifications guard and the atomic rm aborted, leaving handoff.json tracked too; the subsequent `git add -A` then re-committed prd.json modified instead of removing it (would have leaked per-branch state to main, defeating CAM-27). Fixed in-cycle by `git rm -f --ignore-unmatch` + commit --amend before push.
- **Follow-ups**: File a CAM issue to harden /cam-ship Step 4b (`git rm -f --ignore-unmatch`, or commit/stash the review block first, so a dirty prd.json at ship time cannot re-leak). CAM-70 (reviewer CLEAN verdict did not reach the orchestrator via send-keys; read from prd.review directly) confirmed live again. CAM-65 (reviewer pane lingers post-CLEAN) still open.

## cam/CAM-72-deterministic-cycle-close: deterministic /cam-ship cycle-close (cam ship --finalize)

- **Started**: 2026-06-23
- **Closed**: 2026-06-23
- **Branch**: cam/CAM-72-deterministic-cycle-close
- **Issue**: CAM-72
- **Outcome**: shipped (PR #64)
- **Summary**: Closes the exact follow-up the CAM-68 entry filed. Moves the /cam-ship cycle-close hygiene out of LLM-executed markdown into deterministic TypeScript: new finalizeCycleClose() (src/commands/ship-finalize.ts), invoked via `cam ship --finalize` which branches before the thin-proxy (US-002). It reads the issue backend, closes the local issue in issues.local.json, removes per-branch state (prd.json, handoff.json, progress.txt) with `git rm -f --ignore-unmatch`, and commits in one cycle-close commit; markdown Step 4b is now a single invocation (US-003, both copies + embed-vendor). US-004 is the real-git regression the issue demanded (dirty prd.json ends DELETED, not modified), US-005 hardening/idempotency, US-006 a structured result line (for CAM-71 auto-ship narration), US-007 the recovery-runbook. 1032 pass / 0 fail.
- **Decisions**: Launch-ready (7 stories) over MVP (4), operator choice. Core fix: `git rm -f --ignore-unmatch`, the -f overrides git's local-modifications guard that plain --ignore-unmatch does not. Git surface uses DI'd synchronous spawn (mirrors status.ts / resume.ts) over Bun.spawn for hermetic tests, a documented deviation flagged by the auditor (F-04) and accepted.
- **Blockers encountered**: None at runtime: the loop self-drove plan-approval through 7 stories to review with ZERO manual re-arm (CAM-58 holding live). Review round 1 returned FIXES_PENDING on a real find (US-003 left a stale "Step 4a" cross-reference in cam-ship.md Step 7), fixed in US-R1-001, round 2 CLEAN. The CLEAN verdict did not reach the orchestrator via send-keys (CAM-70 still open), read from prd.review directly. Plan-time the auditor APPROVEd with 5 suggestions, 3 applied before branching (F-01 em-dash oracle on both copies, F-02 behavioral thin-proxy oracle, F-04 spawn-deviation note).
- **Follow-ups**: The fix dogfooded itself on its own ship: prd.json was dirty with the review block, and `cam ship --finalize` (run via `bun index.ts`, commit 1f5abc2) deleted prd.json + handoff.json rather than re-committing the modified prd.json, verified by git ls-files empty + clean tree. Post-merge rebuild + reinstall so the operator binary carries the --finalize flag (installed cam 0.1.x lacks it). CAM-71 (auto-ship) now unblocked on its deterministic-close dependency. CAM-70 and CAM-65 still open.

## cam/CAM-59-ci-macos-gate-spine: CI on macOS + deterministic gate spine (check:all/verify + ci-parity)

- **Started**: 2026-06-23
- **Closed**: 2026-06-23
- **Branch**: cam/CAM-59-ci-macos-gate-spine
- **Issue**: CAM-59
- **Outcome**: shipped (PR #65)
- **Summary**: cam's first CI (the agent-readiness keystone). macos-latest GitHub Actions (setup-bun@v2, brew install tmux, bun install, bun run check:all) so the OS-gated real-tmux integration tests actually run in CI, not just on the laptop (Burrow's lesson). Plus the os-eco gate spine: a GATES-as-data check:all/verify runner (typecheck, test, embed-vendor, ci-parity; quiet ok/fail+timing, --bail, --json to GITHUB_STEP_SUMMARY) and a check:ci-parity gate that fails if ci.yml drifts from the local manifest (green-local==green-CI). Launch-ready, 7 stories (US-006 operator). 1079 pass / 0 fail, review CLEAN.
- **Decisions**: Launch-ready (6) over MVP (3), operator choice. ci-parity manifest entry deferred from US-002 to US-003 (after ci.yml exists) so check:all never breaks between stories (auditor F-02). US-007 added mid-cycle, operator-approved, to keep "CI green" honest in one PR.
- **Blockers encountered**: The CI proved itself on day 1: the first run (red, 36s) caught a pre-existing green-local != green-CI bug. test/init.test.ts asserted runInit() exitCode 0, which only holds with claude on PATH; on the runner (no claude) runInit returns 1 though config.toml is written. US-007 made the 2 cases hermetic; second run (28057929789) green and the tmux-introspect suite ran with real 0.5 to 1.4s durations (not skipped), validating the Burrow's-lesson fix. Repo is PUBLIC, not private, so branch protection IS available (the issue's "free private plan" premise was wrong); corrected the CAM-59 note and filed CAM-73. CAM-65 (reviewer pane lingers post-CLEAN) hit the 2-pane mutex on the US-007 re-arm; killed the pane by hand. Binary 0.1.2 lacks the CAM-72 --finalize flag, so cycle-close ran via `bun index.ts ship --finalize` (sha 509e3ac).
- **Follow-ups**: CAM-73 (enable real branch protection now the repo is public + fix the agent-readiness.md branch_protection premise). CAM-65 (reviewer pane recycle) still open, hit again this cycle. CAM-70 (verdict via send-keys) read from prd.review directly again. Post-merge rebuild + reinstall so the binary carries --finalize (and CAM-58/67/68). Operator to merge PR #65.
