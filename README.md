# Gateship

Gateship is a local software delivery runtime: a web control plane for coding
agents. It turns an operator-specified task into an isolated implementation,
deterministic verification, independent review, and a mergeable pull request.
Run state and public activity are durable, and interrupted Claude Code sessions
resume without relying on terminal keystrokes.

Built on Bun + TypeScript. Distributed as a single-file binary built from source.

> **Status:** the web-first strangler is live. `gship init` installs a project and
> `gship` starts the localhost runtime. The browser can create tasks, start and
> observe runs, answer agent decisions, cancel, and ship. The previous
> tmux/sidecar/orchestrator stack remains available only through `gship run`
> while its remaining external-issue and interactive-spec capabilities are
> measured rather than blindly ported.

---

## Prerequisites

`gship` shells out to a few tools. Install these first:

- **[Claude Code CLI](https://docs.claude.com/en/docs/agents-and-tools/claude-code/quickstart)**: the runtime agent (`claude` on PATH, signed in)
- **Bun >= 1.2**: required only for source installs (`brew install oven-sh/bun/bun`)
- **`gh` CLI**: required for the web runtime to open and merge pull requests (`brew install gh && gh auth login`)

The legacy `gship run` path additionally requires **tmux**. A
`LINEAR_API_KEY` is needed only when using the legacy Linear issue adapter.

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
is an on-demand check, not something `install.sh` runs for you, and it uses
the same `gh` CLI listed in [Prerequisites](#prerequisites):

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
cd gateship

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

Useful while iterating on Gateship itself or on a non-darwin-arm64 machine:

```bash
git clone https://github.com/gateship-dev/gateship.git
cd gateship
bun install

# Add a shim that runs the TS entrypoint via Bun:
cat <<'SHIM' | sudo tee /usr/local/bin/gship >/dev/null
#!/usr/bin/env bash
exec bun run /Users/YOU/path/to/gateship/index.ts "$@"
SHIM
sudo chmod +x /usr/local/bin/gship

gship --version
```

---

## Quick start

For an already initialized Gateship project, the default entry point is the
local web control surface:

```bash
# 1. Enter the project.
cd ~/code/my-project

# 2. Start the durable runtime and open the printed localhost URL.
gship          # starts the local web control surface

# The previous orchestrator remains available during the strangler migration.
gship run      # legacy tmux session
```

New projects use `gship init`, which installs the project files without opening
tmux, then `gship` to enter the web runtime. `gship init --legacy-tmux` keeps the
previous setup agent available during the migration. The web screen lists
plannable issues, creates operator-specified tasks from a title, scope, and
verification command, follows the current run through server-sent events, and
shows a durable activity timeline with the agents' public text and tool names.
When an executor needs a concrete decision, the run pauses at `waiting-user`;
the operator answers in the same screen and Gateship persists that response
before resuming the same Claude session. It also offers contextual start,
cancel, and ship actions. A task created there is committed directly to the
remote backlog as `specified`; it
does not need a separate planner pass before execution.

### Legacy tmux runtime

The previous orchestrator remains documented below while its remaining
non-equivalent setup and planning seams are migrated.

The orchestrator persists between sessions and accumulates project memory
in `scripts/cam/journal.md`. On a cycle-close, the orchestrator runs
`gship journal append --cycle-close` to arm the recycle marker (`cam-orch-recycle`);
the watcher SIGTERMs the claude process and the wrapper respawns it, delivering
the handoff via `CAM_ORCH_REHYDRATE`. If no recycle marker is pending, the wrapper
tears down the session. See `.claude/agents/subagent-orchestrator.md` for its full
system prompt.

---

## Commands

```text
gship                       Start the local web runtime on 127.0.0.1:7777
gship init [options]        Initialize a project for the web-first flow
gship web [--port N]        Start the web runtime on a custom port
gship run [options]         Open the temporary legacy tmux runtime
gship help                  Show web-first, maintenance, and legacy command groups
```

Run `gship <command> --help` for command-specific options. The complete legacy
surface remains callable during the migration but is grouped separately in
`gship help` instead of being presented as the primary workflow.

`gship next --headless` (CAM-516, ADR-0059) opts the legacy implementer worker
into a `claude -p`/stream-json dispatch for that one invocation only, instead of the
default interactive TUI `claude` session; it is never persisted by config and
never sticky across a call that omits it. The CLI trigger first detects or
bootstraps a live orchestrator session and refuses while the three-pane mutex
reports a worker already running. Only the sidecar's later implementer dispatch
changes mode. Headless dispatch is supported only with
`worker_isolation = "host"` and `[backend] implementer = "claude"`; either
container isolation or a non-Claude implementer backend blocks before spawn.
See "Recent changes" for the measurement that exempted it from the CAM-42
`claude -p` prohibition.

### Single project session

`gship run` manages one tmux session per project (named `cam-orch-<basename>-<hash>`).
All cam session commands use a dedicated `tmux -L cam` socket, isolated from your
default tmux socket. This isolation guarantees that cam's session is never confused
with sessions on the default socket and avoids a failure mode specific to macOS:
a stale tmux server left over from a dead security session denies TCC access to
`~/Documents`, which causes Claude Code to fail silently when reading project files.
By using `tmux -L cam`, cam always starts from a fresh server with the correct
security context for the current login session.

The session layout has two permanent panes plus an optional worker pane:

- **Pane 0.0 (left):** orchestrator claude process (boots the `subagent-orchestrator` agent). The orchestrator is the human-facing interface: it narrates sidecar reports, routes `/cam-plan`, `/cam-review`, `/cam-ship`, `/cam-issue`, and surfaces blockers. The implement-review loop is driven by the SIDECAR (background process), not by the orchestrator.
- **Pane 0.1 (right):** `gship dashboard`, a permanent navigable monitor. Browse stories with j/k or arrow keys, Enter to open a story detail view, Esc to go back. Press `n/r/s/p/i` to dispatch `/cam-*` commands to the orchestrator, `d` to focus the orchestrator pane, `q` to close the dashboard.
- **Pane 0.2 (tmux worker, ephemeral):** created on the first default tmux worker dispatch and reused across stories via `respawn-pane -k`. Present only while a tmux worker is active; the mutex check refuses new pane dispatches when this pane exists (3 panes = busy). The opt-in headless implementer path does not create this pane.

`gship plan`, `gship issue`, `gship spec`, `gship review`, and `gship ship` are thin-proxies: they detect the active cam session, ensure the orchestrator is idle (`sendKeysWhenIdle`), and inject the corresponding slash command into the orchestrator pane via atomic `send-keys` (text + Enter in one literal call). If no session exists, they bootstrap `gship run --no-attach` first. If a worker is already running (mutex: 3 panes present), the proxy refuses the dispatch and exits with code 1. From outside the session the proxy prints a contextual hint with the `gship run` attach command (suppressed inside the session). `gship next` shares the session detection/bootstrap and worker-mutex gates, then flips `active:true` in the sidecar state file and returns immediately; unlike the send-keys proxies, it does not wait for orchestrator idleness or inject a slash command.

On a cycle-close, the orchestrator runs `gship journal append --cycle-close` to arm
the recycle marker (`cam-orch-recycle`). The watcher detects the marker, SIGTERMs
the claude process, and the wrapper respawns it, delivering the handoff via
`CAM_ORCH_REHYDRATE`. If no recycle marker is pending or the respawn cap is reached,
the wrapper tears down the entire session (`tmux kill-session`).

### Recovery runbook: stale tmux server

**Stale cam socket** (cam server is unresponsive or pane operations fail):

```bash
tmux -L cam kill-server
```

This terminates every process attached to the dedicated cam socket and releases the socket file. After running it, `gship run` will spin up a fresh server with the correct security context for the current login session.

**Stale default socket** (you see TCC or file-access errors in the default tmux server that bleed into cam):

```bash
tmux kill-server   # kills the default socket server, not the cam socket
gship run          # re-opens the session under the isolated cam socket
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

- **Print mode** (`gship claude -p "…"`): cam captures `claude` output and retries
  transparently until the request succeeds or the retry budget is exhausted.
- **Interactive mode** (`gship claude` inside a tmux session): cam forks a detached
  background monitor (`gship retry-monitor`) that watches the tmux pane and sends
  the retry keystroke after the rate-limit window expires. Note: `gship claude` and
  `gship retry-monitor` intentionally use the user's ambient tmux socket (not `-L cam`),
  because they watch the user's live interactive pane, not the cam workspace session.

**Configuration** (`~/.config/cam/retry.toml`):

`gship init` writes this file on first run with commented defaults. Edit it to
tune the retry policy (max attempts, custom rate-limit patterns, foreground
command allowlist, etc.). If the file is absent, cam uses built-in defaults.

**Logs** (`~/.cam/retry-logs/`):

Each retry event is appended to a dated log file under this directory.
Gateship rotates logs automatically and keeps the last 7 days by default.

**Attribution**: the retry logic is ported from
[claude-auto-retry v0.2.2](https://github.com/cheapestinference/claude-auto-retry)
under the MIT license. See [LICENSES/claude-auto-retry-MIT.txt](./LICENSES/claude-auto-retry-MIT.txt).

---

## Development

```bash
bun install
bun test                 # run the unit-test suite (~470 tests)
bun run typecheck        # typecheck both the server/CLI and web UI projects
bun run build:ui         # build the browser UI into webui/dist
bun run build:release    # produce dist/gateship-{darwin,linux}-{arm64,x64}
```

Source layout:

```text
index.ts              CLI dispatch
src/commands/         one file per `gship <subcommand>`
src/linear/           Linear GraphQL client
src/config/           scripts/cam/project.toml reader/writer + model/effort/backend resolution
templates/            shipped to projects by `gship init`
  agents/             subagent-orchestrator, planner, implementer, reviewer, auditor
  commands/           /cam-plan, /cam-next, /cam-review, /cam-ship, /cam-issue, /cam-prune
  scripts/cam/        CLAUDE.md, journal.md, handoff.schema.json
webui/                Vite + React browser UI (build only; bundle serving is CAM-560)
test/                 bun:test suites
```

---

## Architecture

`gship run` is the single dispatch hub. CLI subcommands (`gship plan`, `gship issue`, `gship spec`, `gship review`, `gship ship`) are thin-proxies: they detect the live orchestrator session and inject the request into the orchestrator pane via atomic `send-keys` (text + Enter in one literal call). If no session exists, they bootstrap `gship run --no-attach` and wait for the `.claude/.cam-orch-ready` marker before injecting. `gship next` uses a different trigger after its CLI gates: it detects or bootstraps the same live session, refuses while the worker-pane mutex is busy, checks sidecar liveness and preflight, then writes `active:true` to the sidecar state file without injecting a slash command.

```
gship next  (CLI-gated sidecar-state trigger; no send-keys)
  └── detect live orchestrator (hasSession + orchestratorAlive)
        ├── on miss: bootstrap cam run --no-attach, poll .claude/.cam-orch-ready
        ├── mutex check: refuse if worker-pane is already running (3 panes = busy)
        ├── sidecar-liveness + deterministic preflight gates
        └── write active:true to .claude/cam-loop.local.md and return

gship plan / gship issue / gship spec / gship review / gship ship  (send-keys thin-proxies)
  └── detect live orchestrator (hasSession + orchestratorAlive)
        ├── on miss: bootstrap cam run --no-attach, poll .claude/.cam-orch-ready
        ├── mutex check: refuse if worker-pane is already running (3 panes = busy)
        ├── idle check: wait for orchestrator pane idle (sendKeysWhenIdle)
        └── atomic send-keys: inject slash command + Enter (NO -l: -l makes "Enter" literal and never submits)

sidecar (background process, spawned by cam run)
  └── receives active:true flag, acquires the supervisor lock, dispatches one worker
        ├── default tmux path
        │     respawn-pane -k <worker-pane>   -- reuse titled 3rd pane id
        │       claude --permission-mode <mode>
        │              --session-id <uuid>
        │              --agent <name>
        │              "<task-prompt>"
        ├── opt-in headless implementer path (cam next --headless)
        │     requires host isolation + claude implementer backend; otherwise block
        │     Bun.spawn claude --print ...    -- direct child, no worker pane
        │       stream-json stdout + child exit/idle/absolute deadlines end the dispatch
        └── worker writes completion report in either path:
              scripts/cam/worker-report.json   -- structured outcome (PRIMARY)
              sidecar reads report, emits: "[cam] US-XXX DONE: ..." to orchestrator pane
```

Workers (implementer, reviewer) are interactive TUI `claude` sessions invoked with `--agent <name>` by default. On completion, the worker writes `scripts/cam/worker-report.json` (structured outcome). The sidecar polls for the report file, then emits the `[cam]` narration line to the orchestrator pane via its own `notifyOrchestrator` seam. Scrollback polling is not used for completion detection. The old stop-hook driver (a vendored Stop hook + `/cam-next` re-inject) is retired; `claude -p` (print mode) is not used for workers except through the explicit `gship next --headless` opt-in (CAM-516, ADR-0059), which is never persisted and never sticky across a call that omits it.

The default tmux path runs workers in the **titled 3rd pane** (created on first dispatch and reused across stories via `respawn-pane -k`). Its pane-count mutex prevents concurrent pane workers: if 3 panes are already present, the dispatch is refused until the worker pane closes. The headless implementer path runs `claude --print` as a direct child process with stream-json I/O and creates no worker pane; `gship next` still applies the three-pane mutex before activation, and the running sidecar dispatch is serialized by the supervisor lock.

---

## Security

`cam` spawns `claude` with `permission_mode = "bypassPermissions"` hardcoded
as a literal at every spawn site: the orchestrator (`src/commands/run.ts`),
`gship init`'s setup panes (`src/commands/setup.ts`), the worker/reviewer
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

- **Single-hub dispatch (CAM-55)**: `gship run` is the only dispatch hub. `gship plan`, `gship issue`, `gship spec`, `gship review`, and `gship ship` are send-keys thin-proxies that inject slash commands into the orchestrator pane; after session/bootstrap and worker-mutex gates, `gship next` uses an `active:true` sidecar-state trigger (no send-keys). The default tmux worker path uses a titled 3rd pane; the opt-in headless implementer path uses a direct child process serialized by the supervisor lock. Completion is push-based in either mode (worker writes `scripts/cam/worker-report.json`; the sidecar reads it and emits the `[cam]` narration line to the orchestrator pane). The idle-guarantee (`sendKeysWhenIdle`) ensures the orchestrator is not mid-response when slash commands are injected.
- **Interactive TUI workers by default, headless opt-in (CAM-42, recortada by ADR-0059/CAM-516)**: `gship next` dispatches workers as interactive TUI `claude` sessions (not `claude -p`) by default. `claude -p` remains banned for the tmux worker path and for the `gship claude` retry-wrapper's own auth preflight. The one exemption is `gship next --headless`: a pure per-invocation flag (never persisted by config, never sticky across a call that omits it) that opts the implementer worker into a `claude -p`/stream-json dispatch instead, born exempt because a 2026-08-08 measurement (ADR-0059) found it left console API consumption unchanged and reported a subscription-window `rate_limit_event`, not a per-use charge.
- **Single per-project session**: `gship run` now creates one tmux session per
  project with a 2-pane layout (orchestrator + navigable dashboard). The navigable
  dashboard replaces the old interactive menu: n/r/s/p/i dispatch /cam-* to the
  orchestrator, j/k or arrows browse stories, Enter opens a story detail view.
  On a cycle-close, the orchestrator arms the recycle marker (`cam-orch-recycle`),
  the watcher SIGTERMs the process, and the wrapper respawns it with `CAM_ORCH_REHYDRATE`;
  otherwise the wrapper tears down the session.
- **Thin pane launchers**: `gship plan`, `gship issue`, and `gship spec` open a pane inside the
  project session and return 0 immediately (suppressing the attach hint when
  already inside the session). `gship next` is also a thin-proxy: after its
  session/bootstrap and worker-mutex gates, it flips `active:true` to trigger
  the sidecar and returns 0 immediately.
- **`gship issue` subcommand**: file an issue from free text without entering
  the session. The pane agent runs `/cam-issue create <text>`.
- **Auto-retry internalized**: rate-limit retry is now built into `cam` (no
  external tool installation required). `gship init` no longer checks for any
  external retry binary. See [LICENSES/claude-auto-retry-MIT.txt](./LICENSES/claude-auto-retry-MIT.txt)
  for upstream attribution.
- **`gship claude` subcommand**: new explicit entry point for print-mode and
  interactive-mode claude runs with built-in retry.

---

## License

MIT. See [LICENSE](./LICENSE).
