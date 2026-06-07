# cam-cli

Autonomous Claude Code loop driver. `cam` wraps long-running Claude Code
sessions, scaffolds a project for the cam autonomous loop, and runs a
long-lived orchestrator agent that drives `/cam-plan`, `/cam-next`,
`/cam-review`, `/cam-ship` cycles against Linear, GitHub, or local issues.

Built on Bun + TypeScript. Distributed as a single-file binary built from source.

> **Status:** orchestrator-driven loop live. `cam init` scaffolds the project,
> `cam run` opens the single per-project session (3-pane layout), and
> `cam plan`, `cam next`, and `cam issue` are thin pane launchers that open
> inside that session. The orchestrator exit tears down the session automatically.

---

## Prerequisites

`cam` shells out to a few tools. Install these first:

- **[Claude Code CLI](https://docs.claude.com/en/docs/agents-and-tools/claude-code/quickstart)**: the agent that runs inside every cam pane (`claude` on PATH, signed in)
- **tmux**: every cam session lives in a tmux split (`brew install tmux`)
- **Bun >= 1.2**: required only for source installs (`brew install oven-sh/bun/bun`)
- **`gh` CLI**: only required if you pick `github` as your project's issue system (`brew install gh && gh auth login`)
- **`LINEAR_API_KEY`**: only required for `linear` issue system; get one at <https://linear.app/settings/api>

---

## Install

### Option A: From source

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

### Option B: Run from source without compiling

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
# 1. cd into any project (fresh or existing).
cd ~/code/my-project

# 2. Run the project setup wizard. cam init validates the machine,
#    asks a couple of questions (new vs existing, issue system),
#    installs templates into .claude/, and spawns a tmux session
#    where a config agent adapts everything to your project.
cam init

# 3. When the config agent finishes (it prints CAM_SETUP_STATUS=DONE),
#    the orchestrator launches automatically in a new pane. The session
#    has three panes: orchestrator (pane 0.0), cam dashboard (pane 0.1,
#    permanent read-only monitor), and an interactive menu (pane 0.2).
#    Talk to the orchestrator in plain English: "plan LIN-42",
#    "implement", "ship".

# 4. From any future shell, re-attach the session:
cam run

# 5. File an issue without entering the session:
cam issue "add dark mode toggle to settings page"
```

The orchestrator persists between sessions and accumulates project memory
in `scripts/cam/journal.md`. When the orchestrator exits, the session is
torn down automatically. See `.claude/agents/subagent-orchestrator.md`
for its full system prompt.

---

## Commands

```text
cam init [options]          Validate the machine, then run the project-setup wizard
cam run  [options]          Open or attach the single per-project session (3-pane layout)
cam plan [<N>]              Open a planning pane in the project session (thin launcher)
cam next [options]          Open a loop pane in the project session (thin launcher)
cam issue "<text>"          Open an issue-creation pane in the project session (thin launcher)
cam claude [args...]        Run claude with built-in auto-retry on rate limits
cam dashboard               Permanent read-only TUI (pane 0.1 in the session; also standalone)
cam status                  Show current loop state (idle / active / paused)
cam stop                    Cancel a running loop
cam resume [options]        Reconcile loop state after interrupt
cam version                 Print the installed cam-cli version
cam help                    Show top-level help
```

Run `cam <command> --help` for command-specific options. Permission mode
for spawned claude sessions is read from `~/.config/cam/config.toml`.
No subcommand exposes a CLI flag for it.

### Single project session

`cam run` manages one tmux session per project (named `cam-orch-<basename>-<hash>`).
All cam session commands use a dedicated `tmux -L cam` socket, isolated from your
default tmux socket. This isolation guarantees that cam's session is never confused
with sessions on the default socket and avoids a failure mode specific to macOS:
a stale tmux server left over from a dead security session denies TCC access to
`~/Documents`, which causes Claude Code to fail silently when reading project files.
By using `tmux -L cam`, cam always starts from a fresh server with the correct
security context for the current login session.

The session layout has three panes:

- **Pane 0.0 (left):** orchestrator claude process running `/cam-next`.
- **Pane 0.1 (top right):** `cam dashboard`, a permanent read-only monitor. Always visible.
- **Pane 0.2 (bottom right):** interactive menu. Press `n`, `p`, `i`, `s`, or `q` to inject commands into the orchestrator pane.

`cam plan`, `cam next`, and `cam issue` are thin pane launchers: they call
`cam run` logic to ensure the session exists, open a new pane inside it for
the requested command, and return 0 immediately. If you run them from outside
the session, they print a contextual hint with the `cam run` attach command.
Inside the session, the hint is suppressed.

When the orchestrator process in pane 0.0 exits, it automatically tears down
the entire session (`tmux kill-session`).

---

## Auto-retry

`cam` ships a built-in rate-limit retry mechanism (no external tool required).
When a `claude` process hits a rate limit, cam automatically waits out the
back-off window and re-submits the request.

**How it works:**

- **Print mode** (`cam claude -p "…"`): cam captures `claude` output and retries
  transparently until the request succeeds or the retry budget is exhausted.
- **Interactive mode** (`cam claude` inside a tmux session): cam forks a detached
  background monitor (`cam retry-monitor`) that watches the tmux pane and sends
  the retry keystroke after the rate-limit window expires. Note: `cam claude` and
  `cam retry-monitor` intentionally use the user's ambient tmux socket (not `-L cam`),
  because they watch the user's live interactive pane, not the cam workspace session.

**Configuration** (`~/.config/cam/retry.toml`):

`cam init` writes this file on first run with commented defaults. Edit it to
tune the retry policy (max attempts, custom rate-limit patterns, foreground
command allowlist, etc.). If the file is absent, cam uses built-in defaults.

**Logs** (`~/.cam/retry-logs/`):

Each retry event is appended to a dated log file under this directory.
cam rotates logs automatically and keeps the last 7 days by default.

**Attribution**: the retry logic is ported from
[claude-auto-retry v0.2.2](https://github.com/cheapestinference/claude-auto-retry)
under the MIT license. See [LICENSES/claude-auto-retry-MIT.txt](./LICENSES/claude-auto-retry-MIT.txt).

---

## Development

```bash
bun install
bun test                 # run the unit-test suite (~470 tests)
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

- **Single per-project session**: `cam run` now creates one tmux session per
  project with a 3-pane layout (orchestrator + permanent dashboard + interactive
  menu). The orchestrator exit tears down the session automatically.
- **Thin pane launchers**: `cam plan`, `cam next`, and `cam issue` open a pane
  inside the project session and return 0 immediately. They suppress the
  attach hint when already inside the session.
- **`cam issue` subcommand**: file an issue from free text without entering
  the session. The pane agent runs `/cam-issue create <text>`.
- **Auto-retry internalized**: rate-limit retry is now built into `cam` (no
  external tool installation required). `cam init` no longer checks for any
  external retry binary. See [LICENSES/claude-auto-retry-MIT.txt](./LICENSES/claude-auto-retry-MIT.txt)
  for upstream attribution.
- **`cam claude` subcommand**: new explicit entry point for print-mode and
  interactive-mode claude runs with built-in retry.

---

## License

MIT. See [LICENSE](./LICENSE).
