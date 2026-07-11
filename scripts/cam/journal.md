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

> Archived 17 oldest entries to scripts/cam/journal.archive.md on 2026-07-10. See that file for the full history.

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

## CAM-239 — Fix-forward: restore issue_system none as a deprecated read-normalized alias

- **Started**: 2026-07-09T09:00:00Z
- **Closed**: 2026-07-09T09:38:00Z
- **Branch**: cam/issue-239
- **Issue**: CAM-239
- **Outcome**: shipped
- **Summary**: Fix-forward for the CRITICAL regression CAM-236 shipped. CAM-236's implementation removed the legacy issue_system value none from every code path (readIssueSystem threw on none) instead of keeping it as the mandatory deprecated alias the issue body required, which breaks every already-initialized cam project on issue_system=none (init mergeIntoConfig does not rewrite an existing project.toml value) and aborted the v0.98 --install when the build-release smoke `cam init --issue-system none` exited 1. Caught by the smoke; both auditor APPROVE and reviewer CLEAN (3 rounds) on CAM-236 had missed the requirement. Filed CAM-239 via /cam-issue, specced it via /cam-spec (captured type:fix + ADR 0018), planned autonomously. Auditor APPROVE, 2/2 stories: US-001 readIssueSystem normalizes none->local (returns local, no throw; truly-unknown values still fail loud), US-002 cam init --issue-system accepts none as a deprecated alias plus the smoke stays as a permanent regression guard (+10 tests). Review CLEAN round 1. Shipped ci-gated as PR #172, tag v0.99.0. Post-ship: rebuilt+installed 0.99 (smoke `cam init --issue-system none` now passes = fix proven live), hot-swapped the sidecar 0.97->0.99 (pid 74187->42506), closed CAM-236 and CAM-239 manually with the 0.99 binary.
- **Decisions**: none is a deprecated read-normalized alias for local, not a removed value (ADR 0018): normalize at the single readIssueSystem point, keep it accepted by cam init, guard permanently via the build-release smoke + a unit test. Fix-forward over revert (operator-chosen). This closes the operator-directed branch/PR hygiene theme (CAM-234/235/236) plus its regression.
- **Blockers encountered**: none during the loop
- **Follow-ups**: Cosmetic, unfiled: PR #172 was type:fix but bumped MINOR (0.98->0.99) not patch, because classifyBump reads branch commit subjects, not the PRD type. Process note: a mandatory back-compat/alias requirement in an issue body slipped past auditor APPROVE + reviewer CLEAN and was caught only by the build-release smoke; the smoke is load-bearing acceptance.

## cam/pr-175-orch-prompt-truthup — CAM-225 shipped: truth-up orchestrator prompt (dispatch/sidecar/handoff) + boot journal tail-read

- **Started**: 2026-07-09
- **Closed**: 2026-07-09T13:55:24Z
- **Branch**: cam/issue-225
- **Issue**: CAM-225
- **Outcome**: shipped
- **Summary**: Truthed-up both orchestrator prompt copies (.claude/agents + templates/agents) plus re-embed to match the real system: full PreToolUse allowlist and reviewer-as-worker, signal-file vs send-keys dispatch (removed the nonexistent CAM_LOOP_STATUS sentinel), documented CAM_ORCH_REHYDRATE step-0, meta_loop=auto auto-plan, CAM-189 auto-filed SUGGESTIONs, switched boot journal-read to tail+grep-on-demand, and corrected handoff required-fields + close-on-ship. 4 stories, review round 1 CLEAN, PR #175 ci-gated, v0.100.0.
- **Decisions**: Prompt-only; no src runtime change beyond the embed regeneration. Both copies kept byte-identical in the body per cam-dual-copy-is-per-file. First of the operator's 11-issue context-truth-up specified chain (CAM-224/225/226/227/228/229/230/231/232/233/240).
- **Blockers encountered**: None on the ship. Auto-ship fired on its own (no CAM-191 wedge this cycle). PR #175 landed BEHIND because main advanced (Renovate #174 checkout-v7 merge + CAM-242/243/244/245 filings); sidecar merge-watch CAM-182 ran update-branch (2/2) and it merged clean.
- **Follow-ups**: Continue the chain topological by blockedBy: next unblocked specified are CAM-227/228/229. Renovate App installed this session: #174 (checkout v7) merged; #173 (bun 1.3.14) RED until CAM-245 ships (brittle literal-pin toolchain test at test/config/toolchain.test.ts). Filed CAM-243 (jscpd@5 native-Rust dup-gate pin spike), CAM-244 (container-manager automerge on container-blind macOS CI), CAM-245 (P2, unblocks Renovate toolchain automerge). Idea follow-ups needing /cam-spec: CAM-237/238/242 (242 deferred by operator).

## CAM-227 — Fix orchestrator frontmatter drift (Write in disallowedTools) + mark frontmatter advisory-only

- **Started**: 2026-07-09T14:03:17Z
- **Closed**: 2026-07-09T14:20:10Z
- **Branch**: cam/issue-227
- **Issue**: CAM-227
- **Outcome**: shipped
- **Summary**: Second issue of the operator-directed 11-issue context-truth-up specified chain (after CAM-225). The orchestrator agent frontmatter listed Write under disallowedTools while the body grants and relies on Write; the fix aligns the Write grant and marks the frontmatter enforcement as advisory-only in both copies (.claude/agents + templates/agents), then re-embeds. Single story US-001, auditor APPROVE, gates green (typecheck ok, 3956 pass / 0 fail), review CLEAN round 1 with zero findings. Shipped ci-gated as PR #176; PR landed BEHIND because main advanced (CAM-246 auto-file) and the sidecar merge-watch (CAM-182) ran gh pr update-branch and squash-merged clean. Post-merge tag v0.101.0, CAM-227 closed.
- **Decisions**: Prompt-only change; both agent copies kept body-identical per cam-dual-copy-is-per-file. At this cycle boundary the operator's no-AI-attribution rule was committed as a chore direct-to-main (commit 6f2e8c3): repo CLAUDE.md now forbids Co-Authored-By / Generated-with trailers, overriding the harness default for every claude session in the repo. Operator decided NOT to clean existing git history of the claude/cursoragent co-author contributors.
- **Blockers encountered**: none
- **Follow-ups**: CAM-246 auto-filed (idea SUGGESTION from the CLEAN review). Continue the chain topological by blockedBy: next unblocked specified are CAM-228, CAM-229, CAM-240. Renovate #173 (bun 1.3.14) stays RED until CAM-245 ships (literal-pin toolchain test). CAM-237/238/242 need /cam-spec before joining the DAG (242 deferred by operator).

## CAM-228 — Fix auditor prompt C.8/B.5 self-contradiction (browser+E2E vs F.19/F.20) for cam-cli

- **Started**: 2026-07-09T14:26:12Z
- **Closed**: 2026-07-09T14:50:00Z
- **Branch**: cam/issue-228
- **Issue**: CAM-228
- **Outcome**: shipped
- **Summary**: Third issue of the operator-directed 11-issue context-truth-up specified chain (after CAM-225, CAM-227). fix, prompt-only, single story US-001: rewrote C.8 and B.5 in .claude/agents/subagent-auditor.md ONLY, resolving the self-contradiction where C.8 required browser+E2E verification for UI stories while F.19/F.20 of the same prompt forbid browser/E2E for a terminal CLI (spurious C.8 critical -> false BLOCK -> burned re-plan -> plan-escalated). Rewrote so UI/Ink stories verify via ink-testing-library + glyph and genuine interactive ceremonies are flagged requires:operator; updated B.5 ordering from generic web (DB->server->client->tests->E2E) to cam-cli (types->core->surface->polish). Auditor APPROVE, gates green (typecheck ok, 3956 pass / 0 fail, check:all green), review CLEAN round 1. Shipped ci-gated as PR #177, tag v0.102.0.
- **Decisions**: By-design dual-copy divergence: fixed only the .claude copy; templates/agents/subagent-auditor.md stays generic web-app (C.8 browser+E2E coherent there), NO re-embed. Prompt-only, no src runtime change.
- **Blockers encountered**: Post-merge fallback required: the sidecar merge-watch merged #177 (after update-branch, PR was BEHIND) but its post-merge step failed with 'pull-failed' -- most likely because a concurrent orchestrator git-fetch poll loop contended for the repo lock. Recovered manually: FF local main, cam issue close CAM-228, created+pushed tag v0.102.0 by hand (installed cam binary is stale, cam tag mis-computed v0.99.0). New memory orch-no-gitfetch-poll-during-postmerge: poll ci-gated merges via gh pr view, never a git fetch loop.
- **Follow-ups**: CAM-247 auto-filed (idea SUGGESTION from the CLEAN review). Continue the chain: next unblocked specified are CAM-229 and CAM-240. Renovate #173 (bun 1.3.14) stays RED until CAM-245 ships. Installed cam binary is stale; a rebuild+reinstall would restore correct cam tag.

## cam/issue-229 — CAM-229 — Fix implementer Step 5.5 schema-invalid handoff example + warn-guard officialDocsValidated + cut NotebookEdit

