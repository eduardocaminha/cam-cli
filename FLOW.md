# Gateship flow

Gateship has one operator entry point: `gship`, a localhost web service backed
by a durable SQLite run store. It does not create a tmux session.

```mermaid
flowchart TD
    START["gship"] --> WEB["Bun HTTP service on 127.0.0.1"]
    EXTERNAL["External conversational agent"] --> COMMAND["Typed Gateship command"]
    WEB --> RUNS["Project Runs surface"]
    COMMAND --> INTAKE["Create, specify, or approve a task"]
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
- `ConversationalOrchestrator` resolves typed cycle questions internally. The
  external agent investigates conversationally and invokes typed commands; the
  browser does not render its transcript.
- `GitWorkspaceManager` creates one isolated worktree per run from
  `origin/main`, releases it after a confirmed merge, and preserves dirty or
  unknown leftovers for operator inspection. It never moves local `main`.
- `AgentSession` is the provider-neutral adapter contract; the selected
  Claude/Codex executor owns its resumable native session.
- `GitIssueVerifier` runs the acceptance commands from the task contract.
- Task contracts are direct `{ scope, verify[], evidence? }` records. Scope,
  verification and every optional evidence command/output are covered by the
  human approval fingerprint.
- The matching provider reviewer starts a fresh read-only session for
  independent review.
- `GithubShipper` owns commit, push, PR creation, squash auto-merge, and source
  refresh after a real merge.
- The external agent is the primary conversational interface. The browser's
  Runs, Trabalho and Ajustes surfaces invoke the same typed deterministic
  service methods.

Recovery is the durable run state plus explicit resume in the web UI. No tmux,
sidecar, container-worker, or terminal-control path participates in this flow.
