# Gateship

Gateship is a local software delivery runtime: a control plane for coding
agents. It turns issues and goals into verifiable planning, implementation,
review, and ship workflows, keeping state, coordinating specialized agents,
and recovering interrupted runs. `cam` wraps long-running Claude Code
sessions, scaffolds a project for the cam autonomous loop, and runs a
long-lived orchestrator agent that drives `/cam-plan`, `/cam-next`,
`/cam-review`, `/cam-ship` cycles against Linear, GitHub, or local issues.

Built on Bun + TypeScript. Distributed as a single-file binary built from source.

> **Status:** single-hub dispatch model live. `cam init` scaffolds the project,
> `cam run` opens the single per-project session (2-pane layout: orchestrator + navigable dashboard), and CLI subcommands (`cam plan`, `cam issue`, `cam spec`, `cam review`, `cam ship`) are thin-proxies that inject into the orchestrator pane via atomic `send-keys`; `cam next` is a pure `active:true` sidecar trigger (no send-keys). Workers run in a titled 3rd pane; completion is push-based (worker writes a report file; the sidecar reads it and emits the `[cam]` narration line to the orchestrator). On a cycle-close, the orchestrator arms the recycle marker (`cam-orch-recycle`), the watcher SIGTERMs the claude process, and the wrapper respawns it delivering the handoff via `CAM_ORCH_REHYDRATE`; if no recycle marker is pending, the wrapper tears down the session.

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

### Option A: Packaged binary (recommended)

One command, no clone or Bun toolchain required:

```bash
curl -fsSL https://raw.githubusercontent.com/gateship-dev/gateship/main/install.sh | bash
```

This detects your OS/arch, downloads the matching asset from the latest
GitHub Release
(`https://github.com/gateship-dev/gateship/releases/download/<tag>/<asset>`,
one of `gateship-darwin-arm64`, `gateship-darwin-x64`, `gateship-linux-x64`,
`gateship-linux-arm64`), and installs it as both `gateship` and `gship` into
`~/.local/bin` (override with `GATESHIP_INSTALL_DIR`). It is additive: it
never removes or overwrites a pre-existing `cam` binary.

Ensure `~/.local/bin` is on `$PATH` (add to `~/.zshrc` or `~/.bash_profile`
if missing), then verify:

```bash
export PATH="$HOME/.local/bin:$PATH"
gateship --version
```

#### About the signature (macOS)

The published binaries are **ad-hoc signed, not notarized by Apple**: there
is no Apple Developer account behind this project (operator decision,
2026-08-01). Ad-hoc signing is enough to satisfy `codesign -v` and to run
the binary yourself, but it carries none of Apple's notarization
malware-scan guarantee, and it does not stop Gatekeeper from quarantining a
binary that arrived via download. `install.sh` already strips that
quarantine bit for you (`xattr -d com.apple.quarantine`); if you installed a
binary by hand, or macOS still refuses to run it, run that command yourself
against the binary before it will execute:

```bash
xattr -d com.apple.quarantine ~/.local/bin/gateship
xattr -d com.apple.quarantine ~/.local/bin/gship
```

Distributing a fully notarized binary would require Developer ID signing,
`notarytool` submission, and stapling; the current build/release pipeline
does not include those steps.

#### Verifying what you downloaded

`install.sh` verifies the download automatically before it copies anything
into `INSTALL_DIR`: it fetches `SHA256SUMS.txt` from the same GitHub
Release, computes the SHA-256 of the downloaded asset, and aborts the
install on all three ways verification can go wrong: a hash mismatch, an
unreachable `SHA256SUMS.txt`, and a host with neither `sha256sum` nor
`shasum` on `PATH`.

This checksum buys **integrity**, not **authenticity**. It proves the file
on your disk is byte-identical to the one GitHub Actions built for this
release (catches transport corruption and partial tampering), but it does
**not** prove who built it: `SHA256SUMS.txt` ships in the same Release as
the binary, so anyone who can rewrite the Release rewrites the checksum
file alongside it. To reproduce the automatic check by hand against a
binary you already downloaded:

```bash
curl -fsSLO https://github.com/gateship-dev/gateship/releases/download/<tag>/gateship-darwin-arm64
curl -fsSLO https://github.com/gateship-dev/gateship/releases/download/<tag>/SHA256SUMS.txt
grep " gateship-darwin-arm64" SHA256SUMS.txt | shasum -a 256 -c -
```

(swap `gateship-darwin-arm64` for your platform's asset name and `<tag>` for
the release you downloaded)

