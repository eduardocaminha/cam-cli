# ADR 0020: Orchestrator runs as an enforced agent (--agent), not a catted prompt

## Context

The orchestrator was launched by catting a bootstrap prompt as the first user message (claude --model ... "$(cat promptFile)"), so its .claude/agents/subagent-orchestrator.md frontmatter (tools/disallowedTools) was never loaded and was advisory only. The PreToolUse hook gated subagent spawns, but nothing prevented the orchestrator from directly Editing or Writing code, so the 'orchestrator never edits code' invariant was aspirational rather than enforced.

## Decision

Launch the orchestrator with --agent subagent-orchestrator (plus a minimal boot nudge), making the frontmatter binding: tools/disallowedTools are enforced at runtime. This requires the frontmatter tools list to be complete against real runtime usage (Read, Glob, Grep, Bash, WebFetch, SlashCommand, Write, Skill, Task/Agent) and the boot-imperatives folded into the agent body Boot context so they run under --agent without the separate bootstrap prompt file.

## Consequences

The 'orchestrator never edits code' invariant becomes real (Edit/NotebookEdit denied at runtime). Cost: the tools list is now load-bearing (an omission bricks delegation), so it must be audited against real usage and kept in sync; enforcement is verified via a requires:operator live-validation ceremony because typecheck/tests cannot exercise the root-session launch. The alternative (keep the frontmatter advisory and merely document it) was rejected because it leaves the safety invariant unenforced.
