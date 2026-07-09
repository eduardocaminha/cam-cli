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

> Archived 17 oldest entries to scripts/cam/journal.archive.md on 2026-07-09. See that file for the full history.

## cam-176-wire-firewall-ensure-up — CAM-176 shipped: wire init-firewall.sh into the ensure-up container path, fail-closed

- **Started**: 2026-07-04T09:51:35-03:00
- **Closed**: 2026-07-04T14:02:55Z
- **Branch**: cam/pr-132-wire-firewall-ensure-up
- **Issue**: CAM-176
- **Outcome**: shipped
- **Summary**: Wired the existing default-deny egress firewall (.devcontainer/init-firewall.sh) into cam's ensure-up container path, which until now never ran the firewall (only the devcontainer postStartCommand did, and cam's docker run path never triggers it, so container mode was not egress-sandboxed). New src/supervisor/container-firewall.ts (buildFirewallExecArgv pure builder + applyContainerFirewall), wired into makeProductionEnsureContainerFn to run unconditionally after ensureWorkerContainer, fail-closed in runSidecar (typed FirewallError, log stderrTail, return before runSidecarLoop, no worker dispatches). 1 story US-001, auditor APPROVE, review CLEAN round 1, check:all green (3012 tests), shipped v0.59.0 (PR #132).
- **Decisions**: Wiring-only (allowlist owned by CAM-116, e2e by CAM-175). Separate applyContainerFirewall fn (keeps ensureWorkerContainer 4-branch machine pure). Apply unconditional on every ensure-up (idempotent script; netns rules drop on stop/start). exec form sudo bash /workspace/.devcontainer/init-firewall.sh mirrors the devcontainer and reuses the restricted NOPASSWD sudoers grant. Script exit code IS the readiness gate (self-verify curls). Fail-closed via typed FirewallError (clean return, avoids wrapper crash-loop). Test = pure argv builder + injectable spawnFn fakes; real-daemon deferred to CAM-175.
- **Blockers encountered**: Implementer sentinel poll ran the full 30min budget then timed out (pollOutcome:timeout, pane-died-retry), but the work was committed well before; supervisor self-healed by advancing to review (US-001 already passes:true). Recurring buffering fragility, slow but not blocking. Ship: env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write).
- **Follow-ups**: CAM-175 is next and the definitive container-mode gate: PRECONDITION rebuild+reinstall cam to 0.59.0 (running sidecar is 0.55.0 = no firewall wiring), then flip worker_isolation=container and run a real story GREEN in the container (firewall converges, egress allow/block, zero-prompt, /workspace writable). Then CAM-139. Also open: CAM-181, CAM-182, CAM-177, CAM-180 (mostly folded into 175). Optional nit: reviewer SUGGESTION on container-firewall.ts:40.

## cam/pr-185-container-config-chown-bypass — CAM-185 shipped: fix container-mode root-owned .claude volume (build-time + runtime), container mode product-complete

- **Started**: 2026-07-04
- **Closed**: 2026-07-04T22:13:19Z
- **Branch**: cam/pr-185-container-config-chown-bypass
- **Issue**: CAM-185
- **Outcome**: shipped
- **Summary**: Fixed container mode's root-owned /home/bun/.claude named volume, the last CAM-175 blocker. The claude-code-config named volume mounted root-owned (the image lacked a bun-owned /home/bun/.claude dir, so Docker created the mountpoint root, shadowing the build-time chown), causing two symptoms in real workers: every Bash tool call failed EACCES on mkdir session-env, and claude rewrote .claude.json dropping bypassPermissionsModeAccepted so the Bypass Permissions modal reappeared and hung the worker. Fixed at both layers: build-time (Dockerfile pre-creates the bun-owned dir + installs jq) so fresh volumes mount bun-owned, and runtime (new container-config.ts mirroring container-firewall.ts, wired unconditionally into ensure-up, fail-closed in the sidecar) that self-heals existing volumes by chowning the dir and re-asserting the 5 CAM-179 keys on every ensure-up. 3 stories, auditor APPROVE, review CLEAN round 1, 3070 tests, shipped v0.60.0 (PR #133).
- **Decisions**: Operator chose build-time + runtime (root-cause for fresh volumes + self-heal for existing). Runtime module mirrors the CAM-176 firewall pattern exactly (pure argv builder + non-throwing orchestrator union + typed error thrown by the caller + instanceof fail-closed arm). Applied a SHIP-GATE (not operator-requested): did not let auto-ship merge on host-green alone because CI is macos-only with no Docker daemon (the CAM-178 trap). Verified the fix on the REAL production ensure-up path (makeProductionEnsureContainerFn from branch source against the live daemon, no fakes) on both stale (self-heal) and fresh (build-time) volumes before shipping: dir 501:20, bun mkdir OK, bypass=true + 5 keys, firewall allow-anthropic+github/block-example, jq-1.6 in image. CAM-175 already proved state to clean-worker (worker %14), so a full re-dispatch was not re-run.
- **Blockers encountered**: US-003 (wiring + fail-closed + tests) took ~25min on the host wrestling the file-size ratchet gate; the worker raises the budget itself (memory orch-no-hardkill-on-filesize-story) and converged, no intervention. Ship: env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write). To run the in-session container verification, swapped the sidecar in-place rather than cam stop (which would kill the orchestrator tmux session).
- **Follow-ups**: CAM-139 (autonomous meta-loop) is now UNBLOCKED (hard-precondition container active+validated is met): the natural next major work, likely needs /cam-spec first. Installed cam + sidecar are still 0.59.0; container-mode dev needs rebuild+reinstall to 0.60.0 (build-release.sh --install) before ensure-up carries the fix. CAM-186 (10 in-container test fails vs host) is a scoped follow-up, now unblocked. Also open: CAM-181, CAM-182, CAM-177, CAM-180.

## cam/pr-186-in-container-test-harness — CAM-186 shipped: on-demand in-container test harness; suite green on v0.60.0 (stale 10-fail baseline was 0 real fails)

- **Started**: 2026-07-04
- **Closed**: 2026-07-05T01:53:05.996Z
- **Branch**: cam/pr-186-in-container-test-harness
- **Issue**: CAM-186
- **Outcome**: shipped
- **Summary**: Delivered the on-demand in-container test harness (scripts/test-in-container.ts: ensure-ups cam-worker + docker-exec bun test against /workspace; exit non-zero iff FAILURES) and re-baselined the suite on v0.60.0. The reported 2957 pass / 10 fail vs 3012 (from the pre-jq/pre-185 CAM-175 ceremony) was STALE: on v0.60.0 it is Host 3102/0/0 vs Container 3064 pass / 34 skip / 0 REAL fail. The spec contingency path was hit (jq + CAM-185 ownership already resolved the failures). 34 skips all documented via test.skipIf(!probe). Shipped v0.61.0 (PR #134).
- **Decisions**: Spec grill Q1-Q6 (operator-approved): (B) classify+guard+fix-cheap-gaps, (i) green = 0 failures + documented skips (no tmux added to the worker image, the worker never uses tmux at runtime), (a) dedicated on-demand harness that brings the container up itself (no worker_isolation flip committed; not a CI gate since macos CI has no Docker = CAM-178 trap; pointer added to docs/adr/0003), and US-001 captures the baseline in the loop. 34 skips: 20 pre-existing tmux + 6 tmux (US-001) + 8 US-002 (procps ps absent x1; bun 1.2.x macrotask scheduling differs from bun 1.3 host x7).
- **Blockers encountered**: US-002 (container story: image rebuild + 3098 in-container tests) hit the 30-min sentinel timeout AFTER writing passes=true and git-add-staging but BEFORE committing; the loop read the uncommitted passes=true and spawned a premature reviewer. It self-healed: the reviewer reviews the working-tree diff and caught two real CRITICALs (check:all RED at the file-size gate, and a parseBunOutput false-green matching a marker bun never emits in non-TTY docker-exec) -> FIXES_PENDING -> round-1 fixers (US-R1-001 budget bump, US-R1-002 regex + real bun fixture) committed all staged work via git add -A -> review round 2 CLEAN. Auto-ship did NOT fire after CLEAN (loop idle, reviewer pane lingering held the 3-pane mutex); orchestrator killed the pane and ran /cam-ship by hand. My own slip: re-arming the sidecar in-place with nohup logging into .claude/.cam-sidecar.out dirtied the tree and failed the plan-preflight clean-tree once. env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write).
- **Follow-ups**: CAM-139 (autonomous meta-loop) is the natural next major work: container mode is product-complete and its suite is now green (needs /cam-spec first if stage:idea; confirm scope with the operator). CAM-187 (P3, filed this cycle): the loop advances on an uncommitted passes=true after a worker timeout, and the 30-min sentinel ceiling is too short for container stories. Investigate why auto-ship did not fire after review CLEAN despite plan_approval=auto (may relate to CAM-181). Also open: CAM-182, CAM-177, CAM-180. Running sidecar/installed cam are 0.60.0; rebuild to 0.61.0 only for a fresh container-mode dispatch.

## cam/pr-139-inter-cycle-auto-drain — CAM-139 shipped: armed the unattended inter-cycle auto-drain (meta_loop=auto, opt-in); auto-ship-after-CLEAN no-fire bug reproduced 2x

- **Started**: 2026-07-05
- **Closed**: 2026-07-05T12:15:43Z
- **Branch**: cam/pr-139-inter-cycle-auto-drain
- **Issue**: CAM-139
- **Outcome**: shipped
- **Summary**: Armed the unattended inter-cycle auto-drain (meta_loop=auto, opt-in, default off): the sidecar dispatches the next plannable issue's plan and chains plan->implement->review->ship->merge via existing primitives, hard-gated on container isolation active + plan_approval=auto, with a runtime kill-switch (cam drain) and a judgment point that parks + escalates on a blocked cycle. 5 stories, review round 1 CLEAN, check:all EXIT 0 (3166 pass), shipped v0.62.0 (PR #135).
- **Decisions**: CAM-139 was already stage:specified (grill done in a prior session) so it went straight to cam plan 139 (no /cam-spec). US-001 extend meta_loop enum with 'auto'; US-002 runtime kill-switch (cam drain + DRAIN_STOP_MARKER, wired into cam stop); US-003 fail-closed hard-precondition gate (container active + plan_approval=auto or refuse); US-004 auto-dispatcher wired into the sidecar idle-tick; US-005 judgment point (park on MAX_ROUNDS_DEBT, escalate once, dedup across ticks). ADR docs/adr/0007. The auto-drain is opt-in and fail-closed; the merge does not auto-activate it.
- **Blockers encountered**: Auto-ship did NOT fire after review CLEAN again (2nd reproduction: CAM-186 + CAM-139) despite plan_approval=auto: the loop went idle/active:false and a reviewer pane lingered holding the 3-pane mutex; the orchestrator killed the pane and ran /cam-ship by hand (ci-gated). This is exactly the failure point where CAM-139's own auto-drain will stall (drainer cannot chain to merge if auto-ship never fires after CLEAN). env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write).
- **Follow-ups**: START-HERE next cycle: fix the auto-ship-after-CLEAN no-fire bug (reproduced 2x, blocks the auto-drain end-to-end, likely CAM-181; stage:idea -> needs /cam-spec then /cam-plan). To exercise the auto-drain: rebuild+reinstall to 0.62.0, flip meta_loop=auto, satisfy the container + plan_approval gate. 2 reviewer perf/efficiency SUGGESTIONs were non-blocking and not structurally captured (optional file). Backlog: CAM-181 (elevated), CAM-187, CAM-182, CAM-177.

