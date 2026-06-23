# Vendored smokes

These files are vendored verbatim from the [eduardocaminha/reporter](https://github.com/eduardocaminha/reporter) monorepo so `cam init` can validate the operator's machine without depending on a local checkout of `reporter`. Once installed, the CLI must work standalone — vendoring is the cheapest way to honor that contract while keeping the smokes' diagnostic precision intact.

## Files

| File | Source | Last vendored from sha |
|---|---|---|
| `check-agent-frontmatter.sh` | `reporter:scripts/smoke/check-agent-frontmatter.sh` | 03c185c3244b7d3fa29cdd92793f8e01cae88c38 |
| `check-agent-frontmatter.ts` (CAM-69: hand-rolled parser, zero-dep) | `reporter:scripts/smoke/check-agent-frontmatter.ts` | 03c185c3244b7d3fa29cdd92793f8e01cae88c38 |
| `cam-loop.local.md.tmpl` | cam-cli (state file pre-armed by `cam next`)                                          | n/a |

The sha column for the reporter-derived files refers to the reporter HEAD at the time of the most recent re-vendor. Byte-parity of the embedded copies (in `src/vendor/_generated.ts`) against the on-disk vendor files is checked by `test/embedded.test.ts` on every `bun test` run, and by `bun run embed-vendor:check`.

The `cam-loop.local.md.tmpl` template defines the YAML-frontmatter-plus-prompt shape that `cam next` writes to `.claude/cam-loop.local.md` before spawning `claude`. The supervisor (the deterministic TS loop driven by `cam next`) reads and updates this file directly; the old vendored Stop hook that drove the loop was retired in CAM-22 and its script was deleted in CAM-3.

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
cd $CAM && bun run embed-vendor && bun test test/embedded.test.ts   # re-embed + confirm parity
```

## Runtime behavior

`cam init` invokes `check-agent-frontmatter.ts` directly via `bun` (not via the `.sh` wrapper) — Bun is a hard dependency of `cam` itself, so the runtime-detection ladder in the `.sh` is redundant. The `.sh` is vendored only for parity / drift detection.

Built-in skip behavior:

- `check-agent-frontmatter.ts` exits 0 when `.claude/agents/` is missing under the resolved repo root, and exits 2 when no git repo is reachable from cwd. `cam init` treats exit 2 as **skip-with-warning**, not failure — the operator may not be inside a git repo when running `cam init`.
