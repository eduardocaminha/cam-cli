# Cam Agent Instructions

## Your Task

1. Read the PRD at `prd.json` (in the same directory as this file).
2. Read `handoff.json` (if it exists) for context from the previous story iteration.
3. Read the progress log at `progress.txt` (check the `## Codebase Patterns` section first).
4. Check you are on the correct branch from PRD `branchName`. If not, check it out or create from main.
5. Pick the **highest priority** user story where `passes: false` and `requires != "operator"`.
6. Implement that single user story.
7. Run quality checks (typecheck, lint, test).
8. If checks pass, commit ALL changes with message: `feat: [Story ID] - [Story Title]`.
9. Update the PRD to set `passes: true` for the completed story.
10. Append your progress to `progress.txt`.
11. Validate against official library docs (Step 5.5 in the agent SYSTEM PROMPT): one targeted fetch against the lib the story touched.
12. Write `handoff.json` for the next iteration (schema: `handoff.schema.json`). Include the Step 5.5 validation entries in `officialDocsValidated`.
13. Push: `git push origin $(git branch --show-current)`.
14. Print your status line: `CAM_IMPLEMENTER_STATUS=DONE story=US-XXX`.

## Stop Condition

The cam-loop terminates when the TS supervisor (`runSupervisor` in `src/supervisor/loop.ts`) detects that all non-operator stories have `passes: true` AND the review cycle is complete (`prd.review.lastVerdict === "CLEAN"` or `"MAX_ROUNDS_DEBT"`). The supervisor is driven by `cam next`, not by a stop-hook or `/cam-next` re-inject.

Stories with `requires: "operator"` are **out-of-scope** for autonomous implementation (operator ceremonies: TUI keypress, real-API hit, screencap, etc.). The loop falls through to the next implementable story; the operator hand-executes the ceremony and flips `passes: true` manually.

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

## Progress Report Format

Append to `progress.txt` after each story:

```
## [YYYY-MM-DD HH:MM] - [Story ID]: [Story Title]

### What was done
- [bullet list of changes]

### Files changed
- [file paths]

### Quality gates
- Typecheck: ok
- Lint: ok
- Tests: <count> pass

### Step 5.5 docs validation
- lib: <name>, status: <ok|corrected|no_external_lib_touched|fetch_failed>

### Notes
- [any patterns, gotchas, or next-story context worth preserving]
---
```

If you discovered a reusable pattern (a project convention, a quirk of a library, a gotcha in the codebase), **add it to the `## Codebase Patterns` block at the top of `progress.txt`**. This is the fastest way to propagate learnings across stories without re-reading the whole codebase.

## Codebase Patterns Block

The `## Codebase Patterns` block lives at the very top of `progress.txt`. Example:

```
## Codebase Patterns

- **Bun runtime**: always `Bun.spawn` / `Bun.$` / `Bun.file` over `node:child_process` / `node:fs`.
- **Permission mode**: never register a `--permission-mode` CLI flag on any subcommand (enforced by `test/no-permission-mode-flag.test.ts`).
- **noUncheckedIndexedAccess**: array indexing and regex capture groups are `T | undefined`. Guard with `?? fallback` or a justified non-null assertion.
- **Ink screens**: success/failure is signalled by the glyph (✓ accent / ✗ destructive), never by divider color. Render and look at the real output; do not trust header comments (see `lessons.md` 2026-06-05).
- **Tests**: `bun test` from repo root; test files live under `test/`, mirroring source. Inject fake reader/writer shapes instead of touching real stdin/stdout.
- **Commits**: conventional commits required (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`).
```

Update this block whenever a story reveals a new reusable insight.

## Cross-Repo PRDs (optional)

Some PRDs span multiple repos. A PRD may declare a top-level `crossRepoLayout` block mapping logical repo names to absolute filesystem paths:

```json
"crossRepoLayout": {
  "main-repo": "~/Documents/Projects/main-repo",
  "other-repo": "~/Documents/Projects/other-repo"
}
```

Per-story routing is driven by the optional `repo` field on each `userStories[]` entry (default `"main-repo"`). When the implementer picks a story whose `repo` is not the default, it `cd`s into the corresponding path BEFORE reading the story's files or running `git` commands. The harness state files (`prd.json`, `progress.txt`, `handoff.json`) always live in the main repo. Only the story's source edits move cwd.