## cam/pr-181-auto-ship-terminal-anchor — CAM-181 shipped: auto-ship-after-CLEAN gate fixed (over-fire A + no-fire B unified) v0.63.0; no-fire reproduced 3x under the 0.60.0 sidecar, shipped by hand

- **Started**: 2026-07-05
- **Closed**: 2026-07-05T15:06:16Z
- **Branch**: cam/pr-181-auto-ship-terminal-anchor
- **Issue**: CAM-181
- **Outcome**: shipped
- **Summary**: Fixed the auto-ship-after-CLEAN gate: BUG A (over-fire, the literal CAM-181) and BUG B (no-fire, reproduced 3x) unified at the same callsite. Re-anchored auto-ship from the transient review->CLEAN edge to the terminal complete branch gated on lastVerdict==='CLEAN' (excludes pending-operator PRDs for free, fixing A) with a persisted review.autoShipDispatchedAt fire-once marker (robust across re-invocation and sidecar restart, fixing B). 2 stories (US-001 code+marker+5 tests, US-002 ADR 0008), auditor APPROVE, review round-1 CLEAN, 3172 pass, check:all green. Shipped v0.63.0 (PR #136).
- **Decisions**: CAM-181 was stage:idea; ran /cam-spec grill this session and amplified scope to A+B (operator-approved), then /cam-plan drove autonomous implement+review. Grill: anchor on terminal complete not the edge (Q1); persisted marker not in-memory blockedCycleEmitted because the side-effect opens a PR and must survive sidecar restart, diverging from CAM-68 for a principled reason (Q2); pane teardown deferred to CAM-188 since the /cam-ship slash command bypasses the pane mutex so a lingering pane never blocks auto-ship (Q3); wrote ADR 0008 (Q4).
- **Blockers encountered**: Auto-ship no-fire reproduced a 3RD time this cycle (CAM-186 + CAM-139 + CAM-181) because the running sidecar is 0.60.0, pre-fix: review CLEAN, loop went idle/active:false, reviewer pane lingered; the orchestrator killed the pane and ran /cam-ship by hand (ci-gated). Expected, not a regression: this PR content IS the fix, dormant until rebuild. env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write).
- **Follow-ups**: START HERE: rebuild+reinstall the sidecar to 0.63.0 (build-release.sh --install), then verify auto-ship fires autonomously after a CLEAN (acceptance proof only observable post-rebuild; the fix cannot self-validate on the 0.60.0 sidecar that shipped it). Then CAM-139 auto-drain is unblockable end-to-end (flip meta_loop=auto, satisfy the container+plan_approval gate). Backlog: CAM-188 (pane teardown, NEW), CAM-187, CAM-182, CAM-177.

## cam/pr-188-teardown-worker-pane-terminal-exit — CAM-188 shipped: teardown lingering worker/reviewer pane on all terminal exits (v0.64.0); implementer switched to sonnet-5

- **Started**: 2026-07-05
- **Closed**: 2026-07-05T16:37:56.843Z
- **Branch**: cam/pr-188-teardown-worker-pane-terminal-exit
- **Issue**: CAM-188
- **Outcome**: shipped
- **Summary**: Shipped the pane-teardown hygiene fix: on every terminal exit of runSupervisorLoop (complete/awaiting-operator/blocked/max-iterations) the single reused worker/reviewer pane is now killed via kill-pane, restoring the 2-pane invariant so the operator CLI fallbacks (cam next/ship/review/issue/spec) stop being spuriously refused by paneCountMutex and the CAM-139 auto-drain can chain. 1 story US-001, review round 1 CLEAN, 3180 pass, check:all green, v0.64.0 (PR #137). Operator-directed follow-up: implementer model switched claude-sonnet-4-6 -> claude-sonnet-5 on main (commit 2c9d817).
- **Decisions**: Grill (operator-approved): kill-pane not respawn-pane -k (respawn keeps the pane => mutex stays busy; only kill-pane restores count==2, and CAM-57 ensureWorkerPane recreates it on next dispatch). Teardown on ALL 4 terminal states, not complete-only (operator needs the CLI fallbacks most in blocked/await-operator). Single finishTerminal(status) wrapper folding notifyTerminal + teardown, replacing ~16 paired callsites so no return can skip teardown; teardownWorkerPaneFn injected (default no-op), real closure wired in host.ts. Teardown-only scope: surfacing reviewer SUGGESTIONs (already persisted in review-report.json, only lost from scrollback) split out to CAM-189. 2-layer test: unit spy + real-tmux integration (3->2->recreate).
- **Blockers encountered**: Auto-ship-after-CLEAN lingering-pane reproduced a 4th time (running sidecar is 0.63.0, pre-CAM-188): CAM-181 auto-ship marker DID fire autonomously (autoShipDispatchedAt set = CAM-181 acceptance PROVEN on 0.63.0) but the reviewer pane %2 lingered holding the 3-pane mutex and the injected /cam-ship never completed the PR; orchestrator killed %2 by hand and ran /cam-ship manually (ci-gated). This is exactly what CAM-188 fixes, dormant until rebuild. env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write).
- **Follow-ups**: START HERE: rebuild+reinstall to 0.64.0 (build-release.sh --install) to activate the pane teardown in the running sidecar, then verify a full cycle auto-ships WITHOUT manual pane-kill (the teardown acceptance is only observable post-rebuild). Implementer now sonnet-5 (read from project.toml at dispatch, effective next implement without rebuild). CAM-189 (surface SUGGESTIONs) filed P3. Backlog: CAM-187 (loop advances on uncommitted passes=true after timeout), CAM-182, CAM-177, CAM-180. 1 non-blocking review SUGGESTION (integration test builds closure vs argv-mirror) left uncaptured.

## cam/pr-187-commit-existence-gate — CAM-187 shipped: commit-existence gate + isolation-aware sentinel timeout ceiling (v0.65.0)

- **Started**: 2026-07-05
- **Closed**: 2026-07-05T19:46:00Z
- **Branch**: cam/pr-187-commit-existence-gate
- **Issue**: CAM-187
- **Outcome**: shipped
- **Summary**: Hardened the autonomous loop story-complete invariant: story confirmed DONE only when prd.json passes:true AND a commit carrying the story ID exists on the branch (main..HEAD scope, bracketed feat:[US-XXX] convention). Operator stories exempt. Companion fix: isolation-aware sentinel timeout ceiling (container 60min, host 30min). 3 stories + 3 R1 fixers (bracketed regex, git log scope, real-git integration test), review round 2 CLEAN, 3205 pass, v0.65.0, PR #138.
- **Decisions**: (Q1) Gate unconditional in readWorkerOutcome, injected as commitExistsForStory(id) callback for testability. (Q2) passes:true-without-commit = not-done, re-dispatches, bounded by MAX_DEAD_WORKER_RETRIES anti-storm. (Q3) Isolation-aware ceiling in-scope same PR. (E1) requires:operator exempt. (E2) Anchor on exact bracketed token [US-XXX], scoped git log. (E3) Gate unconditional. Planner model switched to fable-5 on main (79a4fd3) this session.
- **Blockers encountered**: None. CAM-188 teardown + CAM-181 auto-ship PROVEN on 0.64.0: reviewer pane killed autonomously, /cam-ship injected via send-keys without manual pane-kill (first clean autonomous ship in 4+ cycles). env -u GITHUB_TOKEN still required on gh pr create/merge (PAT lacks PR:write).
- **Follow-ups**: START HERE: wait for CI green + auto-merge of PR #138, then cam tag on main post-merge. Backlog: CAM-182 (merge-watch auto-recover BEHIND), CAM-189 (surface SUGGESTIONs), CAM-177, CAM-180.

## cam/pr-182-merge-watch-behind-autorecover — CAM-182 shipped: merge-watch auto-recovers OPEN+BEHIND (bounded gh pr update-branch, cap 2) + durable stalled marker; cleanest fully-autonomous cycle to date (v0.66.0, PR #139)

