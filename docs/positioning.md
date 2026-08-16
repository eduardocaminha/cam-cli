# Positioning

Gateship is a local software-delivery runtime for coding agents. It sits between
an operator-specified task and a merged pull request, owning the durable outer
loop that would otherwise be coordinated by hand.

It is not a coding model, a general agent framework, or a terminal multiplexer.
The signed-in Claude CLI writes and reviews code; Gateship owns task intake,
workspace isolation, verification, recovery, and shipping.

## Product thesis

The scarce resource for a solo operator is reliable progress per model token,
not the number of terminals visible at once. Gateship therefore favors one
observable run with explicit evidence over a fleet of loosely coordinated
sessions.

The loop is deliberately short:

1. the operator supplies scope and a falsifiable verification command;
2. Gateship creates a worktree from fresh `origin/main`;
3. a resumable Claude session implements the task;
4. Gateship executes the named verification;
5. a fresh capability-restricted Claude session reviews the change;
6. a clean run can be committed, pushed, and squash-merged.

SQLite records state and public activity so a process restart becomes an
explicit interruption and resume, not a lost terminal session or a duplicate
worker.

## Differentiation

- Local-first: repositories, credentials, CLI subscriptions, and worktrees stay
  on the operator's machine.
- Evidence-first: completion requires executable verification and independent
  review, not a model's self-report.
- Durable: the browser can close or the service can restart without discarding
  the run workspace or Claude session id.
- Small control plane: one Bun process owns HTTP, SQLite, child processes, and
  cancellation. There is no separate daemon, sidecar, or message broker.

## Non-goals

- maximizing simultaneous agent count;
- replacing the coding-agent CLI;
- hosted execution or per-token API resale;
- mandatory planning ceremonies before implementation;
- reproducing a terminal inside the browser.
