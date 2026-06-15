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
- **issues.local.json hygiene** (CAM-47 dogfood, 2026-06-14): `cam issue` / `/cam-issue create` allocate the next id from the top-level `next_id` field and then bump it. If you hand-edit issues with explicit ids (bulk-filing), advance `next_id` to `max(id)+1` in the same edit, or the next automatic allocation collides with an existing id (a duplicate `CAM-N` appears, one closed and one open). A live `cam run` orchestrator is a concurrent writer of this file (via `/cam-issue`): do not hand-edit issues.local.json while a session is running on the same working tree.
- **ink-testing-library keypress simulation** (US-003, 2026-06-14): `const { stdin } = render(...)` exposes a fake Stdin whose `stdin.write('n')` emits a 'data' event synchronously, which Ink's useInput hook processes immediately. Use this to assert that injected runTmux/dispatch callbacks receive the correct args (e.g. `['send-keys', '-t', orchPane, '/cam-next', 'Enter']`). The old menu.test.ts comment "cannot easily simulate keypresses without stdin access" was wrong; stdin is returned by render() in ink-testing-library.
- **tmux window-resized hook + resize-pane -x clamp** (CAM-48, US-002, 2026-06-14): `resize-pane -x` rejects tmux format expressions like `#{window_width}` with "width invalid" - the value must be a pre-computed literal integer. tmux comparison modifiers (`#{>:a,b}`) are lexical (string), not numeric, so a numeric min/max clamp cannot be expressed in pure tmux format. Solution: use `run-shell 'w=#{window_width}; t=$(( (w*26+50)/100 )); t=$(( t<34?34:t>80?80:t )); tmux -L <socket> resize-pane -t <paneId> -x $t || true'`. `run-shell` causes tmux to expand `#{window_width}` to a numeric literal before passing the string to `sh -c`, enabling shell `$(())` arithmetic for the clamp. Use `(w*26+50)/100` (round-half-up) not `w*26/100` (truncation) to match `Math.round` in the JS helper. Bounds 34-80, proportion 26%: at 188 cols the column is 49 cols, wide enough for the tokens status row. Interpolate the socket constant (CAM_TMUX_SOCKET) in the TS template string instead of a hardcoded literal. Verified: w=100->34, w=188->49, w=220->57, w=400->80.
