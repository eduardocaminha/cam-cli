#!/usr/bin/env bash
# direct-fix.sh -- launch the direct lane (memory/project_faixa_direta.md) in an
# isolated git worktree.
#
#   ./scripts/direct-fix.sh <slug> "<task>"
#   ./scripts/direct-fix.sh <slug> -f <task-file>
#
# Why a worktree and not just a branch: a fresh worktree has none of the
# gitignored dev artifacts (.claude/cam-worker-events.jsonl and friends), so
# `bun run check:all` there reproduces CI's conditions. The 2026-08-03 CI red
# (a test that ran locally and skipped in CI, tripping skip-ratchet) would have
# been caught before the push. It also keeps the cam sidecar, which operates on
# the primary checkout, from checking out main or pruning a branch underfoot.
#
# Run this yourself. It is deliberately not spawned by the orchestrator: a human
# authorizing each unconstrained session is the only gate this lane has.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLUG="${1:-}"
shift || true

if [[ -z "${SLUG}" ]]; then
	echo "usage: $0 <slug> \"<task>\" | $0 <slug> -f <task-file>" >&2
	exit 64
fi

if [[ "${1:-}" == "-f" ]]; then
	TASK_FILE="${2:?-f needs a file}"
	[[ -r "${TASK_FILE}" ]] || { echo "cannot read ${TASK_FILE}" >&2; exit 66; }
	TASK="$(cat "${TASK_FILE}")"
else
	TASK="${1:-}"
fi

[[ -n "${TASK}" ]] || { echo "empty task" >&2; exit 64; }

BRANCH="direct/${SLUG}"
WORKTREE="${REPO_ROOT}/../$(basename "${REPO_ROOT}")-direct-${SLUG}"

if [[ -e "${WORKTREE}" ]]; then
	echo "worktree already exists: ${WORKTREE}" >&2
	echo "remove it first: git worktree remove '${WORKTREE}'" >&2
	exit 69
fi

echo "[direct-fix] fetching origin/main"
git -C "${REPO_ROOT}" fetch origin main --quiet

echo "[direct-fix] worktree ${WORKTREE} on ${BRANCH}"
git -C "${REPO_ROOT}" worktree add -b "${BRANCH}" "${WORKTREE}" origin/main --quiet

echo "[direct-fix] bun install (fresh worktree has no node_modules)"
(cd "${WORKTREE}" && bun install --silent)

cat <<EOF

[direct-fix] ready
  worktree : ${WORKTREE}
  branch   : ${BRANCH}
  cleanup  : git -C '${REPO_ROOT}' worktree remove '${WORKTREE}'

Launching claude with /direct-fix. Read the task, answer the Step 0 entry gate
BEFORE editing, and stop if you cannot name the check that goes green.

EOF

cd "${WORKTREE}"
exec claude --permission-mode bypassPermissions "/direct-fix ${TASK}"
