# Codebase Patterns

Durable, never-truncated home for reusable project conventions (the old
top-of-progress.txt block, CAM-31). This file is versioned on main and read by
agents to absorb project conventions without re-reading the whole codebase. Add
a bullet whenever a story reveals a reusable insight (a convention, a library
quirk, a gotcha). Unlike the per-story factual record (the event log) and the
per-story handoff (handoff.json), this knowledge persists.

- **Bun runtime**: always `Bun.spawn` / `Bun.$` / `Bun.file` over `node:child_process` / `node:fs`.
- **Permission mode**: never register a `--permission-mode` CLI flag on any subcommand (enforced by `test/no-permission-mode-flag.test.ts`). It is forwarded only to the spawned `claude` process.
- **claude -p is forbidden** (subscription rule, CAM-42): workers are interactive TUI `claude` sessions detected by polling `capture-pane` for the sentinel; never reintroduce `-p` in a worker argv (tests assert its absence). `claude -p` survives only in the separate `cam claude` retry wrapper.
- **noUncheckedIndexedAccess**: array indexing and regex capture groups are `T | undefined`. Guard with `?? fallback` or a justified non-null assertion.
- **Ink screens**: success/failure is signalled by the glyph (check accent / cross destructive), never by divider color. Render and look at the real output; do not trust header comments (see `lessons.md` 2026-06-05).
- **Tests**: `bun test` from repo root; test files live under `test/`, mirroring source. Inject fake reader/writer shapes instead of touching real stdin/stdout.
- **Commits**: conventional commits required (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`).
- **No em-dash in persisted .md** (project rule, 2026-05-20): use colon, comma, parens, period, or cut the connector.
