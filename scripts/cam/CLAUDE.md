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

The cam-loop reaches a terminal state when the TS supervisor (`runSupervisor` in `src/supervisor/loop.ts`) detects either: (a) **complete**, all stories (including operator ones) have `passes: true` AND the review cycle is terminal (`prd.review.lastVerdict === "CLEAN"` or `"MAX_ROUNDS_DEBT"`); or (b) **awaiting-operator**, all non-operator stories pass AND review is terminal AND one or more `requires: "operator"` stories are still `passes: false`. The supervisor is driven by `cam next`, not by a stop-hook or `/cam-next` re-inject.

Stories with `requires: "operator"` are **out-of-scope** for autonomous implementation (operator ceremonies: TUI keypress, real-API hit, screencap, etc.). They do NOT block the review cycle: the loop implements all non-operator stories, runs review to a terminal verdict, then exits with status `awaiting-operator` (exit 0). The operator hand-executes the ceremony, flips `passes: true` manually, and re-runs `cam next` to complete the PRD.

Note: `requires: "operator"` stories are hand-filed by the operator only (via `/cam-issue`). The subagent-planner no longer emits them (changed in US-003); any story that requires an operator ceremony must be filed manually.

Note: a `CLEAN` verdict is not the same as "no findings." The reviewer can return `CLEAN` while still recording non-blocking SUGGESTIONs; the supervisor's terminal-verdict hook (CAM-189, `src/supervisor/loop.ts`) auto-files those SUGGESTIONs as follow-up backlog issues rather than dropping them. A terminal `CLEAN` state may therefore still carry filed follow-up issues to review later.

## Project Stack

`cam-cli` is the `cam` binary itself: an autonomous Claude Code loop driver.

- **Runtime**: Bun (>= 1.2). Never Node.js, npm, pnpm, or vite. Use `bun <file>`, `bun test`, `bun install`, `bunx`. Prefer `Bun.spawn` / `Bun.$` / `Bun.file` over `node:child_process` / `node:fs`.
- **Language**: TypeScript, strict mode with `noUncheckedIndexedAccess: true` (array/regex-group access is `T | undefined`, always guard).
- **UI**: React 19 rendered to the terminal via Ink 7 (`ink`, `ink-spinner`, `ink-text-input`) for interactive screens (`src/ui/*.tsx`), plus a non-interactive print path (`src/logging/*`) for linear command output. `chalk` for ANSI color.
- **Config / data**: TOML for project config (`src/config/toml.ts`, `scripts/cam/project.toml`), `js-yaml` for YAML, JSON for PRD/handoff state.
- **External processes**: `cam` shells out to `claude` (the Claude Code CLI), `tmux` (every session is a tmux split), `git`, and optionally `gh` / the Linear GraphQL API.
- **Distribution**: single-file binary via `bun build --compile` (`bun run build:release`); upstream-vendored files under `vendor/` and `claude-code-harness/` are embedded at build time.

## Quality Gates

