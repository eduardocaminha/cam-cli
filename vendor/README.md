# Vendored smokes

These files are vendored verbatim from the [eduardocaminha/reporter](https://github.com/eduardocaminha/reporter) monorepo so `ralph init` can validate the operator's machine without depending on a local checkout of `reporter`. After `brew install ralph`, the CLI must work standalone — vendoring is the cheapest way to honor that contract while keeping the smokes' diagnostic precision intact.

## Files

| File | Source | Last vendored from sha |
|---|---|---|
| `check-agent-frontmatter.sh` | `reporter:scripts/smoke/check-agent-frontmatter.sh` | 03c185c3244b7d3fa29cdd92793f8e01cae88c38 |
| `check-agent-frontmatter.ts` | `reporter:scripts/smoke/check-agent-frontmatter.ts` | 03c185c3244b7d3fa29cdd92793f8e01cae88c38 |
| `claude-auto-retry-patterns.ts` | `reporter:scripts/smoke/claude-auto-retry-patterns.ts` | 03c185c3244b7d3fa29cdd92793f8e01cae88c38 |

The sha refers to the reporter HEAD at the time of the most recent re-vendor. `test/vendor.test.ts` runs the drift check on every `bun test` run when the reporter checkout is reachable at `~/Documents/Projects/reporter` — silently skips when missing (CI / non-dev machines / non-Eduardo contributors).

## Why verbatim copies, not git submodules?

A submodule would force `brew install ralph` consumers to clone the full reporter monorepo (~MB of unrelated code). Verbatim copies keep the `ralph` formula self-contained. The drift-test alarm catches the only failure mode (silently outdated copies) without the consumer-side cost.

## Re-vendoring procedure

When upstream changes land in `reporter:scripts/smoke/{check-agent-frontmatter.sh,check-agent-frontmatter.ts,claude-auto-retry-patterns.ts}`:

```bash
REPORTER=~/Documents/Projects/reporter
RALPH=~/Documents/Projects/ralph-cli
cp $REPORTER/scripts/smoke/check-agent-frontmatter.sh $RALPH/vendor/
cp $REPORTER/scripts/smoke/check-agent-frontmatter.ts $RALPH/vendor/
cp $REPORTER/scripts/smoke/claude-auto-retry-patterns.ts $RALPH/vendor/
chmod +x $RALPH/vendor/check-agent-frontmatter.sh
# Update the sha column above
cd $RALPH && bun test test/vendor.test.ts   # confirms drift cleared
```

## Runtime behavior

`ralph init` invokes `check-agent-frontmatter.ts` and `claude-auto-retry-patterns.ts` directly via `bun` (not via the `.sh` wrapper) — Bun is a hard dependency of `ralph` itself, so the runtime-detection ladder in the `.sh` is redundant. The `.sh` is vendored only for parity / drift detection.

Both `.ts` files have built-in skip behavior for environments where the validation target is absent:

- `check-agent-frontmatter.ts` exits 0 when `.claude/agents/` is missing under the resolved repo root, and exits 2 when no git repo is reachable from cwd. `ralph init` treats exit 2 as **skip-with-warning**, not failure — the operator may not be inside a git repo when running `ralph init`.
- `claude-auto-retry-patterns.ts` exits 0 with a `[smoke] skipping` log when `claude-auto-retry` is not installed at the hardcoded `/opt/homebrew/lib/node_modules/claude-auto-retry/src/` path.
