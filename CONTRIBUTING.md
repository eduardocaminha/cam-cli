# Contributing to Gateship

Gateship aims to keep autonomous delivery understandable. Prefer a small
behavioral seam over a new policy layer, command, daemon, or compatibility
path.

## Development

Requirements are Bun 1.2.3 or newer, Git, and the GitHub CLI. Install and run
the focused checks for the area you change:

```bash
bun install --frozen-lockfile
bun test test/path/to/relevant.test.ts
bun run typecheck
```

Run `bun run build:ui` after web UI changes. Before opening a pull request, run
the complete gate once:

```bash
bun run check:all
```

## Architecture boundaries

- `gship` is one local web service; do not add a sidecar or second daemon.
- Provider integrations implement the `AgentSession` boundary. Gateship does
  not read or store provider credentials.
- Agents propose work; the service owns state transitions and mutations.
- Deterministic verification belongs in the task's direct `verify` commands.
- Preserve dirty or unowned worktrees. Cleanup must be scoped and recoverable.

Keep pull requests focused, explain the behavior change, and add the smallest
test that would fail without it. Historical `CAM-*` identifiers and ADRs are
provenance and should not be rewritten.
