# Gateship

Gateship is a local software-delivery runtime for coding agents. An operator
defines a task, Gateship gives it an isolated worktree, runs the real Claude Code
CLI, verifies the written acceptance commands, asks an independent read-only
reviewer to inspect the change, and ships the result through a squash-merged pull
request.

The product is web-first and local-first: Bun serves the UI on `127.0.0.1`,
SQLite stores run state and activity, and no terminal keystrokes or tmux session
sit on the execution path.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and signed in
- [GitHub CLI](https://cli.github.com/) installed and authenticated
- Bun 1.2.3 or newer when running from source
- Git with permission to create branches and worktrees in the target repository

Gateship executes the signed-in `claude` binary. It does not require an
Anthropic API key or the Agent SDK.

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
bun run build
./dist/gship --version
```

For development, commands can run directly through Bun:

```bash
bun index.ts --help
```

## Quick start

Initialize a repository once:

```bash
cd /path/to/project
gship init
```

Start the local control surface:

```bash
gship
# prints http://127.0.0.1:7777
```

`gship web --port 8080` selects another port. `gship run` is a compatibility
alias for the same web service; it no longer starts tmux.

From the browser you can:

1. create an operator-specified task, or specify an existing idea;
2. start one durable run from the fresh `origin/main` source ref;
3. observe public agent text, tool names, verification, and review over SSE;
4. answer a concrete agent question and resume the same Claude session;
5. cancel a run or ship a verified run.

## Runtime flow

```text
operator task
  -> remote-main backlog record
  -> isolated .gship/worktrees/<run>
  -> Claude CLI implementation session
  -> acceptance-command verification
  -> independent read-only Claude review
       -> one automatic fix attempt when findings exist
       -> operator guidance if findings remain
  -> commit + push + pull request
  -> squash auto-merge after CI
  -> refresh origin/main
```

The task specification is the execution contract. Gateship does not require a
planner to rewrite it or an auditor to negotiate with the planner. Verification
runs the task's explicit named-command/file-assert oracles; review is a separate
fresh session with only Read, Grep, and Glob built-ins, no MCP servers, and no
slash commands.

## Main commands

```text
gship                       Start the web runtime on 127.0.0.1:7777
gship web [--port N]        Start it on another port
gship run [--port N]        Compatibility alias for gship web
gship init [options]        Initialize a project
gship config [--show]       Configure project models and backends
gship issue list|get|...    Deterministic backlog maintenance
gship help                  Show the complete command registry
```

Run `gship <command> --help` for details.

## Architecture

The current runtime is deliberately small:

- `src/commands/web.ts`: localhost HTTP routes and production composition;
- `src/runtime/run-runtime.ts`: run state machine and cancellation ownership;
- `src/runtime/run-store.ts`: SQLite runs and append-only events;
- `src/runtime/git-workspace.ts`: isolated worktree creation from
  `origin/main`, without moving local `main`;
- `src/runtime/claude-cli-process.ts`: stream-json Claude child lifecycle;
- `src/runtime/claude-cli-executor.ts`: resumable implementer session;
- `src/runtime/claude-cli-reviewer.ts`: independent read-only review;
- `src/runtime/git-runtime.ts`: source preflight and deterministic verification;
- `src/runtime/github-shipper.ts`: idempotent commit, PR, auto-merge, and source
  refresh;
- `webui/`: React/Vite operator interface bundled with the release.

There is no separate `gshipd`: the `gship web` process is already the durable
service. Adding a second daemon would duplicate ownership of the same SQLite
state, child processes, and HTTP lifecycle.

## Durable state and recovery

Run metadata and events live in `.gship/runtime.sqlite`. Each run stores its
Claude session id and worktree path. When the service restarts, an unowned
in-flight run becomes `interrupted`; the operator can resume it instead of
losing the workspace or silently starting a duplicate run.

The runtime source is `refs/remotes/origin/main`. Gateship fetches that ref
before admitting a run and after a merge. It intentionally does not update or
check out the user's local `main` branch.

## Security

The HTTP server binds only to `127.0.0.1` and browser mutations require a
same-origin localhost request. The implementer runs with Claude Code's
`bypassPermissions` mode inside the isolated worktree, so it still has the
host permissions of the user running Gateship. Use Gateship only in repositories
and on machines where that authority is acceptable.

The reviewer is capability-restricted independently of its prompt: only
Read/Grep/Glob are exposed, inherited MCP servers are removed, and slash commands
are disabled.

## Legacy drain

Gateship no longer creates or attaches to the old tmux orchestrator. A small set
of legacy control and cleanup commands remains temporarily so a session that was
already running can reach a terminal state. They are outside the web execution
path and are being removed by dependency closure, not extended with new policy
or tests.

Historical decisions remain in `docs/adr/`; the current executable flow is
summarized in [FLOW.md](./FLOW.md).

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run check:all
```

The full gate includes type checking, tests, formatting/linting, coverage,
dead-code and duplication checks, CI parity, generated-vendor parity, and
repository hygiene checks.

## License

MIT. See [LICENSE](./LICENSE).
