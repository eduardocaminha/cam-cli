#!/bin/bash
# scripts/smoke/check-agent-frontmatter.sh
#
# Thin runtime-detection wrapper around check-agent-frontmatter.ts. Picks the
# first available TS-capable runtime (bun → npx tsx → node 22.6+ with
# --experimental-strip-types → modern node with native TS support) and
# dispatches.
#
# CONSUMERS
#   - .github/workflows/agent-files-lint.yml (CI on push + pull_request)
#   - .claude/hooks/pre-commit-check.sh (Step 6, skip-when-untouched)
#   - docs/runbooks/ralph-loop-recovery.md §Scenario 4 (manual diagnostic)
#   - Local Ralph operators running ad-hoc against tmp copies
#
# Both .sh and .ts accept an optional list of file paths as positional args.
# When no args given, the .ts walks .claude/agents/*.md from REPO_ROOT (default
# CI + pre-commit mode). When args given, only those paths are validated.
#
# Exit codes mirror the underlying .ts file:
#   0 ok / 1 violation / 2 environmental error.

set -e

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  echo "check-agent-frontmatter: not inside a git repo." >&2
  exit 2
fi

TS_FILE="$REPO_ROOT/scripts/smoke/check-agent-frontmatter.ts"
if [ ! -f "$TS_FILE" ]; then
  echo "check-agent-frontmatter: $TS_FILE not found." >&2
  exit 2
fi

# Suppress Node's "type module" reparse warning — see claude-auto-retry-patterns.sh
# for the rationale (matches pattern; keep CI logs clean).
export NODE_NO_WARNINGS=1

if command -v bun >/dev/null 2>&1; then
  exec bun "$TS_FILE" "$@"
fi

# Prefer the locally-installed tsx by absolute path: when the wrapper runs from
# REPO_ROOT (CI default, pre-commit hook), `npx tsx` resolves PATH relative to
# cwd and misses scripts/smoke/node_modules/.bin/tsx. Hard-coding the path
# avoids that miss without forcing a `cd` that would break .ts arg paths.
LOCAL_TSX="$REPO_ROOT/scripts/smoke/node_modules/.bin/tsx"
if [ -x "$LOCAL_TSX" ]; then
  exec "$LOCAL_TSX" "$TS_FILE" "$@"
fi

# Fall back to npx tsx without --no-install: lets ad-hoc operators run the
# smoke without `npm install --prefix scripts/smoke` first (npx fetches tsx
# transparently in ~3s). CI has tsx pre-installed via the previous workflow
# step, so this branch is exercised only on first-time local runs.
if command -v npx >/dev/null 2>&1 && npx --quiet tsx --version >/dev/null 2>&1; then
  exec npx tsx "$TS_FILE" "$@"
fi

# Last-resort branch: only Node 22.6+ can natively strip TS types. Node <22.6
# without bun/tsx will fail with ERR_UNKNOWN_FILE_EXTENSION — that's a real
# environmental gap, surface it cleanly instead of crashing on the .ts ext.
if command -v node >/dev/null 2>&1; then
  if node --help 2>/dev/null | grep -q "experimental-strip-types"; then
    exec node --experimental-strip-types "$TS_FILE" "$@"
  fi
  echo "check-agent-frontmatter: no TS-capable runtime found." >&2
  echo "  Tried: bun (missing), $LOCAL_TSX (missing), npx tsx (failed), node --experimental-strip-types (Node $(node --version) < 22.6)." >&2
  echo "  Fix: run \`npm install --prefix scripts/smoke\` to install the bundled tsx, or upgrade to Node >= 22.6." >&2
  exit 2
fi

echo "check-agent-frontmatter: no JavaScript runtime found (need bun, npx tsx, or node)." >&2
exit 2
