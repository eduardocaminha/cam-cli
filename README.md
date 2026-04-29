# ralph-cli

A standalone CLI that wraps the official `ralph-loop` Claude Code plugin so long unattended Ralph runs can be driven from any terminal (Ghostty, iTerm, embedded VSCode) instead of from inside an IDE Claude session. The CLI adds an alt-screen TUI dashboard, automatic `--permission-mode bypassPermissions`, an OSC 2 pane-title hook for multi-pane setups, and four-mode resumability via `ralph resume`. Built on Bun + TypeScript. Tracking issue: [reporter#127](https://github.com/eduardocaminha/reporter/issues/127).

## Status

Bootstrapping. The initial scaffold lands via `bun init`; commands (`init`, `plan`, `run`, `resume`) follow in subsequent stories on the tracking issue's PRD.

## Development

```bash
bun install
bun test
```

## License

MIT — see [LICENSE](./LICENSE).
