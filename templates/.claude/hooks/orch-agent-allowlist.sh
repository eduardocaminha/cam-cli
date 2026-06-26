#!/usr/bin/env bash
# PreToolUse hook: capability policy for Task/Agent spawns, gated by CAM_SESSION.
#
# Scope gate (CAM_SESSION):
#   When CAM_SESSION is unset, this hook is inactive: exit 0 (allow) for any
#   subagent type. Interactive dev sessions stay completely unrestricted.
#   Only cam-managed sessions (where CAM_SESSION is set by the sidecar) enforce
#   the capability policy below.
#
# Capability policy (applies only when CAM_SESSION is set):
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
