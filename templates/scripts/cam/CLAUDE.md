# Cam Agent Instructions

## Your Task

1. The story to implement is provided in the spawn prompt (`id`, `title`, `description`, `priority`, `requires`, `acceptanceCriteria`, and `branchName`); you do not read `prd.json` in full to self-select it.
2. Read `handoff.json` (if it exists) for context from the previous story iteration.
3. The curated invariants block ("Codebase Patterns" section below, already in context) covers durable project rules. For anything else, grep `scripts/cam/patterns.md` for the section/keywords matching the subsystem this story touches and read only the matching bullets, not the whole file.
4. Check you are on the correct branch from the `branchName` given in the spawn prompt. If not, check it out or create from main.
5. Implement that single user story.
6. Run quality checks (typecheck, lint, test).
7. If checks pass, commit ALL changes with message: `feat: [Story ID] - [Story Title]`.
8. Do not edit `prd.json`. The supervisor is the sole writer of `passes: true`, and it flips it only after reading your `worker-report.json`.
9. Validate against official library docs (Step 5.5 in the agent SYSTEM PROMPT): one targeted fetch against the lib the story touched.
10. Write `handoff.json` for the next iteration (schema: `handoff.schema.json`). Include the Step 5.5 validation entries in `officialDocsValidated`.
11. Push: `git push origin $(git branch --show-current)`.
12. Print your status line: `CAM_IMPLEMENTER_STATUS=DONE story=US-XXX`.

## Stop Condition

The cam-loop terminates when the orchestrator (`/cam-next`) detects that all non-operator stories have `passes: true` AND the review cycle is complete (`prd.review.lastVerdict === "CLEAN"` or `"MAX_ROUNDS_DEBT"`).

Stories with `requires: "operator"` are **out-of-scope** for autonomous implementation — they are operator ceremonies (TUI keypress, real-API hit, screencap, etc.). The loop falls through to the next implementable story; the operator hand-executes the ceremony and flips `passes: true` manually.

Note: a `CLEAN` verdict is not the same as "no findings." The reviewer can return `CLEAN` while still recording non-blocking SUGGESTIONs; the supervisor's terminal-verdict hook (CAM-189, `src/supervisor/loop.ts`) auto-files those SUGGESTIONs as follow-up backlog issues rather than dropping them. A terminal `CLEAN` state may therefore still carry filed follow-up issues to review later.

## Quality Gates

