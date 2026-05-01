# Cam Agent Instructions

## Your Task

1. Read the PRD at `prd.json` (in the same directory as this file).
2. Read `handoff.json` (if it exists) for context from the previous story iteration.
3. Read the progress log at `progress.txt` (check the `## Codebase Patterns` section first).
4. Check you're on the correct branch from PRD `branchName`. If not, check it out or create from main.
5. Pick the **highest priority** user story where `passes: false` and `requires != "operator"`.
6. Implement that single user story.
7. Run quality checks (typecheck, lint, test).
8. If checks pass, commit ALL changes with message: `feat: [Story ID] - [Story Title]`.
9. Update the PRD to set `passes: true` for the completed story.
10. Append your progress to `progress.txt`.
11. Validate against official library docs (Step 5.5 in `.claude/commands/cam-next.md`): one targeted fetch against the lib the story touched.
12. Write `handoff.json` for the next iteration (schema: `handoff.schema.json`) — include the Step 5.5 validation entries in `officialDocsValidated`.
13. Push: `git push origin $(git branch --show-current)`.
14. Print your status line: `CAM_IMPLEMENTER_STATUS=DONE story=US-XXX`.

## Stop Condition

The cam-loop terminates when the orchestrator (`/cam-next`) detects that all non-operator stories have `passes: true` AND the review cycle is complete (`prd.review.lastVerdict === "CLEAN"` or `"MAX_ROUNDS_DEBT"`).

Stories with `requires: "operator"` are **out-of-scope** for autonomous implementation — they are operator ceremonies (TUI keypress, real-API hit, screencap, etc.). The loop falls through to the next implementable story; the operator hand-executes the ceremony and flips `passes: true` manually.

## Quality Gates

Run these before committing. Fix failures before proceeding:
1. **Typecheck**: `<project typecheck command>` (see project's `package.json` or `CLAUDE.md` for the specific command).
2. **Lint**: `<project lint command>`.
3. **Tests**: `<project test command>`.

Do NOT use `--no-verify` to bypass pre-commit hooks. If a hook step is wrong, file a follow-up to fix it — never skip it for the current story.

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

- **Auth**: all API routes must call `getUser()` from `lib/auth.ts` and return 401 if null.
- **Errors**: API errors follow `{ error: string }` shape with appropriate HTTP status.
- **Tests**: use `bun test` from repo root; test files live next to the source file as `*.test.ts`.
- **Commits**: conventional commits required (`feat:`, `fix:`, `chore:`).
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

Per-story routing is driven by the optional `repo` field on each `userStories[]` entry (default `"main-repo"`). When the implementer picks a story whose `repo` is not the default, it `cd`s into the corresponding path BEFORE reading the story's files or running `git` commands. The harness state files (`prd.json`, `progress.txt`, `handoff.json`) always live in the main repo — only the story's source edits move cwd.
