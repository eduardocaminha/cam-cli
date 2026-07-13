#!/usr/bin/env bash
# PreToolUse hook: capability policy for Task/Agent spawns, and a worker-actor
# write-guard on scripts/cam/prd.json for Write/Edit/MultiEdit, gated by CAM_SESSION.
#
# Scope gate (CAM_SESSION):
#   When CAM_SESSION is unset, this hook is inactive: exit 0 (allow) for any
#   subagent type. Interactive dev sessions stay completely unrestricted.
#   Only cam-managed sessions (where CAM_SESSION is set by the sidecar) enforce
#   the capability policy below.
#
# Write/Edit/MultiEdit policy (US-006, applies only when CAM_SESSION is set):
#   DENY only when BOTH are true: CAM_WORKER=1 is set (the worker-actor marker,
#   US-002/CAM-63, set ONLY on the implementer worker path -- never on the
#   planner, which also runs under CAM_SESSION and legitimately Writes
#   prd.json) AND tool_input.file_path ends with scripts/cam/prd.json. This
#   stops a worker session from self-flipping passes:true; the supervisor is
#   the sole writer of that field (ADR 0035 / US-003 finalizeStory).
#   ALLOW everything else (planner Writes to prd.json, any Write to a
#   non-prd.json path, etc).
#
# Capability policy (Task/Agent spawns, applies only when CAM_SESSION is set):
#   ALLOW: read-only / plan-time helpers that do not write code.
#     {Explore, Plan, claude-code-guide, subagent-planner, subagent-auditor, subagent-reviewer}
#   DENY: everything else, including code-writers and absent/unknown types.
#     Default-deny is preserved within scope: an unrecognised type is always DENY,
#     so a misread subagent_type can only produce a false DENY, never a false ALLOW.
#
# Allow contract: exit 0, no stdout.
# Deny contract (Claude Code PreToolUse spec):
#   exit 0 + JSON stdout:
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
#
# Fail-closed without jq:
#   If jq is absent from PATH, the hook emits a static deny JSON (via printf, not
#   via jq) and exits 0. This denies every Task/Agent spawn instead of failing open.
#   Without this guard, a missing jq exits 127, which Claude Code treats as a
#   non-blocking error (the spawn proceeds). The static deny is produced by printf
#   so it is available even when jq is absent.
#
# Reads the spawned subagent type from three field paths (defensive, per CAM-91 notes):
#   1. .tool_input.subagent_type  (primary field, Claude hooks spec)
#   2. .tool_input.agent_type     (alternate field observed in some payload shapes)
#   3. .agent_type                (top-level alternate)
# The first non-null/non-empty value wins.

set -euo pipefail

# Scope gate: inactive outside cam-managed sessions.
if [ -z "${CAM_SESSION:-}" ]; then
  exit 0
fi

# Read the full PreToolUse payload from stdin.
payload="$(cat)"

# Fail-closed guard: if jq is absent, deny every spawn via a static printf deny.
# Without this guard, the jq call below would exit 127 (command not found), which
# Claude Code treats as a non-blocking error and allows the spawn to proceed (fail-open).
if ! command -v jq >/dev/null 2>&1; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"jq is absent: all Task/Agent spawns are denied (fail-closed without jq)."}}'
  exit 0
fi

# Extract tool_name to branch between the Write/Edit/MultiEdit write-guard and
# the Task/Agent capability policy below. Both matchers route to this same
# script (settings.json has two PreToolUse entries), so the branch is required.
tool_name="$(printf '%s' "$payload" | jq -r '(.tool_name // "")' 2>/dev/null || echo "")"

case "$tool_name" in
  Write|Edit|MultiEdit)
    # Worker-actor write-guard: DENY only when CAM_WORKER=1 (worker-actor
    # marker) is set AND the target file_path ends with scripts/cam/prd.json.
    # file_path arrives absolute in production, so suffix-match it.
    file_path="$(printf '%s' "$payload" | jq -r '(.tool_input.file_path // "")' 2>/dev/null || echo "")"
    if [ -n "${CAM_WORKER:-}" ] && [[ "$file_path" == *scripts/cam/prd.json ]]; then
      jq -n --arg fp "$file_path" \
        '{
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: (
              "Worker-actor sessions may not Write/Edit/MultiEdit \"" + $fp + "\"."
              + " The supervisor is the sole writer of passes:true in scripts/cam/prd.json"
              + " (ADR 0035 / US-003 finalizeStory)."
            )
          }
        }'
      exit 0
    fi
    # ALLOW: exit 0, no output.
    exit 0
    ;;
esac

# Extract the spawned subagent type using the defensive three-path read.
# jq //  is the alternative operator: falls through on null or false.
# -r gives raw string output (no quotes). If all three are null, // "" yields "".
# The 2>/dev/null || echo "" guard handles absent jq or malformed JSON without crashing.
subagent_type="$(printf '%s' "$payload" \
  | jq -r '(.tool_input.subagent_type // .tool_input.agent_type // .agent_type // "")' \
  2>/dev/null || echo "")"

# Capability check: ALLOW read-only plan-time helpers; DENY everything else.
case "$subagent_type" in
  Explore|Plan|claude-code-guide|subagent-planner|subagent-auditor|subagent-reviewer)
    # ALLOW: exit 0, no output.
    exit 0
    ;;
esac

# DENY: emit the structured deny payload and exit 0.
jq -n \
  --arg t "$subagent_type" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: (
        "Subagent type \"" + $t + "\" is not in the cam capability allowlist."
        + " Allowed read-only helpers: Explore, Plan, claude-code-guide, subagent-planner, subagent-auditor, subagent-reviewer."
        + " For code work, dispatch the implementer worker via /cam-next instead."
        + " (Policy is scoped to cam-managed sessions via CAM_SESSION.)"
      )
    }
  }'
