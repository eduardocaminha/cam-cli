# cam-cli

Autonomous Claude Code loop driver. `cam` wraps long-running Claude Code
sessions, scaffolds a project for the cam autonomous loop, and runs a
long-lived orchestrator agent that drives `/cam-plan`, `/cam-next`,
`/cam-review`, `/cam-ship` cycles against Linear, GitHub, or local issues.

Built on Bun + TypeScript. Single-binary distribution via Homebrew.

> **Status:** Phase 2 (orchestrator MVP) — `cam init` scaffolds the project
> and `cam run` opens the orchestrator. The legacy `cam next` /
> `cam dashboard` / `cam resume` loop from v0.1.x is still shipped while
> the orchestrator-driven loop lands.

---

## Prerequisites

`cam` shells out to a few tools — install these first:

- **[Claude Code CLI](https://docs.claude.com/en/docs/agents-and-tools/claude-code/quickstart)** — the agent that runs inside every cam pane (`claude` on PATH, signed in)
- **[claude-auto-retry](https://github.com/agnostic-apollo/claude-auto-retry)** — wrapper that retries claude on transient failures (`claude-auto-retry` on PATH)
- **tmux** — every cam session lives in a tmux split (`brew install tmux`)
- **Bun ≥ 1.2** — required only for source installs (`brew install oven-sh/bun/bun`)
- **`gh` CLI** — only required if you pick `github` as your project's issue system (`brew install gh && gh auth login`)
- **`LINEAR_API_KEY`** — only required for `linear` issue system; get one at <https://linear.app/settings/api>

---

## Install

### Option A — From source (recommended while the tap is being renamed)

```bash
# 1. Clone
git clone https://github.com/eduardocaminha/ralph-cli.git
cd ralph-cli

# 2. Install dependencies
bun install

# 3. Build the single-file binary (darwin-arm64; ~60 MB)
bun run build:release

# 4. Put it on PATH
sudo cp dist/cam-darwin-arm64 /usr/local/bin/cam
sudo chmod +x /usr/local/bin/cam

# 5. Verify
cam --version
```

### Option B — Run from source without compiling

Useful while iterating on `cam` itself or on a non-darwin-arm64 machine:

```bash
git clone https://github.com/eduardocaminha/ralph-cli.git
cd ralph-cli
bun install

# Add a shim that runs the TS entrypoint via Bun:
cat <<'SHIM' | sudo tee /usr/local/bin/cam >/dev/null
#!/usr/bin/env bash
exec bun run /Users/YOU/path/to/ralph-cli/index.ts "$@"
SHIM
sudo chmod +x /usr/local/bin/cam

cam --version
```

### Option C — Homebrew (legacy `ralph` formula)

A formula exists at `eduardocaminha/homebrew-tap` but currently installs
the v0.1.1 binary as **`ralph`** (pre-rename). It does not yet ship the
orchestrator (Phase 2) functionality. Track the rename in
[homebrew-tap](https://github.com/eduardocaminha/homebrew-tap).

```bash
brew tap eduardocaminha/tap
brew install ralph    # exposes `ralph` (not `cam`) until the formula is renamed
```

---

## Quick start

Once `cam` is on PATH:

```bash
# 1. cd into any project — fresh or existing.
cd ~/code/my-project

# 2. Run the project setup wizard. cam init validates the machine,
#    asks a couple of questions (new vs existing, issue system),
#    installs templates into .claude/, and spawns a tmux session
#    where a config agent adapts everything to your project.
cam init

# 3. When the config agent finishes (it prints CAM_SETUP_STATUS=DONE),
#    the orchestrator launches automatically in a new pane. Talk to it
#    in plain English — "what should we work on?", "plan LIN-42",
#    "implementa", "ship".

# 4. From any future shell, re-attach the orchestrator session:
cam run
```

The orchestrator persists between sessions and accumulates project memory
in `scripts/cam/journal.md`. See `.claude/agents/subagent-orchestrator.md`
for its full system prompt.

---

## Commands

```text
cam init [options]          Validate the machine, then run the project-setup wizard
cam run  [options]          Open or attach the long-lived orchestrator (tmux session)
cam plan [--issue <N>]      Spawn claude + dispatch /ralph-plan; prompts on APPROVE
cam next [options]          Spawn the legacy autonomous loop (Ghostty + claude + dashboard)
cam dashboard               Standalone read-only TUI for monitoring a loop
cam status                  Show current loop state (idle / active / paused)
cam stop                    Cancel a running loop
cam resume [options]        Reconcile loop state after interrupt
cam version                 Print the installed cam-cli version
cam help                    Show top-level help
```

Run `cam <command> --help` for command-specific options. Permission mode
for spawned claude sessions is read from `~/.config/cam/config.toml` —
no subcommand exposes a CLI flag for it.

---

## Development

```bash
bun install
bun test                 # run the unit-test suite (~240 tests)
bunx tsc --noEmit        # typecheck
bun run build:release    # produce dist/cam-darwin-arm64 + tarball
```

Source layout:

```text
index.ts              CLI dispatch
src/commands/         one file per `cam <subcommand>`
src/linear/           Linear GraphQL client
src/config/           ~/.config/cam/config.toml + scripts/cam/project.toml
templates/            shipped to projects by `cam init`
  agents/             subagent-orchestrator, planner, implementer, reviewer, auditor
  commands/           /cam-plan, /cam-next, /cam-review, /cam-ship, /cam-issue, /cam-prune
  scripts/cam/        CLAUDE.md, journal.md, handoff.schema.json
test/                 bun:test suites
```

---

## License

MIT — see [LICENSE](./LICENSE).
