# Cam Agent Instructions

## Your Task

1. Read the PRD at `prd.json` (in the same directory as this file).
2. Read `handoff.json` (if it exists) for context from the previous story iteration.
3. Read `scripts/cam/patterns.md` for durable project conventions (codebase patterns, gotchas, invariants).
4. Check you're on the correct branch from PRD `branchName`. If not, check it out or create from main.
5. Pick the **highest priority** user story where `passes: false` and `requires != "operator"`.
6. Implement that single user story.
7. Run quality checks (typecheck, lint, test).
8. If checks pass, commit ALL changes with message: `feat: [Story ID] - [Story Title]`.
9. Update the PRD to set `passes: true` for the completed story.
10. Validate against official library docs (Step 5.5 in `.claude/commands/cam-next.md`): one targeted fetch against the lib the story touched.
11. Write `handoff.json` for the next iteration (schema: `handoff.schema.json`): include the Step 5.5 validation entries in `officialDocsValidated`.
12. Push: `git push origin $(git branch --show-current)`.
13. Print your status line: `CAM_IMPLEMENTER_STATUS=DONE story=US-XXX`.

## Stop Condition

The cam-loop terminates when the orchestrator (`/cam-next`) detects that all non-operator stories have `passes: true` AND the review cycle is complete (`prd.review.lastVerdict === "CLEAN"` or `"MAX_ROUNDS_DEBT"`).

Stories with `requires: "operator"` are **out-of-scope** for autonomous implementation — they are operator ceremonies (TUI keypress, real-API hit, screencap, etc.). The loop falls through to the next implementable story; the operator hand-executes the ceremony and flips `passes: true` manually.

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

Reusable patterns, project conventions, library quirks, and gotchas live in `scripts/cam/patterns.md` (durable, versioned on main, never truncated). This replaces the old `## Codebase Patterns` block that used to sit at the top of `progress.txt`.

When a story reveals a new reusable insight, append a bullet to `scripts/cam/patterns.md`. Example patterns that may already be documented there:

- Bun runtime: always use Bun built-ins over Node.js equivalents.
- `noUncheckedIndexedAccess`: array indexing and regex capture groups are `T | undefined`.
- Commits: conventional commits required (`feat:`, `fix:`, `chore:`).

Read `scripts/cam/patterns.md` at story start (step 3 above) so the patterns are in context before you touch files.

## Cross-Repo PRDs (optional)

Some PRDs span multiple repos. A PRD may declare a top-level `crossRepoLayout` block mapping logical repo names to absolute filesystem paths:

```json
"crossRepoLayout": {
  "main-repo": "~/Documents/Projects/main-repo",
  "other-repo": "~/Documents/Projects/other-repo"
}
```

Per-story routing is driven by the optional `repo` field on each `userStories[]` entry (default `"main-repo"`). When the implementer picks a story whose `repo` is not the default, it `cd`s into the corresponding path BEFORE reading the story's files or running `git` commands. The harness state files (`prd.json`, `handoff.json`) always live in the main repo; `patterns.md` is durable and versioned on main; the event log (`.claude/cam-worker-events.jsonl`) is per-project but supervisor-owned. Only the story's source edits move cwd.
