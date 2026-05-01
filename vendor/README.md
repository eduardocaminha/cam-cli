# Vendored smokes

These files are vendored verbatim from the [eduardocaminha/reporter](https://github.com/eduardocaminha/reporter) monorepo so `ralph init` can validate the operator's machine without depending on a local checkout of `reporter`. After `brew install ralph`, the CLI must work standalone — vendoring is the cheapest way to honor that contract while keeping the smokes' diagnostic precision intact.

## Files

| File | Source | Last vendored from sha |
|---|---|---|
| `check-agent-frontmatter.sh` | `reporter:scripts/smoke/check-agent-frontmatter.sh` | 03c185c3244b7d3fa29cdd92793f8e01cae88c38 |
| `check-agent-frontmatter.ts` | `reporter:scripts/smoke/check-agent-frontmatter.ts` | 03c185c3244b7d3fa29cdd92793f8e01cae88c38 |
| `claude-auto-retry-patterns.ts` | `reporter:scripts/smoke/claude-auto-retry-patterns.ts` | 03c185c3244b7d3fa29cdd92793f8e01cae88c38 |
| `ralph-loop.local.md.tmpl` | `~/.claude/plugins/cache/claude-plugins-official/ralph-loop/<v>/scripts/setup-ralph-loop.sh` (output shape) | 1.0.0 |
| `ralph-loop-stop-hook.sh` | `~/.claude/plugins/cache/claude-plugins-official/ralph-loop/1.0.0/hooks/stop-hook.sh` | sha256: `e3e14a7f5b2ff474f41583dd2b5503baa670ae7c05fe03420b1e289941159ba8` (1.0.0 base + US-003 prd.json secondary check) |

The sha refers to the reporter HEAD at the time of the most recent re-vendor. `test/vendor.test.ts` runs the drift check on every `bun test` run when the reporter checkout is reachable at `~/Documents/Projects/reporter` — silently skips when missing (CI / non-dev machines / non-Eduardo contributors).

The `ralph-loop.local.md.tmpl` template mirrors the YAML-frontmatter-plus-prompt shape that the upstream plugin's `setup-ralph-loop.sh` emits to `.claude/ralph-loop.local.md`. We pre-arm the file ourselves (instead of shelling into the plugin's setup script) so `ralph next` works standalone — without requiring the operator to have a `claude` session running with the plugin installed yet. If the upstream plugin changes its state-file shape in a future release, bump the template here, update the version pin in this README, and re-test by running `ralph next` against the new plugin and confirming the loop arms correctly. Drift detection for the template is implicit — the loop's stop hook silently fails to fire if the frontmatter keys diverge.

## Stop-hook vendoring policy (`ralph-loop-stop-hook.sh`)

`ralph-loop-stop-hook.sh` is vendored from the official `claude-plugins-official/ralph-loop` plugin so `ralph next` can materialize the hook to `.claude/hooks/ralph-loop-stop.sh` and wire it into `.claude/settings.local.json` — making the Stop hook fire **without** requiring the operator to have the plugin installed in a live Claude Code session.

### Upstream source

```
~/.claude/plugins/cache/claude-plugins-official/ralph-loop/1.0.0/hooks/stop-hook.sh
```

### Vendored version: 1.0.0 + US-003 extension

This file is based on plugin version 1.0.0 and was **intentionally extended** in US-003
with a secondary prd.json completion check (defense-in-depth for Bug 3 + Bug 4). It is no
longer verbatim upstream. The vendored copy is intentionally diverged; the drift-detection
ceremony below applies only when the upstream plugin bumps its version and you need to
re-merge upstream changes with the local extension.

### sha256 baseline

```
e3e14a7f5b2ff474f41583dd2b5503baa670ae7c05fe03420b1e289941159ba8
```

`bun test` computes this sha256 at runtime (in `test/vendor.test.ts`) and fails if the on-disk file diverges from the baseline — this converts silent rot into an explicit test failure and forces the maintainer to either rebaseline or re-run the drift-detection ceremony below.

### Drift-detection ceremony (run before each cam-cli minor bump)

```bash
UPSTREAM=~/.claude/plugins/cache/claude-plugins-official/ralph-loop/1.0.0/hooks/stop-hook.sh
VENDOR=~/Documents/Projects/cam-cli/vendor/ralph-loop-stop-hook.sh

# Check for drift
diff <(sha256sum "$UPSTREAM" | cut -d' ' -f1) \
     <(sha256sum "$VENDOR"   | cut -d' ' -f1) \
  && echo "no drift — vendored copy matches upstream" \
  || echo "DRIFT DETECTED — upstream has changed"

# If drift found, re-vendor:
#   1. Copy the new version verbatim (after the vendor header).
#   2. Update the sha256 baseline above AND in the file's own header comment.
#   3. Update the table row above.
#   4. Run: bun test test/vendor.test.ts    # must pass
#   5. Open a follow-up story to bump + re-vendor (don't auto-merge).
```

If the upstream plugin changes its stop-hook behavior in a future release, re-vendoring is its own follow-up story — not auto-merged. This converts a silent-rot risk into an explicit ceremony.

## Why verbatim copies, not git submodules?

A submodule would force `brew install cam` consumers to clone the full reporter monorepo (~MB of unrelated code). Verbatim copies keep the `cam` formula self-contained. The drift-test alarm catches the only failure mode (silently outdated copies) without the consumer-side cost.

## Re-vendoring procedure

When upstream changes land in `reporter:scripts/smoke/{check-agent-frontmatter.sh,check-agent-frontmatter.ts,claude-auto-retry-patterns.ts}`:

```bash
REPORTER=~/Documents/Projects/reporter
CAM=~/Documents/Projects/cam-cli
cp $REPORTER/scripts/smoke/check-agent-frontmatter.sh $CAM/vendor/
cp $REPORTER/scripts/smoke/check-agent-frontmatter.ts $CAM/vendor/
cp $REPORTER/scripts/smoke/claude-auto-retry-patterns.ts $CAM/vendor/
chmod +x $CAM/vendor/check-agent-frontmatter.sh
# Update the sha column above
cd $CAM && bun test test/vendor.test.ts   # confirms drift cleared
```

## Runtime behavior

`cam init` invokes `check-agent-frontmatter.ts` and `claude-auto-retry-patterns.ts` directly via `bun` (not via the `.sh` wrapper) — Bun is a hard dependency of `cam` itself, so the runtime-detection ladder in the `.sh` is redundant. The `.sh` is vendored only for parity / drift detection.

Both `.ts` files have built-in skip behavior for environments where the validation target is absent:

- `check-agent-frontmatter.ts` exits 0 when `.claude/agents/` is missing under the resolved repo root, and exits 2 when no git repo is reachable from cwd. `cam init` treats exit 2 as **skip-with-warning**, not failure — the operator may not be inside a git repo when running `cam init`.
- `claude-auto-retry-patterns.ts` exits 0 with a `[smoke] skipping` log when `claude-auto-retry` is not installed at the hardcoded `/opt/homebrew/lib/node_modules/claude-auto-retry/src/` path.
