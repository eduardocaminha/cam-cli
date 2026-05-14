# Vendored smokes

These files are vendored verbatim from the [eduardocaminha/reporter](https://github.com/eduardocaminha/reporter) monorepo so `cam init` can validate the operator's machine without depending on a local checkout of `reporter`. Once installed, the CLI must work standalone — vendoring is the cheapest way to honor that contract while keeping the smokes' diagnostic precision intact.

## Files

| File | Source | Last vendored from sha |
|---|---|---|
| `check-agent-frontmatter.sh` | `reporter:scripts/smoke/check-agent-frontmatter.sh` | 03c185c3244b7d3fa29cdd92793f8e01cae88c38 |
| `check-agent-frontmatter.ts` | `reporter:scripts/smoke/check-agent-frontmatter.ts` | 03c185c3244b7d3fa29cdd92793f8e01cae88c38 |
| `cam-loop.local.md.tmpl` | cam-cli (state file pre-armed by `cam next`)                                          | n/a |
| `cam-loop-stop-hook.sh`  | cam-cli (stop hook wired into `.claude/settings.local.json` by `cam next`)            | sha256: `32587c4699ecbf1f4e4bbf51761b518e4fabe74fa3b0cf8f71fdf3d1a214c5c6` |

The sha column for the reporter-derived files refers to the reporter HEAD at the time of the most recent re-vendor. `test/vendor.test.ts` runs the drift check on every `bun test` run when the reporter checkout is reachable at `~/Documents/Projects/reporter` — silently skips when missing (CI / non-dev machines / non-Eduardo contributors).

The `cam-loop.local.md.tmpl` template defines the YAML-frontmatter-plus-prompt shape that `cam next` writes to `.claude/cam-loop.local.md` before spawning `claude`. The companion `cam-loop-stop-hook.sh` reads this file on every `Stop` event and either emits the next prompt or removes the file to terminate the loop. The `bun test` suite recomputes the stop-hook's sha256 at runtime (in `test/vendor.test.ts`) and fails if the on-disk file diverges from the baseline — converting silent rot into an explicit test failure.

## Why verbatim copies, not git submodules?

A submodule would force `cam` consumers to clone the full reporter monorepo (~MB of unrelated code). Verbatim copies keep the `cam` binary self-contained. The drift-test alarm catches the only failure mode (silently outdated reporter copies) without the consumer-side cost.

## Re-vendoring procedure

When upstream changes land in `reporter:scripts/smoke/{check-agent-frontmatter.sh,check-agent-frontmatter.ts}`:

```bash
REPORTER=~/Documents/Projects/reporter
CAM=~/Documents/Projects/cam-cli
cp $REPORTER/scripts/smoke/check-agent-frontmatter.sh $CAM/vendor/
cp $REPORTER/scripts/smoke/check-agent-frontmatter.ts $CAM/vendor/
chmod +x $CAM/vendor/check-agent-frontmatter.sh
# Update the sha column above
cd $CAM && bun test test/vendor.test.ts   # confirms drift cleared
```

## Runtime behavior

`cam init` invokes `check-agent-frontmatter.ts` directly via `bun` (not via the `.sh` wrapper) — Bun is a hard dependency of `cam` itself, so the runtime-detection ladder in the `.sh` is redundant. The `.sh` is vendored only for parity / drift detection.

Built-in skip behavior:

- `check-agent-frontmatter.ts` exits 0 when `.claude/agents/` is missing under the resolved repo root, and exits 2 when no git repo is reachable from cwd. `cam init` treats exit 2 as **skip-with-warning**, not failure — the operator may not be inside a git repo when running `cam init`.
