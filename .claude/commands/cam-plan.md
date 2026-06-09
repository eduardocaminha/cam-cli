Plan the next issue (or a specific one) by reading the spec and generating a PRD.

## Process

### Step 0: Pre-flight Checks

Run these checks before doing anything else. If any check fails, report the failure and fix it before proceeding.

1. **Ensure local main is current**:
   ```bash
   git checkout main
   git pull origin main
   ```
2. **Prune merged cam branches** — clean up local branches whose PRs were already merged upstream:
   ```bash
   git fetch --prune origin
   for b in $(git for-each-ref --format='%(refname:short)' refs/heads/cam/); do
     merged=$(gh pr list --head "$b" --state merged --json number --jq '.[0].number' 2>/dev/null)
     if [ -n "$merged" ]; then
       echo "Deleting merged branch: $b (PR #$merged)"
       git branch -D "$b"
     fi
   done
   ```
   Skip silently if `gh` isn't available. Do NOT delete branches whose PR is still open or never existed.
3. **Check working tree**:
   ```bash
   git status
   ```
   If there are uncommitted changes, warn the user and ask how to proceed (stash, commit, or discard).
4. **Typecheck**: `bun run typecheck`. If it fails, fix before proceeding.
5. **Tests**: `bun test`. If tests fail, fix before proceeding.

Only proceed to Step 1 once all pre-flight checks pass.

### Step 1: Check for in-progress work

**MANDATORY CHECK — always run this before proceeding.**

Look for ANY of these signals of existing in-progress work:
1. Read `scripts/cam/prd.json` — does it exist and have stories with `passes: false`?
2. Check `git branch --show-current` — are we on a `cam/*` branch that isn't `main`?

**If ANY in-progress work is found**, STOP and ask the user:

```
⚠️  Existing work in progress detected:
- Branch: {branch}
- PRD: {N} stories done, {M} remaining

Options:
1. Continue working on this issue (run /cam-next)
2. Ship this issue first (run /cam-ship)
3. Abandon this issue and start a new one (will overwrite PRD)

Which option?
```

**Do NOT proceed to Step 2 until the user explicitly chooses option 3.**

### Step 2: Pick the issue

First read the configured backend from `scripts/cam/project.toml`: `issue_system` (`none` | `github` | `linear`; `none` is the local-only backend stored in `scripts/cam/issues.local.json`) and `issue_prefix` (the display/team prefix for `none`/`linear`; default `CAM`).

Note: the `cam plan` CLI only ever passes a bare invocation or an integer `N` (it rejects free text). The `/cam-plan` slash additionally accepts a free-text description.

- **No argument**: plan the highest-priority OPEN issue for the backend.
  - `none`: read `scripts/cam/issues.local.json`, filter `state == "open"`, sort by `priority` (`P0` before `P1` before `P2` before `P3`; a missing `priority` sorts last) then by ascending numeric id, take the first.
  - `github`: `gh issue list --state open --limit 5` (pick the top, or ask the user).
  - `linear`: query the active cycle and take the highest-priority open issue.
- **Integer argument `N`** (`70` or `#70`): resolve that issue from the backend.
  - `none`: read `scripts/cam/issues.local.json` and find the issue whose `id == "<issue_prefix>-<N>"` (e.g. `CAM-70`). Use its `title` + `description` as the spec. Stop with a clear error if it is missing or not open.
  - `github`: `gh issue view 70 --json number,title,body,labels,comments,state,url`.
  - `linear`: fetch `<issue_prefix>-<N>` via the Linear API (same path the orchestrator uses).
- **Free-text description** (anything not an integer; reachable only via the slash, never from `cam plan`): use the text as the spec, with no linked issue.

### Step 3: Read context

- Read the resolved issue's full spec (already fetched in Step 2): GitHub via `gh issue view N --json title,body,labels,comments,state,url`, the local `issues.local.json` entry for `none`, or the Linear API result.
- Read `CLAUDE.md` and any `AGENTS.md` files to understand the project stack and conventions.
- Comments frequently carry field evidence, scope corrections, or decisions that never made it into the body — treat them as first-class context.

### Step 4: Identify and read relevant docs

**MANDATORY** — docs are not auto-loaded. Consult them here (once, at plan time) so story implementers pick up the references via PRD `notes` instead of re-reading docs every iteration.

1. From the issue's **Scope** and **Technical notes**, extract the list of files/areas the issue will touch.
2. Cross-reference against the project's doc maintenance table (in `CLAUDE.md` if present) to identify which deep-dive docs correspond to those files.
3. **Read each matched doc** in full. Note constraints, invariants, gotchas, and decisions that stories need to respect.

When generating the PRD in Step 5:
- Add a top-level `"relatedDocs"` field listing the docs you read.
- In each story's `notes`, reference the specific doc section(s) the implementer should re-check before coding.

### Step 5: Consult official library docs

**MANDATORY** — before generating the PRD, check the **official documentation** of any external library the issue touches. This prevents planning in terms of deprecated APIs.

1. From the issue's scope and technical notes, extract the list of external libraries the issue will exercise.
2. For each library, do **one targeted fetch** at the specific API/guide page relevant to the scope.
3. Capture `{ lib, url, version, fetchedAt, summary, status }` for each consulted library.
4. Note any **breaking change / deprecation** in the PRD `notes`.
5. **Graceful failure**: if a fetch fails, record `status: "fetch_failed"` and move on.

