# Gateship repository instructions

For architecture or cross-session continuation work, read `HANDOFF.md` before
acting. It records the operator-approved direction and current stage, but it is
not blanket authorization to implement the roadmap.

## Product boundary

Gateship is one local web service. Bun serves the UI, SQLite stores durable run
state and provider adapters invoke coding agents installed and authenticated by
the operator.

- Simplicity governs scope. Prefer removing obsolete surface or fixing a small
  root cause over adding a gate, policy, compatibility layer, daemon or state
  file.
- Do not add tmux, send-keys, sidecars, container workers, terminal UIs or a
  second `gshipd` process.
- The operator-facing conversational orchestrator may investigate the project,
  refine intent and invoke typed Gateship commands. The deterministic runtime,
  not the conversational agent, owns run state, verification and shipping.
- The operator specification is the execution contract. Do not require planner
  and auditor convergence before work can start.
- Keep review independent and read-only. Findings may trigger one bounded fix;
  unresolved judgment returns to the operator.

## Agent and workspace lifecycle

- Keep provider authentication credential-blind: Gateship may inspect auth
  status, but must not read, copy or store OAuth tokens or API keys.
- Give agent and GitHub CLI children an explicit environment allowlist. Never
  add a provider/GitHub token field to the web UI or runtime database; GitHub
  authentication belongs to `gh`'s credential store.
- Keep remote notification services optional and server-side. Their secrets
  must never enter SQLite, browser responses, logs or agent environments; add a
  concrete channel before considering a generic integration bus.
- Cut run worktrees from fresh `origin/main`. Never move or check out the
  operator's local `main` branch.
- After a confirmed merge, release the clean managed worktree, local branch and
  stale remote-tracking ref. Preserve dirty, failed or unknown leftovers and
  surface them to the operator.
- Keep role contracts in provider adapters: the orchestrator converses and
  invokes typed commands, the executor edits only its assigned worktree, and a
  fresh reviewer session is mechanically read-only.

## Runtime and dependencies

- Use Bun commands (`bun`, `bun test`, `bun run`, `bunx`, `bun install`).
- Use `Bun.serve` and `bun:sqlite`; do not add an application framework or a
  separate database service.
- The React UI is built with Vite because Tailwind v4 requires its build-time
  plugin. Vite is not part of the shipped runtime.
- Prefer existing platform APIs over new packages.

## Verification

- Run the smallest relevant tests while editing. Gateship verification runs the
  task's explicit commands; `bun run check:all` is the once-per-ship/CI spine,
  not a loop after every small change.
- Add tests for observable behavior and destructive or failure boundaries, not
  for duplicated registries, implementation wording or retired compatibility
  paths.
- Do not weaken correctness to make a gate pass. Remove a low-value gate only
  when the protected surface is also removed or covered by a clearer contract.

Do not add AI-attribution trailers to commits or pull-request text.
