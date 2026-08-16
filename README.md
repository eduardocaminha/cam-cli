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
runs the commands in the direct `spec: { scope, verify }` contract. Legacy
`acceptanceCriteria` records remain readable while the existing backlog drains;
new tasks do not use an embedded oracle DSL. Review is a separate fresh session
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
branch, and its stale remote-tracking ref. Cleanup is retried on startup. Dirty,
failed, or unowned leftovers are preserved and shown in the web UI.

The runtime source is `refs/remotes/origin/main`. Gateship fetches that ref
before admitting a run and after a merge. It intentionally does not update or
check out the user's local `main` branch.

## Security

The HTTP server binds only to `127.0.0.1` and browser mutations require a
same-origin localhost request. The implementer is intentionally write-capable
inside the isolated worktree, so the selected Claude Code or Codex process
still has the host permissions of the user running Gateship. Use Gateship only
in repositories and on machines where that authority is acceptable.

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

The tmux orchestrator, sidecar, container worker, terminal UI, installed Claude
personas, and their control commands have been removed. The web runtime invokes
the selected signed-in Claude or Codex CLI directly.

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