Run these before committing. Fix failures before proceeding:
1. **Typecheck**: `bun run typecheck` (= `bunx tsc --noEmit`). Must be zero errors. `vendor/` and `claude-code-harness/` are excluded from typecheck by design.
2. **Tests**: `bun test` (Bun's built-in runner). Test files live under `test/`, mirroring source.
3. **Vendor drift** (only when a story touches `vendor/` or `templates/`): `bun run embed-vendor:check`. Fails if the embedded copy is stale; regenerate with `bun run embed-vendor`.

**Lint**: Biome is configured (`biome.json` at repo root). Run `bun run check:all` to execute the full quality spine, which includes `bunx biome lint --error-on-warnings` (also available standalone as `bun run lint`). CI runs `bun run check:all` as the lint/static gate; PRD planners must include it when specifying quality gates.

Do NOT use `--no-verify` to bypass pre-commit hooks. If a hook step is wrong, file a follow-up to fix it. Never skip it for the current story.

## Per-Story Record (event log, harness-written)

The per-story factual record is written by the harness supervisor, NOT by the agent. The harness appends structured JSON lines to `.claude/cam-worker-events.jsonl`:

- `kind: "result"` carries `{ outcome, filesChanged, gates, docsValidated }` for each completed story.
- `kind: "tokens"` carries token spend.
- `kind: "worker-start"` / `kind: "worker-end"` carry lifecycle timestamps.

The agent does NOT hand-write a prose progress record. The event log is supervisor-owned and not writable by the agent session.

## Codebase Patterns (durable wisdom)

**Curated invariants** (small, durable, always in context; read in full every story):

- **Bun-only**: `Bun.spawn` / `Bun.$` / `Bun.file`, never `node:child_process` / `node:fs` / npm / pnpm / vite.
- **`noUncheckedIndexedAccess`**: array indexing and regex capture groups are `T | undefined`; always guard.
- **Ink success/failure**: signal via the glyph (accent/destructive), never via divider color.
- **Never add a `--permission-mode` flag** to any subcommand; permission mode is fixed by the harness, not a CLI knob.
- **Quality gates**: `bun run typecheck`, `bun test`, `bun run check:all` (lint spine) always; `bun run embed-vendor` + `embed-vendor:check` only when `vendor/`/`templates/` changed.
- **Test quality**: hit real I/O at wire boundaries (real tmpdir/fs/subprocess); behavioral DI-fakes are fine, but a test asserting only "the mock was called" is documentation, not verification (no tautological mock-call assertions); if you must mock, document why; poll async waits with `waitForCondition`, never a fixed `setTimeout`. Detail in `scripts/cam/patterns.md`.

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

**Naming convention:** UPPERCASE.md (CLAUDE, CONTEXT, README, CHANGELOG, AGENTS) is an external-convention entry-point, visible to humans and tooling that expect a conventional filename. lowercase.md (journal, patterns) is a cam-internal artifact. This casing split is BY DESIGN; do not force single casing.

**Location convention:** `scripts/cam/` is cam-harness knowledge (state files, agent instructions, knowledge-layer artifacts). Repo root plus `docs/` is the project domain model (CONTEXT.md, docs/adr/, README, CHANGELOG). Do not move `journal.md` or `patterns.md` out of `scripts/cam/`, and do not move `CONTEXT.md` or `docs/adr/` into it.

**Marking a `patterns.md` bullet resolved:** once a bullet documents a one-time, already-resolved mechanic rather than a living invariant, prefix it with `[resolved YYYY-MM]` immediately after the leading `- ` (e.g. `- [resolved 2026-06] **title** ...`). `cam patterns archive` moves every bullet carrying this marker, verbatim, into `scripts/cam/patterns.archive.md` in one on-main commit; unmarked bullets are left in place. Never mark a durable invariant (Bun runtime, permission-mode, `claude -p` forbidden, `noUncheckedIndexedAccess`, Ink success/failure glyph, single-hub dispatch, sidecar-supervisor) this way.

**Exception (cam-cli only):** `lessons.md` has been retired to `lessons.archive.md` (US-001 of CAM-123). New insights go to the channels above, not to `lessons.archive.md`. This retirement is a cam-cli-specific exception to the etapa-dupla convention in the global CLAUDE.md (section 5, "Capture Lessons"), which records both a chronological diary entry AND a canonical-location entry. For non-cam projects the global etapa-dupla rule still applies in full.

## Domain Model Convention

The durable domain model for any cam-managed project lives at two pinned locations:

- `CONTEXT.md` at the repo root: active vocabulary channel populated via the CAM-118 deterministic writer. Glossary-only (no implementation details, no specs, no decisions).
- `docs/adr/` at the repo root: Architectural Decision Records. Created lazily: when the first ADR is needed.

**Glossary-only vs ADR-worthy:**
- Glossary (`CONTEXT.md`): canonical terminology, bounded-context definitions, and ubiquitous language. Nothing about implementation. No specs, no decisions.
- ADR (`docs/adr/`): write one only when all three gates pass: (1) hard to reverse, (2) surprising without context, (3) the result of a real trade-off with genuine alternatives considered. If any gate is missing, skip the ADR.

This convention applies to cam-cli itself and to any downstream cam project initialized by `cam init`. `CONTEXT.md` is populated by the CAM-118 deterministic writer (do not pre-create an empty stub). `docs/adr/` is created lazily: when the first ADR is needed (do not pre-create an empty directory).

**Self-improvement sources:** the domain model cross-references two knowledge layers:
- `scripts/cam/patterns.md`: durable codebase patterns, gotchas, and invariants (versioned on main, never truncated). Agents read this file at story start to absorb project conventions.
- CAM-64 (Mulch knowledge central): future machine-readable knowledge graph fed by the grill layer. Terms and decisions written into CONTEXT.md and docs/adr/ during a grill session will eventually flow into this central store.

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

**0.x convention:** while the major component of the current version is 0, a
`major` bump (breaking change via `feat!:` or `BREAKING CHANGE:`) is demoted
to a minor increment. Example: `0.1.2 + major -> 0.2.0`, never `1.0.0`.
The rule lives only in `computeNextVersion` (`src/release/version.ts`).
`classifyBump` always returns the raw signal (`major` for breaking); the
demotion is applied at version-compute time. No command produces `1.0.0`
automatically; a 1.0.0 graduation requires a manual operator edit of
`src/version.ts`.

**Squash-merge tag-timing decision:** `cam ship --bump` commits the version
bump on the feature branch. After the PR squash-merges to main, the branch SHA
is gone and tagging it is wrong. Always run `cam tag` on main (after
`git pull origin main`) to create and push the `vX.Y.Z` tag at the correct
main HEAD SHA.

Recovery scenarios for misfired bumps, tag drift, re-tagging, and the manual
1.0.0 escape hatch are documented in `docs/recovery-runbook.md` section (r).
