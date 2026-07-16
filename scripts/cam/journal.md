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

> Archived 17 oldest entries to scripts/cam/journal.archive.md on 2026-07-16. See that file for the full history.

## CAM-285 — CAM-285 : Route reviewer SUGGESTIONs to an append-only suggestions.jsonl holding pen

- **Started**: 2026-07-12T16:40:00Z
- **Closed**: 2026-07-12T17:10:00Z
- **Branch**: cam/issue-285
- **Issue**: CAM-285
- **Outcome**: shipped
- **Summary**: 6-story PRD (PR #218, v0.143.0, ci-gated). Routed reviewer SUGGESTIONs to an append-only scripts/cam/suggestions.jsonl holding pen instead of auto-filing stage:idea issues, curbing the backlog pollution the terminal-verdict hook produced every CLEAN cycle. US-001 suggestions-pen data model + on-main JSONL append/read; US-002 seed empty suggestions.jsonl in cam init + bootstrap this repo; US-003 redirected the terminal-verdict hook sink from issue-filing to the pen; US-004 cam suggestions list CLI; US-005 cam suggestions promote + dismiss; US-006 orchestrator agent docs. auditor APPROVE, review round 1 CLEAN, 4382 pass / 0 fail.
- **Decisions**: Merit-ranked the 8 plannable specified issues (loop-reliability/correctness first, cost separate) and dispatched CAM-285 as highest-merit: it fixes an active compounding defect (a new stage:idea SUGGESTION filed every CLEAN cycle diluted backlog signal, e.g. CAM-288/289 the prior two cycles). Spec-only participation held: no plan_approval=operator; trusted the deterministic auditor+reviewer CLEAN; auto-ship (CAM-191) fired on its own at review-CLEAN. Used cam plan 285 (real renderStateFile writer), never a hand-written signal file (CAM-282 lesson).
- **Blockers encountered**: None functional. Ironic-but-expected: the running sidecar (pid 32211, behind v0.143.0) still carries the OLD terminal-verdict hook, so at review-CLEAN it filed CAM-290 + CAM-291 as stage:idea SUGGESTIONs rather than to the new pen. The holding-pen redirect only activates after a clean cam run restart + rebuild to v0.143.0. PR #218 merged BEHIND: merge-watch ran gh pr update-branch (attempt 1/2) then merged on CI green; post-merge clean, polled via gh pr view only (CAM-228 held).
- **Follow-ups**: Rebuild + clean cam run restart to v0.143.0 to activate the suggestions pen before more idea-stage pollution accrues. Triage CAM-290/291 (this cycle's auto-filed SUGGESTIONs) plus the standing idea backlog. Remaining plannable specified: re-derive live via cam issue list; standing merit order after CAM-285 was CAM-283 (cam init [loop] scaffold) then CAM-287 (CLI tier aliases, unblocked by CAM-286).

## CAM-283 — cam init scaffolds a commented [loop] section in project.toml

- **Started**: 2026-07-12T18:20:00Z
- **Closed**: 2026-07-12T18:56:00Z
- **Branch**: cam/issue-283
- **Issue**: CAM-283
- **Outcome**: shipped
- **Summary**: 2-story PRD (PR #219, v0.144.0, ci-gated). cam init now scaffolds a discoverable, commented [loop] section (meta_loop/worker_isolation/orch_context_window) in project.toml via a comment-capable TOML serializer. US-001 added comment emission to stringifyToml (parser stays comment-tolerant); US-002 made cam init emit the commented [loop] block. auditor APPROVE, review round 1 CLEAN, 4393 pass / 0 fail.
- **Decisions**: Merit-ranked the 7 plannable specified issues (correctness/onboarding first, cost separate) and dispatched CAM-283 as highest-merit: a real onboarding/correctness defect where fresh projects had no [loop] section scaffolded at all. Spec-only participation held: no plan_approval=operator; trusted the deterministic auditor+reviewer CLEAN; auto-ship (CAM-191) fired on its own at review-CLEAN. Used cam plan 283 (real renderStateFile writer), never a hand-written signal file (CAM-282 lesson).
- **Blockers encountered**: None functional. US-002 raised file-size ceilings for setup.ts (841->881) and toml.ts (206->209) with a CAM-283 tracker ref (normal ship-hygiene, worker handled it in-story). Expected-but-ironic: the running sidecar (pid 32211, behind v0.143.0's suggestions-pen redirect) still carries the OLD terminal-verdict hook, so at review-CLEAN it filed CAM-292 as a stage:idea SUGGESTION rather than routing to the new suggestions.jsonl pen; the redirect only activates after a clean cam run restart + rebuild. PR #219 merged BEHIND: merge-watch ran gh pr update-branch (attempt 1/2) then merged on CI green; post-merge clean, polled via gh pr view only (CAM-228 held).

## CAM-287 — Adopt Claude Code CLI tier aliases + free-text model passthrough

- **Started**: 2026-07-12T19:10:00Z
- **Closed**: 2026-07-12T19:40:00Z
- **Branch**: cam/issue-287
- **Issue**: CAM-287
- **Outcome**: shipped
- **Summary**: 2-story PRD (PR #220, v0.145.0, ci-gated). Adopt Claude Code CLI tier aliases (opus/sonnet/haiku/default/...) as first-class model options plus a free-text 'custom / enter id' passthrough, so new Anthropic models are picked up automatically with no dated-id drift. US-001 made the tier aliases the static model set (DEFAULTS + MODEL_OPTIONS + dogfood project.toml); US-002 added the free-text passthrough to the config model picker. auditor APPROVE, review round 1 CLEAN, 4400 pass / 0 fail.
- **Decisions**: Merit-ranked the 6 plannable specified issues (correctness/loop-reliability first, cost separate) and dispatched CAM-287 as highest-merit: direct continuation of CAM-286's model-authority work (shipped earlier today), removing hardcoded model-id drift and future-proofing against new Anthropic releases; standing top candidate unblocked by CAM-286. Spec-only participation held: no plan_approval=operator; trusted the deterministic auditor+reviewer CLEAN; auto-ship (CAM-191) fired on its own at review-CLEAN. Used cam plan 287 (installed binary that spawned the running sidecar, schema-coherent), never a hand-written signal file (CAM-282 lesson).
- **Blockers encountered**: None functional. Expected-but-ironic: the running sidecar (behind the v0.143.0 suggestions-pen redirect) still carries the OLD terminal-verdict hook, so at review-CLEAN it filed CAM-293 + CAM-294 as stage:idea SUGGESTIONs rather than routing to the new suggestions.jsonl pen; the redirect only activates after a clean cam run restart + rebuild. PR #220 merged BEHIND: merge-watch ran gh pr update-branch (attempt 1/2) then merged on CI green; post-merge clean, polled via gh pr view only (CAM-228 held), tag v0.145.0.
- **Follow-ups**: Rebuild + clean cam run restart to >= v0.144.0 to activate the suggestions pen before more idea-stage pollution accrues (operator ceremony). Triage the accumulated auto-filed SUGGESTIONs (CAM-292/293/294). Remaining plannable specified: re-derive live via cam issue list; prior standing order after CAM-287 was CAM-265 (implement-blocked doc-block), CAM-278 (HELP_REGISTRY gate), CAM-281 (createdAt in list). Idea-stage issues need /cam-spec before planning.

## CAM-265 — Consolidate duplicated marker-deletion boilerplate in orchestrator agent doc

- **Started**: 2026-07-12T19:45:00Z
- **Closed**: 2026-07-12T20:15:00Z
- **Branch**: cam/issue-265
- **Issue**: CAM-265
- **Outcome**: shipped
- **Summary**: 1-story PRD (PR #221, v0.146.0, ci-gated). Consolidated the duplicated 'Do NOT delete the marker yourself' boilerplate in the orchestrator agent doc into one shared read-only preamble, fixing the displaced implement-blocked duplicate and per-marker removal clauses. US-001 did the consolidation. auditor APPROVE, review round 2 CLEAN, 4400 pass / 0 fail.
- **Decisions**: Merit-ranked the 5 plannable specified issues (correctness/loop-reliability first, cost separate) and dispatched CAM-265 as highest-merit: a correctness defect in the orchestrator agent doc governing the implement-blocked marker lifecycle (operator recovery behavior). Spec-only participation held: no plan_approval=operator; trusted the deterministic auditor+reviewer CLEAN; auto-ship (CAM-191) fired on its own. Used cam plan 265 (bare number, real renderStateFile writer), never a hand-written signal file (CAM-282 lesson).
- **Blockers encountered**: None functional. Review round 1 returned 1 CRITICAL that was a PRD-DESIGN defect, not a code defect: AC6 ('no file under src/ modified') and AC7 ('embed-vendor:check must pass') are jointly unsatisfiable for a templates/ edit, because bun run embed-vendor regenerates the embedded bundle at src/vendor/_generated.ts. The implementer made the correct engineering call (regenerate; AC7 green) and flagged the tension in handoff.openQuestions + patterns.md. I did NOT hand-edit prd.json (owned by planner/implementer); let the sidecar's auto-fix round US-R1-001 re-scope AC6 to exclude src/vendor/_generated.ts (PRD-text amendment only, zero source change). Review round 2 CLEAN. PR #221 merged BEHIND: merge-watch ran gh pr update-branch then merged on CI green; post-merge clean, polled via gh pr view only (CAM-228 held), tag v0.146.0.
- **Follow-ups**: Rebuild + clean cam run restart to >= v0.144.0 to activate the suggestions pen before more idea-stage pollution accrues (operator ceremony). Triage the accumulated auto-filed SUGGESTIONs (CAM-288..294). Remaining plannable specified: re-derive live via cam issue list; standing merit order after CAM-265 is CAM-278 (HELP_REGISTRY completeness gate, unblocks CAM-279), then CAM-281 (createdAt in list, unblocks CAM-284), then CAM-277 (orch_context_window doc), then CAM-280 (vestigial writeFile cleanup). LESSON reinforced: a review CRITICAL can be a PRD-AC design contradiction rather than a code fault; the correct resolution is an in-loop AC amendment, not a code change and not orchestrator hand-editing of prd.json.

## CAM-278 — Compile-time command-set exhaustiveness

- **Started**: 2026-07-12T20:20:00Z
- **Closed**: 2026-07-12T20:40:00Z
- **Branch**: cam/issue-278
- **Issue**: CAM-278
- **Outcome**: shipped
- **Summary**: 1-story PRD (PR #222, v0.147.0, ci-gated). Made HELP_REGISTRY completeness and dispatch-switch coverage compile-time enforced via a single COMMANDS source-of-truth plus an exhaustive default: never, replacing the prior runtime test gate. US-001 did the whole change. auditor APPROVE, review round 1 CLEAN, 4402 pass / 0 fail, check:all spine ok. Unblocked CAM-279.
- **Decisions**: Merit-ranked the 4 plannable specified issues (correctness/loop-reliability first, cost separate) and dispatched CAM-278 as highest-merit: compile-time exhaustiveness is strictly more robust than the runtime test gate it replaced (the point of the issue). Spec-only participation held: no plan_approval=operator; trusted the deterministic auditor+reviewer CLEAN; auto-ship (CAM-191) fired on its own. Used cam plan 278 (bare number, real renderStateFile writer), never a hand-written signal file (CAM-282 lesson). Zero orchestrator intervention this cycle.
- **Blockers encountered**: None functional. Expected-but-ironic (standing caveat): the running sidecar (pid 32211, behind the v0.144.0 suggestions-pen redirect) still carries the OLD terminal-verdict hook, so at review-CLEAN it filed CAM-295 + CAM-296 as stage:idea SUGGESTIONs rather than routing to the suggestions.jsonl pen (idea count 30 -> 32). PR #222 merged BEHIND: merge-watch ran gh pr update-branch (attempt 1/2) then merged on CI green; post-merge clean, polled via gh pr view only (CAM-228 held), tag v0.147.0.
- **Follow-ups**: Rebuild + clean cam run restart to >= v0.144.0 to activate the suggestions pen before more idea-stage pollution accrues (operator ceremony). Triage accumulated auto-filed SUGGESTIONs (CAM-288..296). Remaining plannable specified: re-derive live via cam issue list; standing merit order after CAM-278 is CAM-279 (newly unblocked, HELP_REGISTRY follow-on) and CAM-281 (createdAt in list, unblocks CAM-284) top two, then CAM-277 (orch_context_window doc), then CAM-280 (vestigial writeFile cleanup).

## CAM-279 — CAM-279 — Remove dead-for-help switch-case guards

- **Started**: 2026-07-12T20:50:00Z
- **Closed**: 2026-07-12T21:10:00Z
- **Branch**: cam/issue-279
- **Issue**: CAM-279
- **Outcome**: shipped
- **Summary**: 1-story PRD (PR #223, v0.148.0, ci-gated). Removed dead-for-help guards in the config, claude, and triage switch cases : the HELP_REGISTRY follow-on unblocked by CAM-278. US-001 did the whole change. auditor APPROVE, review round 1 CLEAN (zero findings), 4402 pass / 0 fail.
- **Decisions**: Merit-ranked the 4 plannable specified issues (correctness/loop-reliability first, cost separate) and dispatched CAM-279 as highest-merit: a correctness/loop-reliability follow-on to just-shipped CAM-278, newly unblocked. Spec-only participation held: no plan_approval=operator; trusted the deterministic auditor+reviewer CLEAN; auto-ship (CAM-191) fired on its own. Used cam plan 279 (bare number, real renderStateFile writer). Zero orchestrator intervention this cycle.
- **Blockers encountered**: None. Review round 1 CLEAN. PR #223 merged ci-gated; post-merge clean, polled via gh pr view only (CAM-228 held), tag v0.148.0. Standing caveat unchanged: sidecar pid 32211 predates v0.144.0 suggestions-pen redirect (old terminal-verdict hook); this cycle's CLEAN review filed nothing new, idea count steady at 32.
- **Follow-ups**: Rebuild + clean cam run restart to >= v0.144.0 to activate the suggestions pen (operator ceremony) and then triage accumulated auto-filed SUGGESTIONs (CAM-288..296). Remaining plannable specified: re-derive live; standing merit order after CAM-279 is CAM-281 (createdAt in list, unblocks CAM-284), then CAM-277 (orch_context_window doc), then CAM-280 (vestigial writeFile cleanup).

## CAM-281 — Expose createdAt on cam issue list --json rows

- **Started**: 2026-07-12T21:20:00Z
- **Closed**: 2026-07-12T21:40:00Z
- **Branch**: cam/issue-281
- **Issue**: CAM-281
- **Outcome**: shipped
- **Summary**: 1-story PRD (PR #224, v0.149.0, ci-gated). cam issue list --json now emits a createdAt timestamp on each issue row, an observability feature that unblocks CAM-284 (updatedAt/last-activity). US-001 did the whole change. auditor APPROVE, review round 1 CLEAN, 4402 pass / 0 fail.
- **Decisions**: Merit-ranked the 3 plannable specified issues (observability/correctness first, cost separate) and dispatched CAM-281 as highest-merit: it adds a new observability capability AND unblocks CAM-284, the most downstream leverage vs CAM-277 (doc) and CAM-280 (cleanup). Spec-only participation held: no plan_approval=operator; trusted the deterministic auditor+reviewer CLEAN; auto-ship (CAM-191) fired on its own. Used cam plan 281 (bare number, real renderStateFile writer), never a hand-written signal file (CAM-282 lesson). Zero orchestrator intervention this cycle.
- **Blockers encountered**: None. Review round 1 CLEAN with zero findings. PR #224 merged ci-gated; post-merge clean, polled via gh pr view only (CAM-228 held), tag v0.149.0. Standing caveat unchanged: sidecar pid 32211 predates v0.144.0 suggestions-pen redirect (old terminal-verdict hook); this cycle's CLEAN review filed nothing new, idea count steady at 32.
- **Follow-ups**: Rebuild + clean cam run restart to >= v0.144.0 to activate the suggestions pen (operator ceremony) and then triage accumulated auto-filed SUGGESTIONs (CAM-288..296). Remaining plannable specified: re-derive live; CAM-281 likely unblocked CAM-284 (updatedAt) -- check if now plannable and rank top; then CAM-277 (orch_context_window doc), then CAM-280 (vestigial writeFile cleanup).

## CAM-284 — CAM-284 — Add updatedAt (last-activity) timestamp to issues

- **Started**: 2026-07-12T21:50:00Z
- **Closed**: 2026-07-12T22:10:00Z
- **Branch**: cam/issue-284
- **Issue**: CAM-284
- **Outcome**: shipped
- **Summary**: 3-story PRD (PR #225, v0.150.0, ci-gated). Issues now carry an updatedAt (last-activity) timestamp: US-001 added the required field to schema+type and stamped it at creation, US-002 stamped it on every issue-mutation writer, US-003 exposed it on cam issue list --json rows. Direct observability follow-on to CAM-281 (createdAt). auditor APPROVE, review round 1 CLEAN, final 4413 pass / 0 fail.
- **Decisions**: Merit-ranked the 3 plannable specified issues; dispatched CAM-284 as highest-merit (updatedAt pairs with just-shipped createdAt, higher leverage than CAM-277 doc and CAM-280 cleanup). Spec-only participation held: no plan_approval=operator; trusted the deterministic auditor+reviewer CLEAN; auto-ship (CAM-191) fired on its own. Used cam plan 284 (bare number, real renderStateFile writer). Zero orchestrator intervention this cycle.
- **Blockers encountered**: None. Review round 1 CLEAN. PR #225 landed BEHIND; merge-watch ran gh pr update-branch (1/2), merged ci-gated; post-merge clean, polled via gh pr view only (CAM-228 held), tag v0.150.0. Standing caveat unchanged: sidecar pid 32211 predates v0.144.0 suggestions-pen redirect (old terminal-verdict hook); this cycle's CLEAN review carried 2 SUGGESTIONs auto-filed as CAM-297/CAM-298, idea count 32 -> 34.
- **Follow-ups**: Rebuild + clean cam run restart to >= v0.144.0 to activate the suggestions pen (operator ceremony) and then triage accumulated auto-filed SUGGESTIONs (CAM-288..298). Remaining plannable specified: re-derive live; standing merit order after CAM-284 is CAM-277 (orch_context_window doc), then CAM-280 (vestigial writeFile cleanup).

## CAM-277 — CAM-277 — Document [loop] keys in project.toml

- **Started**: 2026-07-12T22:20:00Z
- **Closed**: 2026-07-12T22:40:00Z
- **Branch**: cam/issue-277
- **Issue**: CAM-277
- **Outcome**: shipped
- **Summary**: 1-story PRD (PR #226, v0.151.0, ci-gated). US-001 added discoverability comments for orch_context_window, meta_loop, and worker_isolation in cam-cli's own scripts/cam/project.toml [loop] section: an operator-facing doc-accuracy fix. auditor APPROVE, review round 1 CLEAN with zero findings, 4413 pass / 0 fail.
- **Decisions**: Merit-ranked the 2 plannable specified issues and dispatched CAM-277 top: operator-facing config-key doc accuracy outranks CAM-280 (internal vestigial-field dead-code cleanup); merit not effort. Spec-only participation held: no plan_approval=operator; trusted the deterministic auditor+reviewer CLEAN; auto-ship (CAM-191) fired on its own. Used cam plan 277 (bare number, real renderStateFile writer). Zero orchestrator intervention this cycle.
- **Blockers encountered**: None. Review round 1 CLEAN with zero findings and zero SUGGESTIONs, so the old sidecar filed nothing new (idea count steady at 34). PR #226 merged ci-gated; post-merge clean, polled via gh pr view only (CAM-228 held), tag v0.151.0.
- **Follow-ups**: Rebuild + clean cam run restart to >= v0.144.0 to activate the suggestions pen (operator ceremony), then triage accumulated auto-filed SUGGESTIONs (CAM-288..298). Remaining plannable specified: CAM-280 (vestigial writeFile cleanup) is the sole one left; dispatch next. After that the specified queue is empty and the 34 idea issues need spec/triage before they become plannable.

## CAM-280 — CAM-280 — Drop vestigial writeFile? field from on-main issue-mutation writers

- **Started**: 2026-07-12T22:45:00Z
- **Closed**: 2026-07-12T23:05:00Z
- **Branch**: cam/issue-280
- **Issue**: CAM-280
- **Outcome**: shipped
- **Summary**: 1-story PRD (PR #227, v0.152.0, ci-gated). US-001 (type chore) dropped the vestigial writeFile? option field from all five on-main issue-mutation writer interfaces (incl DemoteIssueOnMainOptions) and removed three obsolete test injections. auditor APPROVE, review round 1 CLEAN, 4413 pass / 0 fail, check:all spine green. Zero orchestrator intervention.
- **Decisions**: Dispatched CAM-280 as the sole plannable specified issue left (nothing to merit-rank against). Spec-only participation held: no plan_approval=operator; trusted the deterministic auditor+reviewer CLEAN; auto-ship (CAM-191) fired on its own. Used cam plan 280 (bare number, real renderStateFile writer, CAM-282 lesson). Closed after 1 PR per the one-PR-per-session invariant.
- **Blockers encountered**: None. PR #227 landed BEHIND; merge-watch ran gh pr update-branch (1/2), merged ci-gated; post-merge clean, polled via gh pr view only (CAM-228 held), tag v0.152.0. Standing caveat unchanged: sidecar pid 32211 predates the v0.144.0 suggestions-pen redirect (old terminal-verdict hook); this cycle's CLEAN review carried 1 SUGGESTION auto-filed as CAM-299, idea count 34 -> 35.
- **Follow-ups**: The specified queue is now EMPTY (specified 0, planned 0, plannable []) -- all 35 remaining are stage:idea and need /cam-spec or triage before they become plannable, so there is no auto-dispatch target next boot. Recommend to the operator: (1) rebuild + clean cam run restart to >= v0.144.0 to activate the suggestions pen and stop stage:idea pollution; (2) a /cam-spec pass to deep-spec a high-merit idea into stage:specified; (3) triage accumulated auto-filed SUGGESTIONs (CAM-288..299).

## config-orch-context-window-500k — Raise orch_context_window to 500k (backstop 400k)

- **Started**: 2026-07-13T12:20:06Z
- **Closed**: 2026-07-13T12:20:06Z
- **Branch**: cam/raise-orch-context-window
- **Issue**: none (operator-directed config)
- **Outcome**: shipped
- **Summary**: Uncommented and raised orch_context_window in scripts/cam/project.toml [loop] from the 200k default to 500000. The context-backstop fires at occupancy > orch_context_window * 0.8 (context-window.ts:52-57), so the trip point moves from >160k to >400k tokens, giving the long-lived orchestrator a much longer session before self-handoff+respawn. Shipped via PR #228 merged admin-bypass squash (config-only diff, no runtime code, CI cannot be affected). Landed on main as 17102497.
- **Decisions**: Config-only value change, merit-ranked as operator-directed and shipped via explanatory PR rather than a silent direct-main commit. Admin-bypass merge is justified because the diff carries zero runtime code. Precondition stated in the PR: valid only because the orch model's real context window is >= 500k (operator confirmed); on a 200k-context model the 400k threshold would be unreachable and the CAM-23 graceful self-handoff would never fire. Handoff routed to the journal (not the ephemeral .cam-orch-handoff.json) because a manual cam stop + cam run is a cold boot that deletes any lingering handoff as stale (run.ts:385-392); only the SIGTERM-watcher respawn path rehydrates via CAM_ORCH_REHYDRATE.
- **Blockers encountered**: None.
- **Follow-ups**: Effect timing: orch_context_window is captured at watcher startup (orch-recycle-watch.ts:636-637), not per-tick, so 500k takes effect on the NEXT clean cam run, not the session that shipped it. Operator will rebuild + reinstall the binary, then cam stop + cam run to activate it. Backlog state for the fresh session: derive live via cam issue list; at close it was all stage:idea with specified=0 and planned=0 and plannable empty, so there is NO auto-dispatch target and no active PRD. To reopen the autonomous loop the fresh session must /cam-spec a high-merit idea (idea -> specified) or triage first. Drop the stale prior-handoff caveats: operator confirmed the sidecar is already updated and the accumulated SUGGESTIONs have already been triaged, so do not re-recommend the suggestions-pen ceremony or suggestion triage.

## CAM-288 — CAM-288 — Fire orphan implement-blocked-marker sweep at plan-phase dispatch (mid-session)

- **Started**: 2026-07-13T12:53:00Z
- **Closed**: 2026-07-13T13:05:00Z
- **Branch**: cam/issue-288
- **Issue**: CAM-288
- **Outcome**: shipped
- **Summary**: 1-story PRD (PR #229, v0.153.0, ci-gated). US-001 added a second call site for sweepOrphanedImplementBlockedMarker at plan-preflight start (inside makeProductionPlanPhaseFn's closure), so an implement-blocked marker orphaned mid-session (operator ships/abandons its issue and dispatches a different one without a sidecar reboot) is swept on the next cam plan dispatch, not only at process boot. Pure sweep function untouched; new wiring test added; read-only-on-main invariant preserved. auditor APPROVE, review round 1 CLEAN, 4415 pass / 0 fail, check:all spine green.
- **Decisions**: First PR of an operator-directed batch drain of the 4 KEEP suggestion-derived specified issues (CAM-288/297/294/290), one PR per session by WSJF rank. CAM-288 topped WSJF (6.5): small jobSize, high risk-reduction (a stale marker misleads both the boot-surface and the auto-chain circuit-breaker at loop.ts:2198). Scope held to preflight-start only (the exact orphaning trigger), NOT an idle-tick sweep. Spec-only participation: no plan_approval=operator; trusted deterministic auditor+reviewer CLEAN; auto-ship (CAM-191) fired on its own. Used cam plan 288 (real renderStateFile writer, lesson CAM-282). Worker raised sidecar.ts file-size ceiling 2920->2941 itself with dated _ref (expected ship-hygiene).
- **Blockers encountered**: None. PR #229 landed BEHIND; merge-watch ran gh pr update-branch (1/2), merged ci-gated once ci went green; post-merge clean (polled via gh pr view only, lesson CAM-228), tag v0.153.0, no post-merge-stalled marker. Confirmed sidecar >= v0.144.0: the CLEAN review penned 1 non-blocking SUGGESTION into suggestions.jsonl rather than auto-filing it.
- **Follow-ups**: Batch not yet drained: specified queue still has CAM-290/294/297 (re-derive live). Fresh session continues one PR per session by WSJF: next-ranked is CAM-297 (6) then CAM-294 (5) then CAM-290 (1.5, approach A atomic combine, high jobSize). At end of batch, triage the penned SUGGESTION via cam suggestions list.

## CAM-297 — Guard close among the e.g. mutations in US-002 doc list

- **Started**: 2026-07-13T13:20:00Z
- **Closed**: 2026-07-13T13:40:00Z
- **Branch**: cam/issue-297
- **Issue**: CAM-297
- **Outcome**: shipped
- **Summary**: 1-story PRD (PR #230, v0.154.0, ci-gated). US-001 addressed CAM-297: the US-002 documentation list enumerated the e.g. mutations that should be guarded but omitted close, leaving the doc inconsistent with the actual guarded-mutation set. Fix aligned the listed mutations with the enforced set. auditor APPROVE, review round 1 CLEAN, typecheck ok, 4416 pass / 0 fail, check:all spine green.
- **Decisions**: Second PR of the operator-directed batch drain of the KEEP suggestion-derived specified issues, one PR per session by WSJF rank. CAM-297 ranked 6 (after CAM-288 at 6.5, shipped last session). Spec-only participation held: no plan_approval=operator; trusted deterministic auditor + reviewer CLEAN; auto-ship (CAM-191) fired on its own. Used cam plan 297 (bare number, real CLI writer, lesson CAM-282).
- **Blockers encountered**: None. PR #230 armed ci-gated (ci-container passed fast, ci pending), merged once ci went green; post-merge clean, polled via gh pr view / gh api only (lesson CAM-228, no git-fetch-poll), tag v0.154.0 created, no post-merge-stalled marker.
- **Follow-ups**: Batch not yet drained: specified queue still holds CAM-294 (WSJF 5) then CAM-290 (WSJF 1.5, approach A atomic commit-tree combine, high jobSize) -- re-derive live. Fresh session continues one PR per session. At end of batch, triage any penned SUGGESTIONs via cam suggestions list.

## CAM-294 — CAM-294 — Alias dated model id in cam claude help example

- **Started**: 2026-07-13T13:50:00Z
- **Closed**: 2026-07-13T14:00:25Z
- **Branch**: cam/issue-294
- **Issue**: CAM-294
- **Outcome**: shipped
- **Summary**: 1-story PRD (PR #231, v0.155.0, ci-gated). US-001 addressed CAM-294: the cam claude help example still showed a dated model id (--model claude-opus-4-5...); the fix swapped it to the stable opus alias so the help text no longer bit-rots against model-id churn. auditor APPROVE, review round 1 CLEAN, typecheck ok, 4416 pass / 0 fail, check:all spine (lint/file-size/debt-markers/coverage/dead-code/dup/ci-parity) all green.
- **Decisions**: Third PR of the operator-directed batch drain of the KEEP suggestion-derived specified issues, one PR per session by WSJF rank. CAM-294 ranked 5 (after CAM-288 at 6.5 and CAM-297 at 6, both shipped prior sessions). Spec-only participation held: no plan_approval=operator; trusted deterministic auditor + reviewer CLEAN; auto-ship (CAM-191) fired on its own. Used cam plan 294 (bare number, real CLI writer, lesson CAM-282).
- **Blockers encountered**: None. PR #231 armed ci-gated (auto-merge queued, PR stayed OPEN until CI went green), merged once ci passed; merge-watch ran post-merge, polled via gh pr view / gh api only (lesson CAM-228, no git-fetch-poll), tag v0.155.0 created, no post-merge-stalled marker.
- **Follow-ups**: Batch nearly drained: specified queue now holds ONLY CAM-290 (WSJF 1.5, approach A atomic commit-tree combine, high jobSize). Fresh session continues one PR per session: dispatch cam plan 290. Once CAM-290 ships the specified queue is EMPTY -- then triage any penned SUGGESTIONs via cam suggestions list; the rest of the backlog is all stage:idea needing /cam-spec before it becomes plannable.

## CAM-290 — promoteSuggestionOnMain atomic single on-main commit

- **Started**: 2026-07-13T14:10:00Z
- **Closed**: 2026-07-13T14:42:00Z
- **Branch**: cam/issue-290
- **Issue**: CAM-290
- **Outcome**: shipped
- **Summary**: 2-story PRD (PR #232, v0.156.0, ci-gated). Addressed CAM-290: promoteSuggestionOnMain did two independent on-main commits (issue file, then pen-line removal), leaving a window where a crash between them orphaned state. Approach (A): a single atomic commit-tree combining the issue-file write and the pen-line removal, refactoring id-allocation into one CAS loop. US-001/US-002 both DONE: typecheck ok, 4420 pass / 0 fail; auditor APPROVE; review round 1 CLEAN; check:all spine green.
- **Decisions**: Fourth and final PR of the operator-directed WSJF batch drain of the KEEP suggestion-derived specified issues (CAM-288 6.5, CAM-297 6, CAM-294 5, CAM-290 1.5). Spec-only participation held: no plan_approval=operator; trusted deterministic auditor + reviewer CLEAN; auto-ship (CAM-191) fired on its own. Used cam plan 290 (bare number, real CLI writer, lesson CAM-282). End-of-batch pen triage on engineering merit: promoted edf746712550 -> CAM-300 (real latent CAS-retry clobber), dismissed 1fae2050cefc (test-only double-cast, backlog noise).
- **Blockers encountered**: None. PR #232 landed BEHIND; merge-watch ran gh pr update-branch (attempt 1/2), merged once CI went green; post-merge clean (polled via gh pr view only, lesson CAM-228, no git-fetch-poll), tag v0.156.0 created, no post-merge-stalled marker.
- **Follow-ups**: Batch fully drained: specified queue now EMPTY (specified=0, planned=0). Suggestions pen empty. Remaining backlog is all stage:idea (re-derive live), including the freshly-filed CAM-300. To reopen the autonomous loop a fresh session must /cam-spec a high-merit idea (idea -> specified) before any cam plan dispatch; host isolation means no auto-dispatch.

## CAM-63 — CAM-63 harden supervisor<->worker boundary (contract test + actor-ACL + empty-push gate)

- **Started**: 2026-07-13T15:00:00Z
- **Closed**: 2026-07-13T16:20:00Z
- **Branch**: cam/issue-63
- **Issue**: CAM-63
- **Outcome**: shipped
- **Summary**: 6-story PRD (PR #233, v0.157.0, ci-gated). Hardened the supervisor<->worker boundary in three items: US-001 an orchestrator-surface contract test pinning the protocol shape (send-keys text+Enter without -l, worker-report.json shape, CAM_*_STATUS regex, @cam_label lifecycle) via the existing in-memory fake; US-002/US-003/US-005/US-006 the actor-ACL: supervisor becomes the SOLE writer of story passes:true and re-runs its own gates (typecheck+bun test) per story before flipping (independent oracle, generalizing finalizeStory across pass+incomplete), the worker loses prd.json write authority via the allowlist hook, and the implementer prompt stops instructing the flip; US-004 an empty-push ahead_by>=1 gate (git rev-list --count origin/main..HEAD) on the pass path, degrading to blocked at 0 and exempting requires:operator stories. typecheck ok, 4456 pass / 0 fail; check:all spine green.
- **Decisions**: First PR of an operator-directed Tier 1 batch drain (sequential autonomous, 1 PR/session -- parallel would need CAM-147). Grill decisions: kept all 3 items in one PRD; actor-ACL variant A-i (supervisor sole-writer + independent per-story gate re-run), rejected A-ii (gate on reviewer CLEAN, reorders the loop) and the weak trust-worker-report variant; empty-push gate skips operator stories (parity with commitExistsForStory; planner no longer emits operator stories). type=fix, WSJF 2.8. Contract test scoped here; single-source schema/zod validator split to CAM-301 to run next in sequence. ADR written: supervisor-sole-writer-of-passes with independent per-story gate re-run. Spec-only participation held: no plan_approval=operator; trusted deterministic auditor + reviewer CLEAN; auto-ship fired on its own.
- **Blockers encountered**: Review round 1 FIXES_PENDING:1 -- a doc-sync WARNING: CLAUDE.md step 8 (both scripts/cam/ and templates/ copies) still said the worker flips passes:true, contradicting the new sole-writer convention and would be denied by the new US-006 hook. Fix story US-R1-001 first BLOCKED (the new US-003 supervisor gate re-run caught a red test, likely a dual-copy/embed miss, lesson CAM-123) then completed green; review round 2 CLEAN. PR #233 landed BEHIND; merge-watch ran gh pr update-branch (1/2), merged once CI went green; post-merge clean (polled via gh pr view only, lesson CAM-228), tag v0.157.0, no post-merge-stalled marker.
- **Follow-ups**: Batch continues (sequential): next CAM-166, then CAM-61, then CAM-135, then CAM-301 (the CAM-63 schema follow-up). Each needs its own /cam-spec grill at session top. Suggestions pen holds 1 item: 210695ef5f7d (dedup aheadByForBranch/commitExistsForStory scaffolding in host.ts -- low value, likely dismiss on merit).

## CAM-166 — harden worker-vs-orchestrator control-plane boundary (deny worker Write to issues/ + hand-file-as-oracle)

- **Started**: 2026-07-13T22:30:00Z
- **Closed**: 2026-07-13T23:30:00Z
- **Branch**: cam/issue-166
- **Issue**: CAM-166
- **Outcome**: shipped
- **Summary**: 2-story PRD (PR #234, v0.158.0, ci-gated). Closed the CAM-162 add/add collision class on two layers. US-001 (mechanical): extend the CAM_WORKER-gated worker Write-deny in .claude/hooks/orch-agent-allowlist.sh to also block the whole scripts/cam/issues/ dir (not just scripts/cam/prd.json), converting the single hard-coded suffix check into a small structured deny-set across all 3 synced hook copies (.claude/hooks/, templates/, src/vendor/_generated.ts embed) plus tests. US-002 (process): planner rule in subagent-planner.md that a hand-file-via-/cam-issue requirement is encoded as an on-main file-assert oracle acceptance criterion (verified by the reviewer's existing behavioral gate), never a worker implementation story; no new reviewer machinery. Both stories DONE first pass (typecheck ok, 4459 pass / 0 fail each), review round 1 CLEAN.
- **Decisions**: Second PR of the operator Tier 1 batch drain (sequential autonomous, 1 PR/session). Grill: scope = BOTH layers (issue lists both; they defend different layers), not either-or. (a) structured deny-set over prd.json + issues/, block the whole issues/ dir since the CAM-162 collision was an ADD there; keep 3 hook copies identical (dual-copy per-file, CAM-123). (b) prompt/doc guidance only, no brittle planner-output unit test; reuse the existing file-assert oracle path, no new reviewer code. type=fix, WSJF 3.33. ADR 0036 written: worker actor mechanically denied Write to cam control-plane state; hand-file requirement is an on-main oracle, never a worker story. New terms: control-plane state, worker-actor marker (CAM_WORKER), hand-file oracle. Spec-only participation; auto-ship fired on its own.
- **Blockers encountered**: None. Plan converged first pass, both stories green first pass, review CLEAN round 1, zero SUGGESTIONs. PR #234 merged once CI (ci + ci-container) went green (polled via gh pr view only, CAM-228); post-merge clean, tag v0.158.0, no post-merge-stalled marker.
- **Follow-ups**: Batch drain continues (sequential): next CAM-61 (doc-as-code gate + golden fixtures), then CAM-135 (dead-code gate noUnusedLocals/Params), then CAM-301 (shared schema/zod validator, the CAM-63 follow-up). Each needs its own /cam-spec grill at session top. Housekeeping: a STALE .cam-implement-blocked.json for issue 63 lingers (transient CAM-63 round-1 leftover; #63 shipped, dispatch-gated so it won't self-clear) -- surface as stale, do not delete, not a real blocker.

## CAM-61 — doc-as-code gate (validate-agents-md) as check:all gate #12 + COMMANDS/gate-count freezes

- **Started**: 2026-07-14T02:40:00Z
- **Closed**: 2026-07-14T12:35:00Z
- **Branch**: cam/issue-61
- **Issue**: CAM-61
- **Outcome**: shipped
- **Summary**: 3-story PRD (PR #235, v0.159.0, ci-gated). Split the 3-item issue: CAM-61 = items 1+2 (new scripts/validate-agents-md.ts doc-as-code checker validating cam-cmd/bun-run/backtick-path claims in root+scripts/cam CLAUDE.md and .claude/agents/*.md, wired as check:all gate #12 with a check:agents alias; plus a COMMANDS count+membership freeze and the gate-count freezes bumped 11->12). Item 3 (golden-fixtures) split to CAM-302. type=chore, WSJF 2.33, ADR-0037 (heuristic + KNOWN_MISSING allowlist over explicit annotation).
- **Decisions**: Robust tracked-tree resolution (git ls-files + auto-exempt gitignored as declared-ephemeral) chosen over per-file allowlist churn, on merit (reviewer-endorsed). Recovery: git reset to pre-ship commit to restore prd.json (ship-finalize had consumed it) + force-push; manual /cam-review fed CI ground-truth so the reviewer reliably caught the determinism CRITICAL; fix stories hand-written via the /cam-review Step 5.4 sanctioned path; verified on a git WORKTREE (not git archive, which strips .git and breaks git ls-files) simulating the shipped tree.
- **Blockers encountered**: Initial auto-ship went ci-red: the gate resolved path-claims against the LIVE working tree (green locally where runtime ephemerals linger, red on CI clean checkout). Recurred THREE times, each a subtler instance a prior review missed: (1) bare-filename allowlist not matching full-path citations, (2) all other runtime ephemerals, (3) ship-finalize git-rm's scripts/cam/handoff.json (cited full-path, not gitignored, only bare-allowlisted) -> fails on the SHIPPED tree specifically. Fixed over review rounds 2-3 + US-R2-001/002. Post-merge driven MANUALLY: the re-ship's ship-phase ended pr-create-failed (benign: PR #235 already existed) so the sidecar never armed a merge-watch; I ran gh pr update-branch (BEHIND) -> armed auto-merge fired on green CI -> manual cam issue close + git tag v0.159.0 + branch prune.

## CAM-304 — validate-agents-md fail-loud git-failure guard

- **Started**: 2026-07-15T01:41:00Z
- **Closed**: 2026-07-15T02:20:00Z
- **Branch**: cam/issue-304
- **Issue**: CAM-304
- **Outcome**: shipped
- **Summary**: 1-story PRD (PR #236, v0.160.0, ci-gated). Hardened the CAM-61 doc-as-code gate #12: makeGetTrackedFiles now throws on a git ls-files spawn status!=0 (instead of silently returning an empty tracked set and reding the gate with false path-missing findings), and makeIsIgnored throws on git check-ignore exit 128 while preserving 0=ignored / 1=not-ignored. Fail-loud hardening / defense-in-depth (not a live bug: the only caller runs inside the repo). typecheck ok, 4522 pass / 0 fail; auditor APPROVE; review CLEAN round 1; check:all spine green.
- **Decisions**: First PR of the WSJF-ranked drain of the specified queue (1 PR/session), dispatched via `cam plan 304` on a manually-restarted standalone 0.159.0 sidecar (pid 35473; the prior 0.152.0 sidecar was stale). Scope sha256sum-style: validate-agents-md.ts only; sibling ratchet-diff.ts same-smell left as an out-of-scope note. Spec-only participation held: no plan_approval=operator; trusted deterministic auditor + reviewer CLEAN; auto-ship fired on its own.
- **Blockers encountered**: None. PR #236 landed BEHIND; merge-watch ran gh pr update-branch (attempt 1/2), merged once CI (ci + ci-container) went green; post-merge clean (polled via gh pr view only, lesson CAM-228), tag v0.160.0, no post-merge-stalled marker. The implementer additionally fixed a pre-existing unrelated flaky test (check-agent-frontmatter-standalone.test.ts) per no-flaky-evasion rather than evading it; reviewer vetted CLEAN.
- **Follow-ups**: Session grilled+specced 8 issues (CAM-135/301/300/304/302/209/62/305) and abandoned CAM-303 (ci-container premise false). Penned SUGGESTION promoted -> CAM-306 (Bun-first spawnSync alignment, low priority). Drain continues next session by WSJF: CAM-209 (4.5) next, then CAM-300/135/301/62/302, with CAM-305 after CAM-62 (blockedBy). Re-derive live via cam issue list.

## CAM-209 — harden worker Dockerfile Node tarball download (SHASUMS256 sha256 verify + curl --retry, fail-closed)

- **Started**: 2026-07-15T02:40:00Z
- **Closed**: 2026-07-15T03:05:00Z
- **Branch**: cam/issue-209
- **Issue**: CAM-209
- **Outcome**: shipped
- **Summary**: 1-story PRD (PR #237, v0.161.0, ci-gated). US-001: the worker .devcontainer Dockerfile now verifies the downloaded Node.js tarball sha256 against the official SHASUMS256.txt and adds curl --retry, failing closed on mismatch. Fully autonomous single PR this session. typecheck ok, 4522 pass / 0 fail; auditor APPROVE; review CLEAN round 1 (zero fix rounds); check:all spine green. The implementer additionally validated in-container (rebuilt the image via the new Dockerfile, 4494 pass in-container), the correct verification for a Dockerfile change.
- **Decisions**: Second PR of the WSJF-ranked drain of the specified queue (1 PR/session). Dockerfile-only diff, so no rebuild needed: the installed 0.159.0 standalone sidecar stays loop-coherent with main. Spec-only participation held: no plan_approval=operator; trusted deterministic auditor + reviewer CLEAN; auto-ship fired on its own. Standalone sidecar had died since last session and was relaunched (pid 36519).
- **Blockers encountered**: First plan attempt hit a preflight clean-tree failure because the sidecar relaunch nohup log (.claude/.cam-sidecar-standalone.log) was untracked and dirtied the tree. Removed the untracked log (sidecar kept running on the unlinked-inode fd) and re-issued cam plan 209, which converged and cleared the preflight marker. Lesson recorded in handoff: launch the sidecar with output to /tmp, not into the repo tree. PR #237 landed BEHIND; merge-watch ran gh pr update-branch (1/2), merged on green CI, post-merge clean (polled via gh pr view only, CAM-228), tag v0.161.0, no post-merge-stalled marker.
- **Follow-ups**: Drain continues next session by WSJF: CAM-300 next (real latent CAS-retry clobber, touches supervisor code so REBUILD + restart sidecar before dispatch), then CAM-135, CAM-301, CAM-62, CAM-302; CAM-305 stays after CAM-62 (blockedBy). Penned SUGGESTION a2e7658aa736 dismissed on merit (pipeline already fail-closed; speculative). Re-derive backlog live via cam issue list.

## CAM-300 — CAM-300 — per-attempt content recompute in CAS pen writers (no concurrent-clobber)

- **Started**: 2026-07-15T05:19:00Z
- **Closed**: 2026-07-15T05:55:00Z
- **Branch**: cam/issue-300
- **Issue**: CAM-300
- **Outcome**: shipped
- **Summary**: 2-story PRD (PR #238, v0.162.0, ci-gated). Made the on-main CAS commit-tree writers re-derive whole-file content per attempt so the three suggestions-pen writers (append/dismiss/promote) never clobber a concurrent pen edit that advanced main under them: US-001 added per-attempt content recompute to the CAS commit-tree writers (4526 pass); US-002 routed append/dismiss/promote pen writers through the per-attempt recompute (4529 pass). Fully autonomous single PR. typecheck ok, 4529 pass / 0 fail; auditor APPROVE; review CLEAN round 1 (zero fix rounds); check:all spine green.
- **Decisions**: Third PR of the WSJF-ranked drain of the specified queue (1 PR/session). CAM-300 touches supervisor/suggestions code, so before dispatch rebuilt the installed binary (scripts/build-release.sh --install -> v0.161.0) and restarted the standalone sidecar (killed 36519, relaunched 93413 with /tmp log output, aligned .cam-sidecar.pid) to restore loop-binary-branch coherence. Spec-only participation held: no plan_approval=operator; trusted deterministic auditor + reviewer CLEAN; auto-ship fired on its own.
- **Blockers encountered**: None. PR #238 landed BEHIND; merge-watch ran gh pr update-branch (attempt 1/2), merged once CI went green; post-merge clean (polled via pushed lines only, no git-fetch-poll per CAM-228), tag v0.162.0, no post-merge-stalled marker.
- **Follow-ups**: Penned SUGGESTION 45c1e2e379c9 (cache the happy-path first git-show read for attempt 0) DISMISSED on merit: the per-attempt uniform recompute IS the anti-clobber invariant CAM-300 established; special-casing attempt 0 reintroduces attempt-indexed branching for a negligible one-subprocess saving (Simplicity First). Drain continues next session by WSJF: CAM-135 next, then CAM-301, CAM-62, CAM-302; CAM-305 stays after CAM-62 (blockedBy). NOTE: main is now v0.162.0 but installed binary + sidecar 93413 are 0.161.0 (one loop-version behind) -- rebuild + restart the standalone sidecar before the next dispatch. Re-derive backlog live via cam issue list.

## CAM-135 — Dead-code gate: noUnusedLocals + noUnusedParameters

- **Started**: 2026-07-15T06:20:00Z
- **Closed**: 2026-07-15T06:45:00Z
- **Branch**: cam/issue-135
- **Issue**: CAM-135
- **Outcome**: shipped
- **Summary**: 4-story PRD (PR #239, v0.163.0, ci-gated). Enable noUnusedLocals + noUnusedParameters in tsconfig so dead locals/params/imports are caught at Layer A (typecheck) instead of burning review rounds. US-001 cleaned src/ + scripts/; US-002 cleaned test/supervisor+test/release+test/integration; US-003 cleaned remaining test/**; US-004 flipped the two compiler flags on -- typecheck stayed green (4529 pass / 0 fail), proving the three cleanup passes were exhaustive (68 pre-existing violations removed). Auditor APPROVE at plan time; review CLEAN round 1 (zero fix rounds); check:all spine green.
- **Decisions**: Fourth PR of the WSJF-ranked drain of the specified queue (1 PR/session). Binary coherence: boot found installed binary + sidecar at 0.161.0 while main was v0.162.0 (one loop-version behind from CAM-300), so before dispatch rebuilt via scripts/build-release.sh --install (-> v0.162.0) and restarted the standalone sidecar (killed 93413, relaunched 89249 with /tmp log output, aligned .cam-sidecar.pid). Spec-only participation held: no plan_approval=operator; trusted deterministic auditor + reviewer CLEAN; auto-ship fired on its own.
- **Blockers encountered**: None. PR #239 landed BEHIND; merge-watch ran gh pr update-branch (attempt 1/2), merged once CI went green; post-merge clean (narrated via pushed lines only, no git-fetch-poll per CAM-228), tag v0.163.0 on merge commit c189f670, no post-merge-stalled marker.
- **Follow-ups**: Penned SUGGESTION a0dc5d8afda7 DISMISSED on merit: self-negating (No action required -- an observation that one comment tidy was slightly beyond pure removal, which the reviewer itself deemed fine and in-scope); no latent bug. Drain continues next session by WSJF: CAM-301 next (shared schema/zod validator single-source-of-truth), then CAM-62, then CAM-302; CAM-305 stays after CAM-62 (blockedBy). NOTE: main is now v0.163.0 but installed binary + sidecar 89249 are 0.162.0 (one loop-version behind) -- rebuild + restart the standalone sidecar before the next dispatch. Re-derive backlog live via cam issue list.

## CAM-301 — CAM-301 — Shared hand-rolled report-parse module as single source of truth

- **Started**: 2026-07-15T07:00:00Z
- **Closed**: 2026-07-15T07:40:00Z
- **Branch**: cam/issue-301
- **Issue**: CAM-301
- **Outcome**: shipped
- **Summary**: 4-story PRD (PR #240, v0.164.0, ci-gated). Consolidated four scattered ad-hoc worker/review report guards into one shared hand-rolled fail-closed parse module as the single runtime source of truth; design recorded in ADR-0038 (hand-rolled TS guard, NOT zod/JSON-schema, per sentinel-parse-fragility precedent). US-001 added src/supervisor/report-parse.ts exporting parseWorkerReport + parseReviewReport (fail-closed T|null, never throws) and relaxed WorkerReport optional fields; US-002 routed worker-report readers in host.ts+loop.ts through parseWorkerReport; US-003 routed result.ts sites through it and deleted WorkerReportFallback; US-004 routed review-report readers in host.ts+review.ts through parseReviewReport. typecheck ok, 4549 pass / 0 fail every story; auditor APPROVE; review CLEAN round 1 (zero fix rounds).
- **Decisions**: Fifth PR of the WSJF-ranked drain of the specified queue (1 PR/session). Binary coherence: boot found installed binary + sidecar at v0.162.0 while main was v0.163.0 (one loop-version behind CAM-135), so before dispatch rebuilt via scripts/build-release.sh --install (-> v0.163.0) and restarted the standalone sidecar (killed 89249, relaunched 8809 with /tmp log output, aligned .cam-sidecar.pid). Spec-only participation held: no plan_approval=operator; trusted deterministic auditor + reviewer CLEAN; auto-ship fired on its own.
- **Blockers encountered**: None. PR #240 landed BEHIND; merge-watch ran gh pr update-branch (attempt 1/2), merged once CI went green; post-merge clean (narrated via pushed lines only, no git-fetch-poll per CAM-228), tag v0.164.0 on merge commit 42aa10e9, no post-merge-stalled marker.
- **Follow-ups**: Penned 2 SUGGESTIONs. cc600805390c (poll-exit re-serializes an already-parsed WorkerReport per iteration) DISMISSED on merit: uniform route-through-parser IS the CAM-301 single-source invariant; a pre-parsed fast-path overload reintroduces the branching the consolidation removed for a negligible saving (Simplicity First). f6a7e4ec50a3 (US-003 AC1 oracle `grep -Lq` is self-contradictory, `-q` overrides `-L`, false-BLOCK waiting to happen) PROMOTED -> filed CAM-306 (real latent defect in the deterministic oracle-authoring convention; fix `! grep -q`). Drain continues next session by WSJF: CAM-62 next (test-quality enforced in reviewer), then CAM-302; CAM-305 stays after CAM-62 (blockedBy). CAM-306 is idea-stage, not in the drain-ready queue. NOTE: main is now v0.164.0 but installed binary + sidecar 8809 are v0.163.0 (one loop-version behind) -- rebuild + restart the standalone sidecar before the next dispatch. Re-derive backlog live via cam issue list.

## CAM-62 — Test-quality enforced in the reviewer (extends CAM-52)

- **Started**: 2026-07-15T11:00:00Z
- **Closed**: 2026-07-15T11:35:00Z
- **Branch**: cam/issue-62
- **Issue**: CAM-62
- **Outcome**: shipped
- **Summary**: 4-story PRD (PR #241, v0.165.0, ci-gated). Codified empirically-learned test-quality rules into the reviewer Layer B rubric plus a durable convention and the waitForCondition helper it points to. US-001 added a waitForCondition poll-until-true test helper; US-002 added test-quality rubric guidance (nuanced anti-mock, adversarial-cases, per-test discipline) to the cam reviewer agent (.claude copy); US-003 mirrored the rubric into the generic reviewer template and re-embedded; US-004 added a durable test-quality convention to cam knowledge files pointing to the helper. Fully autonomous single PR. typecheck ok, 4552 pass / 0 fail every story; auditor APPROVE at plan time; review CLEAN round 1 (zero fix rounds); check:all spine green.
- **Decisions**: Sixth PR of the WSJF-ranked drain of the specified queue (1 PR/session). Binary coherence: boot found installed binary + sidecar 8809 at v0.163.0 while main was v0.164.0 (one loop-version behind CAM-301), so before dispatch rebuilt via scripts/build-release.sh --install (-> v0.164.0) and restarted the standalone sidecar (killed 8809, relaunched 92648 with /tmp log output, aligned .cam-sidecar.pid). Spec-only participation held: no plan_approval=operator; trusted deterministic auditor + reviewer CLEAN; auto-ship fired on its own.
- **Blockers encountered**: None. PR #241 landed BEHIND; merge-watch ran gh pr update-branch (attempt 1/2), merged once CI went green; post-merge clean (narrated via pushed lines only, no git-fetch-poll per CAM-228), tag v0.165.0 on merge commit cfcf1b2e, close commit 01ce68c5, no post-merge-stalled marker.
- **Follow-ups**: Penned 1 SUGGESTION 3e0eb00945b8 (waitForCondition default timeoutMs=5000 matches Bun's default per-test timeout, so a defaults caller with a slow condition would race Bun's timeout instead of the helper's clear message) DISMISSED on merit: the story scopes callers to short explicit values in the integration tier so the 5000 default is never reached by any current caller; only a hypothetical future defaults-caller is affected (speculative ergonomics, Simplicity First). CAM-305 became UNBLOCKED this session when CAM-62 shipped (blockedBy cleared). Drain continues next session by WSJF: CAM-302 next (golden-fixtures for CAM_*_STATUS sentinel + handoff), then CAM-305 (deterministic check-test-sleeps gate). CAM-306 stays idea-stage, not in the drain-ready queue. NOTE: main is now v0.165.0 but installed binary + sidecar 92648 are v0.164.0 (one loop-version behind) -- rebuild + restart the standalone sidecar before the next dispatch. Re-derive backlog live via cam issue list.

## CAM-302 — CAM-302 — Golden-fixtures for CAM_*_STATUS sentinel + handoff

- **Started**: 2026-07-15T11:37:00Z
- **Closed**: 2026-07-15T12:15:00Z
- **Branch**: cam/issue-302
- **Issue**: CAM-302
- **Outcome**: shipped
- **Summary**: 4-story PRD (PR #242, v0.166.0, ci-gated). Established a golden-fixture record/replay convention (test/fixtures/golden/) pinning the fragile CAM_*_STATUS sentinel, review-tag, transcript-usage, and self-authored-artifact parse targets. US-001 created the golden dir + sentinel/review-tag replay tests; US-002 added a transcript-usage golden fixture + replay against the usage parser; US-003 added self-authored-artifact shape-pin fixtures + replay (incl a hand-rolled draft-07-subset JSON-schema validator importing the real schema for drift-sensitivity); US-004 added an on-demand record-golden harness + record:golden alias + patterns bullet. Fully autonomous single PR. typecheck ok, 4552->4577 pass / 0 fail across stories; auditor APPROVE at plan time; review CLEAN round 1 (zero fix rounds); check:all spine green.
- **Decisions**: Seventh PR of the WSJF-ranked drain of the specified queue (1 PR/session). Binary coherence: boot found installed binary + sidecar 92648 at v0.164.0 while main was v0.165.0 (one loop-version behind CAM-62), and CAM-302 is loop-adjacent (sentinel/handoff parse targets), so before dispatch rebuilt via scripts/build-release.sh --install (-> v0.165.0) and restarted the standalone sidecar (killed 92648, relaunched 13109 with /tmp log output, aligned .cam-sidecar.pid). Spec-only participation held: no plan_approval=operator; trusted deterministic auditor + reviewer CLEAN; auto-ship fired on its own.
- **Blockers encountered**: None. PR #242 landed BEHIND; merge-watch ran gh pr update-branch (attempt 1/2), merged once CI went green; post-merge clean (narrated via pushed lines only, no git-fetch-poll per CAM-228), tag v0.166.0 on merge commit a99fd193, close commit 2fd97b5c, no post-merge-stalled marker.
- **Follow-ups**: Penned 1 SUGGESTION c1775b303ec5 (extract the ~40-line hand-rolled JSON-schema validator to a shared test helper IF a second test ever needs it) DISMISSED on merit: speculative DRY for a single current use-site, no latent bug; premature extraction violates Simplicity First. Drain continues next session by WSJF: CAM-305 next (deterministic check-test-sleeps gate; treat as loop-adjacent, rebuild before dispatch). After CAM-305 the specified queue is empty -- remaining backlog is all idea-stage (needs /cam-spec grilling, human-in-the-loop). CAM-306 stays idea-stage, not in the drain-ready queue. NOTE: main is now v0.166.0 but installed binary + sidecar 13109 are v0.165.0 (one loop-version behind) -- rebuild + restart the standalone sidecar before the next dispatch. Re-derive backlog live via cam issue list.

## CAM-305 — Deterministic check-test-sleeps gate (gate #13)

- **Started**: 2026-07-15T12:47:00Z
- **Closed**: 2026-07-15T13:20:00Z
- **Branch**: cam/issue-305
- **Issue**: CAM-305
- **Outcome**: shipped
- **Summary**: 7-story PRD (PR #243, v0.167.0, ci-gated). Deterministic check-test-sleeps check:all gate (#13) banning fixed timed-sleep async waits in tests, plus migration of all 68 existing sites to the waitForCondition helper. US-001 scanner core + unit tests; US-002..005 migrated integration groups A-D; US-006 migrated the unit tier + suppressed the flush-ink macrotask yield; US-007 wired the gate + bumped the two gate-count freeze tests. typecheck ok, 4593 pass / 0 fail at close; auditor APPROVE at plan time; review CLEAN round 1 (zero fix rounds).
- **Decisions**: WSJF drain pick (the last specified issue; unblocked when CAM-62 shipped). Binary coherence: boot found installed binary + sidecar at v0.165.0 while main was v0.166.0, and CAM-305 is check-spine-adjacent, so rebuilt via scripts/build-release.sh --install (-> v0.166.0) and restarted the standalone sidecar before dispatch. Spec-only participation held.
- **Blockers encountered**: None.
- **Follow-ups**: Penned 2 SUGGESTIONs, both DISMISSED on merit: 02220fdfc1d0 (single-line scanner could be evaded by a multi-line promisified sleep -- speculative hardening of a lint heuristic, no defect) and 5299dd361f6b (US-006 patterns.md bullet used em-dash vs siblings -- pre-existing trivial style nit).

## CAM-307 — Fix silent issue-blob truncation in readBacklogFromMain (maxBuffer + fail-closed)

- **Started**: 2026-07-15T13:30:00Z
- **Closed**: 2026-07-15T14:35:00Z
- **Branch**: cam/issue-307
- **Issue**: CAM-307
- **Outcome**: shipped
- **Summary**: Single-story PRD (PR #244, v0.168.0, ci-gated). P0 data-integrity fix: readBacklogFromMain (src/issues/backlog.ts) read all issue blobs via one git cat-file --batch with NO maxBuffer, so once the combined stdout exceeded node spawnSync default 1MiB it returned ENOBUFS + a TRUNCATED buffer that the code parsed without checking result.error, silently dropping the highest-id issues. This blinded both cam issue list (under-reported backlog) and allocateId (max-on-main+1 re-minted an in-use id and clobbered files); cam suggestions promote shared the same allocator. Fix: pass an ample maxBuffer (added to BacklogSpawnFn type too) AND fail-closed on the spawn error (throw, never parse a truncated buffer). auditor APPROVE; review CLEAN round 1; typecheck ok, 4597 pass / 0 fail.
- **Decisions**: Discovered while filing the dashboard cosmetic issue: cam issue --file-local re-minted CAM-306 a third time (after two prior suggestions-promote collisions), clobbering the grep-Lq issue. Explore root-caused the 1MiB spawnSync truncation and PROVED the authorized hand-place-CAM-0307 bypass non-viable (cam plan resolves the target via the SAME truncated readBacklogFromMain, both CLI validation and sidecar dispatch; no per-file reader in compiled code). Bootstrapped instead by purging 38 abandoned issues (commit f39c1f69, pushed; abandoned = excluded from all views, git-recoverable) to shrink the blob below 1MiB so the allocator worked, then filed CAM-307 via cam issue --file-local --fast-track (specified/operator, wsjf 5/5/5/2) and drove the normal plan->ship. After merge, rebuilt installed binary + standalone sidecar to v0.168.0 so both carry the fix. Operator authorized the purge-A approach explicitly.
- **Blockers encountered**: The broken allocator was a chicken-and-egg (could not file the fix issue without the allocator, which needed the fix). Resolved by the abandoned-purge bootstrap rather than a source hotfix or a hand-placed file.
- **Follow-ups**: Restored the 2 clobbered issues faithfully as new issues: CAM-308 (Bun-first alignment nit, node child_process spawnSync -> Bun.spawnSync in check-* gate helpers, from CAM-304 fp 2197b006eae8) and CAM-309 (PRD-authoring convention: self-contradictory grep -Lq absence oracle -> ! grep -q, from CAM-301 fp f6a7e4ec50a3). CAM-306 keeps the dashboard-Loop Ink-repaint-ghosting content (cosmetic). NEXT SESSION: operator directive to spec ALL idea-stage issues via /cam-spec (interactive grill, human-in-the-loop) in priority order (nits/conventions -> medium features -> epics), then resume the WSJF drain. Speccing is token-heavy: spec a batch then cycle-close. Re-derive the idea list live via cam issue list.

## SPEC-NITS-2026-07-15 — Spec batch: nit/convention tier (5 issues specified, queue refilled 0->5)

- **Started**: 2026-07-15T14:45:00Z
- **Closed**: 2026-07-15T15:30:00Z
- **Branch**: main
- **Issue**: CAM-308, CAM-309, CAM-219, CAM-169, CAM-306 (+ CAM-310 filed)
- **Outcome**: specified
- **Summary**: Spec-only session (no PR). Refilled the empty plannable queue by speccing the whole nit/convention tier via interactive /cam-spec grills, each grounded with an Explore fan-out first. CAM-308: migrate the 4 node:child_process spawnSync sites in the 3 check:all gate-helpers to Bun.spawnSync, retype the injectable seam Bun-native, preserve exit-code/decoding/fail-closed fidelity. CAM-309: codify the absence-oracle convention (! grep -q, never grep -Lq) in the planner Oracle Contract + auditor accept-criteria-health check (both cam+template, re-embed, drift test), general grep -q+-L/-l class detection. CAM-219: add --plan-approval operator to the build-release.sh:114 hermetic init smoke to kill the false-positive Resend warning (harness-side, reject product-side suppression). CAM-169: faithful carry-over of 11 off-convention orch-recycle-watch tests into the canonical test/commands file, zero coverage loss, no dedup. CAM-306: dashboard Loop-ghost on tmux reflow, width-change-detected clear on the poll path.
- **Decisions**: CAM-308 scope held to the 3 gate-helpers (principled cohesion, not effort); other scripts/ node-spawnSync left as optional sibling. CAM-309 chose planner+auditor agent-prose over a deterministic static linter, filing the linter as CAM-310. CAM-306 verification: recommended deterministic test + a requires:operator real-tmux visual ceremony ON MERIT, but operator chose deterministic-test-only for full autonomy (visual becomes an informal post-ship eyeball). Binary+sidecar coherent at v0.168.0; no rebuild needed (speccing does not dispatch the sidecar).
- **Follow-ups**: Operator directive: on the fresh session, CONTINUE speccing (medium-feature tier next, epics last), do NOT pivot to draining yet. The 5 nits are ready to drain whenever the operator pivots. Re-derive the idea list live via cam issue list; never re-spec a stage:specified issue.

## SPEC-MED-2026-07-15 — Spec batch: medium-feature tier (1 OBE-closed, 3 specified incl 1 ADR)

- **Started**: 2026-07-15T20:30:00Z
- **Closed**: 2026-07-15T21:15:00Z
- **Branch**: main
- **Issue**: CAM-65, CAM-218, CAM-146, CAM-310
- **Outcome**: specified
- **Summary**: Spec-only session (no PR), continuing the operator-directed drain-prep from the nit tier into the medium-feature tier. CAM-65 CLOSED as OBE (subsumed: CAM-57 teardownWorkerPaneFn already kill-panes the worker at every terminal exit -> 2-pane mutex-idle, and CAM-80 shipped deterministic worker-pane geometry; both stated benefits delivered, per-story kill+recreate rejected as churn). Specified 3, each grounded with an Explore fan-out first: CAM-218 (feat 4/2/2/3 resend_from plumbing through 7 sendEscalation sites + [notify] fields in the cam config flat wizard; cam init dropped on architectural-correctness grounds; API key status-only). CAM-146 (chore 3/1/2/4 rename grill->spec surface vocab; specSource enum grill->interview, skill dir grill-with-docs->spec-with-docs+embed, living docs; vendored /grilling + /domain-modeling stay; 0 issue files carry explicit specSource grill; ADRs/journal/CHANGELOG untouched). CAM-310 (feat 4/1/4/4 deterministic PRD-oracle shell linter in plan-runner BEFORE the auditor, folded into the audit-BLOCK re-plan loop, grep -q+-L/-l rule behind an extensible rules list; ADR db8a113 written). Specified queue 5->8.
- **Decisions**: Recommend-on-merit held every fork: CAM-218 init-exclusion was scope-correctness not effort; CAM-146 enum interview over tautological spec, hard rename with no dead legacy branch (0 data), no new ADR (reversible); CAM-310 fail-closed-before-auditor + reuse the existing re-plan machinery + defer the em-dash oracle class. Only CAM-310 cleared the 3 ADR gates. Blast-radius drift reconfirmed as a hard rule: CAM-146 2026-06-30 filed blast radius was materially stale (cam-plan.md + agent files now 0 grill refs, new code surfaces appeared): always re-measure with Explore before speccing a pre-analyzed idea.
- **Blockers encountered**: None.
- **Follow-ups**: Operator directive stands: continue /cam-spec on the remaining medium tier (plan-runner gates cluster, config tabbed-UI, token analysis: verify live) then epics last; do NOT pivot to draining yet. The 8 specified issues are drain-ready. Some ideas may be OBE: verify with Explore and cam issue close rather than spec (did so for CAM-65). Re-derive the backlog live via cam issue list; never re-spec a stage:specified issue. Sidecar/binary coherence only matters at drain time.

## SPEC-CAM153-BOOTSTRAP-2026-07-15 — Spec CAM-153 gates cluster + root-cause ENOBUFS filing block; grant orchestrator Edit to bootstrap the fix

- **Started**: 2026-07-15T21:30:00Z
- **Closed**: 2026-07-15T22:30:00Z
- **Branch**: main
- **Issue**: CAM-153
- **Outcome**: specified
- **Summary**: Continued the operator-directed /cam-spec drain-prep into the medium-feature tier. Re-measured CAM-153 (CAM-117 Half B/B-2, plan-runner gates cluster) live with an Explore fan-out: of its 5 items, item 3 (BLOCK to re-plan loop) already shipped v0.73.0, item 4 (plan_approval=operator full-PRD gate) is a partial dead-end, items 1/2/5 absent. Operator chose the full launch-ready cluster. Grilled and SPECIFIED CAM-153 scoped to the keystone: a generic operator-decision gate primitive (.claude/.cam-gate.json = gate/options/context/decision, distinct from the flat loop-file frontmatter) plus a new cam decide return-channel plus item 5 (in-progress-work conflict gate, continue/ship/abandon). Wrote an ADR for the file-based gate primitive. Split item 4 to a separate derived idea issue blockedBy CAM-153. While filing item 4, hit a P1 bug: cam issue --file-local throws ENOBUFS.
- **Decisions**: CAM-153 gate lives in a dedicated durable file, single-source decision, sidecar polls/validates/executes/clears/flips; new verb cam decide (not overloading the existing cam resume interrupt-recovery); generic shape reused by CAM-149 ship-pauses and CAM-139 drainer kill-switch. Operator granted the orchestrator the Edit tool (frontmatter change) to bootstrap a fix the loop cannot self-perform, a deliberate scoped departure from the read-only-orchestrator design (Edit for rare bootstrap escape-hatches only, never inline feature/test implementation).
- **Blockers encountered**: ENOBUFS root cause: CAM-307 raised readBacklogFromMain maxBuffer to 256MiB and made it fail-closed, but three production SpawnFn wrappers (index.ts:2179 file-local/allocator BLOCKING, sidecar.ts:2627 suggestions-promote, index.ts:2350 triage) rebuild the spawnSync options with only encoding/env/input/stdio and drop maxBuffer, so on the current ~1.01MiB / 272-file blob it falls back to the node 1MiB default and throws. 0 abandoned issues so the CAM-307 purge-bootstrap is unavailable; cam issue list, cam spec, and the drain path are unaffected. Fix is the { ...opts, stdio: pipe } spread.
- **Follow-ups**: Fresh session (with Edit) applies the minimal index.ts:2179 spread fix, rebuilds via scripts/build-release.sh --install, verifies file-local no longer throws, files the maxBuffer-fix hardening issue (drafts in /tmp/hardening-issue.json, wsjf 4/4/5/2, type fix) and the item-4 derived idea (/tmp/item4-issue.json), specs the hardening issue with a regression test covering file-local + suggestions-promote above a 1MiB blob and a SpawnFn-type hardening, then reverts the bootstrap edit so main stays clean and the hardening PR carries the full fix + test through the loop. After the bootstrap, resume the standing directive: continue /cam-spec drain-prep on the idea tier (medium features CAM-87/CAM-136 then epics), one at a time, Explore-remeasure blast radius before each grill, do not pivot to draining yet.

## BOOTSTRAP-ENOBUFS-2026-07-15 — Bootstrap the ENOBUFS filing unblock, file + spec the real fix (CAM-311) and the CAM-153 item-4 split (CAM-312)

- **Started**: 2026-07-15T22:45:00Z
- **Closed**: 2026-07-15T23:15:00Z
- **Branch**: main
- **Issue**: CAM-311, CAM-312
- **Outcome**: specified
- **Summary**: Rehydrated from the prior cycle-close to execute the pre-authorized bootstrap of the ENOBUFS filing block. Confirmed the bug live with no drift: the createLocalIssueOnMain spawnFn wrapper (index.ts) rebuilds spawnSync options field-by-field and drops maxBuffer, so readBacklogFromMain falls back to the node 1 MiB default and throws on the ~1.01 MiB / 272-file blob, blocking all issue filing. Applied the one-line spread fix to a throwaway local binary (scripts/build-release.sh --install, hermetic smoke), verified filing works, filed CAM-311 (the real fix) and CAM-312 (item-4 split), specified CAM-311 with a full structured spec, then reverted the source edit so main stays clean and CAM-311 carries the complete fix plus regression test through the loop. The installed binary retains only the file-local fix.
- **Decisions**: Bootstrap kept minimal (single spread fix, source reverted): the local binary is a throwaway unblock, the loop delivers the audited fix. CAM-311 spec acceptance: forward maxBuffer at every field-rebuilding SpawnFn wrapper, type-harden the SpawnFn options surface so maxBuffer cannot be silently dropped again, add a >1 MiB behavioral regression test covering file-local and suggestions-promote, and audit every remaining readBacklogFromMain consumer. CAM-311 write-docs was a valid empty noOp (no new domain term or ADR).
- **Blockers encountered**: CRITICAL discovery beyond the documented 3-site scope: cam issue demote also throws ENOBUFS via readBacklogFromMain, so cam issue close/abandon almost certainly do too; the demote/close/abandon on-main wrappers share the maxBuffer drop and were NOT fixed by the local bootstrap binary (only file-local was). CAM-311's audit-all-consumers criterion covers it, but the implementer must fix these lifecycle-command wrappers explicitly. This also blocked the intended CAM-312 demote-to-idea, so CAM-312 stayed stage:specified with an EMPTY blockedBy (the --derived-from flag auto-promoted it to specified and did not set blockedBy:[CAM-153]); its low WSJF plus operator-controlled drain order guard against a premature pick before CAM-153, and the dependency will be recorded once demote/close is fixed or by re-persisting CAM-312.
- **Follow-ups**: Loose end for operator decision: the orchestrator Edit grant is uncommitted on main (.claude/ + templates/ subagent-orchestrator.md); keep it permanently and track/commit it, or revert to restore the read-only invariant now the bootstrap is done. Recommend draining CAM-311 soon (P1, blast radius now includes core issue-lifecycle commands). Standing directive stands: resume /cam-spec drain-prep on the idea tier one at a time, Explore-remeasure blast radius before each grill, recommend on merit, do not pivot to draining yet; re-derive the backlog live via cam issue list.

## DRAIN-CAM311-2026-07-16 — Drain CAM-311 (P1 ENOBUFS root fix) end-to-end; spec CAM-87 + CAM-136

- **Started**: 2026-07-16T02:50:00Z
- **Closed**: 2026-07-16T03:30:00Z
- **Branch**: cam/issue-311
- **Issue**: CAM-311
- **Outcome**: shipped
- **Summary**: Rehydrated from the prior cycle-close, then drained CAM-311 (the P1 ENOBUFS root fix) end to end: plan generated a 3-story PRD (auditor APPROVE), the loop implemented US-001/002/003 (typecheck ok, 4603 pass), review returned CLEAN round 1, and ship opened PR #245 (ci-gated) which merged squash (main 002f68b), tagged v0.169.0, pruned the branch, and the issue was closed stage:shipped. The fix forwards maxBuffer at all four field-by-field spawnSync wrappers feeding readBacklogFromMain (file-local, triage, suggestions-promote, and the previously-missed post-merge close/abandon/demote path) via one shared spread-forwarding helper, plus >1 MiB behavioral regression tests. Earlier in the same session specified CAM-87 (tabbed config UI + per-phase effort selector) and CAM-136 (tokens-per-issue report + plan-time split advisory), and reverted the orchestrator Edit-grant to restore the read-only invariant.
- **Decisions**: CAM-87 scoped effort to the 5 LLM phases (orchestrator/planner/auditor/reviewer default xhigh, implementer high), ship excluded on merit (deterministic, zero-LLM, ADR-0009) with its vestigial models.ship knob deferred to a separate follow-up; the model selector already ships so only tabs+effort are net-new. CAM-136 recut on merit to a retrospective report plus a non-gating plan-time split advisory keyed on WSJF jobSize, dropping the full statistical correlation because cam's small issue history makes it low-signal; ~40% of the original issue was already OBE. Edit-grant reverted to restore read-only-orchestrator.
- **Blockers encountered**: meta_loop=auto auto-advanced plan to ship with no manual gate: the go/no-go pause raced and lost (the PR was created before the phase:idle pause took), and the post-merge auto-close stalled SILENTLY because it ran on the stale v0.168.0 binary whose close path still carried the ENOBUFS bug, writing no post-merge-stalled marker. Recovered via the documented fallback: rebuild to v0.169.0 (build-release.sh --install, hermetic smoke) then cam issue close CAM-311; main stayed coherent with origin.
- **Follow-ups**: CRITICAL for next session: the running sidecar (pid 51656) is still v0.168.0 with the broken close path and MUST be restarted to v0.169.0 BEFORE the next drain, else the next ship's post-merge close stalls identically. Standing operator directive: drain all specified issues in WSJF order, one PR per session. Open: (1) meta-gate preference (full-auto vs meta_loop=observe for a real ship gate), left full-auto; (2) CAM-312 blockedBy is still empty and can now be set to [CAM-153] since demote/close is fixed.

## DRAIN-CAM218-2026-07-16 — Drain CAM-218 (custom Resend sender + notify config) end-to-end; boot sidecar recovery + preflight false-positive root-cause

- **Started**: 2026-07-16T04:00:00Z
- **Closed**: 2026-07-16T04:35:00Z
- **Branch**: cam/issue-218
- **Issue**: CAM-218, CAM-313
- **Outcome**: shipped
- **Summary**: Rehydrated from the prior cycle-close and drained CAM-218 (configurable Resend sender resend_from + non-secret [notify] fields in the config wizard) end to end: plan produced a 4-story PRD (auditor APPROVE), the loop implemented US-001..004 (typecheck ok, 4613 pass), review returned CLEAN round 1, and ship opened PR #246 (ci-gated). The PR was BEHIND after CAM-313 landed on main, so merge-watch ran gh pr update-branch (attempt 1/2), self-healed, and merged squash (main 4d19113); tagged v0.170.0, pruned the branch, closed CAM-218. The post-merge auto-close SUCCEEDED cleanly on the v0.169.0 sidecar, the payoff of the boot sidecar-restart (CAM-311 close had silently stalled on the stale v0.168.0 last session).
- **Decisions**: Boot sidecar recovery: the handoff feared a stale v0.168.0 sidecar (pid 51656) but that process was DEAD (nothing driving the loop); launched a standalone detached v0.169.0 sidecar (pid 84016, survives orchestrator respawns) instead of cam stop+cam run (which would cold-boot and lose rehydrate context), and hand-fixed .cam-sidecar.pid to the live pid. Dismissed reviewer SUGGESTION 2067e08031d3 (US-002 bundled a beneficial but out-of-scope test-hardening) as a non-actionable surgical-scope nit on already-merged code.
- **Blockers encountered**: First cam plan preflight failed bun-test with 2 fail / 4601 pass (orch-recycle-watch.test.ts:223 respawn race + interactivity.test.ts Test 5 runInit 5000ms timeout). Root-caused as a load-intermittent false-positive, NOT flaky-evaded: both pass in isolation and passed CI on the CAM-311 merge, and a quiet-machine full-suite re-run gave 4603 pass / 0 fail in 54s vs the failing run's 116s. Filed CAM-313 (fix, WSJF 2/2/3/2) to harden the 2 fragile tests to waitForCondition/generous timeouts, then retried plan on the quiet machine and it passed.
- **Follow-ups**: CAM-313 (harden the 2 preflight-fragile e2e tests) awaits drain at its natural WSJF priority; until then, a plan preflight can false-positive under load, so re-run the suite quiet to confirm intermittency before retrying, never blind-retry. Standing operator directive: drain all specified in WSJF order, one PR per session. Open: (1) meta-gate preference (full-auto vs meta_loop=observe for a real ship gate), left full-auto; (2) CAM-312 blockedBy still empty, should be [CAM-153]. Coherence: main is v0.170.0 but the running sidecar + installed binary are v0.169.0; fine for dispatch since CAM-218 did not touch the supervisor, rebuild only if the next issue touches loop/notify internals.

## DRAIN-CAM309-2026-07-16 — Drain CAM-309 (PRD-authoring oracle-idiom convention) end-to-end

- **Started**: 2026-07-16T04:50:00Z
- **Closed**: 2026-07-16T05:15:00Z
- **Branch**: cam/issue-309
- **Issue**: CAM-309
- **Outcome**: shipped
- **Summary**: Rehydrated from the prior cycle-close and drained CAM-309 (replace the self-contradictory grep -Lq absence oracle with ! grep -q in PRD acceptance-criteria authoring) end to end. Dispatched cam plan bare; WSJF self-selected CAM-309. Plan produced a 2-story PRD (auditor APPROVE): US-001 codified the absence/presence oracle idiom on the planner Oracle Contract, US-002 made the auditor BLOCK on the -q + -L/-l antipattern, in both cam-project and embedded template copies. The loop auto-advanced: implement US-001 (4614 pass) + US-002 (4615 pass), review CLEAN round 1, ship PR #247 (ci-gated). The PR went BEHIND, merge-watch ran gh pr update-branch (attempt 1/2), self-healed, and merged squash (main c992225); post-merge completed on the v0.169.0 sidecar: tag v0.171.0, branch pruned, CAM-309 closed stage:shipped, no stall markers.
- **Decisions**: Boot coherence call: main was v0.170.0 with the sidecar+binary at v0.169.0; judged CAM-309 blast radius as planner/auditor agent instructions + templates (convention consumed by future PRD runs), NOT supervisor/dispatch/ship/plan-runner control flow the current-drain sidecar executes, so no rebuild. Confirmed correct: ship and post-merge auto-close ran clean. Reusable rule recorded in the handoff: rebuild only when the selected issue changes orchestration/ship/plan-runner mechanics (e.g. CAM-153); pure agent/template/config features are coherence-safe on a one-minor-behind sidecar. Dismissed reviewer SUGGESTION 9edd49f0a7b7 (worker appended a new resolution bullet to patterns.md despite US-001 do-not-touch note): the reviewer itself flagged it as additive and consistent with cam knowledge-routing convention, a literal-note deviation with a correct already-merged outcome, so non-actionable.
- **Blockers encountered**: None. The PR-BEHIND state self-healed via merge-watch update-branch; no preflight false-positive fired this cycle.
- **Follow-ups**: Standing operator directive: drain all specified in WSJF order, one PR per session. Open: (1) meta-gate preference (full-auto vs meta_loop=observe for a real ship gate), left full-auto after three clean drains; (2) CAM-312 blockedBy still empty, should be [CAM-153]. CAM-313 (harden the 2 preflight-fragile e2e tests) still awaits drain at its natural WSJF priority; re-run the suite quiet before retrying a failed preflight, never blind-retry. Coherence: main is v0.171.0 but the running sidecar + installed binary are v0.169.0; fine for dispatch, rebuild only if the next issue touches loop/ship/plan-runner internals.

## DRAIN-CAM219-2026-07-16 — Drain CAM-219 (build-release smoke false-positive Resend warning) end-to-end

- **Started**: 2026-07-16T11:50:00Z
- **Closed**: 2026-07-16T12:15:00Z
- **Branch**: cam/issue-219
- **Issue**: CAM-219
- **Outcome**: shipped
- **Summary**: Rehydrated from the prior cycle-close and drained CAM-219 (build-release smoke emitted a false-positive 'plan_approval is auto but Resend not configured' warning on every build). Dispatched cam plan bare; WSJF self-selected CAM-219. 1-story PRD (auditor APPROVE): US-001 added --plan-approval operator to the hermetic init smoke in build-release.sh. The loop auto-advanced: implement US-001 (4615 pass); review round 1 FIXES_PENDING:1 (CRITICAL: the one-liner was a no-op because --plan-approval was parsed into setupArgs.planApproval at setup.ts:847 but never forwarded into the runSetup calls in index.ts init/setup cases, so the interactive prompt still fired, read EOF, defaulted to auto); fix US-R1-001 forwarded planApproval into runSetup (4620 pass, +5 tests); review round 2 CLEAN; ship PR #248 (ci-gated). The PR went BEHIND, merge-watch ran gh pr update-branch (attempt 1/2), self-healed, merged squash (main 0caafb4c); post-merge completed on the v0.169.0 sidecar: tag v0.172.0, branch pruned, CAM-219 closed stage:shipped, no stall markers.
- **Decisions**: Boot coherence call: main was v0.171.0 with the sidecar+binary at v0.169.0; judged CAM-219 blast radius as build-release.sh smoke + init/setup command wiring (index.ts runSetup forwarding), NOT supervisor/dispatch/ship/plan-runner control flow the current-drain sidecar executes, so no rebuild. Confirmed correct: ship and post-merge auto-close ran clean. The review round-1 CRITICAL was a genuine root-cause catch (pre-existing wiring gap the story missed), fixed properly rather than papered over. Dismissed penned reviewer SUGGESTION 76139a0d5100 (textual-smoke asserts exactly 2 occurrences of planApproval forwarding, brittle to a hypothetical future shared-options-literal refactor): the test mirrors the blessed two-layer precedent (no-permission-mode-flag.test.ts), so acting on it in isolation would contradict the established convention; non-actionable without a separate deliberate decision to change the precedent everywhere.
- **Blockers encountered**: None. The PR-BEHIND state self-healed via merge-watch update-branch; no preflight false-positive fired this cycle.
- **Follow-ups**: Standing operator directive: drain all specified in WSJF order, one PR per session. Open: (1) meta-gate preference (full-auto vs meta_loop=observe for a real ship gate), left full-auto after four clean drains; (2) CAM-312 blockedBy still empty, should be [CAM-153]. CAM-313 (harden the 2 preflight-fragile e2e tests) still awaits drain at its natural WSJF priority; re-run the suite quiet before retrying a failed preflight, never blind-retry. Coherence: main is v0.172.0 but the running sidecar + installed binary are v0.169.0 (3 minors behind); fine for dispatch, rebuild only if the next issue touches loop/ship/plan-runner internals.

## DRAIN-CAM310-2026-07-16 — Drain CAM-310 (deterministic static PRD-oracle shell linter) end-to-end; proactive boot rebuild vindicated

- **Started**: 2026-07-16T12:30:00Z
- **Closed**: 2026-07-16T13:05:00Z
- **Branch**: cam/issue-310
- **Issue**: CAM-310
- **Outcome**: shipped
- **Summary**: Rehydrated from the prior cycle-close and drained CAM-310 (a deterministic static PRD-oracle shell linter that fails closed at plan time on the self-nullifying grep -q + -L/-l absence oracle, routing broken oracles through the existing re-plan loop before the auditor spawns). At boot the sidecar+installed binary were 3 minors behind (v0.169.0 vs main v0.172.0), so I rebuilt to v0.172.0 (build-release.sh --install, hermetic smoke clean, and the CAM-219 fix confirmed working: no false Resend warning, Plan approval: operator) and relaunched the sidecar standalone detached (old pid 84016 killed, new pid 68364 ppid 1) BEFORE dispatch. Dispatched cam plan bare; WSJF self-selected CAM-310. 2-story PRD (auditor APPROVE): US-001 built the pure linter module (named-rules scanner + PRD walk, 4640 pass), US-002 wired it into the plan-runner audit path folding findings into the re-plan loop (4662 pass). Review round 1 CLEAN. Ship PR #249 (ci-gated) went BEHIND, merge-watch ran gh pr update-branch (attempt 1/2), self-healed, merged squash (main c4b40a09); post-merge completed on the fresh v0.172.0 sidecar: v0.173.0 tagged, branch pruned, CAM-310 closed stage:shipped, no stall markers.
- **Decisions**: Proactive boot rebuild was vindicated: two top specified candidates (CAM-153, CAM-310) touch plan-runner mechanics, and WSJF picked CAM-310 whose US-002 wires the linter INTO the plan-runner audit path, so a coherent sidecar was required. Reusable refinement to the coherence rule: when the sidecar is >1 minor behind AND plan-runner-touching issues sit at the top of specified, rebuild proactively while idle (zero-risk) rather than reactively. Dismissed penned reviewer SUGGESTION 2c94d471ff9b (collectGrepFlagChars misses operand-trailing grep flags like grep 'X' -q -L file): the reviewer itself flagged it out-of-scope per US-001 enumerated forms + the deliberate 'no full shell tokenizer' note; the guarded domain (machine-authored PRD-oracle idioms) is always flags-first, so it is speculative gold-plating, dismissed on merits not effort.
- **Blockers encountered**: None. The PR-BEHIND state self-healed via merge-watch update-branch; no preflight false-positive fired this cycle.
- **Follow-ups**: Standing operator directive: drain all specified in WSJF order, one PR per session. Open: (1) meta-gate preference (full-auto vs meta_loop=observe for a real ship gate), left full-auto after six clean drains; (2) CAM-312 blockedBy still empty, should be [CAM-153]; (3) CAM-313 (harden 2 preflight-fragile e2e tests) is still IDEA-stage and must be /cam-spec'd before cam plan can self-select it. COHERENCE for next session: installed binary + running sidecar are v0.172.0 but main is v0.173.0 (= +CAM-310). Because CAM-310 is a plan-TIME linter, the v0.172.0 sidecar will not actually run it during next session's planning until rebuilt to v0.173.0 at boot; do the rebuild so the new PRD-oracle linter is active.

## DRAIN-CAM153-2026-07-16 — Drain CAM-153 (generic operator-decision gate primitive); proactive v0.173.0 boot rebuild vindicated again

- **Started**: 2026-07-16
- **Closed**: 2026-07-16
- **Branch**: cam/issue-153
- **Issue**: CAM-153
- **Outcome**: shipped
- **Summary**: Drained CAM-153 (generic operator-decision gate primitive: .cam-gate.json + `cam decide`, wired to the in-progress-work conflict gate at plan start) end-to-end. 5-story PRD, auditor APPROVE, final typecheck ok + 4734 pass / 0 fail, review round 1 CLEAN. Shipped PR #250, v0.174.0.
- **Decisions**: Proactive boot rebuild v0.172.0->v0.173.0 + sidecar relaunch before dispatch (coherence refinement); vindicated when WSJF self-selected CAM-153, a plan-runner/sidecar-gate issue. Promoted both penned SUGGESTIONs on merits (CAM-314 checkout observability, CAM-315 e2e sidecar wiring test) rather than dismissing.

## DRAIN-CAM87-2026-07-16 — Drain CAM-87 (tabbed cam config UI + per-phase effort selector) end-to-end

- **Started**: 2026-07-16T15:00:00Z
- **Closed**: 2026-07-16T15:45:00Z
- **Branch**: cam/issue-87
- **Issue**: CAM-87
- **Outcome**: shipped
- **Summary**: Rehydrated from the CAM-153 cycle-close and drained CAM-87 (redesign cam config into a tabbed UI: one tab per phase + Global, plus a per-phase effort selector with full read/write/frontmatter plumbing) end-to-end. At boot the sidecar+installed binary were 1 minor behind (v0.173.0 vs main v0.174.0), so I rebuilt proactively to v0.174.0 (build-release.sh --install, hermetic smoke clean) and relaunched the sidecar standalone detached (old pid 81259 killed, new pid 85640 ppid 1) BEFORE dispatch, because CAM-153 had added plan-start conflict-gate + sidecar gate-lifecycle mechanics the v0.173.0 sidecar did not enforce. Dispatched cam plan bare; WSJF self-selected CAM-87. 4-story PRD: US-001 effort config read/write plumbing no-UI (4750 pass), US-002 rewriteFrontmatterEffort + wire into save/agent-sync (4761 pass), US-003 TabBar chip component (4766 pass), US-004 refactor ConfigScreen to tabbed UI with per-tab model + effort (4774 pass). Review round 1 CLEAN. Ship PR #251 (ci-gated) went BEHIND, merge-watch ran gh pr update-branch (attempt 1/2), self-healed, merged squash (main dcdf641d); post-merge completed on the fresh v0.174.0 sidecar: v0.175.0 tagged, branch pruned, CAM-87 closed stage:shipped, no stall markers.
- **Decisions**: Proactive boot rebuild v0.173.0->v0.174.0 + sidecar relaunch before dispatch, per the established coherence refinement (last-shipped CAM-153 touched plan-runner + sidecar-gate mechanics). WSJF then picked CAM-87 (pure Ink UI, coherence-safe even on v0.173.0), so the rebuild was not strictly required this drain, but the rule holds. Promoted BOTH penned reviewer SUGGESTIONs on merits rather than dismissing: CAM-316 (suppress TabBar Left/Right tab-nav while a config TextInput is focused so arrows move the cursor; a real editing papercut, intended per AC5 so it is a deliberate design change to consider) and CAM-317 (rewriteFrontmatterEffort interpolates the body into a String.replace replacement so a dollar-sequence would be reinterpreted; nil risk on controlled agent frontmatter but a replacer function is the one-line root-cause fix). Both quality-within-scope, promote is reversible, neither high priority.
- **Blockers encountered**: None. The PR-BEHIND state self-healed via merge-watch update-branch; no preflight false-positive fired this cycle.
- **Follow-ups**: Standing operator directive: drain all specified in WSJF order, one PR per session. Open: (1) meta-gate preference (full-auto vs meta_loop=observe for a real ship gate), left full-auto after eight clean drains; (2) CAM-312 (plan_approval=operator full-PRD gate) is unblocked now that CAM-153 shipped, blockedBy still empty, WSJF governs the pick; (3) CAM-313 (harden 2 preflight-fragile e2e tests) plus the new CAM-316/CAM-317 are IDEA-stage and must be spec'd before cam plan can self-select them. COHERENCE for next session: installed binary + running sidecar are v0.174.0 but main is v0.175.0 (= +CAM-87). CAM-87 is pure Ink UI, so the v0.174.0 sidecar is coherence-safe for the next dispatch; rebuild to v0.175.0 only if the next WSJF pick touches loop/ship/plan-runner internals.

## DRAIN-CAM136-2026-07-16 — Drain CAM-136 (tokens-per-issue stats + plan-time split advisory) end-to-end

- **Started**: 2026-07-16T16:30:00Z
- **Closed**: 2026-07-16T17:30:00Z
- **Branch**: cam/issue-136
- **Issue**: CAM-136
- **Outcome**: shipped
- **Summary**: Rehydrated from the CAM-87 cycle-close and drained CAM-136 (tokens-per-issue analysis: mean/median per issue from the cycle-tokens stream, plus a plan-time non-gating split advisory keyed on WSJF jobSize). At boot the sidecar+installed binary were 1 minor behind (v0.174.0 vs main v0.175.0); rebuilt proactively to v0.175.0 (build-release.sh --install, hermetic smoke clean) and relaunched the sidecar standalone detached (old pid 85640 killed, new pid 63743 ppid 1) BEFORE dispatch, because several top-of-specified candidates plausibly touch loop/ship/plan-runner internals and a rebuild is zero-risk while idle. Dispatched cam plan bare; WSJF self-selected CAM-136. 4-story PRD: US-001 pure tokens-per-issue aggregation module (4792 pass), US-002 cam stats tokens command + dispatch wiring (4807 pass), US-003 split-advisory heuristic + plan-split-advisory event kind (4823 pass), US-004 emit the split advisory at plan-time non-gating (4827 pass). Review round 1 CLEAN. Ship PR #252 (ci-gated) went BEHIND, merge-watch ran gh pr update-branch (attempt 1/2), self-healed, merged squash (main 6876c2f7); post-merge completed on the fresh v0.175.0 sidecar: v0.176.0 tagged, branch pruned, CAM-136 closed stage:shipped, no stall markers.
- **Decisions**: Proactive boot rebuild v0.174.0->v0.175.0 + sidecar relaunch before dispatch. Only 1 minor behind and last-shipped CAM-87 was pure Ink UI, but WSJF's pick is not predictable pre-dispatch and several top specified candidates touch loop/plan-runner internals, so matching main first removes the guessing at zero risk; vindicated in spirit since CAM-136 US-004 emits a plan-time split advisory. Promoted penned reviewer SUGGESTION 950af7f7ce89 -> CAM-318 on merits rather than dismissing: a genuine minor DRY inconsistency the PR itself introduced (stats help handled twice, index.ts:2024), reviewer called it harmless but it is a real single-source cleanup and promote is reversible. Low priority.
- **Blockers encountered**: None. The PR-BEHIND state self-healed via merge-watch update-branch; no preflight false-positive fired this cycle.
- **Follow-ups**: Standing operator directive: drain all specified in WSJF order, one PR per session. Open: (1) meta-gate preference (full-auto vs meta_loop=observe for a real ship gate), left full-auto after ~9 clean drains; (2) CAM-312 (plan_approval=operator gate) unblocked and specified, blockedBy still empty; (3) CAM-313, CAM-316, CAM-317, and new CAM-318 (stats help DRY cleanup) are IDEA-stage and must be /cam-spec'd before cam plan can self-select them. COHERENCE for next session: installed binary + running sidecar are v0.175.0 but main is v0.176.0 (= +CAM-136). CAM-136 US-004 emits a plan-time split advisory, so the v0.175.0 sidecar will not emit it during next planning until rebuilt to v0.176.0 (advisory is non-gating, correctness unaffected); rebuild to v0.176.0 at boot to activate it or if the next pick touches loop/ship/plan-runner internals.

## DRAIN-CAM312-2026-07-16 — Drain CAM-312 (live plan_approval=operator PRD-approval gate); proactive v0.176.0 boot rebuild vindicated again

- **Started**: 2026-07-16T18:00:00Z
- **Closed**: 2026-07-16T18:45:00Z
- **Branch**: cam/issue-312
- **Issue**: CAM-312
- **Outcome**: shipped
- **Summary**: Rehydrated from the CAM-136 cycle-close and drained CAM-312 (turn the previously dead-end plan_approval=operator into a live full-audited-PRD approve/reject gate, wiring a new plan-approval discriminator + resolver onto the shipped CAM-153 operator-decision gate primitive). At boot the sidecar+installed binary were 1 minor behind (v0.175.0 vs main v0.176.0); rebuilt proactively to v0.176.0 (build-release.sh --install, hermetic smoke clean) and relaunched the sidecar standalone detached (old pid 63743 killed, new pid 25027 ppid 1) BEFORE dispatch, because top specified candidates skewed toward loop/plan-runner internals. Dispatched cam plan bare; WSJF self-selected CAM-312. 3-story PRD (auditor APPROVE): US-001 plan-approval gate module identity/context/resolver (4838 pass), US-002 wire gate write-side into plan-runner pause-operator path (4858 pass), US-003 wire production write seam + resolver into the sidecar (4852 pass, dip = test consolidation not regression). Review round 1 CLEAN. Ship PR #253 (ci-gated) went BEHIND, merge-watch ran gh pr update-branch (attempt 1/2), self-healed, merged squash (main 43e53ef1); post-merge completed on the fresh v0.176.0 sidecar: v0.177.0 tagged, branch pruned, CAM-312 closed stage:shipped, no stall markers.
- **Decisions**: Proactive boot rebuild v0.175.0->v0.176.0 + sidecar relaunch before dispatch; vindicated when WSJF picked CAM-312, a plan-runner/gate issue. Promoted penned SUGGESTION 713163004dde -> CAM-319 on merits: proceedBranchFn's swallow-all try/catch flips phase to implementing even when git branch creation fails (silent-failure/observability gap; surface the failed branch creation instead), aligns with robust-root-cause-over-silent-swallow directive; promote reversible, WSJF places it low. Resolved the CAM-312 gate-default landmine via targeted Explore: absent plan_approval key -> auto -> proceed-branch (no gate), pause fires only on exact operator (src/config/models.ts:350, src/plan/plan-approval-decision.ts:32-37), so a v0.177.0 rebuild is coherence-safe and does not introduce an accidental gate.
- **Blockers encountered**: None. The PR-BEHIND state self-healed via merge-watch update-branch; no preflight false-positive fired this cycle.
- **Follow-ups**: Standing operator directive: drain all specified in WSJF order, one PR per session. Open: (1) meta-gate preference now ACTIONABLE - CAM-312 shipped a live plan_approval=operator PRD-approval gate, so a real gate is achievable by setting plan_approval=operator in scripts/cam/project.toml (and/or meta_loop=observe/off); left full-auto (key absent -> auto) after ~10 clean drains, confirm preference with operator; (2) idea-stage CAM-313/314/315/316/317/318 and new CAM-319 must be /cam-spec'd before cam plan bare can self-select them. COHERENCE for next session: installed binary + running sidecar are v0.176.0 but main is v0.177.0 (= +CAM-312). Because our plan_approval key is absent (resolves to auto = no gate), the v0.176.0 sidecar is coherence-safe for full-auto dispatch; rebuild to v0.177.0 at boot if the next WSJF pick touches loop/ship/plan-runner internals or to stay strictly coherent.

## DRAIN-CAM146-2026-07-16 — Drain CAM-146 (grill->spec/interview vocab rename across cam-owned surface); proactive v0.177.0 boot rebuild vindicated again

- **Started**: 2026-07-16T19:00:00Z
- **Closed**: 2026-07-16T19:30:00Z
- **Branch**: cam/issue-146
- **Issue**: CAM-146
- **Outcome**: shipped
- **Summary**: Rehydrated from the CAM-312 cycle-close and drained CAM-146 (rename the 'grill' surface vocabulary to 'spec'/'interview' across all cam-owned artifacts: enum value, skill directory, living docs; preserving the vendored Matt Pocock /grilling + /domain-modeling calls verbatim). At boot the sidecar+installed binary were 1 minor behind (v0.176.0 vs main v0.177.0); rebuilt proactively to v0.177.0 (build-release.sh --install, hermetic smoke clean) and relaunched the sidecar standalone detached (old pid 25027 killed, new pid 67122 ppid 1) BEFORE dispatch, because top specified candidates skewed toward loop/plan-runner internals. Dispatched cam plan bare; WSJF self-selected CAM-146. 6-story PRD (all 4853 pass, typecheck clean): US-001 rename specSource enum grill->interview across schema+code, US-002 residual grill comments, US-003 skill dir grill-with-docs->spec-with-docs (both copies)+cam-grill->cam-spec, US-004 grill vocab in index.ts CLI strings, US-005 grill vocab in recovery-runbook+patterns.md, US-006 grill vocab in CLAUDE/README/CONTEXT. Non-gating split advisory fired (jobSize 4, 6 stories, ~27M token bucket projection) - ignored, 6 stories is under the review-strain threshold and it is advisory-only. Review round 1 CLEAN. Ship PR #254 (ci-gated) went BEHIND, merge-watch ran gh pr update-branch (attempt 1/2), self-healed, merged squash (main 33c69e84); post-merge completed on the fresh v0.177.0 sidecar: v0.178.0 tagged, branch pruned, CAM-146 closed stage:shipped, no stall markers.
- **Decisions**: Proactive boot rebuild v0.176.0->v0.177.0 + sidecar relaunch before dispatch; vindicated when WSJF picked CAM-146, a wide rename touching schema+CLI+skill-dirs. Ignored the non-gating split advisory (6 stories under the ~8-9 review-strain threshold, mostly mechanical doc/comment renames, low risk) - vindicated by CLEAN round 1. Promoted penned SUGGESTION ec6f66390639 -> CAM-320 on merits: a comment mislabels the specSource===undefined->'interview' live common path as 'back-compat', a genuine tiny doc-accuracy gap aligned with comments-go-stale discipline; outside rename ACs, promote reversible, WSJF ranks it low.
- **Blockers encountered**: None. The PR-BEHIND state self-healed via merge-watch update-branch; no preflight false-positive fired this cycle.
- **Follow-ups**: Standing operator directive: drain all specified in WSJF order, one PR per session. Open: (1) meta-gate preference still UNANSWERED (~11 clean drains) - full-auto vs plan_approval=operator (live since CAM-312) and/or meta_loop=observe/off; left full-auto (key absent -> auto). (2) idea-stage CAM-313/314/315/316/317/318/319 and new CAM-320 must be /cam-spec'd before cam plan bare can self-select them. COHERENCE for next session: installed binary + running sidecar are v0.177.0 but main is v0.178.0 (= +CAM-146). CAM-146 renamed the specSource enum value grill->interview, so the v0.177.0 binary would write a stale enum value if a cam spec runs - REBUILD to v0.178.0 at boot before any spec op and as the coherence default; the plan->implement->review->ship loop does not involve specSource so v0.177.0 is loop-safe but stale-vocab.

## DRAIN-CAM169-2026-07-16 — Drain CAM-169 (consolidate orch-recycle-watch tests); proactive v0.178.0 boot rebuild vindicated again

- **Started**: 2026-07-16T20:00:00Z
- **Closed**: 2026-07-16T20:15:00Z
- **Branch**: cam/issue-169
- **Issue**: CAM-169
- **Outcome**: shipped
- **Summary**: Rehydrated from the CAM-146 cycle-close and drained CAM-169 (consolidate the off-convention orch-recycle-watch tests into the canonical test/comm file). At boot sidecar+installed binary were 1 minor behind (v0.177.0 vs main v0.178.0); rebuilt proactively to v0.178.0 (build-release.sh --install, hermetic smoke clean, cam 0.178.0) and relaunched the sidecar standalone detached (old pid 67122 killed, new pid 95970 ppid 1) BEFORE dispatch, doubly-motivated: the CAM-146 specSource enum rename left v0.177.0 stale-vocab AND all 3 top specified candidates (CAM-169 recycle-watch tests, CAM-306 dashboard header, CAM-308 gate helpers node->bun) skew toward loop/plan-runner internals. Verified the --install did NOT clobber project.toml (no plan_approval key, tree clean). Dispatched cam plan bare; WSJF self-selected CAM-169. Single-story PRD: US-001 merged 11 off-convention orch-recycle-watch tests into the canonical file (28 total test() calls), retargeted imports, deleted the off-convention file (4853 pass, typecheck ok, check:all green). No preflight false-positive. Review round 1 CLEAN, no findings, pen empty. Ship PR #255 (ci-gated): ci check IN_PROGRESS while ci-container already SUCCESS, mergeStateStatus BLOCKED during the CI wait (normal); once ci went green auto-merge squash-merged (main b921b16a). Post-merge completed on the fresh v0.178.0 sidecar: v0.179.0 tagged, branch pruned, CAM-169 closed stage:shipped, merge-watch consumed, no stall markers.
- **Decisions**: Proactive boot rebuild v0.177.0->v0.178.0 + sidecar relaunch before dispatch, doubly-motivated (specSource enum rename + 3 loop-touching specified candidates); vindicated when WSJF picked CAM-169, a supervisor-test consolidation. Explicitly re-verified project.toml was NOT clobbered by the --install template copy (hermetic smoke prints 'Plan approval: operator' for its tmpdir default, which is NOT our project); confirmed no plan_approval key + clean tree so full-auto continues. Did NOT git-fetch-poll during CI-wait/post-merge; polled PR state via env -u GITHUB_TOKEN gh pr view 255 (API, no git lock) and read branch/tag/marker locally, per the no-gitfetch-poll-during-postmerge lesson.
- **Blockers encountered**: None. ci-gated PR sat mergeStateStatus BLOCKED while the ci check was IN_PROGRESS (normal CI-wait, not a stall); self-resolved on CI green. No preflight false-positive fired.
- **Follow-ups**: Standing operator directive: drain all specified in WSJF order, one PR per session. Open: (1) meta-gate preference still UNANSWERED (~12 clean drains) - full-auto vs plan_approval=operator (live since CAM-312) and/or meta_loop=observe/off; left full-auto (key absent -> auto). (2) idea-stage CAM-313/314/315/316/317/318/319/320 must be /cam-spec'd before cam plan bare can self-select them; only CAM-306 and CAM-308 remain stage:specified. COHERENCE for next session: installed binary + running sidecar are v0.178.0 but main is v0.179.0 (= +CAM-169). CAM-169 was PURE test consolidation (no product/schema/CLI/plan-runner change) so v0.178.0 is fully loop-safe and spec-safe; only the version string drifts. Both remaining specified (CAM-306/CAM-308) touch loop/ship internals, so rebuild to v0.179.0 at boot as the coherence default before dispatch.