- **Started**: 2026-07-05
- **Closed**: 2026-07-05T22:31:50Z
- **Branch**: cam/pr-182-merge-watch-behind-autorecover
- **Issue**: CAM-182
- **Outcome**: shipped
- **Summary**: Shipped CAM-182: the sidecar merge-watch now auto-recovers a PR stuck at OPEN+BEHIND under strict branch protection by running gh pr update-branch (bounded cap 2, only when auto-merge is armed) instead of polling silently to the 4h timeout, and durably surfaces non-recoverable merge-watch terminals (behind-unrecovered, dirty, ci-red, closed, timeout) via a merge-watch-stalled event plus a .claude/.cam-ship-stalled.json marker the orchestrator reads on boot. 3 stories, review round 1 CLEAN, check:all EXIT 0 (3236 pass), v0.66.0.
- **Decisions**: Scope split at grill: GAP1 (auto-recover, the action) stays in CAM-182; GAP2 durable escalation is the minimal event+marker+boot-read for CAM-182's own non-recoverable terminals, with general unification of all merge-watch outcomes deferred to CAM-170 as consumer of the merge-watch-stalled event (CAM-170 is a different bug: poll-command errors, not stuck-but-successful polls). update-branch runs under env -u GITHUB_TOKEN (PAT lacks PR:write); read-only poll keeps the token. Cap only spent when main advances again (post-update state is BLOCKED/UNSTABLE not BEHIND). Marker is a separate file from consume-on-read .cam-merge-watch.json; boot-read consumes automatically when a later watch merges the same PR.
- **Blockers encountered**: None. Cleanest cycle to date: plan, auditor APPROVE, 3 stories, review round 1 CLEAN, auto-ship via injected /cam-ship, auto-merge, and post-merge all ran with zero manual intervention (PR #139 merged CLEAN with no BEHIND, unlike PR #138 which needed a manual gh pr update-branch at this session boot). Dogfood irony: the running sidecar (pid 31482) is pre-CAM-182 so this fix is dormant until rebuild.
- **Follow-ups**: Rebuild+reinstall the sidecar to 0.66.0 (build-release.sh --install) to activate CAM-182 auto-recover in the running process. Next candidates: CAM-189 (surface reviewer SUGGESTIONs, P3), CAM-170 (now consumer of merge-watch-stalled; stage:idea, needs /cam-spec), CAM-177 (.dockerignore), CAM-180 (rebuild worker image), CAM-139 (autonomous meta-loop, unblocked).

## cam/pr-149-ship-runner-deterministic — CAM-149 shipped: deterministic ship runner (ship phase is a TS state machine, PR body templated from the PRD, LLM removed from the ship path); dogfood-shipped itself (v0.67.0, PR #140)

- **Started**: 2026-07-05
- **Closed**: 2026-07-06T00:45:08Z
- **Branch**: cam/pr-149-ship-runner-deterministic (merged+pruned)
- **Issue**: CAM-149
- **Outcome**: shipped
- **Summary**: Moved the entire ship phase out of markdown into deterministic TS: runShipPhase (src/supervisor/ship-runner.ts) runs branch guard, PRD-complete, commits-ahead, quality gates (bun run check:all), version bump, cycle-close finalize and push as a fail-fast state machine; runShipPrStep (src/release/ship-pr.ts) does gh pr create + ci-gated auto-merge + artifact comment; the PR title/body are composed purely from the PRD snapshot (composePrTitle/composePrBody, src/release/pr-body.ts). No LLM participates in the ship path. cam ship and cam-ship.md are now thin phase:shipping signal-writers. 6 stories, review round 1 CLEAN, v0.67.0, PR #140.
- **Decisions**: ADR 0009 records the pipeline-determinism decision (considered alternative: LLM-authored PR prose via a worker pane; chosen: deterministic template). PRD snapshot captured in memory BEFORE finalize git-rms prd.json. bump is non-idempotent so a mid-sequence failure escalates to the operator (recovery-runbook) and never auto-resumes. GITHUB_TOKEN stripped on gh mutations (keyring OAuth fallback).
- **Blockers encountered**: None on the ship. Two boot-time corrections: (1) operator believed a PR 149 had already merged; hard evidence (gh pr list empty for the head, main lacked ship-runner.ts, the last consumed.json was CAM-182's) proved it had not. (2) I mis-read a single strings-grep token as the binary lacking the ship-runner; a multi-token sweep proved the rebuild had landed (see memory binary-capability-multi-token-check).
- **Follow-ups**: Sidecar already runs 0.67.0 with the deterministic ship runner (no rebuild needed next cycle). Backlog: CAM-189 (surface reviewer SUGGESTIONs, P3), CAM-170 (surface merge-watch poll errors + consumer of the CAM-182 merge-watch-stalled event, stage:idea needs /cam-spec), CAM-177 (.dockerignore), CAM-180 (rebuild worker image), CAM-139 (autonomous meta-loop, unblocked).

## cam/pr-190-issue-list-derived-backlog — CAM-190 shipped: deterministic cam issue list as the single backlog source; orchestrator derives backlog live (boot + on-demand) and nextActions becomes ephemeral-only, killing stale-backlog propagation across respawns (v0.68.0, PR #141)

- **Started**: 2026-07-06
- **Closed**: 2026-07-06T02:55:28Z
- **Branch**: cam/pr-190-issue-list-derived-backlog (merged+pruned)
- **Issue**: CAM-190
- **Outcome**: shipped
- **Summary**: Made cam issue list the single deterministic source of the actionable backlog (open issues grouped by stage; shipped excluded since a shipped issue keeps status:open) and wired the orchestrator to derive the backlog live at boot and on-demand instead of trusting a hand-authored nextActions snapshot; nextActions is now ephemeral-only with a hard no-backlog rule. 5 stories, review round 1 CLEAN, v0.68.0, PR #141.
- **Decisions**: Root cause was found by verifying the reviewer and handoff code against runtime, not the issue premise: the handoff nextActions was fully LLM free-form with no deterministic re-derivation, copied forward verbatim across respawns (CAM-139 shipped in the morning still showed as unblocked backlog in the evening handoff). The fix was reframed to subsume CAM-74: one deterministic cam issue list command (reuses readBacklogFromMain, stage-based filter) used by both the terminal glance and the orchestrator boot and on-demand derivation. Greeting shows counts only, never per-issue enumeration. Decomposed into 5 stories: pure list.ts derivation, runIssueList core, CLI surface, boot and persona wiring, nextActions ephemeral-only doc-gate.
- **Blockers encountered**: None. Ship clean: gates green, v0.68.0 tagged and pushed, branch pruned, no stall marker.
- **Follow-ups**: ACTIVATION: CAM-190 changes the binary (cam issue list), the persona and the boot prompt; the running cam, sidecar and wrapper stay on 0.67.0 until a rebuild-reinstall plus cam stop and cam run, so the live orchestrator keeps the old boot behavior until then. SPEC NIT: the CAM-190 spec said sort and column by priority, but issues have no priority field (canonical order is rank from CAM-108); implement against rank. Remaining specified backlog filed and specced this session: CAM-189, CAM-170, CAM-177 (derive the live list via cam issue list once the rebuilt binary has it). CAM-180 is an operator ceremony (not autonomizable); CAM-139 already shipped.

## cam/pr-118-domain-docs-writer — CAM-118 shipped: deterministic CONTEXT.md/ADR writer plus cam spec --write-docs stdin channel; wedge-audit day, 6 hardening issues filed (v0.70.0, PR #143)

- **Started**: 2026-07-06
- **Closed**: 2026-07-06T14:57:00Z
- **Branch**: cam/pr-118-domain-docs-writer
- **Issue**: CAM-118
- **Outcome**: shipped
- **Summary**: Shipped the CAM-107 follow-up: pure render/merge helpers (src/domain-docs/render.ts), ref-only writeDomainDocsOnMain (one atomic commit-tree to main), cam spec --write-docs stdin-JSON entrypoint, and the /cam-spec persist step. 4 stories, review round 1 CLEAN, PR #143 squash-merged, v0.70.0 tagged by the sidecar post-merge automation (first fully autonomous post-merge). Session opened with the cycle wedged: image-stale false-positive (Dockerfile mtime touched by branch switch) hot-looped the implement preflight 55887 times, then a cam run restart orphaned the in-flight PRD at phase idle. Recovery: docker build --no-cache plus cam next.
- **Decisions**: Chain audit produced 6 issues on main (wedge auto-resume and evented refusals; meta_loop-aware orch boot; epic deterministic-CLI-or-pane; Node 18 in-container knip gap; gate tools unpinned; send-keys push loss with the busy-composer mechanism). Ship failed twice: unpinned bunx knip floated to a release flagging the pre-existing cam self-spawn (pinned 6.24.0 + ignoreBinaries), then the GATES manifest test I had not swept (updated). CAM-191 nudged with cam ship (3rd reproduction). Operator forbids Co-Authored-By trailers: branch history rewritten pre-merge, squash verified clean, preference saved to persistent memory.
- **Blockers encountered**: CAM-182 auto-recover fired live for the first time (PR BEHIND, update-branch attempt 1); my trailer force-push consumed attempt 2, cap exhausted but merge landed. Two send-keys reports stalled in the orch composer while mid-turn (evidence for the push-loss issue spec).
- **Follow-ups**: START HERE: rebuild-reinstall the binary to 0.70.0 (build-release.sh --install) and restart cam run BEFORE any /cam-spec (installed 0.68.0 lacks --write-docs); then check for a meta-loop auto-dispatched cycle in flight and narrate. Derive the backlog live via cam issue list.

## cam/pr-202-no-flaky-test-evasion — CAM-202 shipped: no-flaky-test-evasion guard (red gate is a hard-stop for workers)

- **Started**: 2026-07-06
- **Closed**: 2026-07-06
- **Branch**: cam/pr-202-no-flaky-test-evasion (merged+pruned)
- **Issue**: CAM-202
- **Outcome**: shipped
- **Summary**: PR #144, v0.71.0. Red-gate guard in readWorkerOutcome (src/supervisor/result.ts): a story marked passes:true whose recorded gate has a failing test is refused (US-001), plus the no-flaky-evasion hard-stop rule encoded in subagent-implementer.md and subagent-reviewer.md (US-002/003). The rule self-validated on its own ship: the US-002 worker hit a real flaky test (test/dashboard.test.ts 'k after j', a genuine pre-existing flake, likely the same one a CAM-66 worker tried to dismiss) and FIXED it deterministically with a waitForAccentLine poll instead of dismissing it, plus a knip --bun fix; that is what made the host check:all pass where CAM-66 had gone red. 3 stories, review CLEAN round 1.
- **Decisions**: Operator directive 2026-07-06 (memory feedback-no-flaky-test-evasion): a worker may NEVER dismiss a failing test as flaky/pre-existing/environmental/unrelated nor re-run to confirm flakiness; red gate is a hard-stop, fix the root cause or HALT+escalate. This session was triggered by a CAM-66 worker evading the same failure the CAM-66 skipIf had masked. Sequence agreed with operator: CAM-202 (no-flaky) then CAM-203 (targeting/rank bug) then CAM-201 (toolchain parity) then CAM-66 replan; operator wants everything automatic (Renovate automerge-all).
- **Blockers encountered**: Root incident: CAM-66 shipped RED because a worker masked a brittle Ink assertion via it.skipIf(bun<1.3); the container runs bun 1.2.23 while host/CI run 1.3.x, so both in-loop gates (implementer AND reviewer, both containerized) skip version-gated tests while the ship host check:all catches them. That is CAM-201's scope (filed+specified+ranked). Two plumbing bugs derailed the first attempt to plan CAM-201: (a) specifyIssueOnMain leaves rank:None so an unranked specified issue is never plan-selected; (b) /cam-plan <id> writes plan_issue but runPlanPhase.selectIssueFn ignores it and picks top-ranked, so /cam-plan CAM-201 planned CAM-66 instead. Both filed as CAM-203. Fixed the queue with cam triage (WSJF ranks: CAM-202=1, CAM-160=2, CAM-203=3, CAM-201=4, CAM-66=7). Manual sidecar re-establish is fiddly: killing the sidecar leaves a stale .cam-supervisor.lock (pid of dead sidecar) that blocks the fresh sidecar's implement supervision, and the plan-worker (auditor) pane lingers and trips the 2-pane mutex; fix is rm .claude/.cam-supervisor.lock + tmux -L cam kill-pane on the lingering pane. CAM-191 (auto-ship loses phase:shipping on CLEAN) still live on 0.71.0: re-arm with cam ship when CLEAN-without-ship.
- **Follow-ups**: REMAINING ARC (rank order, all specified+ranked): CAM-160 (rank 2, trivial gitignore) then CAM-203 (rank 3, targeting/rank fix) then CAM-201 (rank 4, toolchain parity: pin bun+Node via .bun-version/.tool-versions single source, CI bun-version-file, Dockerfile build-arg, Renovate app + automerge-all gated on green CI, a check:all guard forbidding version-conditional test skips but allowing platform/capability skips, a fail-closed preflight asserting container bun==.bun-version, and a sidecar auto-rebuild of the image on mismatch; closes CAM-198/192/180; 2 ADRs already written docs/adr/0010,0011) then CAM-66 replan (abandon the two dead cam/pr-66 branches, replan fresh on the fixed container). GUARD IS NOW LIVE only after the 0.71.0 rebuild+restart. Operator participation is spec-only; loop is otherwise autonomous. Watch every implementer/reviewer for evasion until habitual. When CAM-201 ships, its preflight+auto-rebuild only activates after another rebuild+restart to the CAM-201 version, and then the container finally moves to bun 1.3.x.

## cam/pr-160-templates-gitignore-worker-plan-logs — CAM-160 shipped: ignore cam-worker-out/cam-plan-out logs in templates/.gitignore + regenerate embed (v0.72.0, PR #145)

- **Started**: 2026-07-06
- **Closed**: 2026-07-06T19:18:31Z
- **Branch**: cam/pr-160-templates-gitignore-worker-plan-logs
- **Issue**: CAM-160
- **Outcome**: shipped
- **Summary**: Trivial gitignore hygiene: added .claude/.cam-worker-out-*.log and .claude/cam-plan-out-*.log ignore globs to templates/.gitignore so cam-init-seeded downstream projects avoid the clean-tree false-halt, and regenerated the embedded templates copy (src/vendor/_generated.ts). 1 story, review CLEAN round 1, 3404 pass / 0 fail, v0.72.0, PR #145 merged + tagged + pruned.
- **Decisions**: The first plan BLOCKed on a correct auditor finding (F-01): the embed-regeneration oracle targeted src/templates/embedded.ts, but that file is a hand-written runtime wrapper that only re-exports templatesContents. The real embedded artifact is src/vendor/_generated.ts (codegen of scripts/generate-embedded-vendor.ts; gate `bun run embed-vendor:check`). Verified the artifact roles against the live tree, not memory. The plan-runner has no BLOCK-to-re-plan loop (CAM-151 Half B unshipped), so it halted and handed the BLOCK back; re-ran /cam-plan CAM-160 and the planner self-corrected to APPROVE, then drove implement/review/ship autonomously.
- **Blockers encountered**: Two operator unblocks. (1) The re-plan stalled at phase:planning with no fresh planner because the prior BLOCKed run's auditor pane (%2) lingered as a 3rd pane, keeping paneCountMutex busy (plan-runner.ts:670 returns mutex-busy each tick); killed it by hand (tmux -L cam kill-pane) to restore count==2, and the planner spawned within 12s. This is CAM-167 (still open): CAM-188 teardown covers only runSupervisorLoop terminals, not the plan-runner BLOCK/timeout terminals. APPROVE does not hit this because the pane is immediately reused as the implementer slot; only the halting terminals leak it. (2) CAM-191 reproduced: review CLEAN set autoShipDispatchedAt but lost phase:shipping (loop idle, no PR); re-armed via /cam-ship. Ship + ci-gated auto-merge + tag + prune then ran fully autonomously.
- **Follow-ups**: CAM-167 (plan-runner BLOCK/timeout pane teardown, post-CAM-188 residual) and CAM-191 (auto-ship loses phase:shipping on CLEAN) both reproduced live this cycle and are the top autonomy-friction items. Binary and sidecar stay 0.71.0 (post-merge tags but does not reinstall); CAM-160's change only affects downstream cam init, so no rebuild is needed for this repo. Arc continues by rank: CAM-203 (auto-drain planning in flight at close) then CAM-201 then CAM-66 replan.

## cam/pr-204-plan-block-replan-loop — CAM-204 shipped: deterministic plan-runner BLOCK->re-plan loop

- **Started**: 2026-07-06T20:42:00Z
- **Closed**: 2026-07-06T21:47:00Z
- **Branch**: cam/pr-204-plan-block-replan-loop
- **Issue**: CAM-204
- **Outcome**: shipped
- **Summary**: On auditor audit-blocked, the plan-runner now feeds the plan-verdict-report.json findings back into a fresh planner (cap N=2 rounds), escalates durably on non-convergence, and tears down planner/auditor panes on every plan terminal. Implements CAM-151 Half B, which was marked shipped but never delivered. 5 stories + 1 review-fix round, review CLEAN. v0.73.0, PR #146.
- **Decisions**: Plan non-convergence is a hard-stop (escalated), never proceed-with-debt, asymmetric with the review loop MAX_ROUNDS_DEBT: an unsound PRD poisons every downstream story it spawns. ADR + glossary written via cam spec --write-docs. Filed and specified without an interactive grill (fix was well-understood).
- **Blockers encountered**: CAM-191 auto-ship wedge (review CLEAN + autoShipDispatchedAt set but phase went idle with no PR); re-armed via /cam-ship.
- **Follow-ups**: Binary rebuild pending to activate in the running sidecar (installed cam was v0.71.0).

## cam/pr-205-deterministic-init-tests — CAM-205 shipped: deterministic runInit tests (flaky-timeout root-cause fix)

- **Started**: 2026-07-06T22:55:00Z
- **Closed**: 2026-07-06T23:15:00Z
- **Branch**: cam/pr-205-deterministic-init-tests
- **Issue**: CAM-205
- **Outcome**: shipped
- **Summary**: Stubbed runInit's three real subprocess spawns (command -v claude, claude --version, bun smoke-script) via an injectable spawnFn seam, so test/init.test.ts is deterministic and no longer times out at 5000ms under check:all concurrent load. Root-cause fix for the flake that hard-stopped the CAM-203 ship gate. 1 story, review CLEAN. v0.74.0, PR #147.
- **Decisions**: First real application of the CAM-202 no-flaky-evasion rule: the red gate was NOT re-run to force green; the root was fixed. Filed as a SEPARATE issue (not silently fixed on CAM-203's branch) per surgical-changes discipline.
- **Blockers encountered**: CAM-191 auto-ship wedge again; re-armed via /cam-ship.

## cam/pr-203-plan-target-and-wsjf-fallback — CAM-203 shipped: honor explicit plan targets + WSJF fallback for rank:None

- **Started**: 2026-07-06T21:48:00Z
- **Closed**: 2026-07-06T23:35:00Z
- **Branch**: cam/pr-203-plan-target-and-wsjf-fallback
- **Issue**: CAM-203
- **Outcome**: shipped
- **Summary**: Honor explicit /cam-plan <id> targets end-to-end (invalid target fails loud, never a silent no-op) and make freshly-specified rank:None issues plannable via a single-sort-key WSJF fallback in selection. 4 stories, review CLEAN. v0.75.0, PR #148.
- **Decisions**: The auditor correctly BLOCKed the planner twice on an intransitive two-tier comparator (a genuine Array.sort total-order violation); resolved as a single comparable-scalar key. The issue SPEC was clean: the contradiction was planner-introduced in the PRD, not the spec, so /cam-spec was neither needed nor possible (specified issues cannot be re-spec'd). Blind re-plan converged on the 3rd attempt.
- **Blockers encountered**: Ship gate first hard-stopped on the unrelated CAM-205 flaky init timeout (halted per CAM-202, not evaded). Re-shipped after merging main (CAM-205 fix) into the branch, resolving a file-size-budget.json _ref conflict (numeric budgets auto-unioned), re-review CLEAN, and re-arming the ship past the CAM-191 wedge.
- **Follow-ups**: Binary rebuild to activate the selection change in the running sidecar. File the re-spec-gap follow-up (no supported path to re-spec a stage:specified issue).

## cam/pr-201-toolchain-parity — CAM-201 shipped: bun+Node toolchain parity, container claude-off-PATH regression fixed live

- **Started**: 2026-07-07
- **Closed**: 2026-07-07
- **Branch**: cam/pr-201-toolchain-parity
- **Issue**: CAM-201
- **Outcome**: shipped (PR #149, CI green, v0.76.0)
- **Summary**: Boot found CAM-201 code-complete (9 stories, 2x CLEAN) but the operator's cam run had wedged the container reviewer on image-stale and been cam-stopped. Diagnosed a four-layer container cascade: stale image (US-R3-001 touched the Dockerfile so mtime exceeded image Created), then the pre-CAM-201 binary only ensures the container at boot (removing the container mid-session left the reviewer exec-ing a missing container), then CAM-207 firewall re-entrancy (dnsmasq port 53 already-in-use on a reused container), then the root blocker: US-003 regressed claude off the container PATH. The round-3 reviewer independently caught the regression. Fixed via US-R3-002 (ENV PATH=/usr/local/lib/nodejs/bin), verified live (docker exec cam-worker env claude prints 2.1.197), re-reviewed round 4 CLEAN, shipped.
- **Decisions**: Operate via host (the documented default; container was a reverted CAM-175 temp ceremony) until container mode is validated. The claude-off-PATH fix landed on-branch as US-R3-002 because it is a self-introduced US-003 regression, not a separate pre-existing defect. In-place binary swap to the CAM-201 build (which adds per-cycle ensure) to unblock the loop. worker_isolation reverted to host in project.toml.
- **Blockers encountered**: Four container layers peeled: stale image (rebuilt --no-cache to move Created past mtime), missing container after mid-session rm (exposed 0.75.0 boot-only ensure, an orchestrator misstep, recovered), firewall port-53 re-entrancy on reused container (fresh container fixed it), claude off PATH (US-003 moved npm global to /usr/local/lib/nodejs/bin with only node/npm/npx symlinked). Root cause of the whole session: running the pre-CAM-201 binary. Auto-ship wedged (CAM-191); shipped via manual cam ship.
- **Follow-ups**: CAM-207 (sidecar dies on firewall-init failure, dnsmasq port 53; pre-existing, covers the re-entrancy). Post-merge housekeeping: closed CAM-192/198/180 (subsumed by CAM-201). Filed CAM-208 (auto-drain host-mode hot-spin), CAM-209 (Node tarball SHASUMS256), and the deterministic-CLI-completeness thread under the CAM-197 epic: CAM-210 (cam issue close/abandon CLI, functions already exist) and CAM-211 (--help guard on every command incl. the stray-sidecar safety bug + undocumented --file-local flags). Operator pivoted next-session priority to that CLI thread over the formal Specified queue; stay worker_isolation=host until the backlog is organized. Container-mode re-enable checklist: image already rebuilt with the ENV PATH fix (claude resolves), address CAM-207 before flipping back.

## cam/pr-210-issue-close-abandon-cli — CAM-210 shipped: cam issue close/abandon deterministic CLI (Layer-1 of CAM-197)

- **Started**: 2026-07-07
- **Closed**: 2026-07-07
- **Branch**: cam/pr-210-issue-close-abandon-cli
- **Issue**: CAM-210
- **Outcome**: shipped
- **Summary**: Exposed `cam issue close <id>` and `cam issue abandon <id>` as deterministic positional CLI subcommands wrapping the already-existing on-main mutations closeIssueOnMain/abandonIssueOnMain, plus a symmetric already-closed idempotency guard and a CAM_ISSUE_RESULT machine handback line. 3 agent stories, review CLEAN round 1, PR #150, v0.77.0. First concrete Layer-1 instance of the CAM-197 deterministic-CLI-exposure epic.
- **Decisions**: close sets stage:shipped and abandon sets status:abandoned (orthogonal axes; close moves stage, abandon moves status). The already-closed guard keys strictly on entry.stage==='shipped'; both shared callers (ship-pr.ts, post-merge.ts) were verified SAFE (they inspect result.ok and tolerate a failed close as warning-only). The CAM_ISSUE_RESULT machine handback line was added to close/abandon but intentionally NOT retrofitted onto the sibling --file-local/list paths (tracked as a follow-up). PRD kept lean at 3 stories, well under the review-convergence danger zone.
- **Blockers encountered**: The sidecar was dead at boot (a recycle-attach does not respawn it, only a fresh cam run session-create does); started a standalone sidecar. A wrong redirect of the manual sidecar log to a non-gitignored path dirtied the working tree and failed the plan-runner clean-tree preflight; fixed by redirecting to the gitignored .claude/cam-supervisor.log. Auto-ship wedged on review-CLEAN (CAM-191, unfixed in the installed 0.76.0), so the ship was re-armed manually via cam ship. The CAM-208 drain log spam under meta_loop=auto plus worker_isolation=host is cosmetic and does not block the planning/shipping branches.
- **Follow-ups**: Retrofit the CAM_ISSUE_RESULT machine line onto the sibling --file-local/list deterministic paths, and expose the /cam-spec spec-persist step as a deterministic CLI (both filed to main this session; derive via cam issue list). Continue the CAM-197 Layer-1 CLI-exposure thread. Rebuild plus reinstall to 0.77.0 so the new close/abandon subcommands are usable in the running binary.

## cam/pr-213-spec-persist-cli — CAM-213 shipped: cam spec --persist deterministic CLI (Layer-1 of CAM-197)

- **Started**: 2026-07-07T16:47:00Z
- **Closed**: 2026-07-07T17:29:37Z
- **Branch**: cam/pr-213-spec-persist-cli
- **Issue**: CAM-213
- **Outcome**: shipped
- **Summary**: Exposed `cam spec --persist <id>` as a deterministic in-process CLI that reads {spec, wsjf, blockedBy?} as JSON from stdin and calls specifyIssueOnMain (mirroring cam spec --write-docs), with a CAM_SPEC_RESULT=<id> sha=<sha> / =ERROR reason=<r> machine handback, and rewrote the /cam-spec final persist step (both .claude and templates copies) to pipe JSON into it instead of the inline TS snippet. 2 stories plus 1 round-1 fix, review CLEAN round 2. PR #151, v0.78.0. Completes the spec-persist half of the /cam-spec CLI-ification (the --write-docs half already existed); Layer-1 instance of the CAM-197 epic.
- **Decisions**: Handback: CAM_SPEC_RESULT=<id> sha=<sha> on success, =ERROR reason=<reason> on failure (mirrors the CAM_ISSUE_RESULT reason= convention from CAM-210 and the write-docs sha=). invalid-json is a persist-specific reason token (JSON.parse fails before specifyIssueOnMain runs). --persist does NOT re-validate: specifyIssueOnMain already validates spec+wsjf+integrity and enforces every guard; --persist only marshals stdin and maps the discriminated outcome, exactly like runSpecWriteDocs. Kept persist and write-docs as TWO separate commands (decision A), not folded into one payload, since --write-docs is already a tested CLI and folding would couple two on-main commits and exceed the issue scope. This CAM-213 spec was itself persisted via the OLD throwaway-bun-script anti-pattern because cam spec --persist did not exist yet: it is exactly what CAM-213 built.
- **Blockers encountered**: CAM-191 auto-ship wedge on review-CLEAN again (active:false / phase:idle / no PR); re-armed via manual cam ship. CAM-208 cosmetic drain log spam under meta_loop=auto + worker_isolation=host, ignored.
- **Follow-ups**: Rebuild+reinstall to 0.78.0 BEFORE the next /cam-spec: the on-main /cam-spec command now pipes into cam spec --persist, which is absent from the installed 0.77.0 binary, so the next persist would break until rebuilt. Continue the CAM-197 Layer-1 CLI-exposure thread (CAM-212 next: retrofit the CAM_ISSUE_RESULT machine line onto the sibling --file-local/list paths). Derive the live queue via cam issue list.

## cam/pr-212-issue-result-retrofit — CAM-212 shipped: cam issue --file-local CAM_ISSUE_RESULT retrofit + list machine-line-free (Layer-1 of CAM-197)

- **Started**: 2026-07-07T18:18:02Z
- **Closed**: 2026-07-07T18:46:00Z
- **Branch**: cam/pr-212-issue-result-retrofit
- **Issue**: CAM-212
- **Outcome**: shipped
- **Summary**: Retrofit the CAM_ISSUE_RESULT machine handback line onto `cam issue --file-local` mirroring the CAM-210 close/abandon convention (success CAM_ISSUE_RESULT=<id> via process.stdout.write after the existing `filed <id> on main (<sha>)` printHint; failures CAM_ISSUE_RESULT=ERROR reason=<token>, token from the createLocalIssueOnMain discriminated union {diverged|detached-head|missing-main|guardrail-failed} plus invalid-json for the stdin JSON.parse failure and exception for the catch block), and regression-lock `cam issue list` as deliberately machine-line-free. 2 stories, review CLEAN round 1, ci-gated merge. PR #152, v0.79.0. Concrete Layer-1 instance of the CAM-197 deterministic-CLI-exposure epic, after CAM-210 (close/abandon) and CAM-213 (spec-persist).
- **Decisions**: list handback (operator-approved grill option 1): `cam issue list` emits NO CAM_ISSUE_RESULT line. CAM_ISSUE_RESULT is a mutation-outcome contract (the id of the single acted-on issue, or ERROR reason=), scoped to create/close/abandon; list is a read with no id, so forcing CAM_ISSUE_RESULT=OK would pollute the contract. Locked by an explicit AC + regression test so a future reviewer does not flag list as forgotten. --file-local mirrors close/abandon exactly: success prints the printHint then process.stdout.write(CAM_ISSUE_RESULT=<id>); reason token from the createLocalIssueOnMain union, plus invalid-json (emitted before the create runs) and exception (catch block). Machine line always via process.stdout.write, never the human printHint/printError channels.
- **Blockers encountered**: CAM-191 auto-ship wedge on review-CLEAN again (active:false / phase:idle / no PR); re-armed via manual cam ship. CAM-208 cosmetic drain log spam under meta_loop=auto + worker_isolation=host, ignored.
- **Follow-ups**: Continue the CAM-197 Layer-1 thread; derive the next concrete instance live via cam issue list. Rebuild+reinstall to 0.79.0 only if the running binary needs the new --file-local machine line (not a gate on the next spec/plan/loop, since CAM-212 touched no command markdown). CAM-191 (auto-ship wedge) and CAM-208 (drain spam) remain unfixed.

## cam/pr-191-auto-ship-last-write — CAM-191 shipped: auto-ship phase:shipping is the last state-file write on the terminal complete path (outer-loop-owned)

- **Started**: 2026-07-07T20:08:58Z
- **Closed**: 2026-07-07T20:52:09Z
- **Branch**: cam/pr-191-auto-ship-last-write
- **Issue**: CAM-191
- **Outcome**: shipped
- **Summary**: Fixed the auto-ship-on-CLEAN wedge. On a terminal complete+CLEAN return in auto mode, the phase:shipping signal written by autoShipFn inside runSupervisor (loop.ts:850) was destroyed before the next sidecar tick could read it, by a deterministic 3-writer clobber chain on .claude/cam-loop.local.md: autoShipFn writes phase:shipping, then onProgress unlinks the file on complete (host.ts:713-719), then clearActive recreates it as phase:idle (loop.ts:1905). Result: CLEAN-without-ship, marker set, no PR. Fix: moved the whole auto-ship decision (CLEAN check + autoShipDispatchedAt marker + setPhase shipping) out of runSupervisor into runSidecarLoop AFTER clearActive, symmetric with the auto-chain flipActive block, so phase:shipping is the last state-file write and survives teardown; dropped the autoShipFn param from runSupervisor; gated strictly on complete (never awaiting-operator); exported makeClearActive; added a real-writer regression test that fails against pre-fix code. 2 stories, review CLEAN round 1, ci-gated merge. PR #153, v0.80.0.
- **Decisions**: Outer-loop-owned (grill A/A1, operator-approved): auto-ship decision moved fully to runSidecarLoop after clearActive so phase:shipping is the LAST write, surviving the onProgress unlink and clearActive idle-rewrite. autoShipFn param dropped from runSupervisor (single owner, no split-brain); fire-once preserved via the prd.json marker plus the once-per-complete property of the active-tick-only outer block. Rejected teaching clearActive+onProgress to preserve shipping (two fragile special-cases). ADR 0013 records this and SUPERSEDES the callsite of ADR 0008 (CAM-181) while preserving 0008 anchoring semantics (complete-gated, persisted marker, await-operator elimination). Regression lock: integration test with REAL setPhase/clearActive/onProgress writers on a real temp state file, must fail against pre-fix code.
- **Blockers encountered**: Dogfood irony: this session's own ship hit the very CAM-191 wedge it fixes, because the running sidecar (pid 77460, 0.79.0) predates the fix: review CLEAN + autoShipDispatchedAt marker set + phase clobbered to idle + no PR. Re-armed manually via phase:shipping (cam ship), then ci-gated merge went green. CAM-208 cosmetic drain log spam under meta_loop=auto + host mode, ignored.
- **Follow-ups**: Rebuild+reinstall to 0.80.0 to activate the fix in the running sidecar; until then the next cycle auto-ship still wedges and needs manual re-arm. After rebuild, auto-ship should work end-to-end (the point of CAM-191). Derive the next priority live via cam issue list.

## cam/pr-208-auto-drain-host-gate — CAM-208 shipped: gate meta_loop=auto dispatcher arming on worker_isolation=container (host-mode no-op with one boot warn instead of 2s hot-spin)

- **Started**: 2026-07-07T21:05:00Z
- **Closed**: 2026-07-07T21:34:00Z
- **Branch**: cam/pr-208-auto-drain-host-gate
- **Issue**: CAM-208
- **Outcome**: shipped
- **Summary**: Fixed the meta-loop auto-drain hot-spin: with meta_loop=auto plus worker_isolation=host, buildMetaLoopFn (src/commands/sidecar.ts) armed the auto-dispatcher on meta_loop alone, so every ~2s idle tick evaluateDrainPreconditions returned container-not-active and both warned to stderr and appended a meta-loop-dispatch{refused} event, spamming logs and console. Fix: gate the meta_loop==='auto' branch on readWorkerIsolation; in host mode emit one boot-time warn and return undefined so the dispatcher is never armed (the loop seam guard then never calls it). 1 story (US-001), review CLEAN round 1, ci-gated merge. PR #154, v0.81.0.
- **Decisions**: Guard location (grill Q1 option A, operator-approved): do NOT arm the dispatcher in host mode (return undefined from buildMetaLoopFn), rather than silencing per-tick (B) or backing off (C), because host mode is a permanent config mismatch where auto-chaining is structurally impossible, so cut at the root. Observability (grill Q2 option A2): emit exactly one boot-time warn instead of total silence, so auto+host is not a silent no-op. Asymmetry preserved: host (permanent, read at boot) does not arm; container with Docker preflight not-ready (transient) keeps the per-tick refuse in evaluateDrainPreconditions, so the gate is boot-time static, not moved into the precondition. No new ADR (0007 already covers container-gating; this is an implementation refinement); added meta_loop, worker_isolation, and auto-drain glossary terms to CONTEXT.md.
- **Blockers encountered**: None in the cycle. Notable positive milestone: the auto-ship ran end-to-end with NO wedge (phase:shipping survived teardown, PR, CI, merge, tag, and close all autonomous), the first production validation of the CAM-191 fix. It is live because this session restarted the sidecar 0.79.0 to 0.80.0 at boot; prior cycles (CAM-191, CAM-212, CAM-213) had to manually re-arm ship because the running sidecar predated the fix.
- **Follow-ups**: Rebuild+reinstall to 0.81.0 (operator committed) then restart the sidecar (pid 51172) to activate the CAM-208 fix and stop the residual auto-drain spam: the running 0.80.0 sidecar still has the bug, and the spam resumed at idle post-merge. Not a gate on the next spec/plan/loop; purely cosmetic. Derive the next priority live via cam issue list.

## cam/pr-170-merge-watch-poll-error — CAM-170 shipped: surface merge-watch gh poll failures (discriminated GhPollFn, persisted consecutive-error counter, edge-triggered merge-watch-poll-error at threshold N)

- **Started**: 2026-07-07T21:41:51Z
- **Closed**: 2026-07-07T22:29:55Z
- **Branch**: cam/pr-170-merge-watch-poll-error
- **Issue**: CAM-170
- **Outcome**: shipped
- **Summary**: Made muted merge-watch poll failures loud and diagnosable instead of spinning silently to the 4h timeout. US-001 added the merge-watch-poll-error event kind + detail type and a persisted consecutiveNullPolls counter on MergeWatchState (mirroring pollCount). US-002 changed GhPollFn from PrStatus-or-null to a discriminated result (PrStatus on a successful poll, or an error result carrying the gh stderr), threaded the counter through the pure stepMergeWatch with an edge-triggered emit at exactly N=3, and propagated the signature to the production gh pr view wrapper and every test fake. 2 stories, review CLEAN round 1, ci-gated merge. PR #155, v0.82.0.
- **Decisions**: Emit-once implemented as a transition to exactly N (=== N), not a >= N test, so ticks past the threshold do not re-emit; a successful poll resets consecutiveNullPolls to 0 and re-arms the single emit. The counter increments ONLY on the discriminated error result, never on a successful not-merged (OPEN) poll, made explicit by the discriminated return. poll-error is advisory mid-watch and distinct from the terminal merge-watch-stalled (CAM-182): a run that fails consecutively then recovers (e.g. after a token rotation) emits merge-watch-poll-error but not merge-watch-stalled, and proceeds to MERGED normally. No token auto-rotation or re-read, and no new early terminal (out of scope).
- **Blockers encountered**: None affecting cycle correctness. Two self-inflicted false alarms worth recording. (1) I briefly diagnosed the boot-restarted standalone cam sidecar as not driving the plan phase because cam-supervisor.log was frozen; the plan-runner logs to cam-worker-events.jsonl, not supervisor.log, so a frozen supervisor.log during planning is expected and the loop was healthy (captured in memory supervisor-log-vs-events-jsonl-liveness). (2) A monitor script broke early on a false PR-exists positive: gh pr list with -q '.[0]|"..."' on an empty array returns the literal string 'PR#null null'; fixed with '.[0].number // empty'.
- **Follow-ups**: Second consecutive fully-autonomous ship after CAM-208; CAM-191 auto-ship and the CAM-208 host-mode drain gate are both validated live on the 0.81.0 sidecar this session restarted at boot (killed stale 0.80.0 pid 51172). Intra-cycle plan->implement->review->ship auto-chaining confirmed to work in host mode; only the inter-cycle meta-loop drain stays container-gated. Rebuild to 0.82.0 is optional (not a correctness gate). Continue the WSJF specified queue; derive the next priority live via cam issue list.

## cam/pr-177-dockerignore-worker-image — CAM-177 shipped: allowlist .dockerignore for the cam-worker image build context

- **Started**: 2026-07-07T22:38:00Z
- **Closed**: 2026-07-07T23:02:14Z
- **Branch**: cam/pr-177-dockerignore-worker-image
- **Issue**: CAM-177
- **Outcome**: shipped
- **Summary**: Added a repo-root allowlist .dockerignore so the cam-worker (.devcontainer) image build stops tarring the whole repo (4.9G seen in CAM-175) to the docker daemon. Four ordered lines (star; !.devcontainer; .devcontainer/star; !.devcontainer/claude-config.json) preceded by a header comment documenting the ignore-all-but-one rule and that a future Dockerfile COPY needs a matching allow line; golden-fixture test at test/dockerignore.test.ts. 1 story (US-001), review CLEAN round 1, ci-gated merge. PR #156, v0.83.0.
- **Decisions**: Single story: the .dockerignore + golden-fixture test as one deliverable, with the docker-build behavioral proof as an AC WITHIN US-001 rather than a separate operator-requires story; the implementer ran that proof live (docker on host, exit 0). Allowlist idiom requires BuildKit last-match-wins and the .devcontainer dir must be un-ignored (!.devcontainer) before re-including the nested claude-config.json, hence the 4-line form. With -f .devcontainer/Dockerfile the Dockerfile is read directly (not from context), so excluding it via star is fine.
- **Blockers encountered**: None. THIRD consecutive fully-autonomous ship (CAM-208 -> CAM-170 -> CAM-177): plan -> audit APPROVE -> implement -> review CLEAN r1 -> auto-ship -> CI -> merge -> tag -> close -> prune, zero manual intervention. Restarted the sidecar at boot (killed stale 0.81.0 pid 29249, launched 0.82.0 pid 60210) to match the operator rebuild; CAM-208 host-gate boot warn fired, no drain spam.
- **Follow-ups**: Rebuild to 0.83.0 is optional (CAM-177 added only a .dockerignore + test, no runner/command change). Continue the WSJF specified queue; derive the next priority live via cam issue list. Final gate: typecheck ok, 3715 pass / 0 fail.

## cam/pr-66-dashboard-truncate-loop-ghost — CAM-66 shipped: truncate long story titles in the list + harden the Loop-header ghost (dashboard polish)

- **Started**: 2026-07-07T23:09:00Z
- **Closed**: 2026-07-07T23:56:18Z
- **Branch**: cam/pr-66-dashboard-truncate-loop-ghost
- **Issue**: CAM-66
- **Outcome**: shipped
- **Summary**: Two dashboard render fixes from dogfood. US-001 truncates long story titles in the Stories list rows with a trailing ellipsis at a fixed width (the full title is still readable in the CAM-50 per-story detail subview, so no PRD schema change). US-002 hardens the Loop section header against ghosting/duplication under resize/reflow storms. Pure src/ui/Dashboard.tsx + src/commands/dashboard.ts change, 2 non-operator stories, review CLEAN round 1, ci-gated merge. PR #157, v0.84.0.
- **Decisions**: Operator picked CAM-66 in sequence (rank 7, top of the WSJF specified queue after CAM-177). Already stage:specified, so no grill. Planner made 2 autonomous stories; auditor APPROVED round 1 and runPostAuditAction auto-chained active:true + phase:implementing in host mode with no manual cam next. US-001 approach (operator-chosen at spec time): truncate the list row rather than change the PRD schema, since the detail subview already shows the full title.
- **Blockers encountered**: None in the cycle. Significant milestone: this was the CAM-66 REPLAN. CAM-66 previously shipped RED because a worker masked a version-gated Ink assertion via it.skipIf(bun<1.3) (container bun 1.2.23 vs host/CI 1.3.x skipped the test in-loop while the ship host check:all caught it). It was abandoned and requeued behind the CAM-202 (no-flaky-evasion) / CAM-203 (plan-targeting + rank) / CAM-201 (toolchain parity) arc. This replan shipped CLEAN round 1 with 3728 pass / 0 fail and no evasion, the live validation that the arc closed the root cause.
- **Follow-ups**: FOURTH consecutive fully-autonomous ship (CAM-208 -> CAM-170 -> CAM-177 -> CAM-66): plan -> audit APPROVE -> implement -> review CLEAN r1 -> auto-ship -> CI -> merge -> tag -> close -> prune, zero manual intervention. Sidecar pid 60210 (0.82.0) drove it end-to-end; not restarted at boot since it already matched. Rebuild to 0.84.0 is optional (CAM-66 was a pure UI change, no runner/command behavior change). Continue the WSJF specified queue; next candidates by rank are CAM-83 (8), CAM-92 (9), CAM-115 (10). Derive the next priority live via cam issue list.

## cam/pr-83-dashboard-session-cost-elapsed — CAM-83 shipped: session-cumulative token cost and total session elapsed in the dashboard Loop header

- **Started**: 2026-07-08T00:00:00Z
- **Closed**: 2026-07-08T00:54:49Z
- **Branch**: cam/pr-83-dashboard-session-cost-elapsed
- **Issue**: CAM-83
- **Outcome**: shipped
- **Summary**: Dashboard session-cost observability (P2, supports CAM-71 prolonged autonomous use). US-001 tracks the sidecar session start and renders total session elapsed in the Loop header. US-002 accumulates the session-cumulative worker-token total from the event log and renders it in the header. Cost is shown in tokens, not USD, since the price varies by model tier the cam does not know. Two non-operator/autonomous stories touching DashboardData plus src/ui/Dashboard.tsx (and supervisor session-start tracking), review CLEAN round 1, ci-gated merge. PR #158, v0.85.0.
- **Decisions**: Operator picked CAM-83 in rank sequence (rank 8, top of the WSJF specified queue after CAM-66) and had rebuilt the binary to 0.85.0 at boot. Already stage:specified, so no grill. Planner produced 2 non-operator stories matching the issue spec exactly (US-001 sessionStartTs at startup plus render elapsed; US-002 accumulate totalTokens from the EventLog plus render). Auditor APPROVED round 1 and runPostAuditAction auto-chained active:true plus phase:implementing in host mode with no manual cam next. Did NOT restart the sidecar at boot: running pid 60210 is 0.82.0 and the rebuild to 0.85.0 was on-disk only; assessed as not a correctness gate because 0.83 (.dockerignore) and 0.84 (dashboard UI) touched neither the plan-runner nor the supervisor loop, and the implementer edits branch source not the compiled binary. pid 60210 drove the cycle end-to-end.
- **Blockers encountered**: None in the cycle. US-002 raised the test-file-size budget for test/dashboard.test.ts itself during implement (worker has Write; normal self-raise per the orch-no-hardkill-on-filesize-story convention, not a disfunction). Test count moved 3728 to 3778 (US-001) to 3749 (US-002), all 0 fail; the net fluctuation between the two per-story reports is benign.
- **Follow-ups**: FIFTH consecutive fully-autonomous ship (CAM-208 to CAM-170 to CAM-177 to CAM-66 to CAM-83): plan to audit APPROVE to implement to review CLEAN r1 to auto-ship to CI to merge to tag to close to prune, zero manual intervention. Sidecar restart to 0.85.0 is optional (not a correctness gate; CAM-83 added dashboard/supervisor behavior but the running sidecar drives via its own compiled code, which is behaviorally identical for orchestration). Continue the WSJF specified queue; derive the next priority live via cam issue list. Final gate: typecheck ok, 3749 pass / 0 fail.

## cam/pr-92-narrate-report-helper — CAM-92 shipped: dedupe notifyOrchestrator blocks in loop.ts behind private helpers

- **Started**: 2026-07-07
- **Closed**: 2026-07-08
- **Branch**: cam/pr-92-narrate-report-helper
- **Issue**: CAM-92 (#159)
- **Outcome**: shipped (PR #159, v0.86.0)
- **Summary**: Extracted private narrateReport()/notifyBlocked()/blockedResult helpers in src/supervisor/loop.ts, deduping the CAM-78 inline notifyOrchestrator blocks (3 report-narration sites + 7 blocked-terminal template lines) to a single source, and lowered the loop.ts file-size ceiling to 1928. Review round 1 CLEAN, 3748 tests pass / 0 fail.
- **Decisions**: The PRD was self-contradictory and had burned 10 consecutive implementer sessions (all BLOCKED_AMBIGUITY): AC1-3 dedup collapses the formatWorkerReportSummary( call-site count in loop.ts from 3 to 1, but a pre-existing CAM-94 static-grep test (AC7) pinned it at 3 and AC4 forbade touching existing supervisor tests. Operator authorized a surgical prd.json amendment relaxing AC4 to permit deleting the superseded AC7 test (its intent already covered by the runtime AC2/AC5 tests plus the new AC1-3 oracles). A static source-text-count test is brittle against a legitimate dedup; runtime behavior tests survive it.
- **Blockers encountered**: 10-session BLOCKED_AMBIGUITY wedge from the contradictory AC, resolved by the operator-authorized PRD amendment (not an 11th implementer attempt). Auto-ship succeeded in host mode; merge-watch recovered a BEHIND PR via gh pr update-branch before the squash, so the CAM-121 clobber hazard (CAM-214 filed on main mid-cycle) did not bite.
- **Follow-ups**: CAM-214: harness circuit-breaker for repeated identical BLOCKED_AMBIGUITY on the same story ID with an unchanged PRD (halt + escalate instead of re-spinning).

## cam/pr-115-review-suggestion-followups — CAM-115 shipped: follow-ups dos SUGGESTIONs do review do CAM-106

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-115-review-suggestion-followups
- **Issue**: CAM-115 (#160)
- **Outcome**: shipped
- **Summary**: Enderecou as 4 SUGGESTIONs nao-bloqueantes diferidas do review do CAM-106: selectPlannableFromFile passa a retornar null e propagar erro real (em vez de engolir pra undefined), alinhamento do seam de fonte-de-verdade com a prosa do cam-plan, remocao do clock/ClockFn orfao em ship-finalize.ts, e limpeza dos review findings stale no verdict CLEAN. Version 0.86.0 para 0.87.0, tag v0.87.0.
- **Decisions**: Review round 1 achou 1 CRITICAL: US-001 fez selectPlannableFromFile passar a THROW em erro de leitura/parse e guardou a fn OBSERVE de producao, mas deixou a fn AUTO/DISPATCH desprotegida; no idle tick de meta_loop=auto+container (loop.ts:1811, sem try/catch) um backlog corrompido crasharia o sidecar long-lived, o exato vetor que US-001 queria fechar. Corrigido em US-R1-001 (guard no caller AUTO/DISPATCH), round 2 CLEAN.
- **Blockers encountered**: O plan de CAM-115 travou no primeiro disparo: o clean-tree preflight (git status --porcelain, untracked-sensitive) recusou porque .claude/.cam-sidecar-session.json estava untracked e nao-gitignored, revertendo phase pra idle sem marker durável nem notify (pareceu que o sinal nunca disparou). Diagnostico via Explore confirmou o gap de surfacing. Mitigado removendo o arquivo runtime (recriável no proximo cam run boot); o fix definitivo (gitignore + surfacing) foi filado como CAM-215.
- **Follow-ups**: CAM-215 (idea): gitignore do .cam-sidecar-session.json + marker durável/boot-read/notify pro plan-preflight-failed analogo a ship-stalled/plan-escalated + tratar o fallback silencioso plan-target-invalid->top-specified. Proxima acao do operador: /cam-spec CAM-215 (idea->specified) entao /cam-plan.

## cam/pr-215-plan-preflight-failed-surfacing — CAM-215 shipped: durable plan-preflight-failed marker + notify + boot-read, gitignore runtime trigger

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-215-plan-preflight-failed-surfacing
- **Issue**: CAM-215 (#161)
- **Outcome**: shipped
- **Summary**: Closed the silent plan-preflight-failure gap. Added a durable .claude/.cam-plan-preflight-failed.json marker (shape { step, detail, writtenAt }, no issueId) written when a plan preflight fails, an explicit preflight-failed arm in runPostAuditAction that fires notifyFn and returns a distinct result kind, Option B removal (any non-preflight-failed plan result clears the marker), and orchestrator boot step 9 that surfaces it. Also gitignored the three untracked runtime artifacts (the .cam-sidecar-session.json trigger, the latent .cam-ship-stalled.json sibling, and the new marker). 5 auto stories, review CLEAN round 1, ci-gated merge, v0.87.0 to v0.88.0, PR #161.
- **Decisions**: Grill decisions: (1) removal semantics Option B (marker present iff the last plan attempt died in preflight) over mirroring plan-escalated convergence-only removal, since preflight-failed is issue-agnostic; (2) dropped issueId from the schema (preflight failure is an environment problem, not an issue problem); (3) full detail in the durable marker, first-line plus (+N more) truncation on the volatile notify and boot surfaces; (4) folded in the latent .cam-ship-stalled.json gitignore gap (identical bug class, one line); (5) mirror plan-escalated conventions (writtenAt, writer-seam clock split, distinct PostAuditActionResult kind). ADR 0014 records: clean-tree preflight stays untracked-strict, false-refusals resolve via gitignore plus surfacing, never by loosening to -uno.
- **Blockers encountered**: None in the cycle. PR #161 went BEHIND before merge; merge-watch recovered it via gh pr update-branch (attempt 1/2) and squash-merged clean. Installed cam binary is 0.85.0 (behind main 0.88.0) but drove plan/implement/review fine since the plan-runner and supervisor are behaviorally stable.
- **Follow-ups**: (1) plan-target-invalid to top-specified silent fallback: planning an idea-stage issue silently plans the top-specified issue instead (bit in the CAM-115 session where /cam-plan on CAM-215-as-idea planned CAM-115); NOT covered by CAM-215 as filed, candidate to file. (2) Doc drift: subagent-orchestrator.md self-handoff section references cam journal append --cycle-close, but journal.ts parses only --force; recycle is armed by the orch-recycle-watch context backstop (CAM-163), not a journal flag. Candidate to file.

## cam/pr-217-journal-cycle-close-help — CAM-217 shipped: document --cycle-close in JOURNAL_HELP + exit-3 in the agent doc

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-217-journal-cycle-close-help
- **Issue**: CAM-217 (#162)
- **Outcome**: shipped
- **Summary**: Narrowed doc and help-text fix, no runtime change. US-001 documented --cycle-close and the exit-code contract (exit 1 invalid/duplicate JSON, exit 3 handoff absent, exit 4 no live watcher) in JOURNAL_HELP plus a static test. US-002 added the exit-3 refuse-to-arm case to the subagent-orchestrator.md Self-handoff lifecycle section (both dual copies plus embed). Review CLEAN round 1, 2 stories, v0.88.0 to v0.89.0, PR #162.
- **Decisions**: The filed premise (recycle drift, --cycle-close broken, recycle only via context-backstop) was FALSE. The flag and the recycle arm live in index.ts (parseJournalArgs at index.ts:1258, arm block at index.ts:1367-1399 that checks handoff-present then watcher-alive then writes ORCH_RECYCLE_MARKER), NOT in the pure library src/commands/journal.ts (which only knows --force). cam journal append --cycle-close works as documented, tested in test/commands/journal-append.test.ts, shipped in CAM-162. Operator approved narrowing CAM-217 to the sole real gap: JOURNAL_HELP omitted --cycle-close, which caused the original misdiagnosis (grepping the pure lib alone). Meta-lesson: verify CLI flags against the dispatcher index.ts, not just the pure library.
- **Blockers encountered**: None. Both follow-ups filed from the CAM-215 session narrative (CAM-216, CAM-217) turned out to describe pre-fix behavior or the wrong file; the spec-stage Explore grounding caught both before any wasted implementation. CAM-216 (plan-target-invalid silent fallback) was abandoned as already fixed by CAM-203; CAM-217 was narrowed to the help-doc gap.
- **Follow-ups**: None material. This cycle closes the CAM-215/216/217 family (silent and misleading paths in the plan and handoff flow): CAM-215 shipped the plan-preflight-failed marker, CAM-216 was already solved by CAM-203 (abandoned), CAM-217 fixed the JOURNAL_HELP discoverability gap.

## cam/pr-120-jscpd-dedup-ratchet-down — CAM-120 shipped: jscpd dedup ratchet back to 4 via shared arg-parse + check-script helpers

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-120-jscpd-dedup-ratchet-down
- **Issue**: CAM-120 (#163)
- **Outcome**: shipped
- **Summary**: Reversed the jscpd threshold regression (4.0 to 5.0) introduced by the CAM-107 ship. 3 auto stories: US-001 extracted shared ratchet-diff/spawn helpers between check-coverage.ts and check-file-sizes.ts; US-002 extracted a shared subcommand arg-parse helper in index.ts (spec/plan/issue); US-003 ratcheted the .jscpd.json threshold back down to 4. All 3 GREEN (typecheck ok, 3802 pass / 0 fail). Review CLEAN round 1. Shipped v0.89.0 to v0.90.0, PR #163, CI pass 1m53s, squash-merged ci-gated.
- **Decisions**: Fully autonomous cycle (meta_loop=auto): plan approved by auditor round 1, sidecar drove implement->review->ship with no operator gating.
- **Blockers encountered**: Post-merge failed with pull-failed: local main carried an unpushed direct commit (notify.resend_recipient config, filed with CAM-218) that the plan runner branched from; the squash-merge of #163 diverged origin/main from local main so post-merge git pull broke. Root cause is a direct commit to local main left unpushed before the loop cut the branch (the no-direct-main-commit-mid-loop class). Recovery by orchestrator: git reset --hard origin/main (the unpushed commit's content was preserved intact inside the #163 squash, verified), manual git tag v0.90.0 at the merge SHA + push (cam tag no-op'd because the installed binary is stale at 0.89.0 and reads its baked-in version, not src/version.ts), close CAM-120 stage:shipped via commit-tree + push, then this journal append.
- **Follow-ups**: Installed cam binary is stale at 0.89.0: rebuild+reinstall to 0.90.0 so cam tag reads the shipped version. Consider hardening post-merge to reconcile a diverged local main automatically (reset to origin/main when the local-ahead commits are content-subsumed by the squash), tracked-adjacent to CAM-174.

## cam/pr-128-cam108-review-suggestions — CAM-128 shipped: resolve the 3 non-blocking SUGGESTIONs from the CAM-108 review

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-128-cam108-review-suggestions
- **Issue**: CAM-128 (#164)
- **Outcome**: shipped
- **Summary**: 3 auto stories resolving the non-blocking SUGGESTIONs from the CAM-108 review (PR #87): US-001 unified the triage warnings source between the no-op and commit paths; US-002 made the never-read RunTriageOptions.clock optional; US-003 refactored runKahn out of the biome noExcessiveCognitiveComplexity suppression and dropped rank.t. All GREEN (typecheck ok, 3804 pass / 0 fail). Review CLEAN round 1. v0.90.0 to v0.91.0, PR #164, ci-gated squash-merge, CI green.
- **Decisions**: Fully autonomous (meta_loop=auto): auditor approved round 1, sidecar drove implement->review->ship with no operator gating. Binary was rebuilt+reinstalled to 0.90.0 earlier this session, fixing the stale-binary cam-tag no-op from CAM-120.
- **Blockers encountered**: None. Post-merge completed fully automatically (pull + tag v0.91.0 + close CAM-128 + prune), unlike CAM-120 whose post-merge broke on pull-failed from an unpushed direct-to-main commit; here local main was fully pushed when the branch was cut, so the divergence root cause was absent.
- **Follow-ups**: CAM-219 filed this session (P3, defer to release hardening): build-release hermetic init smoke emits a false-positive 'Resend not configured' warning; fix = add --plan-approval operator to the smoke invocation at build-release.sh:114.

## cam/pr-125-journal-archive — CAM-125 shipped: deterministic GC of journal.md (cam journal archive) at cycle close

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-125-journal-archive
- **Issue**: CAM-125
- **Outcome**: shipped
- **Summary**: Added `cam journal archive [--threshold N]`: a deterministic GC that moves the oldest third of journal.md entries to journal.archive.md on main when the entry count exceeds a configurable threshold (default 50), via the same commit-tree-to-main plumbing the journal writer uses. Auto-invoked on the --cycle-close path so the journal self-bounds. Shipped fully autonomous (meta_loop=auto): plan converged auditor-APPROVE, 4/4 non-operator stories, review CLEAN round 1, ship ci-gated merged clean at v0.92.0.
- **Decisions**: Archive threshold is configurable (default 50) and the move is a pure oldest-third slice, keeping the newest two-thirds hot in journal.md. US-004 retired the old manual archive rule from the templates + agent files so the deterministic path is the single source of truth.
- **Follow-ups**: Installed cam binary still at 0.90.0 (shipped code 0.92.0); a rebuild+reinstall gives cam-tag version-parity and lands the archive feature in the installed binary. Non-blocking (post-merge auto-tag works).

## cam/pr-189-suggestion-followups — CAM-189 shipped: surface reviewer SUGGESTIONs as auto-filed idea follow-ups before cycle close

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-189-suggestion-followups
- **Issue**: CAM-189 (#166)
- **Outcome**: shipped
- **Summary**: Makes review SUGGESTIONs durable instead of losing them when review-report.json is overwritten or the pane is torn down. 3 auto stories. US-001 carried SUGGESTION findings through the reviewer CLEAN exit report (both no-oracle and with-oracle CLEAN templates stopped forcing an empty findings array) plus re-embed. US-002 added the suggestion fingerprint (stable short hash of normalized file/line/text), the follow-up builder, and dedup helpers. US-003 files SUGGESTION follow-ups at the terminal review verdict via createLocalIssueOnMain (on-main commit-tree, no claude spawn), dedups against the open backlog and within the batch, pushes a one-line pane summary, and is a silent no-op on zero SUGGESTIONs. All GREEN (typecheck ok, 3900 pass / 0 fail). Review CLEAN round 1. v0.92.0 to v0.93.0, PR #166, ci-gated squash-merge, CI green.
- **Decisions**: Fully autonomous (meta_loop=auto): auditor APPROVE round 1, sidecar drove implement to review to ship with no operator gating. Verdict CLEAN now means 'no blocking findings', not 'no findings'; decide.ts terminal detection keys off TERMINAL_VERDICTS (the verdict string), never findings length, with a regression test so a future refactor cannot start gating on findings emptiness. The auto-file path is deterministic in the sidecar (no claude spawn), uses the on-main commit-tree path, and treats a diverged main as skip-and-warn.
- **Blockers encountered**: None for the ship. Post-merge completed fully automatically (pull, tag v0.93.0, close CAM-189); local main was fully pushed when the branch was cut, so no divergence.
- **Follow-ups**: The running sidecar binary predates CAM-189 (loop-binary-branch-coherence), so it did not auto-file this cycle's own 2 review SUGGESTIONs; the orchestrator preserved them manually via cam issue as CAM-220 (doc-gate for the reviewer CLEAN-findings test covers only the dev and embedded copy, not the raw template copy; non-blocking, transitively covered by embed-vendor:check) and CAM-221 (suggestion-filing crash path reuses the sidecar-exit event kind instead of a dedicated kind; cosmetic). Rebuild+reinstall the sidecar to 0.93.0 so the CAM-189 auto-file path is live on future cycles and cam-tag has version-parity. Out of scope in the issue: non-blocking WARNING findings surviving a CLEAN are a separate follow-up.

## cam/pr-223-worker-context-diet — CAM-223 shipped: prompt-side context diet for workers (invariants to CLAUDE.md, patterns.md grep-on-demand)

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-223-worker-context-diet
- **Issue**: CAM-223
- **Outcome**: shipped (PR #167, v0.94.0)
- **Summary**: Born from the operator-driven 2026-07-08 prompt/context audit (8 Explore agents over all cam agents vs code). Implementer was reading patterns.md (292KB) in full every story (~85% of an ~86k-token bill) and planner read patterns+journal (~92% of ~128k/round). Shipped: curated invariants block in the auto-loaded scripts/cam/CLAUDE.md (option A, operator grill), patterns.md demoted to grep-on-demand, planner dropped journal.md entirely, dead refs removed (AGENTS.md nonexistent, reviewer citing retired lessons.archive.md, CLAUDE.md double-load), both copies plus re-embed. Plan APPROVE round 1, 5/5 stories all 3900 tests green, review CLEAN round 1 with zero findings, ci-gated merge, fully autonomous post-spec. Same session also: accepted abandonment of CAM-99/103/130/184 (stage/status orthogonality decided, ADR + glossary written, integrity-gate issue specified), and filed the remaining audit slate as idea issues with embedded file:line evidence, identifiable by 'Origem: auditoria 2026-07-08'. Audit criticals still open ride that slate (orchestrator dispatch-protocol truth-up, auditor C.8 contradiction, implementer Step 5.5 schema-invalid example, template Write contradiction).

## cam/pr-222-plannable-predicate-gate — CAM-222 shipped: two-part query-side plannability gate (isPlannable + cam issue list --json + spine guard + docs)

- **Started**: 2026-07-09T01:35:10Z
- **Closed**: 2026-07-09T02:12:48Z
- **Branch**: cam/pr-222-plannable-predicate-gate
- **Issue**: CAM-222
- **Outcome**: shipped
- **Summary**: Fully autonomous after the plan signal: plan APPROVE, 4/4 stories, review CLEAN round 1 (zero findings), ship ci-gated merged as PR #168, post-merge tag v0.95.0 + close clean. Closes the 2026-07-08 zombie-resurrection hole: a layered isPlannable(entry, backlog) predicate (specified+open core vs core+!blocked) is now the single source routing select/rank/plan/list; cam issue list --json emits {counts, plannable, byStage} (abandoned excluded from all three, counts open-only, shipped only with --all); a spine guard test bans inline stage-literal comparisons outside the canonical module; docs (orchestrator .claude/ + templates/ dual-copy + skill cam-issue) now mandate backlog derivation via the CLI, never raw grep of issues/*.json.
- **Decisions**: stage and status remain orthogonal by design (abandonment preserves stage as history); integrity is enforced at the query layer, not by mutating zombie entries. Existing zombies (CAM-99/103/130/184) need no migration since abandoned already drops them from every output.
- **Blockers encountered**: none
- **Follow-ups**: Version skew: installed binary 0.93.0 lacks the new --json code path; rebuild+reinstall for --json parity. Operator directive: proceed to speccing the 2026-07-08 audit slate starting CAM-224.

## CAM-234 — Deterministic branch naming cam/issue-<N>

- **Started**: 2026-07-09T03:05:11Z
- **Closed**: 2026-07-09T03:44:43Z
- **Branch**: cam/pr-234-deterministic-branch-naming
- **Issue**: CAM-234
- **Outcome**: shipped
- **Summary**: Two-part deterministic branch naming. US-001 moved branch-name construction into code (plan-runner derives cam/issue-<issueNumber>, no slug; git checkout -B for idempotent re-plan; bars plan when issueNumber is absent, no ad-hoc fallback). US-002 updated planner and auditor templates to the cam/issue-<N> contract and re-embedded vendor. Root cause fixed: orphan remote branches came from LLM-authored non-deterministic slugs (CAM-66 spawned 3 names, only the merged one was auto-deleted). Fully autonomous post-signal: APPROVE, 2/2 stories, review CLEAN round 1, ci-gated ship (branch behind -> merge-watch update-branch -> CI green -> merged), post-merge tag v0.96.0, GitHub deleted the remote branch (zero orphans).
- **Decisions**: Branch format cam/issue-<N>, kept cam/ namespace to avoid churn in prefix-matching (rejected issue/cam-<N>). No slug (nothing parses it out). checkout -B over -b. No fallback since issueNumber is always present.
- **Follow-ups**: CAM-237 (reviewer suggestion). CAM-235 and CAM-236 queued next in the operator-directed branch/PR-hygiene theme. Final rebuild+swap of the sidecar pending after all three merge (deliberate skew: sidecar is 0.95, main is 0.96).

## CAM-235 — Deterministic PR title + labels tied to the issue (conventional-commit)

- **Started**: 2026-07-09T03:59:55Z
- **Closed**: 2026-07-09T04:43:31Z
- **Branch**: cam/issue-235
- **Issue**: CAM-235
- **Outcome**: shipped
- **Summary**: Second issue of the operator-directed branch/PR hygiene theme. Adds a deterministic conventional-commit signal end to end: a new optional issue-schema field type (feat|fix|chore|docs, default feat applied on read, both schema copies), captured/confirmed in the /cam-spec grill and persisted via cam spec --persist, carried by the planner from the issue into the PRD, consumed by composePrTitle to emit `<type>: <text> (CAM-<N>)` (textual CAM-N never #N, self-contained via prdSnapshot), and applied by ship-pr as a gh pr create --label using the type->label map (feat->enhancement, fix->bug, docs->documentation, chore->none). Bonus: the conventional-commit prefix propagates to the squash subject on main and feeds classifyBump. Fully autonomous after the plan signal: auditor APPROVE, 6/6 non-operator stories all green (peak 3940 pass / 0 fail), review CLEAN round 1 with zero findings, ship ci-gated (branch went BEHIND, merge-watch ran gh pr update-branch, CI green, squash-merged as PR #170), post-merge tag v0.97.0 and close clean, GitHub deleted the remote branch (zero orphans).
- **Decisions**: Issue reference in PR titles/bodies is textual CAM-N, never #N, because #N would link to a GitHub entity (our issue system is local). chore intentionally applies no label (no natural existing label; decision was to use only labels already present in the repo). type enum is aligned to classifyBump on purpose (feat->minor, fix->patch, chore/docs->none). Session deviation from the prior handoff: rebuilt+swapped the sidecar to 0.97.0 immediately after this ship rather than deferring to after CAM-236, on merit: it live-validates CAM-235 on CAM-236's own ship PR, and CAM-236 rewrites readIssueSystem which the running sidecar calls at runtime, so binary/main coherence is load-bearing, not cosmetic.
- **Blockers encountered**: none
- **Follow-ups**: CAM-238 (reviewer non-blocking SUGGESTION). Next in the hygiene theme: CAM-236 (issue_system none->local). Its plan/audit must handle a transition risk: the running 0.97 sidecar does not know the new local value, so flipping project.toml mid-branch could disturb runtime issue operations; keep none as a deprecated accepted alias and/or sequence the value change safely. A rebuild+swap to CAM-236's version is required post-merge to make its own code live.

## CAM-236 — Rename issue_system none->local (canonical value + deprecated alias)

- **Started**: 2026-07-09T04:47:00Z
- **Closed**: 2026-07-09T05:47:00Z
- **Branch**: cam/issue-236
- **Issue**: CAM-236
- **Outcome**: shipped
- **Summary**: Third and final issue of the operator-directed branch/PR hygiene theme (CAM-234/235/236). Renames the canonical issue_system value none->local: enum + setup prompts + init default flip to local, a central readIssueSystem reader, migrated fixtures and docs, and project.toml flipped to local. Fully autonomous after the plan signal: auditor APPROVE, 4/4 non-operator stories green (US-001 enum+prompts, US-002 reader+ship wiring, US-003 issue-list wiring+fixture sweep, US-004 project.toml+docs+templates+CHANGELOG). Review took 3 rounds: round 1 FIXES_PENDING (AC-oracle pinned the IssueSystem union to setup.ts but US-002 relocated it to src/config/issue-system.ts), round 2 FIXES_PENDING (residual ### None heading in both subagent-orchestrator.md copies + embedded vendor), round 3 CLEAN. Shipped ci-gated as PR #171, tag v0.98.0. Validated CAM-235 live: PR #171 title was `feat: Rename issue_system... (CAM-236)` with the enhancement label, proving composePrTitle+ship-pr work on a real ship.
- **Decisions**: local is the canonical value and new init default; none is meant to survive as a deprecated read-normalized alias (mandatory per the issue body, since init mergeIntoConfig does not rewrite an existing project.toml value).
- **Blockers encountered**: none during the loop
- **Follow-ups**: CRITICAL regression discovered post-merge by the build-release smoke: the implementation REMOVED none from every code path (readIssueSystem throws on none) instead of keeping it as the mandatory deprecated alias, breaking every already-initialized cam project on issue_system=none and aborting the 0.98 --install. Auditor APPROVE + reviewer CLEAN both missed it. Filed and fixed as CAM-239 (fix-forward, same session). CAM-236 issue-close was skipped by the 0.97 sidecar post-merge (it read the new local value against its old ===none gate); closed manually with the 0.99 binary.
