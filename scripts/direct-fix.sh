#!/usr/bin/env bash
# direct-fix.sh -- launch the direct lane (memory/project_faixa_direta.md) in an
# isolated git worktree.
#
#   ./scripts/direct-fix.sh [--base <ref>] <slug> "<task>"
#   ./scripts/direct-fix.sh [--base <ref>] <slug> -f <task-file>
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
#
# The worktree base defaults to origin/main but is configurable with --base
# (e.g. --base origin/cam/issue-566, to fix a review finding whose oracle only
# exists on that branch). A non-main base is refused while the cam loop is
# active (active: true in the primary checkout's .claude/cam-loop.local.md):
# with the loop live, the sidecar can checkout or prune that branch under the
# worktree, which is exactly the isolation this script exists to provide.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BASE="origin/main"
POSITIONAL=()
while [[ $# -gt 0 ]]; do
	case "$1" in
		--base)
			[[ -n "${2:-}" ]] || { echo "--base needs a ref" >&2; exit 64; }
			BASE="$2"
			shift 2
			;;
		*)
			POSITIONAL+=("$1")
			shift
			;;
	esac
done
set -- ${POSITIONAL[@]+"${POSITIONAL[@]}"}

SLUG="${1:-}"
shift || true

if [[ -z "${SLUG}" ]]; then
	echo "usage: $0 [--base <ref>] <slug> \"<task>\" | $0 [--base <ref>] <slug> -f <task-file>" >&2
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

if [[ "${BASE}" != "origin/main" ]]; then
	LOOP_STATE="${REPO_ROOT}/.claude/cam-loop.local.md"
	if [[ -f "${LOOP_STATE}" ]] && grep -qE '^active:[[:space:]]*true' "${LOOP_STATE}"; then
		echo "refusing --base ${BASE}: the cam loop is active (active: true in .claude/cam-loop.local.md)." >&2
		echo "with the loop live, the sidecar can checkout or prune that branch under the worktree." >&2
		echo "stop the loop first, or use the default origin/main base." >&2
		exit 75
	fi
fi

BRANCH="direct/${SLUG}"
WORKTREE="${REPO_ROOT}/../$(basename "${REPO_ROOT}")-direct-${SLUG}"

if [[ -e "${WORKTREE}" ]]; then
	echo "worktree already exists: ${WORKTREE}" >&2
	echo "remove it first: git worktree remove '${WORKTREE}'" >&2
	exit 69
fi

if [[ "${BASE}" == origin/* ]]; then
	echo "[direct-fix] fetching ${BASE}"
	git -C "${REPO_ROOT}" fetch origin "${BASE#origin/}" --quiet
else
	echo "[direct-fix] using local ref ${BASE} (no fetch)"
fi

echo "[direct-fix] worktree ${WORKTREE} on ${BRANCH} (base ${BASE})"
git -C "${REPO_ROOT}" worktree add -b "${BRANCH}" "${WORKTREE}" "${BASE}" --quiet

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
