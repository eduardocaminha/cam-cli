Review all changes on the current branch vs `main` using the `subagent-reviewer` agent.

**CLI thin-proxy invocation**: `cam review` (run from a terminal outside the session) is a thin-proxy. It detects the active cam session, waits for the orchestrator to be idle, then injects `/cam-review` into the orchestrator pane via atomic `send-keys`. The content below is what the orchestrator executes when it receives this slash command.

The `subagent-reviewer` runs in a **separate context** with read-only access. It receives only the diff and acceptance criteria -- not the generator's reasoning or progress notes.

The review-fix cycle is **bounded**: at most `CAM_MAX_REVIEW_ROUNDS` rounds (default 3, env override). Each round either ends with `<review>CLEAN</review>` (loop terminates with `<promise>COMPLETE</promise>`) or with N findings that get turned into `US-RX-NNN` stories for the implementer to pick up next iteration. After max-rounds, ship with explicit debt rather than spinning forever.

---

## Step 0: Read review state from PRD

Before gathering context, read `scripts/cam/prd.json` and check the optional `review` block:

```json
{
  "review": {
    "roundsCompleted": 0,
    "maxRounds": 3,
    "lastReviewSha": null,
    "lastVerdict": null
  }
}
```

If the block is absent (older PRDs), treat all fields as defaults: `roundsCompleted=0`, `maxRounds=3`, `lastReviewSha=null`, `lastVerdict=null`.

`maxRounds` may be overridden by env var `CAM_MAX_REVIEW_ROUNDS`. Read it once at the top:
```bash
CAM_MAX_REVIEW_ROUNDS="${CAM_MAX_REVIEW_ROUNDS:-3}"
```

The number of the round about to run is `roundsCompleted + 1`. Use this for round-aware story IDs (`US-R<round>-NNN`) and for the delta-diff scope (Step 1 below).

If `roundsCompleted >= maxRounds`, **STOP** and tell the operator:
```
⚠ Already at max review rounds ({roundsCompleted}/{maxRounds}). Ship with debt or raise the cap via CAM_MAX_REVIEW_ROUNDS.
```
Do not dispatch `subagent-reviewer` again.

---

## Step 1: Gather context

Before spawning `subagent-reviewer`, collect the inputs it needs:

1. **Acceptance criteria**: Read `scripts/cam/prd.json`. For each story where `passes: true`, extract its `id`, `title`, and `acceptanceCriteria` array.

2. **Diff summary**: Run `git diff <BASE>...HEAD --stat` where `<BASE>` is:
   - **Round 1** (no `lastReviewSha`): `<BASE> = main`
   - **Round 2+**: `<BASE> = lastReviewSha` (delta-diff so `subagent-reviewer` audits only what changed since the last round)

   When using delta-diff for round 2+, also pass the **cumulative diff vs main** as a second context block.

3. **Full diff**: Run `git diff <BASE>...HEAD`.

4. **Commit list**: Run `git log <BASE>..HEAD --oneline`.

5. **Pre-fetch doc URLs (optional)**: Scan the diff for external libraries touched. If you know the specific doc URL `subagent-reviewer` should consult, include those URLs as hints under a `Pre-fetched doc URLs` section in the Step 2 prompt.

---

## Step 2: Spawn the reviewer agent

```
Task(
  subagent_type="subagent-reviewer",
  description="Cam code review",
  prompt="""
<acceptance criteria from Step 1>

<diff summary and commit list from Step 1>

<pre-fetched doc URLs from Step 1.5, if any, under a `Pre-fetched doc URLs` heading>

Round N of max M.
<round 2+ only: previous round's verdict + fix commits since lastReviewSha>

Review these changes against your checklist. Read changed files in full for context. Run the project's build/typecheck command to verify. Report findings in the output format from your AGENT.md. End your output with a `<review>CLEAN</review>` or `<review>FIXES_PENDING:N</review>` tag on the very last line.
"""
)
```

Do NOT pass: `scripts/cam/handoff.json` or any generator reasoning.

---

## Step 3: Report findings

Display the `subagent-reviewer`'s output verbatim.

### Verdict body contract

The reviewer emits a structured **verdict body** block immediately before the terminal `<review>` sentinel. This body is the **payload the CAM-55 report-on-exit pushes to the orchestrator**:

