Deep-spec an idea issue into `stage:specified` by running the grill-with-docs interview chain.

**CLI thin-proxy invocation**: `cam spec <id>` (run from a terminal outside the session) is a thin-proxy. It detects the active cam session, waits for the orchestrator to be idle, then injects `/cam-spec <id>` into the orchestrator pane via atomic `send-keys`. The content below is what the orchestrator executes when it receives this slash command.

## Overview

`/cam-spec <id>` takes a `stage:idea` issue (e.g. `CAM-42`) and transforms it into a `stage:specified` issue by running a structured operator interview (the **grill-with-docs** skill chain). At the end of the interview the orchestrator pipes the assembled spec into `cam spec --persist <id>` (the in-process CLI channel over the deterministic spec writer, `specifyIssueOnMain`): the issue transitions from `idea` to `specified` on `main` without touching the working branch.

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
- Capture or confirm the issue's `type` with the operator during the interview: one of `feat`, `fix`, `chore`, or `docs` (default `feat` when the operator has no preference). This is a deliberate choice, not a guess — ask explicitly rather than inferring it silently from the idea's wording.

## Final step: persist the spec

After the grill-with-docs interview concludes and you have assembled the full
`spec` object, `wsjf` scores, and the confirmed `type` (and, if applicable, a
`blockedBy` list of issue ids), pipe the payload to `cam spec --persist <id>`
via stdin, using a **safe quoting pattern** so shell interpolation cannot
corrupt the JSON or execute arbitrary content (CAM-106 lesson):

```bash
cam spec --persist <id> <<'EOF'
{
  "spec": {
    "acceptanceCriteria": ["..."],
    "scope": "...",
    "gotchas": ["..."],
    "domainTerms": ["..."]
  },
  "wsjf": { "value": 0, "timeCriticality": 0, "riskReduction": 0, "jobSize": 0 },
  "type": "feat",
  "blockedBy": ["..."]
}
EOF
```

Include `"type"` as one of `"feat"`, `"fix"`, `"chore"`, or `"docs"` — the
value captured or confirmed with the operator earlier in the interview.
Omit `blockedBy` entirely when the interview surfaced no blocking issues. A
single-quoted heredoc (`<<'EOF'`, note the quotes around `EOF`) or a
single-quoted `echo '<json>' | cam spec --persist <id>` are both safe: the
shell does not expand `$`, backticks, or other special characters inside a
single-quoted body. **Never use an unquoted heredoc** (`<<EOF` without
quotes) or an unquoted `echo` to carry this payload: the shell would
interpolate `$` and backtick sequences that may appear in the operator's
interview answers, corrupting the JSON or, worse, executing arbitrary
content.

`cam spec --persist <id>` calls the deterministic spec writer
(`specifyIssueOnMain`) in-process: no tmux, no send-keys, no orchestrator
liveness check. It already validates `spec` and `wsjf` and enforces every
guard (stage, status, integrity, up-to-date-with-main), so this step never
re-validates the payload: the command's exit code and stdout are the sole
source of truth for the outcome.

The command's own stdout is the handback contract:

```
CAM_SPEC_RESULT=<id> sha=<sha>          # success, exit 0
CAM_SPEC_RESULT=ERROR reason=<reason>   # any failure, exit 1
```

On success:
- Print: `✓ <id> is now stage:specified. Run /cam-plan <N> to generate a PRD.`
- The issue is now visible to `selectPlannableIssue` (used by `/cam-plan` with no argument).

On failure:
- Stop and report the `reason` to the operator. Do NOT retry silently: a
  non-zero exit means the spec was never persisted.

## Final step: persist the domain docs

After `specifyIssueOnMain` succeeds, assemble a `DomainDocsPayload` from the
interview and persist it too. This is the missing output from the CAM-109
dogfood: two ADR-worthy decisions were resolved during that grill but nothing
was written, because there was no step wiring the interview output into
`CONTEXT.md` / `docs/adr/`. Every grill must produce the durable domain model,
not just the issue spec.

