# cam-cli

Autonomous Claude Code loop driver. `cam` wraps long-running Claude Code
sessions, scaffolds a project for the cam autonomous loop, and runs a
long-lived orchestrator agent that drives `/cam-plan`, `/cam-next`,
`/cam-review`, `/cam-ship` cycles against Linear, GitHub, or local issues.

Built on Bun + TypeScript. Distributed as a single-file binary built from source.

> **Status:** single-hub dispatch model live. `cam init` scaffolds the project,
> `cam run` opens the single per-project session (2-pane layout: orchestrator + navigable dashboard), and all CLI subcommands (`cam plan`, `cam issue`, `cam next`, `cam review`, `cam ship`) are thin-proxies that inject into the orchestrator pane via atomic `send-keys`. Workers run in a titled 3rd pane; completion is push-based (worker writes a report file + sends a summary line to the orchestrator). The orchestrator exit respawns on a token-budget handoff, otherwise tears down the session.

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

# 3. Build and install (builds dist/cam-darwin-arm64, re-signs it ad-hoc, copies to ~/.local/bin/cam; no sudo)
./scripts/build-release.sh --install

# 4. Ensure ~/.local/bin is on $PATH (add to ~/.zshrc or ~/.bash_profile if missing):
#    export PATH="$HOME/.local/bin:$PATH"

# 5. Verify
cam --version
```

**Alternative: system-wide install to /usr/local/bin**

If you prefer a system-wide location, build first, then copy with sudo.
The build script handles re-signing, so the binary is valid for any destination:

```bash
./scripts/build-release.sh
sudo cp dist/cam-darwin-arm64 /usr/local/bin/cam
```

#### Public distribution note

Ad-hoc signing (used above) is sufficient for your own machine only. Distributing
the binary to other users requires Developer ID signing, notarytool submission, and
stapling via Apple's notarization service (Apple Developer account required). The
current build scripts do not include those steps.

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
#    has two panes: orchestrator (pane 0.0) and the navigable cam dashboard
#    (pane 0.1, permanent). In the dashboard, press n/r/s/p/i to send
#    /cam-* commands to the orchestrator, j/k or arrows to browse stories,
#    Enter to open a story detail view, Esc to go back, d to focus the
#    orchestrator pane, q to close the dashboard.

# 4. From any future shell, re-attach the session:
cam run

# 5. File an issue without entering the session:
cam issue "add dark mode toggle to settings page"
```

The orchestrator persists between sessions and accumulates project memory
in `scripts/cam/journal.md`. When the orchestrator exits, the `cam run` wrapper
respawns it from a token-budget handoff when one is pending, otherwise it tears
down the session. See `.claude/agents/subagent-orchestrator.md` for its full
system prompt.

---

## Commands

