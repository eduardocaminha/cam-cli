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
