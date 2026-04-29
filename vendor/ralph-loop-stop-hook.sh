#!/bin/bash
# vendor/ralph-loop-stop-hook.sh
#
# Based on (intentionally extended, no longer verbatim):
#   ~/.claude/plugins/cache/claude-plugins-official/ralph-loop/1.0.0/hooks/stop-hook.sh
# Upstream version: 1.0.0
# Upstream sha256 (at time of base): 13c547e77956e44f6af41d1be140f55da0e1ee3c55a540b530f48ee7c7ba9a11
#
# Extended in US-003: secondary prd.json completion check added after the
# standard <promise> tag check. See the "Secondary: prd.json completion check"
# section below and vendor/README.md for the extension policy.
#
# The sha256 baseline for THIS (extended) file is in vendor/README.md and
# test/vendor.test.ts. Run `bun test test/vendor.test.ts` to verify integrity.

# Ralph Loop Stop Hook
# Prevents session exit when a ralph-loop is active
# Feeds Claude's output back as input to continue the loop

set -euo pipefail

# Read hook input from stdin (advanced stop hook API)
HOOK_INPUT=$(cat)

# Check if ralph-loop is active
RALPH_STATE_FILE=".claude/ralph-loop.local.md"

if [[ ! -f "$RALPH_STATE_FILE" ]]; then
  # No active loop - allow exit
  exit 0
fi

# Parse markdown frontmatter (YAML between ---) and extract values
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$RALPH_STATE_FILE")
ITERATION=$(echo "$FRONTMATTER" | grep '^iteration:' | sed 's/iteration: *//')
MAX_ITERATIONS=$(echo "$FRONTMATTER" | grep '^max_iterations:' | sed 's/max_iterations: *//')
# Extract completion_promise and strip surrounding quotes if present
COMPLETION_PROMISE=$(echo "$FRONTMATTER" | grep '^completion_promise:' | sed 's/completion_promise: *//' | sed 's/^"\(.*\)"$/\1/')

