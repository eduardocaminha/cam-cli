## Pre-flight Checks (run in this session)

Run these checks yourself, in the current session, before the supervisor starts. They are cheap and fail fast.

1. **Sync with remote**:
   First fetch all refs (including main), then check if the remote tracking branch exists:
   ```bash
   git fetch origin
   git rev-parse --verify origin/$(git branch --show-current) >/dev/null 2>&1
   ```
   - **If it exists**: `git pull origin $(git branch --show-current)` to get updates.
   - **If it does not exist**: `git push -u origin $(git branch --show-current)` to create it (this means `/cam-plan` did not push; fix it now).
2. **Check working tree**:
   ```bash
   git status
   ```
   If there are uncommitted changes, warn the user and ask how to proceed.
3. **Typecheck**:
   Run `bun run typecheck`. If it fails, fix type errors before proceeding.
4. **Tests**:
   Run `bun test`. If tests fail, fix them before proceeding.

Only proceed once all pre-flight checks pass.

---

## Architecture: deterministic TS supervisor

`cam next` does NOT dispatch a Task subagent. It calls `runSupervisor()` directly in the current TypeScript process. The supervisor owns the full implement-review-complete loop:

```
cam next
  └── runSupervisor(options)
        ├── decideNextAction(prd)        -- implement | review | complete | blocked
        ├── respawn-pane -k <worker-pane> <claude-argv>
        │     worker = claude -p --permission-mode <mode>
        │               --session-id <uuid>
        │               --output-format json
        │               --agent <name>
        │               "<task-prompt>"
        ├── tmux wait-for <channel>      -- blocks until worker exits + signals
        ├── capture-pane -p              -- scrape pane for CAM_*_STATUS sentinel
        └── loop until: complete | blocked | max-iterations
```

Workers (implementer and reviewer) are real separate `claude -p` sessions. Each story runs in a **reused worker pane**: `respawn-pane -k` kills the previous command and starts the next one in the same pane id. The worker pane id is written by `cam plan` to `.claude/.cam-worker-pane` and read by the supervisor on every iteration.

**Stop-hook driver is retired.** The old model (vendor/cam-loop-stop-hook.sh injecting `/cam-next` on each assistant turn) is gone. Workers are real per-story `claude -p` sessions that exit on their own; the supervisor waits on a `tmux wait-for` channel instead of relying on a stop hook.

---

## Worker entrypoint

Workers are invoked as `--agent <name>` agents, not as slash commands:

```
claude -p \
  --permission-mode <mode> \
  --session-id <uuid> \
  --output-format json \
  --agent subagent-implementer \
  "<task-prompt>"
```

There is no `/cam-implement` slash command. The implementer and reviewer are agents (`subagent-implementer`, `subagent-reviewer`) defined in `.claude/agents/`.

The task prompt for the implementer is:

```
Implement the next user story from scripts/cam/prd.json per your AGENT.md.
Branch: <current-branch>
Return with one of the CAM_IMPLEMENTER_STATUS= lines on your last line.
```

---

## Worker exit contract (CAM_IMPLEMENTER_STATUS sentinel)

Every implementer worker must print exactly one of these lines as the **last line** of its output. The supervisor scrapes the worker pane with `capture-pane -p` and matches this sentinel to decide the next action.

| Status line | Meaning |
|---|---|
| `CAM_IMPLEMENTER_STATUS=DONE story=US-XXX` | Story implemented, committed, handoff written, pushed. |
| `CAM_IMPLEMENTER_STATUS=PRD_COMPLETE` | Worker found nothing to implement (stories already passing). Supervisor re-evaluates via `decideNextAction` (review, await-operator, or complete). |
| `CAM_IMPLEMENTER_STATUS=BLOCKED_QUALITY story=US-XXX reason=<short>` | Quality gate failed repeatedly; story still `passes: false`. Supervisor surfaces to operator. |
| `CAM_IMPLEMENTER_STATUS=BLOCKED_AMBIGUITY story=US-XXX question=<short>` | Story acceptance criteria are ambiguous. Worker documents in `openQuestions` and exits. |
| `CAM_IMPLEMENTER_STATUS=BLOCKED_OPERATOR_REQUIRED story=US-XXX reason=<short>` | Story has `requires: "operator"`. Worker exits without touching files. |
| `CAM_IMPLEMENTER_STATUS=RATE_LIMIT` | Hit Anthropic rate-limit mid-story; partial work left uncommitted. |

The sentinel is consumed by the TS supervisor (`src/supervisor/result.ts`). It is NOT consumed by a stop-hook script.

---

## Branch decision: implement, review, or complete?

Before dispatching a worker, `decideNextAction` reads `scripts/cam/prd.json` and returns one of:

Decision order (operator-required stories do **not** block the review cycle: review runs first, the operator ceremony is the final seal over reviewed, stable code):

| Condition | Action |
|---|---|
| Any **non-operator** story has `passes: false` | Dispatch implementer worker (lowest `priority`, then `id` asc). |
| All non-operator stories `passes: true` AND review **not** terminal (`lastVerdict` is `null` or `"FIXES_PENDING"`, and `roundsCompleted < maxRounds`) | Dispatch reviewer worker (`subagent-reviewer`). A pending operator-required story does **not** block this. After it finishes, supervisor re-evaluates. |
| All non-operator stories `passes: true` AND review terminal (`"CLEAN"` / `"MAX_ROUNDS_DEBT"` / cap reached) AND an operator-required story is still `passes: false` | **Await operator** (`await-operator`, status `awaiting-operator`). Autonomous work is done and reviewed clean; the supervisor exits **0** and hands the ceremony to the operator. The operator runs it, flips the story to `passes: true`, and re-runs `cam next` to complete the PRD. |
| All stories `passes: true` (incl. operator) AND review terminal (`"CLEAN"` / `"MAX_ROUNDS_DEBT"` / cap reached) | Complete. Supervisor exits 0. |

The supervisor loops internally until it reaches a terminal state. The orchestrator process running `cam next` does not need to re-invoke itself.

---

## IMPORTANT

The supervisor drives **one story per worker invocation**. After each worker exits, it reads the outcome, updates state, and dispatches the next worker. It does not return control to an external orchestrator between stories.

The parent `cam next` process context stays shallow on purpose: pre-flight output, supervisor call, a terminal status, and a summary. The supervisor itself is fully injectable and unit-tested in `test/supervisor/`.
