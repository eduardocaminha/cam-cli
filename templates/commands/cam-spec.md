Deep-spec an idea issue into `stage:specified` by running the grill-with-docs interview chain.

**CLI thin-proxy invocation**: `cam spec <id>` (run from a terminal outside the session) is a thin-proxy. It detects the active cam session, waits for the orchestrator to be idle, then injects `/cam-spec <id>` into the orchestrator pane via atomic `send-keys`. The content below is what the orchestrator executes when it receives this slash command.

## Overview

`/cam-spec <id>` takes a `stage:idea` issue (e.g. `CAM-42`) and transforms it into a `stage:specified` issue by running a structured operator interview (the **grill-with-docs** skill chain). At the end of the interview the orchestrator calls the deterministic spec writer (`specifyIssueOnMain`) to persist the result — the issue transitions from `idea` to `specified` on `main` without touching the working branch.

This command is an **interactive operator interview** (human-in-the-loop), not an autonomous worker. It requires the operator's participation at each grill stage.

## Pre-flight

1. **Confirm the issue exists and is an idea**:
   ```bash
   # Derive padded filename, e.g. CAM-42 -> scripts/cam/issues/CAM-0042.json
   git show main:scripts/cam/issues/<PREFIX>-NNNN.json 2>/dev/null || cat scripts/cam/issues/<PREFIX>-NNNN.json
   ```
   Stop with a clear error if the issue is absent, already `stage:specified`, or not `status:open`.

2. **Confirm you are NOT in the middle of an active autonomous loop** (`active:true` in `.claude/cam-loop.local.md`). A spec interview and an active loop both write to the issues dir via on-main commit-tree plumbing — running them concurrently risks a commit conflict. If the loop is active, ask the operator to pause it (`cam stop` or wait for the current story to finish) before proceeding.

## Process: grill-with-docs skill chain

Run the **grill-with-docs** skill from `.claude/skills/grill-with-docs/SKILL.md`. Read that file now and follow its steps verbatim for the issue identified in the pre-flight.

Key points:
- The skill drives a structured multi-stage operator interview.
- Each stage probes a different dimension of the idea (problem, users, solution, constraints, success metrics, out-of-scope, risks).
- At each stage you fetch relevant official documentation or prior art (the "with-docs" part) so the operator's answers are grounded in reality.
- You build up the `spec` object incrementally across stages.

## Final step: persist the spec

After the grill-with-docs interview concludes and you have assembled the full `spec` object, call `specifyIssueOnMain` (from `src/commands/issue-specify.ts`) to persist the result:

```typescript
// Orchestrator executes this in-process (Task subagent or inline):
import { specifyIssueOnMain } from './src/commands/issue-specify.ts';
import { spawnSync } from 'node:child_process';

const result = specifyIssueOnMain({
  cwd: process.cwd(),          // absolute path to the project root
  id: '<id>',                  // e.g. 'CAM-42'
  spec: { ... },               // assembled spec from the grill interview
  wsjf: { ... },               // wsjf scores (value, timeCriticality, riskReduction, jobSize)
  spawnFn: (cmd, args, opts) => spawnSync(cmd, args, { ...opts, stdio: 'pipe' }),
  clock: () => new Date().toISOString(),
});
```

On success:
- Print: `✓ <id> is now stage:specified — run /cam-plan <N> to generate a PRD.`
- The issue is now visible to `selectPlannableIssue` (used by `/cam-plan` with no argument).

On failure:
- Print the error reason and stop. Do NOT retry silently.

## Error handling

| Reason | Action |
|---|---|
| Issue not found | Stop, print: `<id> not found in scripts/cam/issues/` |
| Issue not `stage:idea` | Stop, print: `<id> is already stage:<stage> — nothing to do` |
| Issue not `status:open` | Stop, print: `<id> is not open (status:<status>)` |
| Spec validation fails | Show the validation errors, ask the operator to correct the answers |
| diverged / detached-head | Stop, print the guard error from `specifyIssueOnMain` |
| Concurrent loop active | Stop, ask operator to pause the loop first |
