# Positioning

Gateship is a local software-delivery runtime for coding agents. It sits between
an operator-specified task and a merged pull request, owning the durable outer
loop that would otherwise be coordinated by hand.

It is a multiproject control plane, not a coding model, a general agent
framework, or a terminal multiplexer.
The selected signed-in Claude or Codex CLI writes and reviews code; Gateship
owns task intake, workspace isolation, verification, recovery, and shipping.

## Product thesis

The scarce resource for a solo operator is reliable progress per model token,
not the number of terminals visible at once. Gateship therefore favors one
observable run with explicit evidence over a fleet of loosely coordinated
sessions.

The loop is deliberately short:

1. the operator converses with an external agent;
2. the external agent invokes typed Gateship service commands;
3. Gateship creates a worktree from fresh `origin/main`;
4. a resumable selected-provider session implements the task;
5. Gateship executes the named verification;
6. a fresh capability-restricted session reviews the change;
7. a clean run can be committed, pushed, and squash-merged.

SQLite records state, public activity and the operator-owned project brief. The
brief is the only durable handoff between external-agent sessions. The external
agent is the conversational interface; Gateship's deterministic runtime retains
ownership of state, verification, recovery and shipping.

## Differentiation

- Local-first: repositories, credentials, CLI subscriptions, and worktrees stay
  on the operator's machine.
- Evidence-first: completion requires executable verification and independent
  review, not a model's self-report.
- Durable: the browser can close, the provider can change, or the service can
  restart without discarding run state, the workspace, or native session ids.
- Small control plane: one Bun process owns HTTP, SQLite, child processes, and
  cancellation. There is no separate daemon, sidecar, or message broker.
- Multiproject control center: `/overview` is the Agora, with `/overview/runs`
  for executions, `/overview/queues` for queues and `/overview/insights` for
  independent operational signals. `/projects` is for project management;
  project context remains under `/projects/:projectId/{runs,work,settings}` and
  global configuration under `/settings`.
- Persistent context: the selected project remains selected when the operator
  visits the Control center. This is navigation context, not an implicit API
  scope.

## Non-goals

- maximizing simultaneous agent count;
- replacing the coding-agent CLI;
- hosted execution or per-token API resale;
- mandatory planning ceremonies before implementation;
- reproducing a terminal inside the browser.
- a composite score that hides the evidence behind a single number;
- parallel runs in the same repository, new daemons, or new databases;
- a global agent directory, generic memory, generic Kanban, or AI-decided merge.

Autonomous adaptation is bounded by the approved objective, behavior, risk and
verification. Anything that changes one of those four dimensions returns to the
operator as a proposal.
