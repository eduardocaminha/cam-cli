# Gateship

Gateship is a local software-delivery runtime for coding agents. An operator
defines a task, Gateship gives it an isolated worktree, runs the selected local
Claude Code or Codex client, verifies the written acceptance commands, asks an
independent read-only reviewer to inspect the change, and ships the result
through a squash-merged pull request.

The product is web-first and local-first: Bun serves the UI on `127.0.0.1`,
SQLite stores run state and activity, and no terminal keystrokes or tmux session
sit on the execution path.

## Requirements

- Claude Code and/or Codex CLI installed with a subscription login
- [GitHub CLI](https://cli.github.com/) installed and authenticated with
  `gh auth login --web` and `gh auth setup-git`
- Bun 1.2.3 or newer when running from source
- Git with permission to create branches and worktrees in the target repository

Gateship executes the operator's signed-in `claude` or `codex` binary. It
passes agent children an allowlisted environment, never reads provider
credential files, and does not use an Agent SDK. GitHub shipping uses the
credential store owned by `gh`, never an ambient PAT.

## Install

Install the latest packaged binary:

```bash
curl -fsSL https://raw.githubusercontent.com/gateship-dev/gateship/main/install.sh | bash
```

The installer places `gateship` and the shorter `gship` alias in
`~/.local/bin` by default. Override the destination with
`GATESHIP_INSTALL_DIR`.

To build from source:

```bash
git clone https://github.com/gateship-dev/gateship.git
cd gateship
bun install --frozen-lockfile
bun run build:release
./dist/gateship-darwin-arm64 --version # example: Apple Silicon
```

For development, commands can run directly through Bun:

```bash
bun index.ts --help
```

## Update

Re-run the same installer; it replaces an existing installation in place.

```bash
curl -fsSL https://raw.githubusercontent.com/gateship-dev/gateship/main/install.sh | bash
gship --version
```

`gship --version` confirms what is installed, and the web header shows the
same version next to `gateship`. Pin a specific release instead of the newest
one with `GATESHIP_VERSION`:

```bash
curl -fsSL https://raw.githubusercontent.com/gateship-dev/gateship/main/install.sh | GATESHIP_VERSION=vX.Y.Z bash
```

Gateship never updates itself and never checks for new versions; updating is
always this explicit command.

## Quick start

Start the local control surface from any GitHub repository:

```bash
cd /path/to/project
gship
# prints http://127.0.0.1:7777
```

`gship --port 8080` selects another port. Runtime configuration and provider
sign-in belong in the web interface rather than separate CLI subcommands.

From the browser you can:

1. describe the work once, in conversation with a read-only orchestrator that
   investigates the repository;
2. authorize it explicitly, and that same turn records the task in the backlog
   and starts the run instead of asking you for two separate requests;
3. let decisions interrupt the work and wait for you as `Precisa de você`;
4. follow progress as `Trabalhando`, with public agent text, tool names,
   verification, and review over SSE;
5. enable local browser notifications, so a decision, a failure, or the
   completed run reaches you outside the tab;
6. switch between Claude and Codex without losing the durable conversation;
7. use the explicit controls as a deterministic fallback.

## Container

Gateship also ships as one container image: the compiled binary, git, the
GitHub CLI, the Claude Code CLI and the Codex CLI, with the port it already
uses answering the same UI.

```bash
GSHIP_BUILD_SHA=$(git rev-parse HEAD) GATESHIP_PROJECT_DIR=/path/to/project docker compose up
# http://127.0.0.1:7777, published to loopback only
```

`GSHIP_BUILD_SHA` bakes the commit the image was built from into the binary
the same way `scripts/build-release.sh` does for the native release binaries.
It is optional -- CI passes it (`.github/workflows/ci.yml` builds with
`--build-arg GSHIP_BUILD_SHA="${{ github.sha }}"`), but a bare `docker build
.` still produces a working image without it, exactly as a first manual
build or `docker compose up` without the variable would. It just cannot say
what commit it came from, so the service stays silent about it rather than
compare against a ref read that would belong to whatever project the
container is managing, not to Gateship's own source.

Every version tag push builds and publishes that same image, so installing a
new version no longer requires a local build. `.github/workflows/release.yml`
pushes it to the GitHub Container Registry tagged with both the version and
the commit, each carrying its own baked-in `GSHIP_BUILD_SHA` and the same
build provenance attestation the release binaries get:

```bash
GATESHIP_IMAGE=ghcr.io/gateship-dev/gateship:v1.2.3 GATESHIP_PROJECT_DIR=/path/to/project docker compose up
```

Leaving `GATESHIP_IMAGE` unset keeps `docker compose up` building from the
Dockerfile instead, exactly as before -- the local-build path stays available
for development and is what the container image's own verification build
uses.

Provider and GitHub authentication happen inside the container, on first boot,
and persist on the named volume `compose.yaml` mounts over that project's
`.gship/` -- never copied from the host, since on macOS the Claude CLI keeps
its credential in the Keychain and there is no host credential file to mount:

```bash
docker compose exec gateship claude auth login
docker compose exec gateship gh auth login --web
docker compose exec gateship gh auth setup-git
```

The Codex CLI is in the image too, and its `CODEX_HOME` persists on the same
volume, but its ChatGPT sign-in does not work from inside this container yet:
it redirects the browser to a fixed loopback callback (`localhost:1455`) that
Docker's default bridge networking cannot reach from the host, so the web
interface's own Codex login button cannot complete there today.

Recreating the container from the same image and the same volume returns the
operator to the same place: the same SQLite state, the same managed
worktrees, and the same two logins.

## Runtime flow

```text
operator task
  -> read-only conversational orchestrator
  -> at most one typed Gateship command
  -> remote-main backlog record
  -> isolated .gship/worktrees/<run>
  -> selected Claude/Codex implementation session
  -> acceptance-command verification
  -> independent read-only review through the same provider
       -> one automatic fix attempt when findings exist
       -> operator guidance if findings remain
  -> commit + push + pull request
  -> squash auto-merge after CI
  -> refresh origin/main
  -> release the clean managed worktree and local branch
```

The task specification is the execution contract. Gateship does not require a
planner to rewrite it or an auditor to negotiate with the planner. Verification
runs the commands in the direct `spec: { scope, verify }` contract; an issue
with no `verify` commands fails preflight. Review is a separate fresh session
with mechanically read-only capabilities.

## Main commands

```text
gship                       Start the web runtime on 127.0.0.1:7777
gship --port N              Start it on another port
gship --help                Show the CLI surface
gship --version             Print the installed version
```

## Architecture

The current runtime is deliberately small:

- `src/commands/web.ts`: localhost HTTP routes and production composition;
- `src/runtime/run-runtime.ts`: run state machine and cancellation ownership;
- `src/runtime/run-store.ts`: SQLite runs and append-only events;
- `src/runtime/git-workspace.ts`: isolated worktree creation from
  `origin/main`, terminal release, and safe leftover inspection without moving
  local `main`;
- `src/runtime/agent-session.ts`: provider-neutral session contract;
- `src/runtime/agent-process.ts`: shared child/process-group lifecycle;
- `src/runtime/child-env.ts`: allowlisted agent and GitHub CLI environments;
- `src/runtime/conversational-orchestrator.ts`: read-only conversation and the
  single typed-command boundary;
- `src/runtime/claude-cli-*`: Claude stream-json execution and locked review;
- `src/runtime/codex-cli-*`: Codex JSONL execution and built-in read-only review;
- `src/runtime/codex-app-server.ts`: managed ChatGPT browser login without
  exposing tokens to Gateship;
- `src/runtime/git-runtime.ts`: source preflight and deterministic verification;
- `src/runtime/github-shipper.ts`: idempotent commit, PR, auto-merge, and source
  refresh;
- `webui/`: React/Vite operator interface bundled with the release.

The provider boundary and the admission rule for optional local-agent adapters
are documented in [docs/agent-providers.md](./docs/agent-providers.md).
Credential ownership and the notification policy are documented in
[docs/credentials-and-notifications.md](./docs/credentials-and-notifications.md).

There is no separate `gshipd`: the `gship` process is already the durable
service. Adding a second daemon would duplicate ownership of the same SQLite
state, child processes, and HTTP lifecycle.

## Durable state and recovery

Run metadata, provider selection, events, the public orchestrator transcript,
and one native orchestrator session id per provider live in
`.gship/runtime.sqlite`. The shared transcript is the handoff between Claude,
Codex, and later service sessions. Each run stores its own provider, native
session id, and worktree path. When the service restarts, an unowned in-flight
run becomes `interrupted`; the operator can resume it instead of losing the
workspace or silently starting a duplicate run.

After a confirmed merge, Gateship removes the clean managed worktree, its local
branch, and its stale remote-tracking ref. A run that ends `failed` releases the
same way, with one added condition: its branch must also carry no commit missing
from `origin/main`, so a commit made just before the failure is preserved instead
of being discarded with the workspace. Cleanup is retried on startup. Dirty
worktrees, unowned leftovers, and failed branches with such a commit are
preserved and shown in the web UI.

The runtime source is `refs/remotes/origin/main`. Gateship fetches that ref
before admitting a run and after a merge. It intentionally does not update or
check out the user's local `main` branch.

## Security

By default the HTTP server binds only to `127.0.0.1`, and browser mutations
additionally require a same-origin localhost request. Read routes carry no
authentication of their own -- the loopback bind is their only boundary, same
as before this existed. The [container image](#container) needs
`GATESHIP_BIND_HOST=0.0.0.0` for Docker's published-port proxy to reach the
service at all (it always connects to the container's own network address,
never its loopback), so inside the container that boundary no longer lives in
the service's own bind; it moves entirely to how the port is published on the
host. `compose.yaml` publishes it as `127.0.0.1:<port>` to keep the same
loopback-only guarantee end to end. Publishing that port on any other
interface -- a bare `docker run -p 7777:7777` without pinning it to
`127.0.0.1`, or a compose override that widens it -- exposes every
unauthenticated read route to the network. Adding authentication is a
separate, deliberate decision, not a byproduct of this packaging.

The implementer is intentionally write-capable inside the isolated worktree,
so the selected Claude Code or Codex process still has the host permissions of
the user running Gateship. Use Gateship only in repositories and on machines
where that authority is acceptable.

The conversational orchestrator is mechanically read-only: Claude exposes only
Read/Grep/Glob with MCP and slash commands disabled; Codex runs in its read-only
sandbox with user configuration/MCP disabled. Review uses the same restrictions
in a fresh independent session. Only the service interprets and executes the
orchestrator's typed command.

Agent and GitHub CLI children receive an environment allowlist, so unrelated
PATs and API keys are not inherited accidentally. Verification commands are
trusted project commands and retain the service environment. Gateship has no
web or SQLite field for provider or GitHub credentials; see the documented
[credential boundary](./docs/credentials-and-notifications.md).

## Retired runtime

The tmux orchestrator, sidecar, per-run container worker, terminal UI,
installed Claude personas, and their control commands have been removed. The
web runtime invokes the selected signed-in Claude or Codex CLI directly. The
[container image](#container) above is a different, later decision: one image
for the whole service, not a sandbox per run.

Historical decisions remain in `docs/adr/`; the current executable flow is
summarized in [FLOW.md](./FLOW.md).

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run check:all
```

The ship/CI gate runs type checking, tests, linting, and dead-code analysis.
Use focused tests while editing; run the full gate once before shipping.

## Community

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md), the
[Code of Conduct](./CODE_OF_CONDUCT.md), and [SECURITY.md](./SECURITY.md)
before opening a pull request or reporting a vulnerability.

## License

MIT. See [LICENSE](./LICENSE).