Assemble the payload:
- `terms`: the glossary terms surfaced during the interview, including
  (but not limited to) whatever went into `spec.domainTerms`. Each entry is
  `{ term, definition }`.
- `adrs`: only the decisions that pass **all three** ADR gates from the
  domain-modeling skill: (1) hard to reverse, (2) surprising without context,
  (3) the result of a real trade-off with genuine alternatives considered. If
  any gate is missing for a decision, leave it out of `adrs`. Each included
  entry is `{ title, context, decision, consequences }`.

If the interview produced no new terms and no ADR-worthy decisions, the
payload is `{ "terms": [], "adrs": [] }` (a sanctioned noOp: `cam spec
--write-docs` recognizes this shape and exits 0 with no writes). Do not skip
the step to "save time"; piping the empty payload is just as cheap and keeps
the step uniform.

Pipe the payload to `cam spec --write-docs <id>` via stdin, using a **safe
quoting pattern** so shell interpolation cannot corrupt the JSON or execute
arbitrary content (CAM-106 lesson):

```bash
cam spec --write-docs <id> <<'EOF'
{
  "terms": [
    { "term": "...", "definition": "..." }
  ],
  "adrs": [
    { "title": "...", "context": "...", "decision": "...", "consequences": "..." }
  ]
}
EOF
```

A single-quoted heredoc (`<<'EOF'`, note the quotes around `EOF`) or a
single-quoted `echo '<json>' | cam spec --write-docs <id>` are both safe: the
shell does not expand `$`, backticks, or other special characters inside a
single-quoted body. **Never use an unquoted heredoc** (`<<EOF` without
quotes) or an unquoted `echo` to carry this payload: the shell would
interpolate `$` and backtick sequences that may appear in the operator's
interview answers, corrupting the JSON or, worse, executing arbitrary
content.

`cam spec --write-docs` writes `CONTEXT.md` and `docs/adr/` directly on
`main` via commit-tree plumbing (mirrors `specifyIssueOnMain`); it does not
touch the working branch. **Never hand-write `CONTEXT.md` or `docs/adr/`**
via `Edit`, `Write`, `NotebookEdit`, or ad-hoc bash redirection (`>`, `>>`)
instead of this command: those tools are disallowed for this reason, and a
hand-written domain doc bypasses validation and the on-main commit
guarantees.

The command's own stdout is the handback contract on success (a real write,
not the noOp path):

```
CAM_DOMAIN_DOCS_WRITTEN=<id> sha=<sha>   # success, exit 0
```

A non-zero exit from `cam spec --write-docs` is a real failure and **must be
reported to the operator, never silently skipped**: print the error and stop.
This is the exact CAM-109 failure mode this step exists to close: the spec
was persisted but the domain docs were silently dropped, with nothing telling
the operator that the second write never happened.

## Error handling

| Reason | Action |
|---|---|
| Issue not found | Stop, print: `<id> not found in scripts/cam/issues/` |
| Issue not `stage:idea` | Stop, print: `<id> is already stage:<stage> — nothing to do` |
| Issue not `status:open` | Stop, print: `<id> is not open (status:<status>)` |
| Spec validation fails | Show the validation errors, ask the operator to correct the answers |
| diverged / detached-head / missing-main | Stop, print the `CAM_SPEC_RESULT=ERROR reason=<reason>` line from `cam spec --persist`; report to the operator, never retry silently |
| Concurrent loop active | Stop, ask operator to pause the loop first |
| `cam spec --write-docs` malformed/invalid payload | Stop, print the validation errors from the command's stderr; never silently skip |
| `cam spec --write-docs` diverged / detached-head / missing-main | Stop, print the guard error; report to the operator, never silently skip |
| `cam spec --write-docs` noOp (empty payload, nothing to write) | Not a failure: print the muted hint and continue |
