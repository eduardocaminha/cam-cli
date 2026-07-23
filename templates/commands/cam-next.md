## Pre-flight Checks (deterministic, run by `cam next` itself)

`cam next` now runs this preflight itself (US-003, CAM-400) as a gate on the
`active:true` signal write — it is no longer an imperative checklist for this
session to run by hand. The gate: `git fetch origin`, sync with the remote
(pull if the tracking branch exists, else `push -u` to create it), a
clean-tree check, `bun run typecheck`, and `bun test`. A failing preflight
returns nonzero and does NOT flip `active:true`. `cam next --skip-preflight`
bypasses the gate and proceeds straight to the signal write (the resume
escape). See `src/commands/next-preflight.ts`.

---

## Architecture: single-hub dispatch (thin-proxy)

`cam next` is a **thin-proxy** that detects the live orchestrator session and flips `active:true` in `.claude/cam-loop.local.md`. The sidecar (spawned by `cam run`, running in the background) polls that flag and dispatches workers autonomously. `cam next` does NOT inject any task prompt via `send-keys`.

Dispatch flow:

```
cam next
  └── detect live orchestrator (hasSession + orchestratorAlive)
        ├── on miss: bootstrap cam run --no-attach, poll .claude/.cam-orch-ready
        ├── mutex check: refuse if worker-pane already running (3 panes = busy)
        └── flip active:true in .claude/cam-loop.local.md
              [sidecar polls the flag and dispatches the next worker autonomously]
```

Workers (implementer and reviewer) run as interactive TUI `claude` sessions. Each story runs in the **titled 3rd pane** (reused across stories via `respawn-pane -k`). On completion, the worker writes `scripts/cam/worker-report.json` (push report) with outcome, quality-gate results, and notes. The sidecar reads the report file, updates `prd.json`, and emits the `[cam]` narration line to the orchestrator pane via `notifyOrchestrator` (e.g. `[cam] US-003 DONE: typecheck ok, 42 pass / 0 fail`).

The orchestrator receives the pushed narration line and can read the report file for details. Scrollback polling is **not** used for completion detection.

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

The task prompt for the implementer embeds a single, supervisor-selected story (`buildImplementerTaskPrompt`, `src/supervisor/task-prompt.ts`), not a generic self-selection instruction:

```
Implement user story <id> from scripts/cam/prd.json per your AGENT.md.
This exact story has already been selected by the supervisor; do not self-select a different story.

Story ID: <id>
Title: <title>
Description: <description>
Priority: <priority>
Requires: <requires>
Branch: <current-branch>
Acceptance Criteria:
  1. <criterion>
  ...
```

Return with one of the CAM_IMPLEMENTER_STATUS= lines on your last line.

---

## Worker exit contract (push report + CAM_IMPLEMENTER_STATUS sentinel)

Every implementer worker exits by writing one file:

1. **Report file**: write `scripts/cam/worker-report.json` with `{ outcome, story, gates, notes }`.

The sidecar reads the report file, updates `prd.json`, and pushes the `[cam]` narration line to the orchestrator pane via `notifyOrchestrator`. The worker does NOT call `tmux send-keys` directly.

After writing the report file, the worker prints exactly one of these sentinel lines as the **very last line** of its final message. The sentinel is available as a fallback in the pane scrollback; the report file is the primary machine-readable record.

| Status line | Meaning |
|---|---|
| `CAM_IMPLEMENTER_STATUS=DONE story=US-XXX` | Story implemented, committed, handoff written, pushed. |
| `CAM_IMPLEMENTER_STATUS=PRD_COMPLETE` | Worker found nothing to implement (stories already passing). Supervisor re-evaluates via `decideNextAction` (review, await-operator, or complete). |
| `CAM_IMPLEMENTER_STATUS=BLOCKED_QUALITY story=US-XXX reason=<short>` | Quality gate failed repeatedly; story still `passes: false`. Supervisor surfaces to operator. |
| `CAM_IMPLEMENTER_STATUS=BLOCKED_AMBIGUITY story=US-XXX question=<short>` | Story acceptance criteria are ambiguous. Worker documents in `openQuestions` and exits. |
| `CAM_IMPLEMENTER_STATUS=BLOCKED_OPERATOR_REQUIRED story=US-XXX reason=<short>` | Story has `requires: "operator"`. Worker exits without touching files. |
| `CAM_IMPLEMENTER_STATUS=RATE_LIMIT` | Hit Anthropic rate-limit mid-story; partial work left uncommitted. |

The report file is the structured machine-readable record consumed by the sidecar. The sentinel is human-readable corroboration in the pane scrollback. It is NOT consumed by a stop-hook script.

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

`cam next` (the CLI thin-proxy) exits immediately after flipping `active:true`. It does NOT send any prompt or narration to the orchestrator pane. Pre-flight checks (sync, typecheck, tests) still run in the `cam next` session before the active-flag write.
