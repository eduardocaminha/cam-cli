# Gateship flow

Gateship has one operator entry point: `gship`, a localhost web service backed
by a durable SQLite run store. It does not create a tmux session.

```mermaid
flowchart TD
    START["gship"] --> WEB["Bun HTTP service on 127.0.0.1"]
    WEB --> CHAT["Read-only conversational orchestrator"]
    CHAT --> COMMAND["Zero or one typed service command"]
    COMMAND --> INTAKE["Create or specify a task"]
    INTAKE --> SOURCE["Commit task to remote main"]
    SOURCE --> RUN["Start run from origin/main"]
    RUN --> WORKTREE["Isolated .gship/worktrees workspace"]
    WORKTREE --> IMPLEMENT["Selected Claude or Codex session"]
    IMPLEMENT --> VERIFY["Acceptance-command verification"]
    VERIFY --> REVIEW["Independent native read-only review"]
    REVIEW -->|clean| READY["Ready to ship"]
    REVIEW -->|findings, first time| IMPLEMENT
    REVIEW -->|findings after fix| WAIT["Wait for operator guidance"]
    WAIT --> IMPLEMENT
    READY --> SHIP["Commit, push, PR, squash auto-merge"]
    SHIP --> DONE["Refresh origin/main and mark run done"]
    DONE --> RELEASE["Release clean managed worktree and branch"]
```

## Ownership

- `RunRuntime` owns the run state machine and process cancellation.
- `RunStore` persists runs and events in `.gship/runtime.sqlite`.
- `ConversationalOrchestrator` investigates read-only and returns at most one
  typed command. Its public transcript and one native session id per provider
  are persisted for cross-provider and cross-process handoff.
- `GitWorkspaceManager` creates one isolated worktree per run from
  `origin/main`, releases it after a confirmed merge, and preserves dirty or
  unknown leftovers for operator inspection. It never moves local `main`.
- `AgentSession` is the provider-neutral bus; the selected Claude/Codex
  executor owns its resumable native session.
- `GitIssueVerifier` runs the acceptance commands from the task contract.
- New task contracts are direct `{ scope, verify[] }` records. The old
  acceptance-criteria DSL is read only by a compatibility adapter and is never
  emitted by the current intake.
- The matching provider reviewer starts a fresh read-only session for
  independent review.
- `GithubShipper` owns commit, push, PR creation, squash auto-merge, and source
  refresh after a real merge.
- The browser is primarily a conversation. Explicit start, resume, cancel, and
  ship controls remain as a deterministic fallback; both paths reach the same
  service methods.

## Retired runtime

No tmux, sidecar, container-worker, or terminal-control compatibility path
remains. Recovery is the durable run state plus explicit resume in the web UI.
