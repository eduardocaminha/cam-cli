# Cam Agent Instructions

## Your Task

1. The story to implement is provided in the spawn prompt (`id`, `title`, `description`, `priority`, `requires`, `acceptanceCriteria`, and `branchName`); you do not read `prd.json` in full to self-select it.
2. Read `handoff.json` (if it exists) for context from the previous story iteration.
3. The curated invariants block ("Codebase Patterns" section below, already in context) covers durable project rules. For anything else, grep `scripts/cam/patterns.md` for the section/keywords matching the subsystem this story touches and read only the matching bullets, not the whole file.
4. Check you are on the correct branch from the `branchName` given in the spawn prompt. If not, check it out or create from main.
5. Implement that single user story.
6. Run quality checks (typecheck, lint, test).
7. If checks pass, commit ALL changes with message: `feat: [Story ID] - [Story Title]`.
8. Update the PRD to set `passes: true` for the completed story.
9. Validate against official library docs (Step 5.5 in the agent SYSTEM PROMPT): one targeted fetch against the lib the story touched.
10. Write `handoff.json` for the next iteration (schema: `handoff.schema.json`). Include the Step 5.5 validation entries in `officialDocsValidated`.
11. Push: `git push origin $(git branch --show-current)`.
12. Print your status line: `CAM_IMPLEMENTER_STATUS=DONE story=US-XXX`.

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

**Curated invariants** (small, durable, always in context; read in full every story; adapt the placeholders below to this project's actual stack):

- **Runtime**: always use `<project runtime>` built-ins over slower/unsafe equivalents (fill in once the project's stack is known).
- **Type-safety guard**: `<project's strict-mode flag, e.g. noUncheckedIndexedAccess>`, if the language config enables one; array indexing / capture groups may be `T | undefined` and must be guarded.
- **UI success/failure signal** (if the project has a TUI/CLI output layer): use the convention already established there, never an ad-hoc one.
- **Never add a `--permission-mode` flag** to any subcommand; permission mode is fixed by the harness, not a CLI knob.
- **Quality gates**: `<project typecheck command>`, `<project test command>`, `<project lint command>` always green before commit.

**Invariant vs. pattern routing**: a new insight that is durable, project-wide, and worth loading every story goes into the curated block above. Everything else (a one-off gotcha, a library quirk, a narrower convention) is appended as a bullet to `scripts/cam/patterns.md` (durable, versioned on main, never truncated) instead of growing this block.

`scripts/cam/patterns.md` is grep-on-demand, not a mandatory full read: grep it for the section/keywords matching the subsystem this story touches and read only the matching bullets. When a story reveals a new reusable insight that isn't a durable invariant, append a bullet to `scripts/cam/patterns.md`.

## Cross-Repo PRDs (optional)

Some PRDs span multiple repos. A PRD may declare a top-level `crossRepoLayout` block mapping logical repo names to absolute filesystem paths:

```json
"crossRepoLayout": {
  "main-repo": "~/Documents/Projects/main-repo",
  "other-repo": "~/Documents/Projects/other-repo"
}
```

Per-story routing is driven by the optional `repo` field on each `userStories[]` entry (default `"main-repo"`). When the implementer picks a story whose `repo` is not the default, it `cd`s into the corresponding path BEFORE reading the story's files or running `git` commands. The harness state files (`prd.json`, `handoff.json`) always live in the main repo; `patterns.md` is durable and versioned on main; the event log (`.claude/cam-worker-events.jsonl`) is per-project but supervisor-owned. Only the story's source edits move cwd.