Run these before committing. Fix failures before proceeding:
1. **Typecheck**: `<project typecheck command>` (see project's `package.json` or `CLAUDE.md` for the specific command).
2. **Lint**: `<project lint command>`.
3. **Tests**: `<project test command>`.

Do NOT use `--no-verify` to bypass pre-commit hooks. If a hook step is wrong, file a follow-up to fix it — never skip it for the current story.

## Per-Story Record (event log, harness-written)

The per-story factual record is written by the harness supervisor, NOT by the agent. The harness appends structured JSON lines to `.claude/cam-worker-events.jsonl`:

- `kind: "result"` carries `{ outcome, filesChanged, gates, docsValidated }` for each completed story.
- `kind: "tokens"` carries token spend.
- `kind: "worker-start"` / `kind: "worker-end"` carry lifecycle timestamps.

The agent does NOT hand-write a prose progress record. The event log is supervisor-owned and not writable by the agent session.

## Codebase Patterns (durable wisdom)

**Curated invariants** (small, durable, always in context; read in full every story; adapt the placeholders below to this project's actual stack):

- **Runtime**: always use `<project runtime>` built-ins over slower/unsafe equivalents (fill in once the project's stack is known).
- **Type-safety guard**: `<project's strict-mode flag, e.g. noUncheckedIndexedAccess>`, if the language config enables one; array indexing / capture groups may be `T | undefined` and must be guarded.
- **UI success/failure signal** (if the project has a TUI/CLI output layer): use the convention already established there, never an ad-hoc one.
- **Never add a `--permission-mode` flag** to any subcommand; permission mode is fixed by the harness, not a CLI knob.
- **Quality gates**: `<project typecheck command>`, `<project test command>`, `<project lint command>` always green before commit.
- **Test quality**: hit real I/O at wire boundaries (real tmpdir/fs/subprocess); behavioral DI-fakes are fine, but a test asserting only "the mock was called" is documentation, not verification (no tautological mock-call assertions); if you must mock, document why; poll async waits with `waitForCondition`, never a fixed `setTimeout`; every acceptance-criterion oracle and every in-test assertion must be swept red-against-main before being trusted as falsifiable (no tautological oracles, see patterns.md). Detail in `scripts/cam/patterns.md`.

**Invariant vs. pattern routing**: a new insight that is durable, project-wide, and worth loading every story goes into the curated block above. Everything else (a one-off gotcha, a library quirk, a narrower convention) is appended as a bullet to `scripts/cam/patterns.md` (durable, versioned on main, never truncated) instead of growing this block.

`scripts/cam/patterns.md` is grep-on-demand, not a mandatory full read: grep it for the section/keywords matching the subsystem this story touches and read only the matching bullets. When a story reveals a new reusable insight that isn't a durable invariant, append a bullet to `scripts/cam/patterns.md`.

## Knowledge-Layer Routing

When a story produces a new insight, route it to exactly one canonical channel using this table:

| Insight type | Canonical channel | Notes |
|---|---|---|
| Technical/reusable pattern, library quirk, gotcha | `scripts/cam/patterns.md` | Append a bullet; never truncate |
| Cycle narrative, structured observation, history | `scripts/cam/journal.md` | One entry per story cycle |
| Cross-cutting decision, stakeholder policy | `memory/` | One file per decision, named `memory/project_<topic>.md` |
| Architectural decision (hard-to-reverse + surprising + genuine trade-off) | `docs/adr/` | Write an ADR only when all three gates pass; see Domain Model Convention |
| Term definition, bounded-context vocabulary | `CONTEXT.md` (repo root) | Glossary-only; no implementation details |

**Reading `CONTEXT.md`:** it is the domain glossary, and it is grep-on-demand exactly like `patterns.md`. Grep it for the term in question and read only the matching entry. Never read it whole: it is large, and a full read spends the session's context on vocabulary the story does not touch.

**Naming convention:** UPPERCASE.md (CLAUDE, CONTEXT, README, CHANGELOG, AGENTS) is an external-convention entry-point, visible to humans and tooling that expect a conventional filename. lowercase.md (journal, patterns) is a cam-internal artifact. This casing split is BY DESIGN; do not force single casing.

**Location convention:** `scripts/cam/` is cam-harness knowledge (state files, agent instructions, knowledge-layer artifacts). Repo root plus `docs/` is the project domain model (CONTEXT.md, docs/adr/, README, CHANGELOG). Do not move `journal.md` or `patterns.md` out of `scripts/cam/`, and do not move `CONTEXT.md` or `docs/adr/` into it.

**Marking a `patterns.md` bullet resolved:** once a bullet documents a one-time, already-resolved mechanic rather than a living invariant, prefix it with `[resolved YYYY-MM]` immediately after the leading `- ` (e.g. `- [resolved 2026-06] **title** ...`). `gship patterns archive` moves every bullet carrying this marker, verbatim, into `scripts/cam/patterns.archive.md` in one on-main commit; unmarked bullets are left in place. Never mark a durable invariant (Bun runtime, permission-mode, `claude -p` forbidden, `noUncheckedIndexedAccess`, Ink success/failure glyph, single-hub dispatch, sidecar-supervisor) this way.

## Domain Model Convention

The durable domain model for any cam-managed project lives at two pinned locations:

- `CONTEXT.md` at the repo root: active vocabulary channel populated via the CAM-118 deterministic writer. Glossary-only (no implementation details, no specs, no decisions).
- `docs/adr/` at the repo root: Architectural Decision Records. Created lazily: when the first ADR is needed.

**Glossary-only vs ADR-worthy:**
- Glossary (`CONTEXT.md`): canonical terminology, bounded-context definitions, and ubiquitous language. Nothing about implementation. No specs, no decisions.
- ADR (`docs/adr/`): write one only when all three gates pass: (1) hard to reverse, (2) surprising without context, (3) the result of a real trade-off with genuine alternatives considered. If any gate is missing, skip the ADR.

This convention applies to cam-cli itself and to any downstream cam project initialized by `gship init`. `CONTEXT.md` is populated by the CAM-118 deterministic writer (do not pre-create an empty stub). `docs/adr/` is created lazily: when the first ADR is needed (do not pre-create an empty directory).

**Self-improvement sources:** the domain model cross-references two knowledge layers:
- `scripts/cam/patterns.md`: durable codebase patterns, gotchas, and invariants (versioned on main, never truncated). Grep-on-demand, never a full read: agents grep it for the section/keywords matching the subsystem the story touches and read only the matching bullets.
- CAM-64 (Mulch knowledge central): future machine-readable knowledge graph fed by the spec layer. Terms and decisions written into CONTEXT.md and docs/adr/ during a spec session will eventually flow into this central store.

## Cross-Repo PRDs (optional, agent-self-executed, unvalidated)

Some PRDs span multiple repos. A PRD may declare a top-level `crossRepoLayout` block mapping logical repo names to absolute filesystem paths:

```json
"crossRepoLayout": {
  "main-repo": "~/Documents/Projects/main-repo",
  "other-repo": "~/Documents/Projects/other-repo"
}
```

Per-story routing is driven by the optional `repo` field on each `userStories[]` entry (default `"main-repo"`). When the implementer picks a story whose `repo` is not the default, it `cd`s into the corresponding path BEFORE reading the story's files or running `git` commands. The harness state files (`prd.json`, `handoff.json`) always live in the main repo; `patterns.md` is durable and versioned on main; the event log (`.claude/cam-worker-events.jsonl`) is per-project but supervisor-owned. Only the story's source edits move cwd.

**This is agent-self-executed, not harness-driven.** The TS supervisor does NOT read the repo field or the `crossRepoLayout` block: it has zero code path that inspects either. There is no validation that a declared repo path exists, is a git repo, or is reachable; a bad path silently produces a wrong-cwd story with no supervisor-level error. The subagent-planner does NOT emit `crossRepoLayout` or `repo`: these fields only appear in hand-authored PRDs, and only the implementer agent (by reading its own instructions and doing the `cd` itself) makes cross-repo routing happen. Treat this whole section as a documented, fragile, unvalidated escape hatch for hand-authored PRDs, not a supported harness feature. Real harness support (supervisor repo-awareness, planner emission, gate-routing, layout validation) is tracked as a future epic, CAM-241 (related to CAM-147).

## Release Conventions

**Squash-merge tag-timing decision:** `gship ship --bump` commits the version
bump on the feature branch. After the PR squash-merges to main, the branch SHA
is gone and tagging it is wrong. Always run `gship tag` on main (after
`git pull origin main`) to create and push the `vX.Y.Z` tag at the correct
main HEAD SHA.
