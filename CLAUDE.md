---
description: Gateship repository instructions
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## Premise

Simplicity governs scope. Before adding a gate, policy, compatibility layer,
daemon, or state file, ask whether the surface that needs it can be removed.
This does not permit weaker correctness: prefer a small root-cause fix over a
larger workaround.

## Product boundary

Gateship is one local web service started by `gship`. Bun serves the UI, SQLite
stores durable run state, and the signed-in Claude CLI performs implementation
and independent review.

- Do not add tmux, send-keys, sidecars, container workers, terminal UIs, or a
  second `gshipd` process.
- The operator specification is the execution contract. Do not require planner
  and auditor convergence before work can start.
- Keep review independent and read-only. Findings may trigger one bounded fix
  attempt; unresolved judgment returns to the operator.
- Create run worktrees from fresh `origin/main`. Never move or check out the
  user's local `main` branch.
- Use the Claude CLI subscription session. Do not introduce the Agent SDK or an
  Anthropic API-key requirement.

## Runtime and dependencies

- Use Bun commands (`bun`, `bun test`, `bun run`, `bunx`, `bun install`).
- Use `Bun.serve` and `bun:sqlite`; do not add an application framework or a
  separate database service.
- The React UI is built with Vite because Tailwind v4 requires its build-time
  plugin. Vite is not part of the shipped runtime.
- Prefer existing platform APIs over new packages.

## Verification

Run the smallest relevant tests while editing, then `bun run check:all` before
shipping. Add tests for observable behavior and failure boundaries, not for
duplicated registries, implementation wording, or retired compatibility paths.

Do not add AI-attribution trailers to commits or pull-request text.
