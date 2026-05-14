# cam-cli

Autonomous Claude Code loop driver. `cam` wraps long-running Claude Code
sessions, scaffolds a project for the cam autonomous loop, and runs a
long-lived orchestrator agent that drives `/cam-plan`, `/cam-next`,
`/cam-review`, `/cam-ship` cycles against Linear, GitHub, or local issues.

Built on Bun + TypeScript. Distributed as a single-file binary built from source.

> **Status:** Phase 2 (orchestrator MVP) — `cam init` scaffolds the project
> and `cam run` opens the orchestrator. The legacy `cam next` /
> `cam dashboard` / `cam resume` loop from v0.1.x is still shipped while
> the orchestrator-driven loop lands.

---

## Prerequisites

`cam` shells out to a few tools — install these first:

- **[Claude Code CLI](https://docs.claude.com/en/docs/agents-and-tools/claude-code/quickstart)** — the agent that runs inside every cam pane (`claude` on PATH, signed in)
- **tmux** — every cam session lives in a tmux split (`brew install tmux`)
- **Bun ≥ 1.2** — required only for source installs (`brew install oven-sh/bun/bun`)
- **`gh` CLI** — only required if you pick `github` as your project's issue system (`brew install gh && gh auth login`)
- **`LINEAR_API_KEY`** — only required for `linear` issue system; get one at <https://linear.app/settings/api>

---

## Install

### Option A — From source

```bash
# 1. Clone
git clone https://github.com/eduardocaminha/cam-cli.git
cd cam-cli

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
git clone https://github.com/eduardocaminha/cam-cli.git
cd cam-cli
bun install

# Add a shim that runs the TS entrypoint via Bun:
cat <<'SHIM' | sudo tee /usr/local/bin/cam >/dev/null
#!/usr/bin/env bash
exec bun run /Users/YOU/path/to/cam-cli/index.ts "$@"
SHIM
sudo chmod +x /usr/local/bin/cam

cam --version
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
cam plan [--issue <N>]      Spawn claude + dispatch /cam-plan; prompts on APPROVE
cam next [options]          Spawn the legacy autonomous loop (Ghostty + claude + dashboard)
cam claude [args...]        Run claude with built-in auto-retry on rate limits
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

## Auto-retry

`cam` ships a built-in rate-limit retry mechanism — no external tool required.
When a `claude` process hits a rate limit, cam automatically waits out the
back-off window and re-submits the request.

**How it works:**

- **Print mode** (`cam claude -p "…"`): cam captures `claude` output and retries
  transparently until the request succeeds or the retry budget is exhausted.
- **Interactive mode** (`cam claude` inside a tmux session): cam forks a detached
  background monitor (`cam retry-monitor`) that watches the tmux pane and sends
  the retry keystroke after the rate-limit window expires.

**Configuration** — `~/.config/cam/retry.toml`:

`cam init` writes this file on first run with commented defaults. Edit it to
tune the retry policy (max attempts, custom rate-limit patterns, foreground
command allowlist, etc.). If the file is absent, cam uses built-in defaults.

**Logs** — `~/.cam/retry-logs/`:

Each retry event is appended to a dated log file under this directory.
cam rotates logs automatically and keeps the last 7 days by default.

**Attribution**: the retry logic is ported from
[claude-auto-retry v0.2.2](https://github.com/cheapestinference/claude-auto-retry)
under the MIT license — see [LICENSES/claude-auto-retry-MIT.txt](./LICENSES/claude-auto-retry-MIT.txt).

---

## Development

```bash
bun install
bun test                 # run the unit-test suite (~240 tests)
bunx tsc --noEmit        # typecheck
bun run build:release    # produce dist/cam-darwin-arm64
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

## Recent changes

- **Auto-retry internalized**: rate-limit retry is now built into `cam` — no
  external tool installation required. `cam init` no longer checks for any
  external retry binary. See [LICENSES/claude-auto-retry-MIT.txt](./LICENSES/claude-auto-retry-MIT.txt)
  for upstream attribution.
- **`cam claude` subcommand**: new explicit entry point for print-mode and
  interactive-mode claude runs with built-in retry.

---

## License

MIT — see [LICENSE](./LICENSE).