```text
cam init [options]          Validate the machine, then run the project-setup wizard
cam run  [options]          Open or attach the single per-project session (2-pane layout)
cam plan [<N>]              Open a planning pane in the project session (thin launcher)
cam next [options]          Drive the implement-review-complete loop (in-process supervisor)
cam issue "<text>"          Open an issue-creation pane in the project session (thin launcher)
cam claude [args...]        Run claude with built-in auto-retry on rate limits
cam dashboard               Navigable TUI: browse stories, dispatch /cam-* commands (pane 0.1; also standalone)
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

The session layout has two panes:

- **Pane 0.0 (left):** orchestrator claude process (boots the `subagent-orchestrator` agent, which drives `/cam-plan`, `/cam-next`, `/cam-review`, `/cam-ship`).
- **Pane 0.1 (right):** `cam dashboard`, a permanent navigable monitor. Browse stories with j/k or arrow keys, Enter to open a story detail view, Esc to go back. Press `n/r/s/p/i` to dispatch `/cam-*` commands to the orchestrator, `d` to focus the orchestrator pane, `q` to close the dashboard.

`cam plan`, `cam issue`, `cam next`, `cam review`, and `cam ship` are thin-proxies: they detect the active cam session, ensure the orchestrator is idle (`sendKeysWhenIdle`), and inject the corresponding slash command into the orchestrator pane via atomic `send-keys` (text + Enter in one literal call). If no session exists, they bootstrap `cam run --no-attach` first. If a worker is already running (mutex: 3 panes present), the proxy refuses the dispatch and exits with code 1. From outside the session the proxy prints a contextual hint with the `cam run` attach command (suppressed inside the session).

When the orchestrator process in pane 0.0 exits, the `cam run` wrapper respawns it
(rehydrating from a token-budget handoff) when one is pending and under the
respawn cap; otherwise it tears down the entire session (`tmux kill-session`).

### Recovery runbook: stale tmux server

**Stale cam socket** (cam server is unresponsive or pane operations fail):

```bash
tmux -L cam kill-server
```

This terminates every process attached to the dedicated cam socket and releases the socket file. After running it, `cam run` will spin up a fresh server with the correct security context for the current login session.

**Stale default socket** (you see TCC or file-access errors in the default tmux server that bleed into cam):

```bash
tmux kill-server   # kills the default socket server, not the cam socket
cam run            # re-opens the session under the isolated cam socket
```

Run this only if the default socket server is the one misbehaving. The cam socket and the default socket are independent, so killing one does not affect the other.

**Why the isolation matters:**

The `-L cam` flag routes all cam tmux traffic through a private socket file, separate from `$TMPDIR/tmux-<uid>/default`. If your default tmux server was started in a dead security session (a common macOS scenario after a reboot or logout), it loses TCC access to `~/Documents`, and Claude Code fails silently when reading project files. Because cam uses its own socket, it always starts from a server spawned in the current login session, with the correct entitlements.

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

## Architecture

`cam run` is the single dispatch hub. All CLI subcommands (`cam plan`, `cam next`, `cam issue`, `cam review`, `cam ship`) are thin-proxies: they detect the live orchestrator session and inject the request into the orchestrator pane via atomic `send-keys` (text + Enter in one literal call). If no session exists, they bootstrap `cam run --no-attach` and wait for the `.claude/.cam-orch-ready` marker before injecting.

```
cam next  (thin-proxy)
  └── detect live orchestrator (hasSession + orchestratorAlive)
        ├── on miss: bootstrap cam run --no-attach, poll .claude/.cam-orch-ready
        ├── mutex check: refuse if worker-pane is already running (3 panes = busy)
        ├── idle check: wait for orchestrator pane idle (sendKeysWhenIdle)
        └── atomic send-keys: inject task prompt + Enter (-l literal flag)

orchestrator (cam run context)
  └── receives task prompt, dispatches workers in the titled 3rd pane
        ├── respawn-pane -k <worker-pane>   -- reuse titled pane id
        │     claude --permission-mode <mode>
        │             --session-id <uuid>
        │             --agent <name>
        │             "<task-prompt>"
        └── worker pushes completion:
              scripts/cam/worker-report.json   -- structured outcome
              tmux send-keys -> orchestrator pane: "[cam] US-XXX DONE: ..."
```

Workers (implementer, reviewer) are interactive TUI `claude` sessions invoked with `--agent <name>`. On completion, the worker writes a push report (`scripts/cam/worker-report.json`) and sends a one-line summary directly to the orchestrator pane via `tmux send-keys`. The orchestrator receives the line and reads the report file to determine the next action. Scrollback polling is not used for completion detection. The old stop-hook driver (a vendored Stop hook + `/cam-next` re-inject) is retired; `claude -p` (print mode) is not used for workers.

Workers always run in the **titled 3rd pane** (created on first dispatch, reused across stories via `respawn-pane -k`). A mutex check before each dispatch prevents concurrent workers: if 3 panes are already present, the dispatch is refused until the worker-pane closes.

---

## Recent changes

- **Single-hub dispatch (CAM-55)**: `cam run` is the only dispatch hub. All CLI subcommands (`cam plan`, `cam issue`, `cam next`, `cam review`, `cam ship`) are thin-proxies that inject into the orchestrator pane via atomic `send-keys`. Workers run in a uniform titled 3rd pane; completion is push-based (worker writes `scripts/cam/worker-report.json` + sends a summary line to the orchestrator pane via `tmux send-keys`). A mutex prevents concurrent worker dispatches (3 panes = busy). The idle-guarantee (`sendKeysWhenIdle`) ensures the orchestrator is not mid-response when the request is injected.
- **Interactive TUI workers (CAM-42)**: `cam next` dispatches workers as interactive TUI `claude` sessions (not `claude -p`). `claude -p` is reserved for the `cam claude` retry-wrapper feature only.
- **Single per-project session**: `cam run` now creates one tmux session per
  project with a 2-pane layout (orchestrator + navigable dashboard). The navigable
  dashboard replaces the old interactive menu: n/r/s/p/i dispatch /cam-* to the
  orchestrator, j/k or arrows browse stories, Enter opens a story detail view.
  The orchestrator exit respawns on a token-budget handoff, otherwise tears
  down the session.
- **Thin pane launchers**: `cam plan` and `cam issue` open a pane inside the
  project session and return 0 immediately (suppressing the attach hint when
  already inside the session). `cam next` instead runs the supervisor in-process.
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