For real **authenticity**, that is proof the binary was produced by this
repo's release workflow from a specific commit, not just that it matches a
same-origin manifest, verify the build provenance attestation instead. This
is an on-demand check, not something `install.sh` runs for you, and it
requires the `gh` CLI, listed as optional in
[Prerequisites](#prerequisites) (the same one used for the `github` issue
system):

```bash
gh attestation verify gateship-darwin-arm64 --repo gateship-dev/gateship
```

Every published asset (`gateship-darwin-arm64`, `gateship-darwin-x64`,
`gateship-linux-x64`, `gateship-linux-arm64`) carries an attestation from
the release workflow, sigstore-anchored, tying the binary to the commit and
workflow run that produced it. The two checks are complementary, not
substitutes: the checksum runs on every install because it needs no extra
tooling and catches corruption/tampering against the published manifest;
the attestation is for anyone who wants proof of origin and is willing to
install `gh` to get it.

### Option B: From source

```bash
# 1. Clone
git clone https://github.com/gateship-dev/gateship.git
cd cam-cli

# 2. Install dependencies
bun install

# 3. Build all four targets and install the host-native one (re-signed ad-hoc,
#    verified, then renamed into place at ~/.local/bin/gateship and
#    ~/.local/bin/gship via atomic rename(2); no sudo, additive)
./scripts/build-release.sh --install

# 4. Ensure ~/.local/bin is on $PATH (add to ~/.zshrc or ~/.bash_profile if missing):
#    export PATH="$HOME/.local/bin:$PATH"

# 5. Verify
gateship --version
```

**Alternative: system-wide install to /usr/local/bin**

If you prefer a system-wide location, build first, then copy with sudo.
The build script handles re-signing, so the binary is valid for any destination:

```bash
./scripts/build-release.sh
sudo cp dist/gateship-darwin-arm64 /usr/local/bin/gateship
```

### Option C: Run from source without compiling

Useful while iterating on `cam` itself or on a non-darwin-arm64 machine:

