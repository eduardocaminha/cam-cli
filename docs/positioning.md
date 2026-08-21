# Positioning

Gateship is a local software-delivery runtime for coding agents. It sits between
an operator-specified task and a merged pull request, owning the durable outer
loop that would otherwise be coordinated by hand.

It is not a coding model, a general agent framework, or a terminal multiplexer.
The selected signed-in Claude or Codex CLI writes and reviews code; Gateship
owns task intake, workspace isolation, verification, recovery, and shipping.

## Product thesis

The scarce resource for a solo operator is reliable progress per model token,
not the number of terminals visible at once. Gateship therefore favors one
observable run with explicit evidence over a fleet of loosely coordinated
sessions.

The loop is deliberately short:

1. the operator converses with a read-only orchestrator;
2. the orchestrator may return one typed service command;
3. Gateship creates a worktree from fresh `origin/main`;
4. a resumable selected-provider session implements the task;
5. Gateship executes the named verification;
6. a fresh capability-restricted session reviews the change;
7. a clean run can be committed, pushed, and squash-merged.

SQLite records state, public activity, the operator-owned project brief, and the
shared conversational transcript. A successful brief write atomically clears
the generated handoff, so explicit operator intent replaces stale session
memory while provider switches and process restarts remain durable.

## Differentiation

- Local-first: repositories, credentials, CLI subscriptions, and worktrees stay
  on the operator's machine.
- Evidence-first: completion requires executable verification and independent
  review, not a model's self-report.
- Durable: the browser can close, the provider can change, or the service can
  restart without discarding the transcript, run workspace, or native session
  ids.
- Small control plane: one Bun process owns HTTP, SQLite, child processes, and
  cancellation. There is no separate daemon, sidecar, or message broker.

## Non-goals

- maximizing simultaneous agent count;
- replacing the coding-agent CLI;
- hosted execution or per-token API resale;
- mandatory planning ceremonies before implementation;
- reproducing a terminal inside the browser.
