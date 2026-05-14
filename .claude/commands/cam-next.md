## Pre-flight Checks (run in this session)

Run these checks yourself, in the current session, before delegating the story. They're cheap and they fail fast; running them once per invocation is saner than running them inside every subagent.

1. **Sync with remote**:
   First fetch all refs (including main), then check if the remote tracking branch exists:
   ```bash
   git fetch origin
   git rev-parse --verify origin/$(git branch --show-current) >/dev/null 2>&1
   ```
   - **If it exists**: `git pull origin $(git branch --show-current)` to get updates.
   - **If it doesn't exist**: `git push -u origin $(git branch --show-current)` to create it (this means `/cam-plan` didn't push — fix it now).
2. **Check working tree**:
   ```bash
   git status
   ```
   If there are uncommitted changes, warn the user and ask how to proceed.
3. **Typecheck**:
   Run the project's typecheck command (e.g. `npm run typecheck`, `bun run typecheck`, `npx tsc --noEmit`).
   If it fails, fix the type errors before proceeding.
4. **Tests**:
   Run the project's test command (e.g. `npm run test`, `bun test`).
   If tests fail, fix them before proceeding.

Only proceed once all pre-flight checks pass.

---

## Emitting the COMPLETE promise — verbatim format

When the Branch decision matrix (below) tells you to emit COMPLETE, you must output **exactly** this string, on its own line, with no decoration:

```
<promise>COMPLETE</promise>
```

**DO NOT emit plain text like this:**

```
COMPLETE
```

Plain `COMPLETE` without the XML wrapper **never matches**. The plugin's Stop hook (`stop-hook.sh`) does a case-sensitive literal-string match on the first `<promise>...</promise>` tag it finds in your last assistant text block. A bare word, even in all-caps, is invisible to the hook and the loop will not terminate.

Rules:
- Emit it **on its own line**.
- Emit it **exactly once** per turn.
- Emit it **only** when the conditions in the Branch decision matrix are met (see below).
- Do not wrap it in a fenced code block when actually emitting it — only the example above is in a fence.

---

## Branch decision: implementer, reviewer, or COMPLETE?

Before dispatching anything, read `scripts/cam/prd.json` and decide what this iteration should do:

| Condition | Action |
|---|---|
| Any story has `passes: false` | Dispatch **implementer** subagent (skip to next section) |
| All stories `passes: true` AND `prd.review?.lastVerdict === "CLEAN"` | Emit `<promise>COMPLETE</promise>` and stop. Cam-loop terminates. |
| All stories `passes: true` AND `prd.review?.lastVerdict === "MAX_ROUNDS_DEBT"` | Emit `<promise>COMPLETE</promise>` and stop. Ship with debt. |
| All stories `passes: true` AND `prd.review?.roundsCompleted >= prd.review?.maxRounds` (default 3) | Emit `<promise>COMPLETE</promise>` and stop. Cap reached. |
| All stories `passes: true` AND not yet reviewed (or `lastVerdict === "FIXES_PENDING"` from previous round, fixes now landed) | Auto-dispatch **`/cam-review`** (it spawns the `subagent-reviewer` and updates the PRD review state). After it completes, emit nothing — the next cam-loop iteration re-enters here, sees the new state, and decides again. |

**Why auto-dispatch /cam-review and not `subagent-reviewer` directly?** The `/cam-review` command owns the post-review bookkeeping (parsing `<review>` tag, creating `US-RX-NNN` stories, updating `prd.review` state). Calling `subagent-reviewer` without that wrapper drops the autonomous-loop semantics on the floor.

**`<promise>COMPLETE</promise>` etiquette**: emit it on its own line, exactly once, and only when the conditions above are met. The plugin's Stop hook does a literal-string match on the first `<promise>...</promise>` in your last assistant block. Don't decorate.

---

## Delegate the story to a fresh subagent

Every story runs in its own fresh Task subagent. The parent session owns scheduling (pre-flight, status parsing, next-step guidance) but never implements — that guarantees zero context bleed between stories in a long-lived orchestrator session (like the tmux runner).

Invoke the implementer:

```
Task(
  subagent_type="subagent-implementer",
  description="Implement next story",
  prompt="""
Implement the next user story from scripts/cam/prd.json per your AGENT.md.
Branch: <current branch name>
Return with one of the CAM_IMPLEMENTER_STATUS= lines on your last line.
"""
)
```

The subagent reads `handoff.json`, `progress.txt`, `prd.json`, picks the highest-priority `passes: false` story, implements it, runs quality gates, commits, runs Step 5.5 docs validation, writes `handoff.json`, and pushes. You don't repeat that logic here — it's in the subagent's AGENT.md.

---

## Parse the status line and act

Read the last line of the subagent's output. Match one of:

### `CAM_IMPLEMENTER_STATUS=DONE story=US-XXX`

The story is committed and pushed. Show a concise status block:

```
📋 Progress: {done}/{total} stories complete, {remaining} remaining.

Next story: {US-ID} - {title}
Run /cam-next in a new conversation (or the orchestrator will do it).
```

If `done == total` after this story, the next cam-loop iteration will hit the **Branch decision** matrix above.

### `CAM_IMPLEMENTER_STATUS=PRD_COMPLETE`

The PRD was already fully passing when the implementer ran. Log the inconsistency and re-evaluate the matrix:
- All `passes:true` AND `lastVerdict !== "CLEAN"` AND under cap → run `/cam-review`
- All `passes:true` AND `lastVerdict === "CLEAN"` → emit `<promise>COMPLETE</promise>`

Do not re-invoke the implementer.

### `CAM_IMPLEMENTER_STATUS=BLOCKED_QUALITY story=US-XXX reason=...`

Surface to the user. Show the subagent's summary verbatim plus:

```
⚠ Story US-XXX blocked on quality gate: <reason>

Recommended actions:
- Inspect the failing output in the subagent transcript above
- Fix the root cause locally or mark the story blocked in prd.json
- Do NOT re-run /cam-next until resolved — you'd just re-hit the gate
```

### `CAM_IMPLEMENTER_STATUS=BLOCKED_AMBIGUITY story=US-XXX question=...`

The acceptance criteria are under-specified. Show:

```
❓ Story US-XXX blocked on ambiguity: <question>

The subagent appended the question to handoff.json.openQuestions.
Update prd.json or the issue to resolve, then re-run /cam-next.
```

### `CAM_IMPLEMENTER_STATUS=RATE_LIMIT`

Hit Anthropic rate-limit mid-story. Wait for the limit to reset and run again — the partial work left by the subagent is re-done fresh on retry.

---

## IMPORTANT

Work on **ONE** story only. After the subagent returns, stop. Do not re-invoke automatically — the orchestrator (tmux runner or the human) decides when to run `/cam-next` again.

The parent session's context stays shallow on purpose: pre-flight output, one Task spawn, a status line, and a summary. If you notice your context growing past that, something is wrong.