### Step 6: Present scope proposal — MANDATORY

Before generating the PRD, the assistant MUST pause and present a structured proposal. **Do NOT proceed to Step 7 without user's explicit approval.**

Use plan mode (via `ExitPlanMode` tool if available), or present as structured markdown and wait for explicit approval:

```markdown
## Analysis
<1 paragraph: what the issue asks for, which files/areas will be touched, which external dependencies are involved, what already exists vs what's new>

## MVP Proposal (fast path)
<User stories for the minimum viable scope — typically 3-5 stories>
- US-001: ...
- US-002: ...

## Launch-ready Proposal (prod-grade)
**Superset of MVP** + the categories below (include only those relevant to the domain):
- US-001 to US-0NN: (includes MVP stories above)
- US-0NN+1: Observability — <structured logs, events, alerts>
- US-0NN+2: Failure modes — <retries / circuit breaker / fallback>
- US-0NN+3: Scale — <concurrency caps / batching / background jobs>
- US-0NN+4: QA visual / E2E — <if the feature has UI>
- US-0NN+5: Recovery runbook — <if the feature goes to real users>

## My recommendation
<1-2 paragraphs with a concrete opinion. Consider: urgency, project stage, whether real users will be affected, cost/benefit of each launch-ready item for THIS domain.>

## Final question
Which path?
(a) MVP — N stories
(b) Launch-ready — M stories (recommendation)
(c) Custom mix — tell me what to adjust
```

**Wait for explicit choice.** If user asks for custom, iterate until convergence.

### Step 7: Generate PRD

Delegate PRD generation to `subagent-planner`:

```
Task(
  subagent_type="subagent-planner",
  description="Generate PRD",
  prompt="""
Issue: #<N> — <title>
Scope approved by operator: <MVP / Launch-ready / Custom — from Step 6>
Stories to include: <list from Step 6 approval>
Related docs: <list from Step 4>
Official docs consulted: <list from Step 5>

Generate scripts/cam/prd.json per your agent instructions.
"""
)
```

The subagent reads the project context (`CLAUDE.md`, `AGENTS.md`) itself and outputs valid JSON. After it completes, read `scripts/cam/prd.json` to continue.

**Schema reference** (for auditing in Step 8):

Rules:
- Output valid JSON.
- Set `branchName` from the backend: `github` uses `cam/pr-<N>-<slug>` (e.g. `cam/pr-21-auth-refactor`); `none`/`linear` use `cam/<issue_prefix>-<N>-<slug>` (e.g. `cam/CAM-21-auth-refactor`). If there is no issue number (free-text description), use `cam/<slug>`.
- Each story must be small enough for one conversation (1-3 files or one well-scoped refactor).
- Order by dependency: DB → server → client → tests → E2E.
- Every story needs typecheck and lint in acceptance criteria.
- UI stories need browser verification AND E2E test.
- Include file paths in the `notes` field.
- Add top-level `"relatedDocs"` listing docs read in Step 4 (empty array `[]` if none).
- Add top-level `"officialDocsConsulted"` as an array of `{ lib, url, version, fetchedAt, summary, status }` (empty array `[]` if no external library touched).
- Stories needing real-user keypress, OS-level action, or human-curated artifact MUST set `requires: "operator"`.

**Minimal PRD schema**:
```json
{
  "issueNumber": 42,
  "branchName": "cam/pr-42-slug",
  "relatedDocs": [],
  "officialDocsConsulted": [],
  "userStories": [
    {
      "id": "US-001",
      "priority": 1,
      "title": "Short imperative title",
      "acceptanceCriteria": ["Criterion 1", "Typecheck passes", "Tests pass"],
      "passes": false,
      "notes": "Files to touch: src/foo.ts. Read docs/bar.md §2 first."
    }
  ]
}
```

### Step 8: Audit the PRD with a fresh subagent

Before branching, hand the generated `scripts/cam/prd.json` to `subagent-auditor`:

```
Task(
  subagent_type="subagent-auditor",
  description="Audit PRD",
  prompt="""
Audit the PRD at `scripts/cam/prd.json` against:
- GitHub issue #<N> (use `gh issue view <N>` if available)
- The deep-dive docs listed in `relatedDocs`
- The repo invariants in your AGENT.md checklist

Return the JSON verdict per your output format.
"""
)
```

Parse the verdict:
- **`verdict: "APPROVE"`** → proceed to Step 9.
- **`verdict: "BLOCK"`** → do NOT branch. Apply the `suggestion` for each `critical` or `important` finding, then re-invoke the auditor. Repeat until APPROVE or 3 loops — after 3 BLOCKs, surface remaining findings to the user.

### Step 9: Create feature branch and commit

**IMPORTANT**: Create the branch BEFORE committing `prd.json` so it never lands on `main`.

```bash
git checkout -b <branchName>   # from main
```

Then:
- Create empty `scripts/cam/progress.txt` (with `## Codebase Patterns` header at the top).
- Commit all cam working files: PRD, progress.txt.
- Push the branch:
  ```bash
  git push -u origin <branchName>
  ```

### Step 10: Show summary

Print the issue title, number of stories, and a table of all stories with priorities.
