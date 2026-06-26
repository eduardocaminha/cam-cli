#!/usr/bin/env bash
# PreToolUse hook: deny any Task/Agent spawn whose subagent type is not in the allowlist.
#
# Allow contract: exit 0, no stdout output.
# Deny contract (Claude Code PreToolUse spec):
#   exit 0 + JSON stdout:
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
#
# Allowlist: subagent-planner, subagent-auditor (the two sanctioned plan-time subagents).
# All other types (including an absent/empty type) are DENIED.
#
# Reads the spawned subagent type from three field paths (defensive, per CAM-91 notes):
#   1. .tool_input.subagent_type  (primary field, Claude hooks spec)
#   2. .tool_input.agent_type     (alternate field observed in some payload shapes)
#   3. .agent_type                (top-level alternate)
# The first non-null/non-empty value wins.

set -euo pipefail

# Read the full PreToolUse payload from stdin.
payload="$(cat)"

# Extract the spawned subagent type using the defensive three-path read.
# jq //  is the alternative operator: falls through on null or false.
# -r gives raw string output (no quotes). If all three are null, // "" yields "".
# The 2>/dev/null || echo "" guard handles absent jq or malformed JSON without crashing.
subagent_type="$(printf '%s' "$payload" \
  | jq -r '(.tool_input.subagent_type // .tool_input.agent_type // .agent_type // "")' \
  2>/dev/null || echo "")"

# Check against the allowlist.
case "$subagent_type" in
  subagent-planner|subagent-auditor)
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
        "Subagent type \"" + $t + "\" is not in the cam allowlist {subagent-planner, subagent-auditor}."
        + " For code work, dispatch the implementer worker via /cam-next instead."
      )
    }
  }'