```bash
git clone https://github.com/gateship-dev/gateship.git
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
in `scripts/cam/journal.md`. On a cycle-close, the orchestrator runs
`cam journal append --cycle-close` to arm the recycle marker (`cam-orch-recycle`);
the watcher SIGTERMs the claude process and the wrapper respawns it, delivering
the handoff via `CAM_ORCH_REHYDRATE`. If no recycle marker is pending, the wrapper
tears down the session. See `.claude/agents/subagent-orchestrator.md` for its full
system prompt.

---

## Commands

```text
cam init [options]          Validate the machine, then run the project-setup wizard
cam config [--show]         Interactive wizard to set model per phase and backend
cam run  [options]          Open or attach the single per-project session (2-pane layout)
cam plan [<N>]              Open a planning pane in the project session (thin launcher)
cam next [options]          Trigger the sidecar loop (flips active:true, thin-proxy)
cam issue "<text>"          Open an issue-creation pane in the project session (thin launcher)
cam spec <id>               Deep-spec an idea issue into stage:specified via spec-with-docs (thin-proxy)
cam review                  Dispatch /cam-review to the live orchestrator (or bootstrap first)
cam ship                    Dispatch /cam-ship to the live orchestrator (or bootstrap first)
cam tag                     Create and push the vX.Y.Z git tag for the current CAM_VERSION on main
cam journal append          Append a structured cycle entry to scripts/cam/journal.md on main (reads JSON from stdin)
cam journal archive         Move the oldest third of scripts/cam/journal.md entries to journal.archive.md once entries exceed the threshold
cam patterns archive        Move resolved-marked bullets from scripts/cam/patterns.md to patterns.archive.md on main
cam claude [args...]        Run claude with built-in auto-retry on rate limits
cam dashboard               Navigable TUI: browse stories, dispatch /cam-* commands (pane 0.1; also standalone)
cam status                  Show current loop state (idle / active / paused)
cam stop                    Cancel a running loop
cam pause                   Set the operator pause brake marker (.claude/.cam-pause), separate from loop state
cam drain [--stop|--clear]  Set or clear the inter-cycle drain kill-switch without killing the sidecar
cam resume [options]        Reconcile loop state after interrupt
cam version                 Print the installed Gateship version
cam help                    Show top-level help
```

Run `cam <command> --help` for command-specific options. Permission mode
for spawned claude sessions is hardcoded to `bypassPermissions` at every
spawn site; no config key or CLI flag controls it.

### Single project session

`cam run` manages one tmux session per project (named `cam-orch-<basename>-<hash>`).
All cam session commands use a dedicated `tmux -L cam` socket, isolated from your
default tmux socket. This isolation guarantees that cam's session is never confused
with sessions on the default socket and avoids a failure mode specific to macOS:
a stale tmux server left over from a dead security session denies TCC access to
`~/Documents`, which causes Claude Code to fail silently when reading project files.
By using `tmux -L cam`, cam always starts from a fresh server with the correct
security context for the current login session.

The session layout has two permanent panes plus an optional worker pane:

- **Pane 0.0 (left):** orchestrator claude process (boots the `subagent-orchestrator` agent). The orchestrator is the human-facing interface: it narrates sidecar reports, routes `/cam-plan`, `/cam-review`, `/cam-ship`, `/cam-issue`, and surfaces blockers. The implement-review loop is driven by the SIDECAR (background process), not by the orchestrator.
- **Pane 0.1 (right):** `cam dashboard`, a permanent navigable monitor. Browse stories with j/k or arrow keys, Enter to open a story detail view, Esc to go back. Press `n/r/s/p/i` to dispatch `/cam-*` commands to the orchestrator, `d` to focus the orchestrator pane, `q` to close the dashboard.
- **Pane 0.2 (worker, ephemeral):** created on first worker dispatch, reused across stories via `respawn-pane -k`. Present only while a worker is active; the mutex check refuses new dispatches when this pane exists (3 panes = busy).

`cam plan`, `cam issue`, `cam spec`, `cam review`, and `cam ship` are thin-proxies: they detect the active cam session, ensure the orchestrator is idle (`sendKeysWhenIdle`), and inject the corresponding slash command into the orchestrator pane via atomic `send-keys` (text + Enter in one literal call). If no session exists, they bootstrap `cam run --no-attach` first. If a worker is already running (mutex: 3 panes present), the proxy refuses the dispatch and exits with code 1. From outside the session the proxy prints a contextual hint with the `cam run` attach command (suppressed inside the session). `cam next` is different: it flips `active:true` in the sidecar state file and returns immediately -- no idle check, no send-keys, no slash-command injection.

On a cycle-close, the orchestrator runs `cam journal append --cycle-close` to arm
the recycle marker (`cam-orch-recycle`). The watcher detects the marker, SIGTERMs
the claude process, and the wrapper respawns it, delivering the handoff via
`CAM_ORCH_REHYDRATE`. If no recycle marker is pending or the respawn cap is reached,
the wrapper tears down the entire session (`tmux kill-session`).

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
bun run build:release    # produce dist/gateship-{darwin,linux}-{arm64,x64}
```

Source layout:

```text
index.ts              CLI dispatch
src/commands/         one file per `cam <subcommand>`
src/linear/           Linear GraphQL client
src/config/           scripts/cam/project.toml reader/writer + model/effort/backend resolution
templates/            shipped to projects by `cam init`
  agents/             subagent-orchestrator, planner, implementer, reviewer, auditor
  commands/           /cam-plan, /cam-next, /cam-review, /cam-ship, /cam-issue, /cam-prune
  scripts/cam/        CLAUDE.md, journal.md, handoff.schema.json
test/                 bun:test suites
```

---

## Architecture

`cam run` is the single dispatch hub. CLI subcommands (`cam plan`, `cam issue`, `cam spec`, `cam review`, `cam ship`) are thin-proxies: they detect the live orchestrator session and inject the request into the orchestrator pane via atomic `send-keys` (text + Enter in one literal call). If no session exists, they bootstrap `cam run --no-attach` and wait for the `.claude/.cam-orch-ready` marker before injecting. `cam next` is a pure sidecar trigger: it writes `active:true` to the sidecar state file and returns -- no session detection, no idle check, no send-keys.

```
cam next  (pure sidecar trigger)
  └── write active:true to .claude/cam-loop.local.md and return

cam plan / cam issue / cam spec / cam review / cam ship  (send-keys thin-proxies)
  └── detect live orchestrator (hasSession + orchestratorAlive)
        ├── on miss: bootstrap cam run --no-attach, poll .claude/.cam-orch-ready
        ├── mutex check: refuse if worker-pane is already running (3 panes = busy)
        ├── idle check: wait for orchestrator pane idle (sendKeysWhenIdle)
        └── atomic send-keys: inject slash command + Enter (NO -l: -l makes "Enter" literal and never submits)

sidecar (background process, spawned by cam run)
  └── receives active:true flag, dispatches workers in the titled 3rd pane
        ├── respawn-pane -k <worker-pane>   -- reuse titled pane id
        │     claude --permission-mode <mode>
        │             --session-id <uuid>
        │             --agent <name>
        │             "<task-prompt>"
        └── worker writes completion report:
              scripts/cam/worker-report.json   -- structured outcome (PRIMARY)
              sidecar reads report, emits: "[cam] US-XXX DONE: ..." to orchestrator pane
```