```json
{
  "status": "PASS or FAIL",
  "justification": "<one-sentence prose summary of the verdict>",
  "itemizedFailures": [
    { "criterion": "<criterion-name>", "evidence": "<file:line or quoted snippet>", "note": "<short explanation>" }
  ]
}
```

The `status` field is binary: `"PASS"` when all 8 Layer-B criteria are satisfied and no hard-constraint rule triggered; `"FAIL"` otherwise. `itemizedFailures` lists only criteria that FAIL. The terminal `<review>CLEAN</review>` / `<review>FIXES_PENDING:N</review>` sentinel (parsed by `parseReviewVerdict` in `src/supervisor/result.ts`) is separate from this body and must remain the absolute last line of the reviewer's output.

---

## Step 4: Triage findings

After displaying the `subagent-reviewer`'s output, append a triage block:

| Destination | Trigger |
|---|---|
| **Fix in this branch** | CRITICAL items, and WARNINGs that are mechanical and clearly within scope — edits of ≤3 files, no product decision needed. |
| **New cam issue** — HIGH BAR | Must clear ALL three: (1) affects real users today OR blocks a near-term roadmap item, (2) is an active bug / regression / security gap, (3) cannot be addressed by a one-line follow-up note. |
| **Backlog / skip** | Default. Use for: stylistic preferences, defensive-only concerns, "consider X" suggestions, spec-vs-code wording drift. |

Print the triage:

```
## TRIAGE

### Fix in this branch
- [file:line] short description — why it fits

### New cam issue — suggested title
- [file:line] short description — why it needs its own issue

### Backlog / skip
- [file:line] short description — why skip

### Suggested next step
- If any "Fix in this branch" items: "Want me to apply? (applies fixes + runs quality gates + commit)"
- If APPROVE and empty triage: "Ready for /cam-ship"
```

**Bias toward `skip`.** 0–2 items under "New cam issue" is normal. 3+ issues from a single review is a smell.

---

## Step 5: Update PRD review state + materialize fix-stories

### Step 5.1 — Parse the verdict

Grep the `subagent-reviewer` output for the `<review>` tag:
- `<review>CLEAN</review>` — APPROVE with zero actionable findings
- `<review>FIXES_PENDING:N</review>` — N findings need to become stories

### Step 5.2 — Compute the new round number

```
NEW_ROUND = (prd.review?.roundsCompleted ?? 0) + 1
```

### Step 5.3 — On `CLEAN`

Update `prd.json`:
```json
{
  "review": {
    "roundsCompleted": NEW_ROUND,
    "maxRounds": <existing-or-3>,
    "lastReviewSha": "<git rev-parse HEAD>",
    "lastVerdict": "CLEAN"
  }
}
```

Print to operator:
```
✅ Review round N: CLEAN. Ready for /cam-ship.
```

### Step 5.4 — On `FIXES_PENDING:N`

For each "Fix in this branch" finding, create a story in `prd.json.userStories`:
- **id**: `US-R{NEW_ROUND}-{NNN}` (e.g. `US-R1-001`)
- **title**: short imperative from the finding
- **acceptanceCriteria**: the full triage line including `[file:line]`
- **passes**: `false`
- **priority**: insert at the **top** of the queue

Update `prd.json.review`:
```json
{
  "roundsCompleted": NEW_ROUND,
  "maxRounds": <existing-or-3>,
  "lastReviewSha": "<git rev-parse HEAD>",
  "lastVerdict": "FIXES_PENDING"
}
```

Print to operator:
```
⚠ Review round N: FIXES_PENDING:K
Created K fix-stories at top of PRD: US-R{N}-001..US-R{N}-{NNN}.

Run /cam-next to dispatch the implementer to fix them.
Cap: round {N}/{maxRounds}.
```

### Step 5.5 — Max-rounds safety valve

If `NEW_ROUND > maxRounds`, update `prd.json.review.lastVerdict = "MAX_ROUNDS_DEBT"` and print:
```
🚧 Review round N exceeded maxRounds ({maxRounds}). Shipping with debt.
Persistent CRITICAL/WARNING findings: <list>
```

The orchestrator treats `MAX_ROUNDS_DEBT` like `CLEAN` for loop-termination — emit `<promise>COMPLETE</promise>` and let `/cam-ship` proceed.

### Step 5.6 — Don't commit yet

This step ONLY mutates `prd.json`. **Do not commit.** Exception: when `lastVerdict === "CLEAN"`, you MAY commit with message `chore(cam): mark review round N CLEAN`.
