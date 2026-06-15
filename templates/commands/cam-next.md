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

## Architecture: single-hub dispatch (thin-proxy)

`cam next` is a **thin-proxy** (same model as `cam plan`, `cam issue`, `cam review`, `cam ship`): it detects the live orchestrator session and injects the task prompt into the orchestrator pane via atomic `send-keys`. The orchestrator (Claude agent) then schedules and dispatches workers.

Dispatch flow:

```
cam next
  └── detect live orchestrator (hasSession + orchestratorAlive)
        ├── on miss: bootstrap cam run --no-attach, poll .claude/.cam-orch-ready
        ├── mutex check: refuse if worker-pane already running (3 panes = busy)
        ├── idle check: wait for orchestrator pane to be idle (sendKeysWhenIdle)
        └── atomic send-keys: inject task prompt + Enter (one call, NO -l: -l would make "Enter" literal and never submit)
```

Workers (implementer and reviewer) run as interactive TUI `claude` sessions. Each story runs in the **titled 3rd pane** (reused across stories via `respawn-pane -k`). On completion, the worker:
1. Writes `scripts/cam/worker-report.json` (push report) with outcome, quality-gate results, and notes.
2. Sends a one-line summary to the orchestrator pane via `tmux send-keys` (e.g. `[cam] US-003 DONE: typecheck ok, 42 pass / 0 fail`).

The orchestrator receives the pushed summary line and reads the report file to determine the next action. Scrollback polling is **not** used for completion detection.

**Stop-hook driver is retired.** The old model (a vendored Stop hook injecting `/cam-next` on each assistant turn) is gone. `claude -p` (print mode) is not used for workers; it is reserved for the `cam claude` retry-wrapper feature.

---

## Worker entrypoint

Workers are invoked as interactive TUI sessions via `--agent <name>`, not as slash commands and not with `-p`:

```
claude \
  --permission-mode <mode> \
  --session-id <uuid> \
  --agent subagent-implementer \
  "<task-prompt>"
```

There is no `/cam-implement` slash command. The implementer and reviewer are agents (`subagent-implementer`, `subagent-reviewer`) defined in `.claude/agents/`. `--output-format text` and `; tmux wait-for -S <channel>` are NOT used: the session is interactive TUI, and completion is detected via the pushed report file (`scripts/cam/worker-report.json`).

The task prompt for the implementer is:

```
Implement the next user story from scripts/cam/prd.json per your AGENT.md.
Branch: <current-branch>
Return with one of the CAM_IMPLEMENTER_STATUS= lines on your last line.
```

---

## Worker exit contract (push report + CAM_IMPLEMENTER_STATUS sentinel)

Every implementer worker exits via a two-step push protocol:

1. **Report file**: write `scripts/cam/worker-report.json` with `{ outcome, story, gates, notes }`.
2. **Orchestrator notification**: send a one-line summary to the orchestrator pane via `tmux -L cam send-keys -t %0 '[cam] <story> <outcome>: ...' Enter` (NO `-l`: it would make "Enter" literal and the summary would never submit).

After pushing, the worker prints exactly one of these sentinel lines as the **very last line** of its final message. The orchestrator reads this line (received via send-keys) and the report file to determine the next action. The sentinel is also available as a fallback in the pane scrollback.

| Status line | Meaning |
|---|---|
| `CAM_IMPLEMENTER_STATUS=DONE story=US-XXX` | Story implemented, committed, handoff written, pushed. |
| `CAM_IMPLEMENTER_STATUS=PRD_COMPLETE` | Worker found nothing to implement (stories already passing). Supervisor re-evaluates via `decideNextAction` (review, await-operator, or complete). |
| `CAM_IMPLEMENTER_STATUS=BLOCKED_QUALITY story=US-XXX reason=<short>` | Quality gate failed repeatedly; story still `passes: false`. Supervisor surfaces to operator. |
| `CAM_IMPLEMENTER_STATUS=BLOCKED_AMBIGUITY story=US-XXX question=<short>` | Story acceptance criteria are ambiguous. Worker documents in `openQuestions` and exits. |
| `CAM_IMPLEMENTER_STATUS=BLOCKED_OPERATOR_REQUIRED story=US-XXX reason=<short>` | Story has `requires: "operator"`. Worker exits without touching files. |
| `CAM_IMPLEMENTER_STATUS=RATE_LIMIT` | Hit Anthropic rate-limit mid-story; partial work left uncommitted. |

The sentinel is the primary output the orchestrator parses (received via the pushed send-keys line). It is NOT consumed by a stop-hook script. The report file is the structured machine-readable record; the sentinel is the human-readable summary line pushed to the orchestrator pane.

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

The SIDECAR loops across worker invocations until it reaches a terminal state. The CLI thin-proxy (`cam next`) flips `active:true` and returns immediately; it does NOT drive the loop in-process. The sidecar (background process spawned by `cam run`) reads `active:true` and dispatches workers one at a time until a terminal state.

---

## IMPORTANT

The SIDECAR drives **one story per worker invocation**. After each worker pushes its report file (`scripts/cam/worker-report.json`), the sidecar reads the outcome, updates state, and dispatches the next worker. Workers run in the single titled 3rd pane (mutex prevents concurrent dispatches).

`cam next` (the CLI thin-proxy) exits immediately after flipping `active:true` and sending the optional narration prompt to the orchestrator pane. Pre-flight checks (sync, typecheck, tests) still run in the `cam next` session before the send-keys call.