Workers (implementer, reviewer) are interactive TUI `claude` sessions invoked with `--agent <name>`. On completion, the worker writes `scripts/cam/worker-report.json` (structured outcome). The sidecar polls for the report file, then emits the `[cam]` narration line to the orchestrator pane via its own `notifyOrchestrator` seam. Scrollback polling is not used for completion detection. The old stop-hook driver (a vendored Stop hook + `/cam-next` re-inject) is retired; `claude -p` (print mode) is not used for workers.

Workers always run in the **titled 3rd pane** (created on first dispatch, reused across stories via `respawn-pane -k`). A mutex check before each dispatch prevents concurrent workers: if 3 panes are already present, the dispatch is refused until the worker-pane closes.

---

## Security

`cam` spawns `claude` with `permission_mode = "bypassPermissions"` hardcoded
as a literal at every spawn site: the orchestrator (`src/commands/run.ts`),
`cam init`'s setup panes (`src/commands/setup.ts`), the worker/reviewer
dispatch path (`src/commands/sidecar.ts`), and the plan-runner phase
(`src/supervisor/plan-runner.ts`). There is no `permission_mode` config key:
it is not read by any spawn path, and no subcommand accepts a
`--permission-mode` flag. In practice this means every worker and
orchestrator session runs with no permission prompt: the agent can read,
write, and execute anywhere your user account can, without asking first for
each file edit or shell command. This is a deliberate trade-off for autonomous
looping, not an oversight, but it is not "safe by default" in the way an
interactive `claude` session is. If you want the agent's write/execute reach
contained instead of running bypass-permissions against your host, set
`[loop] worker_isolation = "container"` in `scripts/cam/project.toml` (default
is `"host"`), which routes worker sessions into container isolation instead of
running directly against your machine. This mitigation is partial: `worker_isolation`
is read only by the sidecar's worker/reviewer dispatch path (`src/commands/sidecar.ts`,
via `readWorkerIsolation` in `src/config/models.ts`), so it contains implementer
and reviewer sessions only. The orchestrator pane itself is always spawned on
the host with `claude --permission-mode bypassPermissions`
(`src/commands/setup.ts`), even when `worker_isolation = "container"` is set,
so the long-lived orchestrator retains unrestricted host read/write/execute
reach regardless of this setting.

---

## Recent changes

- **Single-hub dispatch (CAM-55)**: `cam run` is the only dispatch hub. `cam plan`, `cam issue`, `cam spec`, `cam review`, and `cam ship` are send-keys thin-proxies that inject slash commands into the orchestrator pane; `cam next` is a pure `active:true` sidecar trigger (no send-keys). Workers run in a uniform titled 3rd pane; completion is push-based (worker writes `scripts/cam/worker-report.json`; the sidecar reads it and emits the `[cam]` narration line to the orchestrator pane). A mutex prevents concurrent worker dispatches (3 panes = busy). The idle-guarantee (`sendKeysWhenIdle`) ensures the orchestrator is not mid-response when slash commands are injected.
- **Interactive TUI workers (CAM-42)**: `cam next` dispatches workers as interactive TUI `claude` sessions (not `claude -p`). `claude -p` is reserved for the `cam claude` retry-wrapper feature only.
- **Single per-project session**: `cam run` now creates one tmux session per
  project with a 2-pane layout (orchestrator + navigable dashboard). The navigable
  dashboard replaces the old interactive menu: n/r/s/p/i dispatch /cam-* to the
  orchestrator, j/k or arrows browse stories, Enter opens a story detail view.
  On a cycle-close, the orchestrator arms the recycle marker (`cam-orch-recycle`),
  the watcher SIGTERMs the process, and the wrapper respawns it with `CAM_ORCH_REHYDRATE`;
  otherwise the wrapper tears down the session.
- **Thin pane launchers**: `cam plan`, `cam issue`, and `cam spec` open a pane inside the
  project session and return 0 immediately (suppressing the attach hint when
  already inside the session). `cam next` is also a thin-proxy: it flips
  `active:true` to trigger the sidecar and returns 0 immediately.
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
