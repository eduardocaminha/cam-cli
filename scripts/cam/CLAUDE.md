# Cam Agent Instructions

## Your Task

1. Read the PRD at `prd.json` (in the same directory as this file).
2. Read `handoff.json` (if it exists) for context from the previous story iteration.
3. Read `scripts/cam/patterns.md` for durable project conventions (codebase patterns, gotchas, invariants).
4. Check you are on the correct branch from PRD `branchName`. If not, check it out or create from main.
5. Pick the **highest priority** user story where `passes: false` and `requires != "operator"`.
6. Implement that single user story.
7. Run quality checks (typecheck, lint, test).
8. If checks pass, commit ALL changes with message: `feat: [Story ID] - [Story Title]`.
9. Update the PRD to set `passes: true` for the completed story.
10. Validate against official library docs (Step 5.5 in the agent SYSTEM PROMPT): one targeted fetch against the lib the story touched.
11. Write `handoff.json` for the next iteration (schema: `handoff.schema.json`). Include the Step 5.5 validation entries in `officialDocsValidated`.
12. Push: `git push origin $(git branch --show-current)`.
13. Print your status line: `CAM_IMPLEMENTER_STATUS=DONE story=US-XXX`.

## Stop Condition

The cam-loop reaches a terminal state when the TS supervisor (`runSupervisor` in `src/supervisor/loop.ts`) detects either: (a) **complete**, all stories (including operator ones) have `passes: true` AND the review cycle is terminal (`prd.review.lastVerdict === "CLEAN"` or `"MAX_ROUNDS_DEBT"`); or (b) **awaiting-operator**, all non-operator stories pass AND review is terminal AND one or more `requires: "operator"` stories are still `passes: false`. The supervisor is driven by `cam next`, not by a stop-hook or `/cam-next` re-inject.

Stories with `requires: "operator"` are **out-of-scope** for autonomous implementation (operator ceremonies: TUI keypress, real-API hit, screencap, etc.). They do NOT block the review cycle: the loop implements all non-operator stories, runs review to a terminal verdict, then exits with status `awaiting-operator` (exit 0). The operator hand-executes the ceremony, flips `passes: true` manually, and re-runs `cam next` to complete the PRD.

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

**Lint**: no standalone linter (ESLint/Biome/Prettier) is configured in this repo. The typecheck above is the static gate. Do not add a lint command unless a story explicitly introduces one.

Do NOT use `--no-verify` to bypass pre-commit hooks. If a hook step is wrong, file a follow-up to fix it. Never skip it for the current story.

## Per-Story Record (event log, harness-written)

The per-story factual record is written by the harness supervisor, NOT by the agent. The harness appends structured JSON lines to `.claude/cam-worker-events.jsonl`:

- `kind: "result"` carries `{ outcome, filesChanged, gates, docsValidated }` for each completed story.
- `kind: "tokens"` carries token spend.
- `kind: "worker-start"` / `kind: "worker-end"` carry lifecycle timestamps.

The agent does NOT hand-write a prose progress record. The event log is supervisor-owned and not writable by the agent session.

## Codebase Patterns (durable wisdom)

Reusable patterns, project conventions, library quirks, and gotchas live in `scripts/cam/patterns.md` (durable, versioned on main, never truncated). This replaces the old `## Codebase Patterns` block that used to sit at the top of `progress.txt`.

When a story reveals a new reusable insight, append a bullet to `scripts/cam/patterns.md`. Example patterns already documented there:

- Bun runtime: always `Bun.spawn` / `Bun.$` / `Bun.file` over Node.js equivalents.
- `noUncheckedIndexedAccess`: array indexing and regex capture groups are `T | undefined`.
- Ink screens: signal success/failure with the glyph (accent/destructive), never by divider color.

Read `scripts/cam/patterns.md` at story start (step 3 above) so the patterns are in context before you touch files.

## Domain Model Convention

The durable domain model for any cam-managed project lives at two pinned locations:

- `CONTEXT.md` at the repo root: glossary-only (no implementation details, no specs, no decisions). Created lazily: when the first term is resolved.
- `docs/adr/` at the repo root: Architectural Decision Records. Created lazily: when the first ADR is needed.

**Glossary-only vs ADR-worthy:**
- Glossary (`CONTEXT.md`): canonical terminology, bounded-context definitions, and ubiquitous language. Nothing about implementation. No specs, no decisions.
- ADR (`docs/adr/`): write one only when all three gates pass: (1) hard to reverse, (2) surprising without context, (3) the result of a real trade-off with genuine alternatives considered. If any gate is missing, skip the ADR.

This convention applies to cam-cli itself and to any downstream cam project initialized by `cam init`. Both files are created lazily (do not pre-create empty stubs).

**Self-improvement sources:** the domain model cross-references two knowledge layers:
- `scripts/cam/patterns.md`: durable codebase patterns, gotchas, and invariants (versioned on main, never truncated). Agents read this file at story start to absorb project conventions.
- CAM-64 (Mulch knowledge central): future machine-readable knowledge graph fed by the grill layer. Terms and decisions written into CONTEXT.md and docs/adr/ during a grill session will eventually flow into this central store.

## Cross-Repo PRDs (optional)

Some PRDs span multiple repos. A PRD may declare a top-level `crossRepoLayout` block mapping logical repo names to absolute filesystem paths:

```json
"crossRepoLayout": {
  "main-repo": "~/Documents/Projects/main-repo",
  "other-repo": "~/Documents/Projects/other-repo"
}
```

Per-story routing is driven by the optional `repo` field on each `userStories[]` entry (default `"main-repo"`). When the implementer picks a story whose `repo` is not the default, it `cd`s into the corresponding path BEFORE reading the story's files or running `git` commands. The harness state files (`prd.json`, `handoff.json`) always live in the main repo; `patterns.md` is durable and versioned on main; the event log (`.claude/cam-worker-events.jsonl`) is per-project but supervisor-owned. Only the story's source edits move cwd.

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