# Session isolation: the state file is project-scoped, but the Stop hook
# fires in every Claude Code session in that project. If another session
# started the loop, this session must not block (or touch the state file).
# Legacy state files without session_id fall through (preserves old behavior).
STATE_SESSION=$(echo "$FRONTMATTER" | grep '^session_id:' | sed 's/session_id: *//' || true)
HOOK_SESSION=$(echo "$HOOK_INPUT" | jq -r '.session_id // ""')
if [[ -n "$STATE_SESSION" ]] && [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
  exit 0
fi

# Validate numeric fields before arithmetic operations
if [[ ! "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "⚠️  Ralph loop: State file corrupted" >&2
  echo "   File: $RALPH_STATE_FILE" >&2
  echo "   Problem: 'iteration' field is not a valid number (got: '$ITERATION')" >&2
  echo "" >&2
  echo "   This usually means the state file was manually edited or corrupted." >&2
  echo "   Ralph loop is stopping. Run /ralph-loop again to start fresh." >&2
  rm "$RALPH_STATE_FILE"
  exit 0
fi

if [[ ! "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "⚠️  Ralph loop: State file corrupted" >&2
  echo "   File: $RALPH_STATE_FILE" >&2
  echo "   Problem: 'max_iterations' field is not a valid number (got: '$MAX_ITERATIONS')" >&2
  echo "" >&2
  echo "   This usually means the state file was manually edited or corrupted." >&2
  echo "   Ralph loop is stopping. Run /ralph-loop again to start fresh." >&2
  rm "$RALPH_STATE_FILE"
  exit 0
fi

# Check if max iterations reached
if [[ $MAX_ITERATIONS -gt 0 ]] && [[ $ITERATION -ge $MAX_ITERATIONS ]]; then
  echo "🛑 Ralph loop: Max iterations ($MAX_ITERATIONS) reached."
  rm "$RALPH_STATE_FILE"
  exit 0
fi

# Get transcript path from hook input
TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.transcript_path')

if [[ ! -f "$TRANSCRIPT_PATH" ]]; then
  echo "⚠️  Ralph loop: Transcript file not found" >&2
  echo "   Expected: $TRANSCRIPT_PATH" >&2
  echo "   This is unusual and may indicate a Claude Code internal issue." >&2
  echo "   Ralph loop is stopping." >&2
  rm "$RALPH_STATE_FILE"
  exit 0
fi

# Read last assistant message from transcript (JSONL format - one JSON per line)
# First check if there are any assistant messages
if ! grep -q '"role":"assistant"' "$TRANSCRIPT_PATH"; then
  echo "⚠️  Ralph loop: No assistant messages found in transcript" >&2
  echo "   Transcript: $TRANSCRIPT_PATH" >&2
  echo "   This is unusual and may indicate a transcript format issue" >&2
  echo "   Ralph loop is stopping." >&2
  rm "$RALPH_STATE_FILE"
  exit 0
fi

# Extract the most recent assistant text block.
#
# Claude Code writes each content block (text/tool_use/thinking) as its own
# JSONL line, all with role=assistant. So slurp the last N assistant lines,
# flatten to text blocks only, and take the last one.
#
# Capped at the last 100 assistant lines to keep jq's slurp input bounded
# for long-running sessions.
LAST_LINES=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" | tail -n 100)
if [[ -z "$LAST_LINES" ]]; then
  echo "⚠️  Ralph loop: Failed to extract assistant messages" >&2
  echo "   Ralph loop is stopping." >&2
  rm "$RALPH_STATE_FILE"
  exit 0
fi

# Parse the recent lines and pull out the final text block.
# `last // ""` yields empty string when no text blocks exist (e.g. a turn
# that is all tool calls). That's fine: empty text means no <promise> tag,
# so the loop simply continues.
# (Briefly disable errexit so a jq failure can be caught by the $? check.)
set +e
LAST_OUTPUT=$(echo "$LAST_LINES" | jq -rs '
  map(.message.content[]? | select(.type == "text") | .text) | last // ""
' 2>&1)
JQ_EXIT=$?
set -e

# Check if jq succeeded
if [[ $JQ_EXIT -ne 0 ]]; then
  echo "⚠️  Ralph loop: Failed to parse assistant message JSON" >&2
  echo "   Error: $LAST_OUTPUT" >&2
  echo "   This may indicate a transcript format issue." >&2
  echo "   Ralph loop is stopping." >&2
  rm "$RALPH_STATE_FILE"
  exit 0
fi

# Check for completion promise (only if set)
if [[ "$COMPLETION_PROMISE" != "null" ]] && [[ -n "$COMPLETION_PROMISE" ]]; then
  # Extract text from <promise> tags using Perl for multiline support
  # -0777 slurps entire input, s flag makes . match newlines
  # .*? is non-greedy (takes FIRST tag), whitespace normalized
  PROMISE_TEXT=$(echo "$LAST_OUTPUT" | perl -0777 -pe 's/.*?<promise>(.*?)<\/promise>.*/$1/s; s/^\s+|\s+$//g; s/\s+/ /g' 2>/dev/null || echo "")

  # Use = for literal string comparison (not pattern matching)
  # == in [[ ]] does glob pattern matching which breaks with *, ?, [ characters
  if [[ -n "$PROMISE_TEXT" ]] && [[ "$PROMISE_TEXT" = "$COMPLETION_PROMISE" ]]; then
    echo "✅ Ralph loop: Detected <promise>$COMPLETION_PROMISE</promise>"
    rm "$RALPH_STATE_FILE"
    exit 0
  fi
fi

# --- Secondary: prd.json completion check ------------------------------------
#
# Defense-in-depth fallback for Bug 3 + Bug 4: if the assistant emitted plain
# "COMPLETE" without the XML wrapper OR the <promise> regex misfired, we still
# stop when the PRD itself says every story is done.
#
# Rules (mirrors scripts/ralph/CLAUDE.md § Stop Condition):
#   - Read <cwd>/scripts/ralph/prd.json.
#   - Every userStory where requires != "operator" must have passes:true.
#   - review.lastVerdict must be "CLEAN" or "MAX_ROUNDS_DEBT" (or review absent).
#   - If prd.json is missing or jq fails, fall through (fail-safe = keep looping).
PRD_JSON="scripts/ralph/prd.json"
if [[ -f "$PRD_JSON" ]]; then
  # Disable errexit temporarily so jq failures don't abort the whole hook.
  set +e

  # Count stories that are NOT operator-required AND have passes:false.
  NON_OPERATOR_INCOMPLETE=$(jq '
    [.userStories[] | select((.requires // "") != "operator") | select(.passes == false)]
    | length
  ' "$PRD_JSON" 2>/dev/null)
  JQ_PRD_EXIT=$?

  set -e

  if [[ $JQ_PRD_EXIT -eq 0 ]] && [[ "$NON_OPERATOR_INCOMPLETE" =~ ^[0-9]+$ ]]; then
    if [[ "$NON_OPERATOR_INCOMPLETE" -eq 0 ]]; then
      # All non-operator stories pass. Now check review verdict.
      set +e
      REVIEW_VERDICT=$(jq -r '(.review.lastVerdict // "NONE")' "$PRD_JSON" 2>/dev/null)
      JQ_REVIEW_EXIT=$?
      set -e

      if [[ $JQ_REVIEW_EXIT -eq 0 ]]; then
        # Verdict is acceptable when: no review block yet (NONE), CLEAN, or MAX_ROUNDS_DEBT.
        if [[ "$REVIEW_VERDICT" = "NONE" ]] || [[ "$REVIEW_VERDICT" = "CLEAN" ]] || [[ "$REVIEW_VERDICT" = "MAX_ROUNDS_DEBT" ]]; then
          echo "✅ Ralph loop: prd.json completion confirmed (all stories pass, verdict=$REVIEW_VERDICT)"
          rm "$RALPH_STATE_FILE"
          exit 0
        fi
      fi
    fi
  fi
fi
# --- End secondary check ------------------------------------------------------

# Not complete - continue loop with SAME PROMPT
NEXT_ITERATION=$((ITERATION + 1))

# Extract prompt (everything after the closing ---)
# Skip first --- line, skip until second --- line, then print everything after
# Use i>=2 instead of i==2 to handle --- in prompt content
PROMPT_TEXT=$(awk '/^---$/{i++; next} i>=2' "$RALPH_STATE_FILE")

if [[ -z "$PROMPT_TEXT" ]]; then
  echo "⚠️  Ralph loop: State file corrupted or incomplete" >&2
  echo "   File: $RALPH_STATE_FILE" >&2
  echo "   Problem: No prompt text found" >&2
  echo "" >&2
  echo "   This usually means:" >&2
  echo "     • State file was manually edited" >&2
  echo "     • File was corrupted during writing" >&2
  echo "" >&2
  echo "   Ralph loop is stopping. Run /ralph-loop again to start fresh." >&2
  rm "$RALPH_STATE_FILE"
  exit 0
fi

# Update iteration in frontmatter (portable across macOS and Linux)
# Create temp file, then atomically replace
TEMP_FILE="${RALPH_STATE_FILE}.tmp.$$"
sed "s/^iteration: .*/iteration: $NEXT_ITERATION/" "$RALPH_STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$RALPH_STATE_FILE"

# Build system message with iteration count and completion promise info
if [[ "$COMPLETION_PROMISE" != "null" ]] && [[ -n "$COMPLETION_PROMISE" ]]; then
  SYSTEM_MSG="🔄 Ralph iteration $NEXT_ITERATION | To stop: output <promise>$COMPLETION_PROMISE</promise> (ONLY when statement is TRUE - do not lie to exit!)"
else
  SYSTEM_MSG="🔄 Ralph iteration $NEXT_ITERATION | No completion promise set - loop runs infinitely"
fi

# Output JSON to block the stop and feed prompt back
# The "reason" field contains the prompt that will be sent back to Claude
jq -n \
  --arg prompt "$PROMPT_TEXT" \
  --arg msg "$SYSTEM_MSG" \
  '{
    "decision": "block",
    "reason": $prompt,
    "systemMessage": $msg
  }'

# Exit 0 for successful hook execution
exit 0