- **Started**: 2026-07-09T15:47:03Z
- **Closed**: 2026-07-09T16:11:05Z
- **Branch**: cam/issue-229
- **Issue**: CAM-229
- **Outcome**: shipped
- **Summary**: Fourth issue of the operator-directed context-truth-up specified chain (after CAM-225, CAM-227, CAM-228). type:fix, 2 non-operator stories, 100% autonomous after the plan signal. US-001: the implementer prompt's Step 5.5 worked example emitted a schema-INVALID handoff (it showed status ok plus a `version` field the handoff.schema.json forbids); fixed the example in BOTH agent copies (.claude/agents + templates/agents), cut the unused NotebookEdit tool grant, and re-embedded. US-002: added a warn-level runtime guard for handoff.officialDocsValidated (warns, does not hard-fail). Auditor APPROVE, gates green (typecheck ok, 3968 pass / 0 fail), review CLEAN round 1 with zero findings. Shipped ci-gated as PR #178, tag v0.103.0.
- **Decisions**: Genuine dual-copy change: the implementer Step 5.5 example is shared, so both agent copies were edited and re-embedded (unlike CAM-228's by-design .claude-only divergence). Diff before assuming divergence (cam-dual-copy-is-per-file). Prompt + one small runtime guard; no other src behavior change.
- **Blockers encountered**: None during the loop. Ship: PR #178 landed BEHIND (main advanced via the CAM-248 auto-file); the sidecar merge-watch (CAM-182) ran gh pr update-branch (1/2) and squash-merged clean. Post-merge completed cleanly this cycle (pull + close CAM-229 + tag) with NO pull-failed -- no parallel git-fetch poll loop ran (lesson from CAM-228 applied).
- **Follow-ups**: CAM-248 auto-filed (idea SUGGESTION from the CLEAN review). Continue the autonomous specified chain (operator standing directive: drive to exhaustion): next unblocked specified after CAM-229 are CAM-224 (unblocked by CAM-229), CAM-230, CAM-240 -- re-derive live via cam issue list. CAM-226/231/232/233 stay blocked. Renovate #173 (bun 1.3.14) stays RED until CAM-245 ships (needs /cam-spec first).

## CAM-224 — CAM-224 — Harness diet: sidecar injects selected story + branchName into implementer spawn

- **Started**: 2026-07-09T16:17:35Z
- **Closed**: 2026-07-09T16:41:53Z
- **Branch**: cam/issue-224
- **Issue**: CAM-224
- **Outcome**: shipped
- **Summary**: Fifth issue of the operator-directed context-truth-up specified chain (after CAM-225, CAM-227, CAM-228, CAM-229). Harness diet, 2 stories, 100% autonomous after the plan signal. US-001: the sidecar now injects the selected story record + branchName into the implementer spawn prompt and decideNextAction's storyId is authoritative, removing the implementer agent's full-prd.json self-selection read (src runtime change, not prompt-only). US-002: updated scripts/cam/CLAUDE.md 'Your Task' steps to drop full-PRD self-selection to match. Auditor APPROVE, gates green (typecheck ok, 3965 pass / 0 fail), review CLEAN round 1 zero findings. Shipped ci-gated as PR #179, tag v0.104.0.
- **Decisions**: First non-prompt-only issue of this chain: touched the supervisor spawn path + decideNextAction. Loop flipped active:true straight after plan APPROVE (no manual /cam-next) and auto-shipped after the CLEAN review (CAM-191). Post-merge coherence verified read-only AFTER the sidecar completion push; no git-fetch poll ran (CAM-228 lesson applied).
- **Blockers encountered**: None. PR #179 merged via the sidecar merge-watch (ci-gated); post-merge completed cleanly (pull + close CAM-224 + tag v0.104.0) with no pull-failed.
- **Follow-ups**: CAM-249 auto-filed (idea SUGGESTION from the CLEAN review). Continue the autonomous specified chain (operator standing directive): next unblocked plannable after CAM-224 is CAM-226 (newly unblocked by CAM-224), then CAM-230, CAM-240 -- re-derive live via cam issue list. Renovate #173 (bun 1.3.14) stays RED until CAM-245 ships (needs /cam-spec first). Installed cam binary stale; rebuild+reinstall would restore correct cam tag.

## CAM-230 — CAM-230: Staleness sweep of plan-phase prompts (planner/auditor Step 7/8 + frontmatter model + cam-plan selection)

- **Started**: 2026-07-09T16:43:38Z
- **Closed**: 2026-07-09T17:07:16Z
- **Branch**: cam/issue-230
- **Issue**: CAM-230
- **Outcome**: shipped
- **Summary**: Sixth issue of the operator-directed context-truth-up specified chain (after CAM-225, CAM-227, CAM-228, CAM-229, CAM-224). Prompt-only staleness sweep of the plan-phase surface, 3 non-operator stories, 100% autonomous. US-001: aligned subagent-planner.md frontmatter model, rewrote the Step 7 description to the deterministic plan runner, and removed dead Spec Sourcing guidance (both agent copies plus re-embed). US-002: rewrote subagent-auditor.md Step 8 description to the deterministic plan runner. US-003: fixed cam-plan.md selection description to champion-vs-champion (both command copies plus re-embed). Auditor APPROVE, gates green (typecheck ok, 3965 pass / 0 fail), review CLEAN round 1 with zero findings. Shipped ci-gated as PR #180, tag v0.105.0.
- **Decisions**: Prompt-only plus re-embed (src/vendor/_generated.ts); no src runtime behavior change. Both agent/command copies edited where the text is shared, per cam-dual-copy-is-per-file. Post-merge coherence verified read-only AFTER the sidecar post-merge-done push; no git-fetch poll ran (CAM-228 lesson held).
- **Blockers encountered**: None. PR #180 landed with mergeStateStatus BLOCKED until CI green (ci-gated branch protection); the sidecar merge-watch (CAM-182) merged on green and the post-merge completed cleanly (pull plus close CAM-230 plus tag v0.105.0, branch pruned local and remote) with no pull-failed.
- **Follow-ups**: Continue the autonomous specified chain (operator standing directive: drive to exhaustion): next plannable after CAM-230 are CAM-226 and CAM-240, re-derive live via cam issue list. OBSERVED prompt-vs-reality drift to verify then possibly file via /cam-issue: the sidecar auto-dispatched CAM-230 this session even though the orchestrator prompt says host mode does not auto-dispatch on idle ticks (likely benign: CAM-226 read as still-blocked at 16:43 before CAM-224 close propagated). Renovate #173 (bun 1.3.14) stays RED until CAM-245 ships (needs /cam-spec first).

## CAM-226 — GC do patterns.md: deterministic marker-based archive mirroring cam journal archive

- **Started**: 2026-07-09T17:16:40Z
- **Closed**: 2026-07-09T17:40:00Z
- **Branch**: cam/issue-226
- **Issue**: CAM-226
- **Outcome**: shipped
- **Summary**: Seventh issue of the operator-directed context-truth-up specified chain (after CAM-225, CAM-227, CAM-228, CAM-229, CAM-224, CAM-230). First genuine src runtime change of the recent chain since CAM-224: added a deterministic marker-based GC for scripts/cam/patterns.md, 4 non-operator stories, 100% autonomous after the plan signal. US-001: new src/commands/patterns-archive.ts (archivePatternsOnMain) moving only bullets tagged [resolved YYYY-MM], on-main via commit-tree, lazy-creating patterns.archive.md, mirroring journal-archive.ts plumbing but NOT its oldest-third criterion (patterns bullets are append-only invariants, old != stale). US-002: cam patterns archive CLI wiring + help + sentinel. US-003: best-effort run on the --cycle-close path alongside journal archive (never blocks handoff). US-004: retrofit the 2026-06 build-notes markers + documented the marking convention in scripts/cam/CLAUDE.md knowledge-layer routing (both copies + re-embed). Auditor APPROVE, gates green (typecheck ok, 3995 pass / 0 fail), review CLEAN round 1 zero findings. Shipped ci-gated as PR #181, tag v0.106.0.
- **Decisions**: Marker-based selection (not position/age/count): only [resolved YYYY-MM]-tagged bullets archive; unmarked living invariants stay. Reused the on-main commit-tree plumbing from journal-archive.ts, not its selection criterion. scripts/cam/CLAUDE.md edited in both copies + re-embed (cam-dual-copy-is-per-file). Post-merge coherence verified read-only AFTER the sidecar push; no git-fetch poll ran (CAM-228 lesson held).
- **Blockers encountered**: None during the loop. Ship: PR #181 landed BEHIND (main advanced via the CAM-250 auto-file); the sidecar merge-watch (CAM-182) ran gh pr update-branch (1/2) and squash-merged on CI green. Post-merge completed cleanly (pull + close CAM-226 + tag v0.106.0) with no pull-failed.
- **Follow-ups**: CAM-250 auto-filed (idea SUGGESTION from the CLEAN review). Continue the autonomous specified chain (operator standing directive: drive to exhaustion): next plannable after CAM-226 is CAM-240; remaining specified CAM-231/232/233 may still be blocked -- re-derive live via cam issue list. Renovate #173 (bun 1.3.14) stays RED until CAM-245 ships (needs /cam-spec first). Installed cam binary stale; rebuild+reinstall would restore correct interactive cam tag.

## CAM-231 — Cross-Repo PRD docs truth-up: re-frame crossRepoLayout/per-story repo as agent-self-executed (unvalidated)

- **Started**: 2026-07-09T17:51:02Z
- **Closed**: 2026-07-09T18:06:51Z
- **Branch**: cam/issue-231
- **Issue**: CAM-231
- **Outcome**: shipped
- **Summary**: Eighth issue of the operator-directed context-truth-up specified chain (after CAM-225, CAM-227, CAM-228, CAM-229, CAM-224, CAM-230, CAM-226). CAM-231 was framed as a scope decision (cross-repo PRD: aspiracional vs implementar, zero suporte no codigo); the /cam-spec-resolved spec decided AGAINST implementing cross-repo harness support. Auditor approved a single docs-only story: US-001 re-frames the Cross-Repo PRD docs (crossRepoLayout / per-story repo) as agent-self-executed and UNVALIDATED (no harness support/validation), not harness-driven. 100% autonomous after the plan signal. Auditor APPROVE, gates green (typecheck ok, 3995 pass / 0 fail, check:all + embed-vendor clean), review CLEAN round 1 zero findings. Shipped ci-gated as PR #182, tag v0.107.0.
- **Decisions**: Scope decision AGAINST implementing cross-repo harness support: kept docs-only, no src runtime change. The stage:specified gate was trustworthy (the /cam-spec output already resolved the decision), so planning it autonomously was correct. Post-merge coherence verified read-only AFTER the sidecar push; no git-fetch poll ran during the merge window (CAM-228 lesson held).
- **Blockers encountered**: None. PR #182 landed BEHIND (main advanced via the CAM-231 close/patterns-archive on-main commits); the sidecar merge-watch (CAM-182) merged on CI green and the post-merge completed cleanly (pull + close CAM-231 + tag v0.107.0) with no pull-failed. Note: cam patterns archive ran 5 entries on the ship path (CAM-226 feature working live).
- **Follow-ups**: Continue the autonomous specified chain (operator standing directive: drive to exhaustion): next plannable after CAM-231 is CAM-232 (newly unblocked), then CAM-240; CAM-233 still blocked -- re-derive live via cam issue list. Renovate #173 (bun 1.3.14) stays RED until CAM-245 ships (needs /cam-spec first). Installed cam binary stale; rebuild+reinstall would restore interactive cam tag.

## CAM-232 — Seeds de template capados: sync de seeds stale + arquivos de template faltantes

- **Started**: 2026-07-09T18:12:00Z
- **Closed**: 2026-07-09T18:28:00Z
- **Branch**: cam/issue-232
- **Issue**: CAM-232
- **Outcome**: shipped
- **Summary**: Nono issue da cadeia de context-truth-up dirigida pelo operador (apos CAM-225, CAM-227, CAM-228, CAM-229, CAM-224, CAM-230, CAM-226, CAM-231). 2 stories non-operator, 100% autonomo apos o plan signal. US-001: sync one-time dos seeds de template stale (issues.schema spec-source + pointer no CLAUDE.md). US-002: seed dos arquivos de template faltantes (patterns.md stub + orch-handoff.schema.json) para que projetos downstream via cam init recebam config completa e correta. Auditor APPROVE, gates verdes (typecheck ok, 3997 pass / 0 fail), review CLEAN round 1 zero findings. Shipado ci-gated como PR #183, tag v0.108.0.
- **Decisions**: Escopo mantido em seed sync one-time (corrigir seeds existentes + adicionar os dois arquivos faltantes); nenhum mecanismo de deteccao continua de drift foi adicionado (fora de escopo). Planejado autonomamente: o gate stage:specified era confiavel. Coerencia post-merge verificada read-only APOS o push do sidecar; nenhum git-fetch poll rodou na janela de merge (licao CAM-228).
- **Blockers encountered**: Nenhum. PR #183 landou BLOCKED ate o CI verde (ci-gated branch protection); o merge-watch do sidecar (CAM-182) mergeou no verde e o post-merge completou limpo (pull + close CAM-232 + tag v0.108.0) sem pull-failed.
- **Follow-ups**: Continuar a cadeia specified autonoma (diretriz permanente do operador: drenar ate esvaziar): proximo plannable apos CAM-232 e CAM-233 (destravado agora), depois CAM-240 -- re-derivar live via cam issue list. Renovate #173 (bun 1.3.14) segue RED ate CAM-245 shipar (precisa /cam-spec antes). Binario cam instalado stale; rebuild+reinstall restauraria o cam tag interativo.

## CAM-233 — Sweep de higiene docs+codigo: HELP, comentarios stale, ADR banners, version-parity test

- **Started**: 2026-07-09T18:35:00Z
- **Closed**: 2026-07-09T19:05:00Z
- **Branch**: cam/issue-233
- **Issue**: CAM-233
- **Outcome**: shipped
- **Summary**: Decimo issue da cadeia de context-truth-up dirigida pelo operador (apos CAM-225, CAM-227, CAM-228, CAM-229, CAM-224, CAM-230, CAM-226, CAM-231, CAM-232). 7 stories non-operator, 100% autonomo apos o plan signal. Sweep de higiene no-behavior-change (11 correcoes de doc/comentario/dead-code dos audits de 2026-07-08) mais um teste real de version-parity. US-001 fix do HELP do cam binary (next+plan); US-002 fix do comentario em version.ts + assert de paridade package.json (o unico teste real); US-003 remove comentario stale de merge-watch + simbolo morto CAM_REVIEWER_; US-004 banners de supersessao nos ADRs 0004/0006/0008; US-005 corrige docs templated de cam-plan/cam-spec; US-006 fix da row PRD_COMPLETE do subagent-implementer + dead code; US-007 completa a tabela de comandos do README + nota CLEAN-com-SUGGESTION. Auditor APPROVE, gates verdes (typecheck ok, 3998 pass / 0 fail), review CLEAN round 1. Shipado ci-gated como PR #184, tag v0.109.0.
- **Decisions**: Escopo mantido em sweep de higiene sem mudanca de comportamento, mais exatamente um teste real de version-parity em US-002; o gate stage:specified era confiavel. PRD de 7 stories convergiu CLEAN no round 1 (abaixo do limiar de blowup de review de 8-9 stories). Coerencia post-merge verificada read-only APOS o push do sidecar; nenhum git-fetch poll rodou na janela de merge (licao CAM-228).
- **Blockers encountered**: Nenhum. PR #184 landou BEHIND (main avancou pelos auto-files CAM-251/252); o merge-watch do sidecar (CAM-182) rodou gh pr update-branch (1/2) e mergeou no CI verde. Post-merge completou limpo (pull + close CAM-233 + tag v0.109.0) sem pull-failed.
- **Follow-ups**: Continuar a cadeia specified autonoma (diretriz permanente do operador: drenar ate esvaziar): proximo e ultimo plannable e CAM-240 (Enforcar allowlist do orquestrador em runtime) -- re-derivar live via cam issue list. CAM-251 e CAM-252 auto-filados (idea SUGGESTIONs do review CLEAN). Renovate #173 (bun 1.3.14) segue RED ate CAM-245 shipar (precisa /cam-spec antes). Binario cam instalado stale; rebuild+reinstall restauraria o cam tag interativo.

## CAM-240 — CAM-240: Enforcar allowlist do orquestrador em runtime (spawn root-persona com --agent, frontmatter binding)

- **Started**: 2026-07-09T19:31:00Z
- **Closed**: 2026-07-09T20:27:55Z
- **Branch**: cam/issue-240
- **Issue**: CAM-240
- **Outcome**: shipped
- **Summary**: Undecimo e ULTIMO issue autonomamente-dirigivel da cadeia de context-truth-up do operador (apos CAM-225, CAM-227, CAM-228, CAM-229, CAM-224, CAM-230, CAM-226, CAM-231, CAM-232, CAM-233). 2 stories non-operator, 100% autonomo apos o plan signal. US-001 reconciliou o tools: list do subagent-orchestrator.md ao uso real de runtime e dobrou os boot-imperatives no corpo do agent (+re-embed). US-002 passou a spawnar o root-persona sob `claude --agent` com boot meta_loop-aware (run.ts buildOrchestratorPaneCommand/buildOrchestratorBootPrompt + testes, absorvendo CAM-196), tornando a allowlist do frontmatter RUNTIME-BINDING (antes advisory-only). Auditor APPROVE, gates verdes (US-001 3998 pass, US-002 3997 pass, 0 fail), review CLEAN round 1. Shipado ci-gated como PR #185, tag v0.110.0. Com isso a cadeia specified autonoma esta DRENADA.
- **Decisions**: CAM-240 torna a allowlist do orquestrador binding em runtime via --agent, fechando a brecha que o proprio system prompt do orquestrador declarava advisory (linhas 50-54). O codigo esta mergeado mas UNVERIFIED-IN-CI: so a cerimonia operator-only CAM-253 prova o binding --agent + Edit-denial live end-to-end (CAM-42: CI nao boota claude interativo autenticado). Tag aponta pro commit de squash-merge do PR (convencao v0.109.0->#184), logo v0.110.0->cb65742 (#185).
- **Blockers encountered**: POST-MERGE pull-failed (padrao CAM-228/CAM-174): local main divergiu 1<->1 (commit local redundante ce06866 'file CAM-253' vs squash-merge remoto cb65742). Reconciliado manualmente pelo orquestrador: git reset --hard origin/main (ce06866 totalmente redundante, CAM-0253.json ja presente em cb65742), cam issue close CAM-240 (on-main 41aef13 auto-pushado, stage->shipped), tag v0.110.0 em cb65742 pushada. Coerencia final VERIFICADA: origin/main HEAD=41aef13, CAM-240 stage:shipped, tag v0.110.0->cb65742 no remote, local==remote.
- **Follow-ups**: CADEIA SPECIFIED AUTONOMA DRENADA. Unico specified restante e CAM-253 (specSource:operator): cerimonia de live-validation do enforcement --agent do CAM-240 (AC#5), que o pipeline autonomo NAO pode dirigir (CAM-42). Precisa hand-run humano: rebuild+reinstall do binario no merge do CAM-240, cam run sob --agent, spawn de subagente, dispatch de slash command, self-handoff/rehydrate, e confirmar Edit DENIED em runtime; registrar no journal. NAO auto-dispatchar CAM-253. Renovate #173 (bun 1.3.14) segue RED ate CAM-245 shipar (precisa /cam-spec). Binario cam instalado stale (embeds pre-v0.110).

## CAM-253 — CAM-253 — Operator live-validation ceremony: CAM-240 --agent enforcement verified end-to-end

- **Started**: 2026-07-10T00:08:00Z
- **Closed**: 2026-07-10T00:16:04Z
- **Branch**: main
- **Issue**: CAM-253
- **Outcome**: verified
- **Summary**: Operator-only hand-run ceremony (specSource:operator, CAM-42: the autonomous pipeline cannot boot an authenticated interactive claude TUI, so this was UNVERIFIED-IN-CI). Split out of CAM-240 AC#5. Ran on a fresh session born from `cam stop && cam run` under the 0.110.0 installed binary (mtime post-CAM-240-merge; the prior journal 'stale binary' note was itself stale). Verified all six ACs live. AC#1 boot under --agent: orchestrator PID 99424 argv carries `--agent subagent-orchestrator` and the respawn wrapper PID 99418 uses the same shape (0.110.0). AC#2 subagent spawn: subagent-implementer spawn DENIED by the orch-agent-allowlist hook, Explore spawn ALLOWED and returned a real read-only result: allowlist enforced on both sides. AC#3 slash-command dispatch: operator ran `cam review` from an outside terminal, the thin-proxy injected /cam-review into the orchestrator pane, and it ran in-context, terminating as a correct no-op on the empty main diff (no PRD, clean tree). AC#5 Edit DENIED: the Edit tool call returned 'No such tool available' and the scratch probe file was untouched: disallowedTools is now runtime-binding under --agent (previously advisory). AC#4 self-handoff/rehydrate + AC#6 journal record: this cycle-close append writes the entry (AC#6) and arms the recycle marker, whose respawn+rehydrate via CAM_ORCH_REHYDRATE proves AC#4. CAM-240 is thus proven end-to-end in runtime; the advisory-vs-binding gap it closed is now empirically closed.
- **Decisions**: Did NOT spawn subagent-reviewer for the injected /cam-review: the main diff was empty (no PRD, clean tree), so a full opus reviewer would burn a session for zero signal (Simplicity + token budget); AC#2 was already proven via the Explore/implementer probes and AC#3 is satisfied by the injected command running in-context. Deferred the CAM-253 close to the rehydrated session (verify-don't-assume): AC#4 must be observed post-respawn before closing, not assumed from the verified wrapper wiring.
- **Blockers encountered**: Initial ambiguity: the first session in this window was spawned by the pre-0.110 in-memory `cam run` (positional boot-prompt arg, no --agent), so its Edit was not gated: this was a stale-process artifact, not a CAM-240 defect. Resolved by the operator running `cam stop && cam run` to respawn under the 0.110.0 wrapper; the new session's argv confirmed --agent.
- **Follow-ups**: SlashCommand truth-up: the orchestrator frontmatter (subagent-orchestrator.md line 12) declares SlashCommand in tools:, but under --agent it is 'No such tool available' at runtime. Non-blocking (the CLI thin-proxy send-keys inject-path works, AC#3 proven), but CAM-240 US-001's tools-reconciliation to 'real runtime usage' missed it: candidate small follow-up to either wire it or drop it from the list. The rehydrated session should raise this with the operator and file via /cam-issue if agreed. Specified chain is drained; re-derive backlog live via cam issue list.

## CAM-254 — Drop non-existent SlashCommand from the orchestrator frontmatter tools list

- **Started**: 2026-07-10T00:45:00Z
- **Closed**: 2026-07-10T01:30:00Z
- **Branch**: cam/issue-254
- **Issue**: CAM-254
- **Outcome**: shipped
- **Summary**: Single-story PRD. Removed the SlashCommand entry from the subagent-orchestrator frontmatter tools: list, closing the accuracy miss from CAM-240 US-001. Grounded via claude-code-guide: SlashCommand is NOT a grantable tool at all in Claude Code (slash commands are an interactive message-parsing construct, not a callable tool; tools.md has no SlashCommand entry), so the CAM-253 'No such tool available' finding was correctly fixed by dropping the entry, not by wiring it (infeasible). No-behavior-change accuracy fix aligning tools: with real runtime usage. Auditor implied-APPROVE (loop ran plan->implement autonomously, participation is spec-only), gates green (typecheck ok, 3997 pass / 0 fail), review CLEAN round 1. Shipped ci-gated as PR #186, tag v0.111.0.
- **Decisions**: Fixed by (a) dropping SlashCommand from tools:, never (b) wiring it: claude-code-guide confirmed SlashCommand is not a real tool. Kept scope minimal (single story, frontmatter + templates mirror). Corrected an earlier orchestrator misstep: promised a PRD-approval pause, but operator participation is spec-only (the loop auto-runs plan/implement/review/ship after spec); no plan_approval=operator was set.
- **Blockers encountered**: None. PR #186 landed BEHIND (main advanced via the CAM-256 SUGGESTION auto-file + close commits); the sidecar merge-watch ran gh pr update-branch (1/2) and merged on CI green; post-merge completed clean (pull + close CAM-254 + tag v0.111.0), no pull-failed. No git-fetch poll ran during the merge window (CAM-228 lesson held).
- **Follow-ups**: CAM-255 (specified, blockedBy CAM-254 now satisfied -> plannable): restore orchestrator-side programmatic slash-command dispatch under --agent via the Skill tool (grounded viable: Skill works under --agent, commands==skills same registry, runs inline in own context). CAM-256 auto-filed (idea): ADR 0020 still lists tools as complete-against-real-runtime including SlashCommand; overlaps CAM-255 (same tools-list truth in docs/adr/0020) -- decide with operator whether to fold into CAM-255 or ship standalone. Operator directive: run both CAM-254 and CAM-255 autonomously; CAM-254 done, CAM-255 next (fresh session via rehydrate).

## CAM-255 — Restore programmatic slash-command dispatch under --agent via the Skill tool

- **Started**: 2026-07-10T01:45:00Z
- **Closed**: 2026-07-10T02:15:00Z
- **Branch**: cam/issue-255
- **Issue**: CAM-255
- **Outcome**: shipped
- **Summary**: Single-story PRD. Granted the Skill tool to the subagent-orchestrator frontmatter (plus templates mirror + re-embed) and swapped the two dead 'use the SlashCommand tool when available' dispatch references in the agent body to the Skill tool, restoring orchestrator-side programmatic /cam-* dispatch under --agent. Grounded from the CAM-254 claude-code-guide sessions: Skill is grantable under --agent and works at runtime, commands==skills share one registry so .claude/commands/*.md are Skill-invokable as-is, running inline in the caller's own context. Auditor implied-APPROVE (loop autonomous, participation spec-only), gates green (typecheck ok, 3997 pass / 0 fail), review CLEAN round 1. Shipped ci-gated as PR #187, tag v0.112.0.
- **Decisions**: Ran CAM-255 with its own defined spec; did NOT silently fold in CAM-256 (ADR 0020 tools-list truth-up) despite the overlapping theme. No plan_approval=operator set (operator participation is spec-only). Kept scope minimal: frontmatter + templates mirror + two body dispatch references.
- **Blockers encountered**: None. PR #187 shipped ci-gated, merged on CI green, post-merge clean (pull + close CAM-255 + tag v0.112.0), no pull-failed. No git-fetch poll ran during the merge window (CAM-228 lesson held).
- **Follow-ups**: CAM-256 (idea) remains open: ADR 0020 still lists the orchestrator frontmatter tools as complete-against-real-runtime including the removed SlashCommand; overlaps CAM-255's tools-list-truth theme but lives in the ADR. Decide with operator whether to spec it standalone or drop. No specified work remains queued after this cycle.

## CAM-256 — Remove stale SlashCommand token from ADR 0020 runtime-tools enumeration

- **Started**: 2026-07-10T04:41:50Z
- **Closed**: 2026-07-10T05:05:00Z
- **Branch**: cam/issue-256
- **Issue**: CAM-256
- **Outcome**: shipped
- **Summary**: Single-story docs fix. Removed the stale 'SlashCommand' token from ADR 0020 line 9's runtime-tools enumeration; the list now reads Read, Glob, Grep, Bash, WebFetch, Write, Skill, Task/Agent. Kept 'Skill' because CAM-255 proved it is a real granted tool, contrary to the issue's own stale text which claimed Skill was never valid (written from the pre-CAM-255 vantage). Operator ran /cam-spec CAM-256 this session; loop then ran plan->implement->review->ship autonomously (spec-only participation). Gates green throughout (typecheck ok, 3997 pass / 0 fail). Shipped ci-gated as PR #188, tag v0.113.0. Closes the tools-list-truth thread across frontmatter (CAM-254), agent body (CAM-255), and the ADR (CAM-256).
- **Decisions**: During the spec grill, caught that the issue's premise was stale ('Skill is never a valid tools: entry') and confirmed with the operator that the fix is remove-SlashCommand-ONLY, not remove-both. Scoped as type:docs, single-line ADR edit, no code/frontmatter change. Grill surfaced no new terms and no ADR-worthy decisions, so the domain-docs write was the sanctioned empty noOp.
- **Blockers encountered**: Review round 1 returned one CRITICAL, but it was a bad-acceptance-criterion finding, not a defect in the ADR fix: AC4's oracle (git diff --name-only main must equal 1 file) is structurally unsatisfiable because the cam workflow itself commits prd.json and handoff.json to the branch (3 files). The reviewer confirmed the intent (frontmatter + code untouched) was satisfied. Round-1 fix scoped the oracle with ':(exclude)scripts/cam/'; round 2 CLEAN. PR #188 merged ci-gated on CI green; post-merge clean (close CAM-256 + tag v0.113.0), no git-fetch poll during the merge window (CAM-228 held).
- **Follow-ups**: None. No specified or planned work remains queued; backlog is entirely idea-stage and needs an operator /cam-spec step to become dispatchable.

## spec-batch-242-252 — Batch spec 242-252 via grill-with-docs

- **Started**: 2026-07-10
- **Closed**: 2026-07-10
- **Branch**: main
- **Issue**: CAM-242..CAM-252
- **Outcome**: 9 specified, 2 closed
- **Summary**: Operator asked to deep-spec the CAM-242..252 review-SUGGESTION / follow-up cluster. Each candidate was grounded via an Explore pass before grilling. 9 issues reached stage:specified (242 fix, 244 chore, 245 fix, 247 docs, 248 chore, 249 docs, 250 chore, 251 chore, 252 docs). 2 were closed without code: 243 subsumed into CAM-199 (jscpd stays floating per operator), 246 already resolved in main (the hard line-numbers it flagged had already been reworded to symbols).
- **Decisions**: CAM-242: the issue's own proposed fix was wrong (env -u runs inside the container via dockerExecWrap); use a separate HOST_ONLY_ENV_UNSET gated by isolation. CAM-244: operator chose to gate container automerge on an in-container check; spec adds a path-filtered always-run ci-container ubuntu job made a required check (renovate.json unchanged), plus an ADR amending ADR 0010. CAM-250: SUGGESTION premise was stale (5 bullets already archived, patterns.md has 0 resolved); reframed to a count-agnostic real-file parser smoke. CAM-249: docs reconciliation (sidecar injects the exact story, so the md self-select logic is dead).
- **Follow-ups**: Autonomous batch drain now in progress: every stage:specified issue goes plan->implement->review->ship, one PR per session, recycling with the drain directive carried forward until zero remain. Sequence a toolchain fix first (green CI), the ci-container issue last (it becomes a required check that gates later PRs). Directive lives in .claude/.cam-orch-handoff.json nextActions; derive the specified set live via cam issue list, never from an enumerated snapshot.

## CAM-245 — Decouple real-file toolchain tests from the concrete pin so Renovate bumps stop reddening CI

- **Started**: 2026-07-10T12:29:33Z
- **Closed**: 2026-07-10T12:52:00Z
- **Branch**: cam/issue-245
- **Issue**: CAM-245
- **Outcome**: shipped
- **Summary**: Single-story PRD (US-001). The two "reads the real repo-root" tests in test/config/toolchain.test.ts now assert a semver-regex format (/^\\d+\\.\\d+\\.\\d+$/) instead of the concrete literal pin, so a Renovate bump of .bun-version or .tool-versions no longer breaks the suite and the toolchain-pin automerge CAM-201 designed can work in practice. Fake-injected tests left unchanged (they keep asserting exact values). Test-only, no src change. Gates green throughout (typecheck ok, 3997 pass / 0 fail, check:all lint spine green). Auditor implied-APPROVE (loop autonomous, participation spec-only), review CLEAN round 1. Shipped ci-gated as PR #189, tag v0.114.0. First issue drained from the specified batch 242-252.
- **Decisions**: Observed live: under this running sidecar a single cam plan signal auto-cascaded plan->PRD+audit->implement->review->ship-signal with no further signals from the orchestrator (the sidecar auto-set active:true and phase:shipping itself). No plan_approval=operator set (participation spec-only). Merge polled via gh pr view only, never git fetch, during the merge window (CAM-228 held). Stashed a stray non-mine cosmetic diff on subagent-orchestrator.md at boot to clear the plan preflight dirty-tree guard.
- **Blockers encountered**: None. PR #189 merged ci-gated on CI green; post-merge clean (close CAM-245 + tag v0.114.0), no pull-failed and no git-fetch poll during the merge window.
- **Follow-ups**: Autonomous batch drain continues: 8 stage:specified issues remain after this cycle (derive live via cam issue list, never from a snapshot). Sequence docs/chore issues next; CAM-244 (adds a path-filtered ci-container REQUIRED status check) LAST because it then gates every subsequent batch PR. One PR per session, recycling with the drain directive carried forward until zero specified remain; the final session drops the directive. Stash entry orch-boot: stray cosmetic color diff on subagent-orchestrator.md awaits operator pop-or-drop.

## CAM-247 — CAM-247 — Split auditor item C.8 into a scannable lead line + sub-bullets

- **Started**: 2026-07-10T13:05:00Z
- **Closed**: 2026-07-10T13:01:41Z
- **Branch**: cam/issue-247
- **Issue**: CAM-247
- **Outcome**: shipped
- **Summary**: Docs-only single-story PRD (US-001). The long single-paragraph item C.8 in .claude/agents/subagent-auditor.md was split into a lead line plus one sub-bullet per concern (ink-testing-library requirement and the others) for scanability. No src change. Gates green throughout (typecheck ok, 3997 pass / 0 fail). Review CLEAN round 1. Shipped ci-gated as PR #190, tag v0.115.0. Second issue drained from the specified batch 242-252.
- **Decisions**: Confirmed live again: a single cam plan signal auto-cascaded plan->PRD+audit->implement->review->ship->merge->post-merge with no further orchestrator signals. Participation spec-only (no plan_approval=operator). Merge polled via gh pr view only, never git fetch, during the merge window (CAM-228 held).
- **Blockers encountered**: None. PR #190 merged ci-gated on CI green; post-merge clean (close CAM-247 + tag v0.115.0), no git-fetch poll during the merge window.
- **Follow-ups**: Autonomous batch drain continues: 7 stage:specified remain after this cycle (CAM-242, 244, 248, 249, 250, 251, 252; derive live via cam issue list, never a snapshot). Sequence docs/chore next; CAM-244 LAST because it adds a path-filtered ci-container REQUIRED status check that then gates every subsequent batch PR. One PR per session, recycling with the drain directive carried forward until zero specified remain; the final session drops the directive. Stash entry orch-boot: stray cosmetic color diff on subagent-orchestrator.md still awaits operator pop-or-drop.

## CAM-242 — Strip CLAUDE_CODE_OAUTH_TOKEN from host workers only (isolation-gated)

- **Started**: 2026-07-10T13:35:00Z
- **Closed**: 2026-07-10T14:05:00Z
- **Branch**: cam/issue-242
- **Issue**: CAM-242
- **Outcome**: shipped
- **Summary**: Single-story PRD (US-001). Host-mode workers no longer inherit CLAUDE_CODE_OAUTH_TOKEN from the tmux-server OS env: added an isolation-gated HOST_ONLY_ENV_UNSET so a host worker is not pinned to the token's account and does not bypass the Team-login config dir. worker-container.ts left untouched per AC6 (the container path already handles env -u via dockerExecWrap). Test-covered, no behavior change in container mode. Gates green throughout (typecheck ok, 4013 pass / 0 fail, check:all lint spine + file-size ratchet green). Auditor implied-APPROVE (loop autonomous, participation spec-only), review CLEAN round 1. Shipped ci-gated as PR #191, tag v0.116.0. Third issue drained from the specified batch 242-252 (after 245, 247).
- **Decisions**: Confirmed live again: a single cam plan signal auto-cascaded plan->PRD+audit->implement->review->ship->merge->post-merge with no further orchestrator signals. Adopted the spec's HOST_ONLY_ENV_UNSET decision over the issue's original env -u proposal (which would have wrongly run inside the container). No plan_approval=operator (participation spec-only). Merge polled via gh pr view only, never git fetch, during the merge window (CAM-228 held).
- **Blockers encountered**: None functionally. Branch was BEHIND at merge time; merge-watch ran gh pr update-branch once (1/2) and merged on CI green. Post-merge clean (close CAM-242 + tag v0.116.0), no pull-failed and no git-fetch poll during the merge window.
- **Follow-ups**: Autonomous batch drain continues: 6 stage:specified remain (derive live via cam issue list, never a snapshot). Sequence docs/chore next; CAM-244 LAST because it adds a path-filtered ci-container REQUIRED status check that then gates every subsequent batch PR. Review auto-filed CAM-257 (idea) as a SUGGESTION follow-up; needs operator /cam-spec to become dispatchable. One PR per session, recycling with the drain directive carried forward until zero specified remain; the final session drops the directive. Stash entry orch-boot: stray cosmetic color diff on subagent-orchestrator.md still awaits operator pop-or-drop.

## CAM-248 — Single-source the officialDocsValidated enum + allowed-keys from handoff.schema.json (runtime-derived in events.ts)

- **Started**: 2026-07-10T13:30:54Z
- **Closed**: 2026-07-10T14:15:00Z
- **Branch**: cam/issue-248
- **Issue**: CAM-248
- **Outcome**: shipped
- **Summary**: Chore, single-story PRD (US-001). handoff.schema.json is now the single source for the officialDocsValidated status enum and its allowed-key set; events.ts derives both at runtime instead of a hand-maintained copy, removing the hand-sync drift risk the SUGGESTION flagged. Gates green throughout (typecheck ok, 4013 pass / 0 fail, check:all spine green). Auditor implied-APPROVE (loop autonomous, participation spec-only), review CLEAN round 1. Shipped ci-gated as PR #192, tag v0.117.0. 4th issue drained from the specified batch 242-252 (after 245, 247, 242).
- **Decisions**: Confirmed live again: a single `cam plan 248` signal auto-cascaded plan->PRD+audit->implement->review->ship->merge->post-merge with no further orchestrator signals (sidecar auto-set active:true and phase:shipping itself). No plan_approval=operator (participation spec-only). Merge polled via gh pr view only, never git fetch, during the merge window (CAM-228 held).
- **Blockers encountered**: None. Branch was BEHIND at merge time; merge-watch ran gh pr update-branch once (1/2) and merged on CI green. Post-merge clean (close CAM-248 + tag v0.117.0), no pull-failed and no git-fetch poll during the merge window.
- **Follow-ups**: Autonomous batch drain continues: 5 stage:specified remain after this cycle (derive live via cam issue list, never a snapshot). Sequence docs/chore issues next; CAM-244 LAST because it adds a path-filtered ci-container REQUIRED status check that then gates every subsequent batch PR. Review auto-filed CAM-258 (idea) as a SUGGESTION follow-up; with CAM-257 both need an operator /cam-spec to become dispatchable. One PR per session, recycling with the drain directive carried forward until zero specified remain; the final session drops the directive. Stash entries orch-boot cosmetic color diff on subagent-orchestrator.md and old CAM-109 WIP still await operator disposition.

## CAM-249 — Reconcile implementer SYSTEM PROMPT + cam-next.md task-prompt to the injected-story dispatch model

- **Started**: 2026-07-10T21:15:00Z
- **Closed**: 2026-07-10T14:27:04Z
- **Branch**: cam/issue-249
- **Issue**: CAM-249
- **Outcome**: shipped
- **Summary**: Docs-only 2-story PRD. US-001 reconciled the subagent-implementer SYSTEM PROMPT (both .claude/ and templates/ copies): the frontmatter 'picks highest-priority story' claim, the jq self-selection block, and the 'skip requires:operator when picking' selection logic were removed/rewritten so the agent instructions state the story is provided in the spawn prompt, matching the sidecar's do-not-self-select dispatch contract. US-002 updated the stale quoted implementer task-prompt in cam-next.md to the same injected-story model. No src change. Gates green throughout (typecheck ok, 4013 pass / 0 fail). Review CLEAN round 1. Shipped ci-gated as PR #193, tag v0.118.0. 5th issue drained from the specified batch 242-252 (after 245, 247, 242, 248).
- **Decisions**: Confirmed live again: a single cam plan 249 signal auto-cascaded plan->PRD+audit->implement(US-001+US-002)->review->ship->merge->post-merge with no further orchestrator signals (sidecar auto-set active:true and phase:shipping itself). Two-story PRD: the DONE push arrived once per story, review ran after the last. No plan_approval=operator (participation spec-only). Merge polled via gh pr view only, never git fetch, during the merge window (CAM-228 held).
- **Blockers encountered**: None. Merged ci-gated on CI green (was IN_PROGRESS at ship time). Post-merge clean (close CAM-249 + tag v0.118.0), no pull-failed and no git-fetch poll during the merge window.
- **Follow-ups**: Autonomous batch drain continues: 4 stage:specified remain after this cycle (CAM-244, 250, 251, 252; derive live via cam issue list, never a snapshot). Sequence docs/chore issues next; CAM-244 LAST because it adds a path-filtered ci-container REQUIRED status check that then gates every subsequent batch PR. One PR per session, recycling with the drain directive carried forward until zero specified remain; the final session drops the directive. Stash entries orch-boot cosmetic color diff on subagent-orchestrator.md and old CAM-109 WIP still await operator disposition.

## CAM-250 — Add count-agnostic real-file smoke test for the patterns.md parser

- **Started**: 2026-07-10T21:50:00Z
- **Closed**: 2026-07-10T22:05:00Z
- **Branch**: cam/issue-250
- **Issue**: CAM-250
- **Outcome**: shipped
- **Summary**: Single-story PRD (US-001). Added a count-agnostic real-file smoke test for the patterns.md parser, satisfying US-004 AC5 by equivalence (synthetic fixtures use the exact reserved-key set). No src behavior change. Gates green throughout (typecheck ok, 4014 pass / 0 fail). Auditor implied-APPROVE (loop autonomous, participation spec-only), review CLEAN round 1. Shipped ci-gated as PR #194, tag v0.119.0. 6th issue drained from the specified batch 242-252 (after 245, 247, 242, 248, 249).
- **Decisions**: Confirmed live again: a single cam plan 250 signal auto-cascaded plan->PRD+audit->implement->review->ship->merge->post-merge with no further orchestrator signals (sidecar auto-set active:true and phase:shipping itself). No plan_approval=operator (participation spec-only). Merge polled via gh pr view only, never git fetch, during the merge window (CAM-228 held).
- **Blockers encountered**: None. Branch was BEHIND at merge time; merge-watch ran gh pr update-branch once (1/2) and merged on CI green. Post-merge clean (close CAM-250 + tag v0.119.0), no pull-failed and no git-fetch poll during the merge window.

## CAM-251 — Remove dead 'reviewer' member from AnySentinelSource union

- **Started**: 2026-07-10T22:30:00Z
- **Closed**: 2026-07-10T15:38:17Z
- **Branch**: cam/issue-251
- **Issue**: CAM-251
- **Outcome**: shipped
- **Summary**: Single-story chore PRD (US-001). Removed the dead 'reviewer' member from the AnySentinelSource union, dead after US-003 removed its only producer. No behavior change. Gates green throughout (typecheck ok, 4014 pass / 0 fail). Review CLEAN round 1. Shipped ci-gated as PR #195, tag v0.120.0. 7th issue drained from the specified batch 242-252 (after 245, 247, 242, 248, 249, 250).
- **Decisions**: Confirmed live again: a single cam plan 251 signal auto-cascaded plan->PRD+audit->implement->review->ship->merge->post-merge with no further orchestrator signals (sidecar auto-set active:true and phase:shipping itself). No plan_approval=operator (participation spec-only). Merge polled via gh pr view only, never git fetch, during the merge window (CAM-228 held).
- **Blockers encountered**: None. PR #195 was MERGEABLE/BLOCKED on required ci at ship time; merge-watch merged on CI green. Post-merge clean (close CAM-251 + tag v0.120.0), no pull-failed and no git-fetch poll during the merge window.
- **Follow-ups**: Autonomous batch drain continues: 2 stage:specified remain after this cycle (CAM-252 docs/chore, then CAM-244 LAST because it adds a path-filtered ci-container REQUIRED status check that then gates every subsequent batch PR; derive live via cam issue list, never a snapshot). One PR per session, recycling with the drain directive carried forward until zero specified remain; the final session drops the directive. Stash entries orch-boot cosmetic color diff on subagent-orchestrator.md and old CAM-109 WIP still await operator disposition.

## CAM-252 — CAM-252 — Umbrella manual-path scoping header before Step 0 in cam-review.md

- **Started**: 2026-07-10T22:50:00Z
- **Closed**: 2026-07-10T15:53:43Z
- **Branch**: cam/issue-252
- **Issue**: CAM-252
- **Outcome**: shipped
- **Summary**: Single-story docs/chore PRD (US-001). Added an umbrella manual-path scoping header before Step 0 in cam-review.md (both .claude/ and templates/ copies) so the manual /cam-review path scope is unmistakable at the section level, not just the intro paragraph. No src change. Gates green throughout (typecheck ok, 4014 pass / 0 fail). Review CLEAN round 1. Shipped ci-gated as PR #196, tag v0.121.0. 8th issue drained from the specified batch 242-252 (after 245, 247, 242, 248, 249, 250, 251).
- **Decisions**: Confirmed live again: a single cam plan 252 signal auto-cascaded plan->PRD+audit->implement->review->ship->merge->post-merge with no further orchestrator signals (sidecar auto-set active:true and phase:shipping itself). No plan_approval=operator (participation spec-only). Merge polled via gh pr view only, never git fetch, during the merge window (CAM-228 held).
- **Blockers encountered**: None. PR #196 was MERGEABLE/BLOCKED on required ci at ship time; merge-watch merged on CI green. Post-merge clean (close CAM-252 + tag v0.121.0), no pull-failed and no git-fetch poll during the merge window.
- **Follow-ups**: Autonomous batch drain NEARLY DONE: exactly 1 stage:specified remains, CAM-244 (the LAST). Next session ships CAM-244 and DROPS the drain directive once cam issue list --json shows zero specified. CAM-244 adds a path-filtered ci-container REQUIRED status check; its own merge may wait on that new check landing. Stash entries orch-boot cosmetic color diff on subagent-orchestrator.md and old CAM-109 WIP still await operator disposition. Auto-filed SUGGESTION follow-ups CAM-257/258/259 (idea) each need an operator /cam-spec to become dispatchable.

## CAM-244 — Renovate container-scoped automerge gated behind a path-filtered ci-container required check

- **Started**: 2026-07-10T16:14:00Z
- **Closed**: 2026-07-10T16:45:00Z
- **Branch**: cam/issue-244
- **Issue**: CAM-244
- **Outcome**: shipped
- **Summary**: 2-story chore PRD. US-001 added an always-run, path-filtered ci-container ubuntu job to ci.yml (guards the CAM-178 required-check-Pending trap: always-run job with path-conditional heavy steps, not a workflow-level paths: filter). US-002 made ci-container a required status check in branch protection and updated the recovery-runbook oracle. Gates green (typecheck ok, 4020 pass / 0 fail). Review CLEAN round 1. Shipped ci-gated as PR #197, tag v0.122.0. Last issue of the specified batch (242-252 + 244); batch drain now complete (0 stage:specified remain).
- **Decisions**: Single cam plan 244 signal auto-cascaded plan->PRD+audit->implement->review->ship->merge->post-merge with no further orchestrator signals. No plan_approval=operator (participation spec-only). PR #197 was BEHIND (merge-watch ran gh pr update-branch 1/2) and merged on both required checks green, including ci-container's first live run as a required check. Merge polled via gh pr view only, never git fetch, during the merge window (CAM-228 held).
- **Blockers encountered**: First ship attempt failed gates-failed on check:file-size: US-001 grew test/ci-workflow.test.ts 74->103 lines but its worker never raised the budget ceiling (still 75). Operator authorized the orchestrator ship-hygiene raise: bumped scripts/file-size-budget.json ceiling 75->104 (gate measures LOC as content.split newline length, one above wc -l) plus a CAM-244 _ref note via surgical perl edits, committed on the branch (7728bffa), confirmed check:all green, re-shipped via cam ship. Second attempt shipped clean.
- **Follow-ups**: Recurring gap: workers grow a file past its file-size-budget ceiling without raising it, surfacing only at the ship gate. CAM-122 already tracks retiring the file-size-budget mechanism entirely, which would eliminate the class; no new issue filed. Stash entries (orch-boot cosmetic color diff on subagent-orchestrator.md; old CAM-109 WIP) still await operator disposition. Auto-filed SUGGESTION follow-ups CAM-257/258/259 (idea) each need an operator /cam-spec to become dispatchable. Backlog now has 0 specified/planned; only idea-stage issues remain.

## CAM-260 — Shift file-size ceiling raise left into the implementer story

- **Started**: 2026-07-10T19:33:56Z
- **Closed**: 2026-07-10T19:53:11Z
- **Branch**: cam/issue-260
- **Issue**: CAM-260
- **Outcome**: shipped
- **Summary**: 3-story chore PRD (PR #198, v0.123.0) moving the file-size ceiling raise from ship time into the implementer story: the worker now runs the file-size gate after coding and raises its own file's ceiling with the tracker-ref in _ref in the same commit; the reviewer backstops each raise (legitimate growth vs the file should have been split). Also fixed the stale patterns.md pointer to the removed cam-ship.md Step 3. Gate mechanism unchanged. Review CLEAN round 1.
- **Decisions**: The raise-responsibility moves left to the implementer with the reviewer as backstop (ADR written during spec). Rejected alternatives: auto-raise at ship time (rubber-stamps growth, guts the gate) and retiring the gate (loses the bloat signal). Sibling ratchets (coverage/debt/dead-code/dup) share the same late-catch gap and were deliberately deferred to CAM-261 to keep this PRD small.
- **Blockers encountered**: Plan preflight aborted on a red bun-test: the codegen byte-parity test failed because an earlier direct-to-main color commit edited templates/agents/subagent-orchestrator.md without regenerating the embed. Fixed at root: ran bun run embed-vendor to regenerate src/vendor/_generated.ts, confirmed check:all green, pushed, and re-fired the plan. PR #198 also merged BEHIND (three direct main commits pushed main ahead); merge-watch ran update-branch once and merged on CI green.
- **Follow-ups**: CAM-261 (generalize the in-story ratchet-raise + reviewer-backstop pattern to the coverage/debt/dead-code/dup ratchets; highest-merit next spec). CAM-262 (cosmetic readability of one implementer-md paragraph; low value, may be dropped). Both are idea-stage and need an operator /cam-spec.

## CAM-261 — Generalize the in-story ratchet-raise to the full check:all spine

- **Started**: 2026-07-10T21:20:00Z
- **Closed**: 2026-07-10T21:43:55Z
- **Branch**: cam/issue-261
- **Issue**: CAM-261
- **Outcome**: shipped
- **Summary**: 2-story chore PRD (PR #199, v0.124.0) generalizing the CAM-260 in-story ratchet-raise pattern from file-size to the full check:all quality spine. US-001: the implementer now runs bun run check:all in-story after coding (reversing CAM-260's scoped exception that kept the worker on typecheck+test+file-size) and resolves each of the four sibling ratchets inline per a per-gate rubric (coverage lower-floor-with-_ref, debt inline-cite, dead-code/knip remove-or-justified-ignore, dup/jscpd dedup-or-justified-threshold). US-002: the reviewer backstops loosenings across all four gates. Review CLEAN round 1.
- **Decisions**: Grill reframing: the issue premise was partly false. Only coverage shares the CAM-260 raise machinery (ratchet-diff.ts + _ref, direction-locked, over 2 global floors not per-file); debt/dead-code/dup have no per-unit _ref raise channel. Reframed to option B: attack the shared late-catch gap (worker ran only typecheck+test+file-size, so the siblings fired only at ship/CI) by making the worker run full check:all in-story and resolving each gate in the form it supports. Rejected: option A (coverage-only) and option C (add per-unit budget files + _ref gates for knip/jscpd, new machinery the reviewer diff already covers). The reversal ADR was written to docs/adr/ at spec time via cam spec --write-docs, so the planner emitted only 2 stories.
- **Blockers encountered**: None. PR #199 was BLOCKED on required ci at ship time; merge-watch merged on CI green. Post-merge clean (close CAM-261 + tag v0.124.0). Merge polled via gh pr view only, never git fetch, during the merge window (CAM-228 held).
- **Follow-ups**: Batch drain: exactly one stage:specified remains, CAM-263 (auto-filed SUGGESTION follow-ups should populate the structured derivedFrom field), to be planned next session via cam plan 263 (bare number). Also this cycle: filed CAM-263, specified CAM-261 + CAM-263, and closed CAM-262 as subsumed by CAM-261 (its target paragraph subagent-implementer.md:100 was rewritten by CAM-261). No re-spec path exists for an already-specified issue (CAM-206). Stash git stash@{0} (old CAM-109 WIP) still awaits disposition.

## CAM-263 — Carry parent issue id to auto-filed SUGGESTION derivedFrom

- **Started**: 2026-07-10T22:00:00Z
- **Closed**: 2026-07-10T22:28:00Z
- **Branch**: cam/issue-263
- **Issue**: CAM-263
- **Outcome**: shipped
- **Summary**: Single-story fix PRD (PR #200, v0.125.0): wire the parent issue id explicitly from plan-time (new PrdSnapshot field, populated in the plan-runner) through to the suggestion-filing call site (sidecar.ts makeProductionFileSuggestionsFn) so auto-filed SUGGESTION follow-ups set the existing derivedFrom field. No branch-string parsing, no specSource, no writer/schema change. US-001 DONE round 1 (typecheck ok, 4025 pass / 0 fail). Review CLEAN round 1.
- **Decisions**: Nothing contentious: CAM-263 was already fully specified (grill-with-docs, locked). Dispatched as-spec and let the sidecar cascade plan->implement->review->ship fully autonomously; participation was spec-only (did not set plan_approval=operator).
- **Blockers encountered**: None. PR #200 merged BEHIND: merge-watch ran gh pr update-branch (attempt 1/2) then merged on CI green. Post-merge clean (close CAM-263 + tag v0.125.0), polled via gh pr view only.
- **Follow-ups**: Batch drain COMPLETE: CAM-261 then CAM-263 both shipped; 0 stage:specified remain (idea 47, planned 0). The terminal-verdict hook auto-filed CAM-264 (idea) from the reviewer SUGGESTION; CAM-264 has NO derivedFrom because the running sidecar binary predated this very fix (loop/binary coherence, expected). No standing directive next session: greet and wait for an operator /cam-spec, do not plan idea-stage issues directly. Stash git stash@{0} (old CAM-109 WIP) still awaits disposition.

## CAM-264 — Skip project.toml read on empty suggestion batch

- **Started**: 2026-07-10T22:55:00Z
- **Closed**: 2026-07-10T23:15:00Z
- **Branch**: cam/issue-264
- **Issue**: CAM-264
- **Outcome**: shipped
- **Summary**: Single-story chore PRD (PR #201, v0.126.0): in makeProductionFileSuggestionsFn (src/commands/sidecar.ts) wrap the config/prefix/parentIssueId resolution and the candidate-filing for-loop behind a candidates.length > 0 guard, so an empty suggestion batch (nothing to file) skips the project.toml read. The post-loop suggestion-filed logEvent stays outside the guard (it fires on dupSkipped > 0, independent of candidates). US-001 DONE round 1 (typecheck ok, 4029 pass / 0 fail, +4 tests). Review CLEAN round 1.
- **Decisions**: Reviewer SUGGESTION-level nit (negligible cost per the reviewer). Flagged the triviality to the operator up front, ran a single confirmation grill round (change was crystal-clear), and verified before speccing that nothing after the loop consumes config/prefix/parentIssueId (the logEvent depends only on filedIds/dupSkipped/failedCount), so the all-duplicates path (candidates empty, dupSkipped > 0) still emits its event. Participation was spec-only: did not set plan_approval=operator; let the sidecar cascade plan->implement->review autonomously and fired cam ship after review CLEAN.
- **Blockers encountered**: None. PR #201 was BLOCKED on required ci at ship time; merge-watch merged on CI green. Post-merge clean (close CAM-264 + tag v0.126.0). Merge polled via gh pr view only, never git fetch, during the merge window.
- **Follow-ups**: Backlog after close: idea 46, specified 0, planned 0 (nothing plannable). CAM-264's own derivedFrom stays None because it was filed by the pre-fix stale binary (loop/binary coherence, expected, not a bug). No standing directive next session: greet, announce autonomous mode without dispatching (host isolation blocks meta_loop=auto), and wait for an operator /cam-spec or new directive. Stash git stash@{0} (old CAM-109 WIP) still awaits disposition.

## CAM-195 — Close the meta-loop wedge: auto-resume in-flight PRDs, event every terminal/refusal, single-owner state file

- **Started**: 2026-07-11T00:25:00Z
- **Closed**: 2026-07-11T01:05:00Z
- **Branch**: cam/issue-195
- **Issue**: CAM-195
- **Outcome**: shipped
- **Summary**: 7-story fix PRD (PR #202, v0.127.0, ci-gated) closing the CAM-118 meta-loop wedge. US-001: renderStateFile/clearActive become read-modify-write, preserving the loop phase (retires the CAM-191 reorder workaround). US-002: the orchestrator-exit wrapper (run.ts) stops rm-ing the live cam-loop.local.md. US-003: the sidecar re-arms implementing at boot and idle-tick for an in-flight PRD, with phase:idle=parked (no auto-resume) vs phase:implementing=wedge (resume) as the discriminator (trustworthy only because of US-001/US-002). US-004: finishTerminal emits a structured event on every terminal. US-005/US-006: a durable .cam-implement-blocked.json marker written on the blocked terminal, consumed by the next implement run, surfaced at orchestrator boot. US-007: every dispatch refusal is evented and a per-issue pending-guard stops the re-dispatch re-fire. All 7 passes:true, review round 1 CLEAN, 4084 tests / 0 fail.
- **Decisions**: One coherent PRD (not split) because the three defects are coupled through the state-file phase field and a partial fix leaves the wedge reachable. Fix direction chosen by grill: single-owner state-file lifecycle (preserve-by-default phase; wrapper never deletes) as the root, re-arm keyed on phase, one shared blocked marker, one refusal event kind with a structured reason, root-cause per-issue pending-guard over a time-throttle. Spec-only participation (no plan_approval=operator); fired cam ship after review CLEAN. An ADR was written: cam-loop.local.md is the single-owner cycle signal and phase is the resume discriminator.
- **Blockers encountered**: PR #202 merged BEHIND (this spec-heavy session advanced main via repeated cam spec commits); merge-watch ran gh pr update-branch (1/2) then merged on CI green. Flagged transient in-PRD test-count dips (US-002 -9, US-004 -13) as a possible weakened-coverage signal; the whole-branch reviewer returned CLEAN and net coverage grew, so the dips were legitimate. Post-merge clean (close + tag v0.127.0), polled via gh pr view only.
- **Follow-ups**: Item #1 of an operator-requested 10-issue merit-ranked batch. Also specced this session (stage:specified, plannable): CAM-214 (blockedBy CAM-195, now unblocked), CAM-174, CAM-200, CAM-167 (re-scoped to the residual plan-runner post-spawn teardown gap after CAM-188/204 shipped most of it), CAM-207 (4 stories), CAM-194, CAM-156, CAM-199 (subsumes CAM-243). CAM-206 (10th) NOT yet specced (still idea). Closed CAM-73 + CAM-74 as obsolete/subsumed at session start. Terminal-verdict hook auto-filed CAM-265 (SUGGESTION from the CAM-195 review, idea, untriaged). Dropped stale stash git stash@{0} (old CAM-109 WIP).

## CAM-214 — Harness circuit-breaker: halt the auto-dispatch chain after N=3 identical BLOCKED_* outcomes

- **Started**: 2026-07-11T04:45:00Z
- **Closed**: 2026-07-11T05:30:00Z
- **Branch**: cam/issue-214
- **Issue**: CAM-214
- **Outcome**: shipped
- **Summary**: 4-story dependency-chained fix PRD (PR #203, v0.128.0, ci-gated) adding a harness circuit-breaker that halts the auto-dispatch chain after N=3 consecutive identical BLOCKED_* outcomes on the same story with an unchanged PRD, escalating via the CAM-195 durable marker instead of re-spinning the same doomed dispatch. US-001 extends the blocked-marker schema with a dedup-key + consecutive-count; US-002 wires the counter + a PRD content-hash into the marker so identity is content-based not just story-id; US-003 is the halt itself (the re-dispatch chain stops once the count escalates); US-004 surfaces the circuit-broken blocker in the orchestrator boot-read. All 4 passes:true, review round 1 CLEAN, 4114 tests / 0 fail. CAM-214 was blockedBy CAM-195 (shipped last cycle); the dependency was respected before dispatch.
- **Decisions**: One coherent PRD (not split): the four stories form a single mechanism (schema -> counter/hash -> halt -> surface) where a partial ship leaves the circuit-breaker non-functional. Content-hash identity (US-002) over bare story-id so a PRD edit legitimately resets the counter. Reused the CAM-195 blocked-marker rather than inventing a second durable marker. Spec-only participation: did not set plan_approval=operator; let the sidecar cascade plan->implement->review autonomously and fired cam ship after review CLEAN. Trusted the deterministic reviewer CLEAN on US-003 despite a flat test-count delta (legit within-suite test of the halt path), did not override by reading code.
- **Blockers encountered**: None functional. PR #203 merged BEHIND: merge-watch ran gh pr update-branch (attempt 1/2) then merged on CI green. Post-merge clean (close CAM-214 + tag v0.128.0), polled via gh pr view only, never git fetch during the merge window (CAM-228 held).
- **Follow-ups**: Item #2 of the operator-requested merit-ranked batch (CAM-195 was #1). Remaining plannable batch items (7, re-derive live): CAM-174 (next in merit order), CAM-200, CAM-167, CAM-207, CAM-194, CAM-156, CAM-199, dispatched one-per-session via cam plan <bare-number>. CAM-206 (re-spec path) still stage:idea, needs /cam-spec before it is plannable. Terminal-verdict hook auto-filed CAM-266 (SUGGESTION from the CAM-214 review, idea, untriaged, expected).

## CAM-174 — Post-merge resilience: harden the diverged-local-main path with a durable stalled marker + non-destructive rebase recovery

- **Started**: 2026-07-11T05:55:00Z
- **Closed**: 2026-07-11T06:45:00Z
- **Branch**: cam/issue-174
- **Issue**: CAM-174
- **Outcome**: shipped
- **Summary**: 4-story fix PRD (PR #204, v0.129.0, ci-gated) hardening the post-merge path against a diverged local main (unpushed pre-branch commits leaving the cycle half-done). US-001: durable post-merge-stalled marker module. US-002: recover via git pull --rebase, never an automatic reset --hard. US-003: write the marker on a merged-but-failed post-merge. US-004: surface the marker at orchestrator boot + document operator recovery. All 4 passes:true, review round 1 CLEAN, 4142 tests / 0 fail (US-004 flat test-count is legit: boot-surfacing + docs, minimal new test surface; reviewer backstopped).
- **Decisions**: One coherent 4-story PRD (not split): the stories form a single mechanism (marker module -> non-destructive recovery -> write-on-failure -> surface-at-boot) where a partial ship leaves the resilience non-functional. Reused the CAM-195 durable-marker pattern rather than inventing new machinery. Spec-only participation: did NOT set plan_approval=operator; let the sidecar cascade plan->implement->review autonomously and fired cam ship after review CLEAN. Trusted the deterministic reviewer CLEAN despite the US-004 flat test-count (docs/boot story), did not override by reading code.
- **Blockers encountered**: None functional. PR #204 merged BEHIND: merge-watch ran gh pr update-branch (attempt 1/2) then merged on CI green. Post-merge clean (pull + close CAM-174 + tag v0.129.0), polled via gh pr view only, never git fetch during the merge window (CAM-228 held).
- **Follow-ups**: Item #3 of the operator-requested merit-ranked batch (CAM-195 #1, CAM-214 #2 shipped prior). Remaining plannable batch items (re-derive live): CAM-200 (next in merit order), CAM-167, CAM-207 (4 stories), CAM-194, CAM-156, CAM-199, one-per-session via cam plan <bare-number>. CAM-206 (re-spec path) still stage:idea, needs /cam-spec before plannable. New durable boot marker shipped this cycle: .claude/.cam-post-merge-stalled.json (surface at boot alongside the other markers). Terminal-verdict hook auto-filed CAM-267 + CAM-268 (SUGGESTION, stage:idea, untriaged, expected).

## CAM-200 — Reliable orchestrator wake-up push: verified send-keys delivery with bounded retry

- **Started**: 2026-07-11T06:55:00Z
- **Closed**: 2026-07-11T07:20:00Z
- **Branch**: cam/issue-200
- **Issue**: CAM-200
- **Outcome**: shipped
- **Summary**: 3-story fix PRD (PR #205, v0.130.0, ci-gated) making the orchestrator wake-up push reliable, closing the recurring report-loss where send-keys landed text in the composer but never submitted. US-001: add a push-undelivered event kind to the flight recorder. US-002: extract sendKeysVerified, a shared helper that verifies delivery (composer emptied) with bounded retry. US-003: wire the sidecar report pusher to sendKeysVerified so both pushers share the verified path and record push-undelivered on exhaustion. All 3 passes:true, review round 1 CLEAN, 4150 tests / 0 fail.
- **Decisions**: One coherent 3-story PRD (not split): schema (event kind) -> shared verify+retry helper -> wire the pusher, where a partial ship leaves the push still unverified. Shared sendKeysVerified used by BOTH pushers rather than duplicating verify logic. Spec-only participation: did NOT set plan_approval=operator; let the sidecar cascade plan->implement->review autonomously and fired cam ship after review CLEAN. Trusted the deterministic reviewer CLEAN, did not override by reading code.
- **Blockers encountered**: None functional. PR #205 merged BEHIND: merge-watch ran gh pr update-branch (attempt 1/2) then merged on CI green. Post-merge clean (pull + close CAM-200 + tag v0.130.0), polled via gh pr view only, never git fetch during the merge window (CAM-228 held).
- **Follow-ups**: Item #4 of the operator-requested merit-ranked batch (CAM-195 #1, CAM-214 #2, CAM-174 #3 shipped prior). Remaining plannable batch items (re-derive live): CAM-167 (next in merit order), CAM-207 (4 stories), CAM-194, CAM-156, CAM-199, one-per-session via cam plan <bare-number>. CAM-206 (re-spec path) still stage:idea, needs /cam-spec before plannable. Terminal-verdict hook auto-filed CAM-269 (SUGGESTION, stage:idea, untriaged, expected).

## CAM-167 — CAM-167 — Plan-runner tears down its planner/auditor pane on every terminal (lingering-pane mutex gap)

- **Started**: 2026-07-11T07:45:00Z
- **Closed**: 2026-07-11T08:05:00Z
- **Branch**: cam/issue-167
- **Issue**: CAM-167
- **Outcome**: shipped
- **Summary**: Single-story fix PRD (PR #206, v0.131.0, ci-gated). US-001: runPlanPhaseWithReplan now tears down its planner/auditor pane at a single unconditional exit covering every terminal (incl. the non-audit post-spawn path), closing the residual mutex-busy lingering-pane gap where a reviewer/planner/auditor TUI stayed alive-idle at cycle end and forced a manual kill. passes:true, review round 1 CLEAN, 4155 tests / 0 fail; check:all spine green (file-size ceiling raised 1362->1381 with tracker-ref).
- **Decisions**: Single coherent story (not split): one unconditional teardown site is the correct shape rather than per-branch cleanup. Spec-only participation: did NOT set plan_approval=operator; let the sidecar cascade plan->implement->review autonomously and fired cam ship after review CLEAN. Trusted the deterministic reviewer CLEAN, did not override by reading code.
- **Blockers encountered**: None functional. PR #206 merged BEHIND: merge-watch ran gh pr update-branch (attempt 1/2) then merged on CI green. Post-merge clean (pull + close CAM-167 + tag v0.131.0), polled via gh pr view only, never git fetch during the merge window (CAM-228 held).
- **Follow-ups**: Item #5 of the operator-requested merit-ranked batch (CAM-195/214/174/200 shipped prior). Remaining plannable batch items (re-derive live): CAM-207 (next, 4 stories, container firewall-init), CAM-194, CAM-156, CAM-199, one-per-session via cam plan <bare-number>. CAM-206 (re-spec path) still stage:idea, needs /cam-spec before plannable. Terminal-verdict hook auto-filed CAM-270 (SUGGESTION, stage:idea, untriaged, expected).

## CAM-207 — CAM-207 — Container sidecar silent-death on firewall-init hardened

- **Started**: 2026-07-11T08:30:00Z
- **Closed**: 2026-07-11T09:30:00Z
- **Branch**: cam/issue-207
- **Issue**: CAM-207
- **Outcome**: shipped
- **Summary**: 4-story fix PRD (PR #207, v0.132.0, ci-gated) closing the compounding gaps that let the container-mode sidecar die silently on firewall-init (dnsmasq port 53) failure. US-001: durable .cam-sidecar-stalled.json marker written on FirewallError + surfaced at orchestrator boot. US-002: liveness watcher with bounded respawn. US-003: sidecarAlive gates guarding plan/meta-loop signal writes. US-004: port-53 root-cause teardown (docker rm -f, best-effort, tolerates absent container). All 4 passes:true, review round 1 CLEAN, 4214 tests / 0 fail. worker_isolation=HOST so the fix ships/tests on host; container behavior is covered by tests, not a live container run.
- **Decisions**: One coherent 4-story PRD (not split): the stories form a single mechanism (marker module -> liveness+respawn -> sidecarAlive gates -> port-53 teardown) where a partial ship leaves the resilience non-functional. Reused the CAM-195 durable-marker pattern rather than inventing new machinery. Spec-only participation: did NOT set plan_approval=operator; let the sidecar cascade plan->implement->review autonomously and fired cam ship after review CLEAN. Trusted the deterministic reviewer CLEAN, did not override by reading code.
- **Blockers encountered**: None functional. PR #207 merged BEHIND: merge-watch ran gh pr update-branch (attempt 1/2) then merged on CI green. Post-merge clean (pull + close CAM-207 + tag v0.132.0), polled via gh pr view only, never git fetch during the merge window (CAM-228 held).
