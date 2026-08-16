# Gateship project handoff

## Current product

Gateship is one local web service started by `gship`. It serves the React UI,
stores durable runs, events, and the orchestrator transcript in SQLite, creates
an isolated worktree from fresh `origin/main`, invokes the selected signed-in
Claude or Codex CLI, runs the task's explicit verification commands, asks a
fresh read-only session from the same provider to review, and ships through a
squash-merged pull request.
After a confirmed merge it releases the clean managed worktree and local branch;
dirty or unowned leftovers stay visible for operator inspection.

The operator specification is the contract. There is no planner/auditor
convergence phase and no terminal proxy on the execution path.

## Boundaries to preserve

- Keep one process and one owner for HTTP, SQLite, children, and cancellation;
  do not add `gshipd` or a sidecar.
- Do not reintroduce tmux, send-keys, container workers, terminal UI, installed
  personas, or control-file protocols.
- Keep the conversational orchestrator read-only. It may investigate and return
  at most one typed command; only the deterministic service mutates lifecycle.
- Use authenticated subscription CLIs, not an Agent SDK or API-key billing.
- Review is a new read-only session. One bounded automatic fix attempt is
  allowed; remaining judgment returns to the operator.
- Runtime work starts from `refs/remotes/origin/main`; never move the user's
  local `main` branch.
- Prefer deleting obsolete surface over adding a policy or gate to govern it.

## Where to look

- `README.md` and `FLOW.md`: public behavior and end-to-end flow.
- `src/commands/web.ts`: HTTP composition.
- `src/runtime/run-runtime.ts`: durable run state machine.
- `src/runtime/run-store.ts`: SQLite state and events.
- `src/runtime/conversational-orchestrator.ts`: durable chat and typed commands.
- `src/runtime/agent-session.ts`: Claude/Codex provider bus.
- `src/runtime/*-cli-executor.ts`: resumable implementation sessions.
- `src/runtime/*-cli-reviewer.ts`: independent review.
- `src/runtime/github-shipper.ts`: commit, PR, auto-merge, and source refresh.

## Verification

Run `bun run check:all`. CI invokes the same manifest on one Ubuntu host job.
