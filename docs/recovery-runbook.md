# cam recovery runbook

When the autonomous loop gets stuck, this is the operator playbook for
unblocking it without reading source. Every scenario below is keyed to the
runtime files the supervisor writes under the project's `.claude/` directory,
and every tmux command targets the dedicated `-L cam` socket.

## Canonical runtime files

All paths are relative to the project root.

| File | Written by | What it tells you |
|---|---|---|
| `.claude/cam-loop.local.md` | `cam next` | Loop state. YAML frontmatter: `active`, `iteration`, `started_at`, `pid` (the supervisor process), `max_iterations`. |
| `.claude/.cam-worker-pane` | `cam plan` | The reused worker pane id (e.g. `%5`). The supervisor drives this single pane with `respawn-pane -k`. |
| `.claude/.cam-worker-<US>.session` | `cam next` | Per-story worker session uuid (one file per completed story), used to resolve that story's transcript. |
| `.claude/cam-worker-events.jsonl` | `cam next` | One JSON line per worker lifecycle step (`worker-start`, `worker-end`, `result`, `tokens`, `pushed`, `stale-lock`). Your primary diagnostic log. |
| `.claude/.cam-supervisor.lock` | `cam next` | Single-supervisor concurrency lock: `{ pid, startedAt, project }`. |
| `.claude/.cam-sidecar.pid` | `cam run` | Sidecar process pid: `cam stop` reads this to SIGTERM the sidecar on shutdown. |
| `scripts/cam/review-report.json` | reviewer agent | Ephemeral, gitignored. Written by the reviewer at exit; sidecar reads it for verdict+findings (file is left in place after reading and cleared before the next review round begins). See section (m). |
| `scripts/cam/worker-report.json` | implementer agent | Ephemeral, gitignored. Written by the implementer at exit before printing the sentinel. The sidecar reads it as the PRIMARY (authoritative) outcome source for the implementer channel: `report.story` names the completed story; `report.outcome` carries DONE/BLOCKED/PRD_COMPLETE. Absent, malformed, or stale reports (story field does not match the advisory story id) fall to the pane-died/timeout failure nets with no false-pass. See section (o). |

Quick triage first:

```bash
cam status
```

It reports whether a loop is active, the current iteration, and the supervisor
pid. If `cam status` looks wrong or stale, pick the matching scenario below.

## (a) Stuck supervisor

Symptom: `cam status` shows the loop active, but nothing is progressing (no new
commits, the worker pane is idle).

1. Find the supervisor pid:

   ```bash
   grep '^pid:' .claude/cam-loop.local.md
   ```

2. Confirm it is actually alive (no output means dead):

   ```bash
   ps -p <pid>
   ```

3. The clean fix is `cam stop`, which SIGTERMs the supervisor pid, SIGTERMs the
   sidecar (via `.claude/.cam-sidecar.pid`), and removes the full marker set
   (`.claude/.cam-supervisor.lock`, `.claude/.cam-orch-session`,
   `.claude/.cam-worker-pane`, `.claude/.cam-orch-ready`,
   `scripts/cam/worker-report.json`, and `.claude/cam-loop.local.md`):

   ```bash
   cam stop
   ```

   Note: the sidecar also self-terminates when the project tmux session disappears
   after an abnormal `cam run` exit, so it does not orphan the process on crash.
   An abnormal exit therefore no longer requires a manual sidecar kill.

4. Restart from where the iteration counter left off:

   ```bash
   cam resume
   ```

If you prefer to kill by hand instead of `cam stop`:

```bash
kill <pid>        # SIGTERM; the loop releases its lock on the way out
```

The supervisor releases `.claude/.cam-supervisor.lock` on a clean SIGTERM. If
it was hard-killed, see scenario (d).

Note: if the symptom is the opposite (the worker keeps dying and the supervisor
keeps re-spawning it), the loop does NOT spin forever. A worker that dies
pre-result or never emits a sentinel is bounded: the supervisor backs off with
an escalating delay and, after `MAX_DEAD_WORKER_RETRIES` consecutive dead-pane
or timeout outcomes, blocks cleanly (it does not burn the whole iteration cap).
Each backoff is recorded as a `pane-died-retry` event (see scenario (f)). A
persistent dead worker usually means the environment is wrong, not the loop:
check scenario (e) for the folder-trust block.

## (b) Orphaned worker pane

Symptom: the tmux session or worker pane is in a bad state (a dead command, a
wedged claude session) but the supervisor pid is gone.

1. List what is actually alive on the cam socket:

   ```bash
   tmux -L cam list-sessions
   tmux -L cam list-panes -a
   ```

2. The simplest recovery is a full stop + resume, which tears down the session
   and lets `cam plan` / `cam next` re-establish a clean worker pane:

   ```bash
   cam stop
   cam resume
   ```

3. If you want to reset just the pane in place (without killing the session),
   read the pane id and respawn it:

   ```bash
   cat .claude/.cam-worker-pane           # e.g. %5
   tmux -L cam respawn-pane -k -t <pane>  # kills the running command, reuses the pane id
   ```

   `respawn-pane -k` is exactly the primitive the supervisor uses per story, so
   the pane id stays stable and the next `cam next` reuses it.

## (c) Partial story (handoff written but prd.json not flipped)

Symptom: a worker implemented a story (you can see its changes, and
`scripts/cam/handoff.json` names it as `lastCompletedStory`) but
`scripts/cam/prd.json` still shows that story as `passes: false`. The supervisor
normally finalizes this automatically (re-runs gates, flips the flag, commits),
but if it crashed mid-finalize you can do it by hand.

1. Confirm which story the worker finished:

   ```bash
   grep -A2 lastCompletedStory scripts/cam/handoff.json
   ```

2. Re-run the quality gates yourself to be sure the work is sound:

   ```bash
   bun run typecheck
   bun test
   ```

3. Only if both are green, flip the story in `scripts/cam/prd.json` (set
   `"passes": true` on the matching `userStories[]` entry), then commit:

   ```bash
   git add -A
   git commit -m "chore(cam): finalize US-XXX (manual recovery)"
   ```

4. Resume the loop:

   ```bash
   cam resume
   ```

If the gates do NOT pass, do not flip the flag. Leave the story `passes: false`
so the next `cam next` re-dispatches it.

## (d) Stale .cam-supervisor.lock

Symptom: `cam next` refuses to start with `supervisor already running (pid=N)`,
but you know that pid is dead (the previous supervisor crashed or was
hard-killed before it could release the lock).

The guard self-heals: on the next start, `cam next` probes the recorded pid with
a signal-0 check, finds it dead, logs a `stale-lock` event to
`.claude/cam-worker-events.jsonl`, and takes the lock over automatically. So in
most cases you can just re-run:

```bash
cam next
```

If you want to verify or force it:

1. Inspect the lock and check the pid:

   ```bash
   cat .claude/.cam-supervisor.lock      # { "pid": N, "startedAt": "...", "project": "..." }
   ps -p <pid>                           # no output => dead => safe to remove
   ```

2. If the pid is dead, removing the lock by hand is safe:

   ```bash
   rm -f .claude/.cam-supervisor.lock
   ```

Never remove the lock while the recorded pid is still alive: that is the exact
double-driver situation the guard exists to prevent.

## (e) Worker pane stuck on the folder-trust prompt

Symptom: a freshly spawned worker never reaches a sentinel. The supervisor poll
keeps timing out (or you see a `pane-died` retry loop), and when you look at the
pane it is sitting on claude's folder-trust prompt:

```
Quick safety check: Is this a project you created or one you trust?
> 1. Yes, I trust this folder
  2. No, exit
```

Cause: the `claude` binary has never seen this project directory, so on first
launch it asks the human to confirm trust before doing anything. The supervisor
detects completion by polling capture-pane for a sentinel; it cannot answer an
interactive prompt, so the worker waits there until the per-worker deadline.

When it happens: a fresh clone, a CI checkout, or any brand-new project path.
The normal `cam setup` flow has the human accept trust once when the interactive
session first opens, so day-to-day runs never hit this.

Recovery: confirm the prompt is what is blocking, then accept it once.

```bash
cat .claude/.cam-worker-pane                       # e.g. %5
tmux -L cam capture-pane -p -t <pane>              # look for "Quick safety check"
tmux -L cam send-keys -t <pane> 1 Enter            # explicitly pick "1. Yes, I trust this folder"
```

After the folder is trusted once, subsequent workers in the same directory boot
without the prompt. For an unattended environment (CI, a scripted fresh clone),
pre-trust the folder before the first `cam next` so no worker ever blocks here.

## (f) Diagnosing with the event log

`.claude/cam-worker-events.jsonl` is the per-story flight recorder. Each line is
one JSON object with `ts`, `storyId`, `uuid`, `kind`, and `detail`.

Tail the most recent activity:

```bash
tail -n 20 .claude/cam-worker-events.jsonl
```

Useful reads:

```bash
# Every result outcome (pass / incomplete / fail / blocked / unknown), per story:
grep '"kind":"result"' .claude/cam-worker-events.jsonl

# Push verifications on each pass: which commits actually reached origin:
grep '"kind":"pushed"' .claude/cam-worker-events.jsonl

# Supervisor takeovers of a dead lock (US-015):
grep '"kind":"stale-lock"' .claude/cam-worker-events.jsonl

# Bounded dead-worker backoff: each retry before the supervisor blocks on a
# persistently dying worker (CAM-44). detail carries attempt, backoffMs, pollOutcome:
grep '"kind":"pane-died-retry"' .claude/cam-worker-events.jsonl

# Per-worker token ceiling breach (CAM-5, opt-in via CAM_WORKER_MAX_TOKENS). The
# worker was killed because its spend crossed the cap. detail carries spend, ceiling:
grep '"kind":"worker-token-ceiling"' .claude/cam-worker-events.jsonl
```

Per-worker guardrails: a worker is bounded by a wall-clock deadline
(`CAM_WORKER_TIMEOUT_MS`, default 30 min) and, when opted in, a cumulative token
ceiling (`CAM_WORKER_MAX_TOKENS`, default 0 = disabled). The turns cap is the
supervisor `maxIterations` (`--max-iter`, default 50). The `claude --max-turns` and
`--max-budget-usd` flags are not used: both are print-mode-only (they need `-p`, which
is forbidden for subscription accounts, CAM-42), and a USD budget is not meaningful on a
subscription.

To correlate a story with its transcript, read its session marker and resolve
the uuid:

```bash
cat .claude/.cam-worker-US-XXX.session
```

Cross-references: `.claude/cam-loop.local.md`, `.claude/.cam-worker-pane`, `.claude/.cam-worker-<US>.session`, `.claude/cam-worker-events.jsonl`, `.claude/.cam-supervisor.lock`, `.claude/.cam-sidecar.pid`.

## (g) CAM-69: "Missing default export" from js-yaml in vendored smoke

Symptom: `cam init` or `cam plan` runs the vendored `check-agent-frontmatter`
smoke script and it fails with an error similar to:

```
error: Expected a default export in 'js-yaml'
Missing 'default' export in module 'js-yaml'
```

Cause: the smoke script formerly used `import yaml from 'js-yaml'` (a default
import). js-yaml v5 is ESM-only and ships no default export, only named
exports (`load`, `dump`, etc.). If `bun` resolves js-yaml@5 from the
module cache (for example after `bun update` or a global cache refresh), the
default import crashes at runtime, even though `package.json` pins
`js-yaml@^4`.

Fix shipped in CAM-69: the smoke script was rewritten with a hand-rolled YAML
parser that has zero external dependencies, so the js-yaml major is no longer
relevant for the smoke. Additionally, all in-repo `js-yaml` consumers in
`src/` were migrated to named imports (`import { load } from 'js-yaml'`),
which are forward-compatible across v4 and v5.

Recovery: if you see this error, your installed `cam` binary predates the fix.
Rebuild and reinstall:

```bash
bash scripts/build-release.sh --install
```

This builds the binary, re-signs it ad-hoc (required on macOS arm64), runs a
quick smoke, and installs to `~/.local/bin/cam`.

Confirm the fix is active:

```bash
which cam        # should point to ~/.local/bin/cam
cam --version    # shows the rebuilt version
```

If the error persists after reinstall, confirm the binary on PATH is the one
you just built (`which cam`) and that no stale copy exists in an earlier PATH
entry such as `/usr/local/bin`.

## (h) Wedged ship cycle: use cam ship --finalize

Symptom: the supervisor reached a terminal state (all non-operator stories pass
and review is CLEAN), but the cycle-close step did not complete. The per-branch
harness state files (`scripts/cam/prd.json`, `scripts/cam/handoff.json`) are
still present and tracked in the repo, or the issue file in `scripts/cam/issues/`
still shows `stage: "planned"` instead of `stage: "shipped"`.

When it happens: the sidecar exited before running the cycle-close commit,
or the process crashed mid-finalize.

Recovery: run the deterministic cycle-close primitive:

```bash
cam ship --finalize
```

What it does (in order):

1. Reads `scripts/cam/project.toml` for `issue_system` and `issue_prefix`.
2. Reads `scripts/cam/prd.json` for the issue number (before removing it).
3. When `issue_system == 'none'`: reads `scripts/cam/issues/<PREFIX>-NNNN.json`
   and sets `stage: "shipped"` on the entry. For `github` or `linear`: skips
   this step (the backend closes the issue via PR merge or explicit API call).
4. Removes `scripts/cam/prd.json`, `scripts/cam/handoff.json`, and
   `scripts/cam/progress.txt` via `git rm -f --ignore-unmatch` (idempotent:
   missing or untracked files are silently skipped).
5. Stages `scripts/cam/issues/<PREFIX>-NNNN.json` when applicable.
6. Commits: `chore(cam): close <issue-id> + drop per-branch harness state
   (CAM-27 hygiene)`.

The command is idempotent: a second invocation after prd.json is already gone
exits cleanly with "cycle already closed: prd.json absent, finalize skipped"
and makes no commit.

Manual fallback (use only when the `cam` binary itself is broken or unavailable):

```bash
# Step 4: remove harness state files
git rm -f --ignore-unmatch \
  scripts/cam/prd.json \
  scripts/cam/handoff.json \
  scripts/cam/progress.txt

# Step 3 (if issue_system == 'none'): edit the per-file issue by hand.
#   Set "stage": "shipped" on the matching scripts/cam/issues/<PREFIX>-NNNN.json entry.
git add scripts/cam/issues/<PREFIX>-NNNN.json

# Step 6: commit
git commit -m "chore(cam): close <issue-id> + drop per-branch harness state (CAM-27 hygiene)"
```

After the cycle-close commit, push and open the PR if not already open:

```bash
git push origin $(git branch --show-current)
cam ship   # thin-proxy: sends /cam-ship to the orchestrator pane
```

## (i) CAM-59: red CI or ci-parity failure

Symptom: the GitHub Actions CI job fails, or `bun run check:ci-parity` exits
non-zero locally with an error like:

```
ci-parity FAIL: CI does not cover gate 'my-gate' (not in 'bun run check:all' spine)
```

or:

```
ci-parity FAIL: CI step 'bun run my-gate' is not in the GATES manifest
```

### How the gate-spine works

All quality gates are declared as entries in the `GATES` manifest at the top of
`scripts/check-all.ts`. The CI workflow (`ci.yml`) calls a single step:

```yaml
- run: bun run check:all
```

The `check:ci-parity` gate (`scripts/check-ci-parity.ts`) then verifies that
`ci.yml` and the GATES manifest are in sync. Parity fails when they drift:
either a gate exists in the manifest but is not covered by the CI spine, or a
`bun run <script>` step appears in CI that is not in the manifest (and is not
on the explicit allowlist in `check-ci-parity.ts`).

### Fixing a parity failure

**Common cause: a new gate was added ad-hoc to `ci.yml` instead of to the
manifest.** Fix:

1. Remove the ad-hoc step from `ci.yml`.
2. Add the gate as a `GATES` entry in `scripts/check-all.ts` using the `g()`
   helper (a space-separated command string: `g('my-gate', 'bun run my:script')`).
3. Verify locally:

   ```bash
   bun run check:all
   bun run check:ci-parity
   ```

**Common cause: a gate was added to the manifest but the CI workflow still runs
it as a separate step too.** Fix: remove the redundant CI step (the spine
covers all GATES entries automatically).

**Common cause: a script was added to the allowlist in `check-ci-parity.ts`
that should instead be a proper gate.** Promote it to a GATES entry instead.

### Debugging a red CI run

1. Open the failing GitHub Actions run and expand the failing step.
2. If the failure is in `check:all`, the output names the failing gate:

   ```
   fail typecheck (3.2s)
   ```

   Fix the underlying issue (typecheck errors, failing tests, vendor drift,
   parity errors) and push again.
3. If the failure is in the summary step (`gate-results.json`), confirm the
   JSON file was written: `bun run check:all -- --json` must produce
   `gate-results.json` in the repo root.
4. To reproduce CI locally:

   ```bash
   bun run check:all -- --json
   bun run check:ci-parity
   ```

Cross-reference: `scripts/check-all.ts` (GATES manifest), `scripts/check-ci-parity.ts` (parity checker), `.github/workflows/ci.yml` (spine step), `scripts/cam/patterns.md` (gate-spine convention bullet).

## (j) CAM-60: ratchet gate blocking a story

Symptom: a story's implementation causes one of the CAM-60 static-layer gates
to fail (file-size, coverage, debt-markers, dead-code, or dup), and the worker
cannot implement the story without triggering the ratchet.

Ratchets enforce a "change-direction-locked" invariant: metrics may improve
freely, but degradation (raising a size ceiling, lowering a coverage floor,
raising a dup threshold) requires an explicit tracker reference in the staged
diff. This prevents silent regression without blocking intentional trade-offs.

### (j.1) Raising a file-size ceiling

The `check-file-sizes.ts` gate checks that no file in `scripts/file-size-budget.json`
exceeds its ceiling, AND that any ceiling that was RAISED in the staged diff
carries at least one tracker reference (`CAM-NNN`, `#N`, or `https://`).

To unblock:

1. Edit `scripts/file-size-budget.json` and raise the ceiling for the affected
   file.
2. Ensure the same `git diff --cached` output for that file contains a tracker
   ref. The simplest form: add a `"_ref"` comment key in the JSON file whose
   value mentions the tracker ID (e.g. `"_ref": "CAM-XXX ..."`).
3. Stage the budget file and re-run the gate:

   ```bash
   git add scripts/file-size-budget.json
   bun scripts/check-file-sizes.ts
   ```

The gate reads only the staged diff, so the tracker ref must be staged, not
just present in the working tree.

### (j.2) Raising the duplication threshold (dup gate)

The `dup` gate runs `bunx jscpd@5 --config .jscpd.json src scripts`. The
threshold lives in `.jscpd.json` as a numeric `threshold` key (currently 4,
meaning 4% maximum duplication).

To raise the threshold:

1. Edit `.jscpd.json` and increase the `threshold` value.
2. Add a comment or annotation nearby (in a `_ref` sibling key or a commit
   message) referencing the tracker: `CAM-NNN`, `#N`, or a URL.
3. Re-run the gate to confirm the new threshold is not immediately exceeded:

   ```bash
   bunx jscpd@5 --config .jscpd.json src scripts
   ```

Note: jscpd has no built-in tracker-ref enforcement; the reference requirement
is a process convention (code-reviewed by the CI reviewer gate). Do not raise
the threshold without a tracker ref in the commit message.

### (j.3) Lowering a coverage floor

The `check-coverage.ts` gate compares actual coverage (from `bun test
--coverage`) against floors in `scripts/coverage-budget.json`. Raising a floor
is always allowed. Lowering a floor requires a tracker reference in the staged
diff of the budget file.

The floor comparison carries a 0.5pp tolerance to absorb cross-environment
jitter (the macos CI runner measures slightly different coverage than local),
so a metric is only flagged when it falls more than 0.5pp below its floor.

To unblock a story that genuinely reduces coverage:

1. Edit `scripts/coverage-budget.json` and lower the affected floor (functions
   or lines).
2. Add a tracker ref inside the same budget file, visible in the staged diff
   (e.g. in the `"_ref"` key at the top of the JSON object).
3. Stage and re-run:

   ```bash
   git add scripts/coverage-budget.json
   bun scripts/check-coverage.ts
   ```

The gate reads only `git diff --cached scripts/coverage-budget.json`, so the
tracker ref must appear in that staged diff.

### General ratchet principle

All three ratchets follow the same pattern: snapshot-on-adopt, then
change-direction-locked. Improvement is free; degradation requires a tracker
ref in the staged diff (or commit message for jscpd). If a story legitimately
requires degradation, file a tracker issue first, then reference it in the diff.
The sidecar will not block you from merging; it will block you from merging
silently.

Cross-reference: `scripts/check-file-sizes.ts`, `scripts/check-coverage.ts`,
`scripts/file-size-budget.json`, `scripts/coverage-budget.json`, `.jscpd.json`,
`scripts/cam/patterns.md` (ratchet pattern bullet).

### (j.4) Ratchet failure during /cam-ship (the ship gate)

`/cam-ship` Step 3 runs `bun run check:all` as the ship gate -- the same spine
CI runs. If this ship gate fails on a ratchet (file-size ceiling or coverage
floor) because the story represents legitimate growth, use the raise-and-retry
procedure from (j.1) or (j.3): edit the budget file, add the tracker ref in the
`"_ref"` field, stage the file, and re-run `bun run check:all` before opening
the PR. Do not skip to the PR step.

Cross-reference: `.claude/commands/cam-ship.md` Step 3 (raise-and-retry block).

## (k) CAM-70: reviewer verdict not appearing in the orchestrator pane

Symptom: the reviewer worker finishes a review round and the orchestrator pane
does not display the verdict line (`[cam] review round N: CLEAN`,
`FIXES_PENDING:K`, or `MAX_ROUNDS_DEBT`). The loop may hang waiting for operator
input that was supposed to be automatic.

### Background

CAM-70 wired an automatic verdict handback: at the end of every review round the
sidecar calls `notifyOrchestrator(line)`, which runs `send-keys` into the
orchestrator pane (pane 0 on the cam tmux socket). The line format is:

```
[cam] review round N: CLEAN
[cam] review round N: FIXES_PENDING:K
[cam] review round N: MAX_ROUNDS_DEBT
[cam] review BLOCKED: <detail>
```

`N` is the round number (starting at 1) and `K` is the count of stories that
still have findings. The BLOCKED variant fires when the review dispatch itself
fails (e.g. the reviewer pane never emitted a verdict), not when the verdict is
FIXES_PENDING.

The formatter lives in `src/supervisor/worker-report.ts`
(`formatReviewVerdictLine`). The wiring lives in `src/supervisor/loop.ts` (calls
`opts.notifyOrchestrator?.()` after each non-error review dispatch) and in
`src/supervisor/host.ts` (`makeNotifyOrchestrator` factory, wired in
`buildSupervisorOptions`).

### Diagnosing a missing verdict line

1. Confirm the reviewer worker finished (look for `kind:"result"` in the event
   log):

   ```bash
   grep '"kind":"result"' .claude/cam-worker-events.jsonl | tail -5
   ```

2. Confirm `prd.review.lastVerdict` was written (the reviewer writes this
   regardless of the notify path):

   ```bash
   jq '.review.lastVerdict' scripts/cam/prd.json
   ```

3. Check whether the orchestrator pane is still alive:

   ```bash
   tmux -L cam list-panes -a -F '#{pane_id} #{@cam_label}'
   ```

   Look for a pane labeled `orchestrator`. If it is absent, the `send-keys` call
   silently failed (the pane closed or the session ended).

4. Inspect the sidecar log for notify errors:

   ```bash
   tail -n 50 .claude/cam-supervisor.log
   ```

### Manual fallback

If the automatic handback failed (e.g. the orchestrator pane closed, a tmux
socket mismatch, or a regression in `makeNotifyOrchestrator`), read the verdict
directly and report it yourself:

```bash
jq -r '.review | "round \(.round // "?"): \(.lastVerdict // "(none)")"' scripts/cam/prd.json
```

Then type the result into the orchestrator pane, or proceed based on the verdict
without it:

- `CLEAN`: all stories pass review. Run `cam ship` to close the cycle.
- `FIXES_PENDING:K`: K stories have findings. Re-run `cam next` to dispatch another
  implement round.
- `MAX_ROUNDS_DEBT`: the review cap was reached. Decide whether to ship with
  debt or pause and file follow-ups manually.

If the loop is stuck waiting for a verdict line it will never see, `cam stop`
and `cam resume` to restart the sidecar (it will re-check `prd.review` state at
boot and pick up from the correct place).

### Confirming the fix is active

After rebuilding:

```bash
bash scripts/build-release.sh --install
```

Watch the orchestrator pane during the next review round: the verdict line should
appear automatically within a few seconds of the reviewer worker exiting.

Cross-reference: `src/supervisor/worker-report.ts` (`formatReviewVerdictLine`),
`src/supervisor/loop.ts` (notify call site), `src/supervisor/host.ts`
(`makeNotifyOrchestrator`), `scripts/cam/patterns.md` (notifyOrchestrator seam
bullet, makeNotifyOrchestrator factory pattern bullet).

## (l) CAM-53: inspecting and resetting per-phase model config

CAM-53 introduced per-phase model selection (`[models]`) and backend selection
(`[backend]`) stored in `scripts/cam/project.toml`. Workers read these at spawn
time via `readPhaseModel` and `readBackend` in `src/config/models.ts`, falling
back to `DEFAULTS` on any read/parse error.

### How to inspect the current resolved config

Run the non-interactive show command (no TTY or Ink required):

```bash
cam config --show
```

Output example:

```
phase          model
-----------------------------
orchestrator   claude-opus-4-8
planner        claude-opus-4-8
auditor        claude-opus-4-8
implementer    claude-sonnet-4-6
reviewer       claude-opus-4-8
ship           claude-sonnet-4-6
backend        claude
```

The values shown are the RESOLVED values (defaults applied when a key is absent
or the file is missing).

### How to reset to defaults

Remove the `[models]` and `[backend]` sections from `scripts/cam/project.toml`.
The simplest approach: delete those sections and their keys by hand, then run
`cam config --show` to confirm the defaults are active.

Or use the interactive wizard to re-select explicitly:

```bash
cam config
```

### How to recover from a typo'd model name

A typo'd model name (e.g. `orchestrator = "claude-oops-4-8"`) is not caught at
config-write time: `mergeConfigChoices` stores whatever string the wizard
produces. The error surfaces only when the spawned `claude --model <value>`
call rejects the unknown model.

Recovery steps:

1. Identify the typo:

   ```bash
   cam config --show
   ```

2. Fix by re-running the wizard (which presents a validated list):

   ```bash
   cam config
   ```

   Or edit `scripts/cam/project.toml` directly: find the `[models]` section and
   correct the offending key to a valid model ID.

3. Confirm the fix:

   ```bash
   cam config --show
   ```

4. Re-dispatch the story that was blocked by the bad model:

   ```bash
   cam next
   ```

Cross-reference: `src/commands/config.ts` (`printConfigShow`),
`src/config/models.ts` (`readPhaseModel`, `readBackend`, `DEFAULTS`),
`scripts/cam/patterns.md` ([models]/[backend] config surface bullet).

## (m) CAM-75: reviewer handback via review-report.json

CAM-75 changed how the reviewer worker hands structured output to the sidecar.
Instead of the sidecar parsing verdict and findings from the pane's scrollback
text (which is rendered markdown: `##` headers and `- [file:line]` bullets are
consumed by the Ink TUI renderer), the reviewer writes a structured JSON file
and the sidecar reads it directly.

### How the flow works

1. The reviewer agent runs in the worker pane, evaluates each story against its
   acceptance criteria, and writes `scripts/cam/review-report.json` before
   exiting.

2. The sidecar poll loop checks for the file's presence on each tick (before
   checking for pane death). When the file is present, the sidecar reads it for
   `verdict` and `findings` and records them in `prd.review`. The file is left in
   place after reading; before the next review round begins the sidecar clears it
   (so a stale round-N report is not picked up on the first poll tick of round
   N+1).

3. The `<review>` tag in the pane output remains the human-readable fallback
   sentinel. If `review-report.json` is absent when the reviewer pane closes,
   the sidecar falls back to parsing the `<review>` tag from capture-pane text.

### File shape

`scripts/cam/review-report.json` (ephemeral, gitignored):

```json
{
  "verdict": "FIXES_PENDING:2",
  "findings": [
    { "severity": "CRITICAL", "file": "src/foo.ts", "line": 42, "text": "Acceptance criterion not met: ..." },
    { "severity": "WARNING",  "text": "Non-blocking observation..." }
  ]
}
```

Field notes:

- `verdict`: `"CLEAN"` or `"FIXES_PENDING:N"` (where N is the count of CRITICAL + actionable WARNING findings). `MAX_ROUNDS_DEBT` is a supervisor-derived terminal state and is never written by the reviewer to this file.
- `findings[].severity`: `"CRITICAL"` (blocks shipping), `"WARNING"` (should fix, not blocking), or `"SUGGESTION"` (nice to have).
- `findings[].file` and `findings[].line`: optional; present when the finding maps to a specific file location.
- `findings[].text`: the human-readable description.

### Durable state after the round

After reading `review-report.json`, the sidecar writes findings into `prd.json`
as `prd.review.findings`. This is the durable record:

```bash
jq '.review.findings' scripts/cam/prd.json
```

Each element matches the `{severity, file?, line?, text}` shape above.

### Graceful fallback path

If `review-report.json` is absent (the reviewer exited without writing it, or
the file was deleted before the sidecar polled), the sidecar falls back to
parsing the `<review>` tag from the worker pane's captured text. In this case:

- `prd.review.lastVerdict` is set from the tag (e.g. `CLEAN`).
- `prd.review.findings` is NOT set (the tag carries no structured findings).

A warning is logged to `.claude/cam-supervisor.log` when the fallback triggers.

### Diagnosing issues

**Reviewer finished but verdict not updated:**

```bash
# Check whether review-report.json was written (still present means the sidecar
# has not polled yet, or there is a parse error):
cat scripts/cam/review-report.json

# Check durable state in prd.json:
jq '.review' scripts/cam/prd.json
```

**review-report.json present but malformed:**

The sidecar treats a parse error as if the file were absent and falls back to
the `<review>` tag. Look for the warning in the sidecar log:

```bash
tail -n 50 .claude/cam-supervisor.log | grep -i 'review-report'
```

**Findings missing from prd.review.findings after a FIXES_PENDING round:**

Findings are only persisted when the file-based path is used. If the tag-based
fallback ran instead (file absent or malformed), `prd.review.findings` will be
absent. Fix stories created by the sidecar will have no `notes` in that case.

To check which path ran, look at the sidecar log for `review-report` entries
and compare with `prd.review.findings`:

```bash
grep 'review-report' .claude/cam-supervisor.log | tail -5
jq '.review' scripts/cam/prd.json
```

### Manual override

If the loop is stuck waiting for the reviewer and the pane is dead with no
verdict:

1. Read the event log to confirm the worker finished:

   ```bash
   grep '"kind":"result"' .claude/cam-worker-events.jsonl | tail -3
   ```

2. Check whether a partial `review-report.json` was written:

   ```bash
   cat scripts/cam/review-report.json 2>/dev/null || echo "(absent)"
   ```

3. Inspect `prd.review`:

   ```bash
   jq '.review' scripts/cam/prd.json
   ```

4. If none of the above gives a verdict, set it manually and resume:

   ```bash
   # Mark CLEAN to proceed to ship:
   jq '.review.lastVerdict = "CLEAN"' scripts/cam/prd.json > /tmp/prd.tmp && mv /tmp/prd.tmp scripts/cam/prd.json
   cam next
   ```

   Or set `FIXES_PENDING` and allow the sidecar to dispatch another implement
   round.

Cross-reference: `src/supervisor/review-report.ts` (REVIEW_REPORT_FILENAME,
ReviewReport schema), `src/supervisor/review.ts` (makeReviewDispatch, poll loop,
fallback path), `src/supervisor/host.ts` (makeReadReviewReport factory),
`scripts/cam/patterns.md` (structured reviewer exit report pattern,
capture-pane-is-rendered-markdown bullet).

## (n) CAM-86: file-on-main backlog filing

Symptom: a `/cam-issue create` call (or a `cam issue --file-local` run) completed without error but the resulting commit landed on a feature branch instead of `main`. The new issue file (`scripts/cam/issues/<PREFIX>-NNNN.json`) is thus visible only on that branch; `cam issue get`/`list` and other commands that read from `main` cannot see it.

This can happen when a worker agent is dispatched from a feature branch and the up-to-date guard in `issue-file.ts` fails silently (e.g. no remote configured), or when a parallel worker commits to the wrong HEAD.

Real case (2026-06-25): a parallel Sonnet filed CAM-81 through CAM-85 and the commit landed on `cam/CAM-79` instead of `main`. Recovery: cherry-pick to `main` + rebase to drop from the feature branch.

### How the commit-tree-to-main primitive works

`cam issue --file-local` files a backlog entry directly on `main` without checking out `main`:

1. **Read-from-main allocation**: existing issue files are enumerated via `git ls-tree -r --name-only main scripts/cam/issues/` and bulk-read via `git cat-file --batch`, so the next-id allocation (`max(parsed ids) + 1`) is always based on the committed state of `main`.
2. **Off-main commit-tree path**: a temporary git index file is created (`mkdtempSync` + `GIT_INDEX_FILE`), the new JSON content is hashed via `git hash-object -w --stdin` and staged in the temp index (`git update-index --add --cacheinfo`), and a tree object is built from the temp index (`git write-tree`).
3. **On-main direct commit**: `git commit-tree <tree> -p $(git rev-parse main) -m "<message>"` creates the commit object with `main` as parent, then `git update-ref refs/heads/main <new-sha>` advances `main` atomically. The current HEAD branch is never touched.

After this flow, `main` has the new entry and the feature branch is unaffected.

### Recovery: wrong-branch commit

Symptom: `git log main -- scripts/cam/issues/<PREFIX>-NNNN.json` does NOT show the new entry, but `git log <feature-branch>` does.

1. Find the commit SHA on the feature branch:

   ```bash
   git log --oneline <feature-branch> | head -10
   # identify the "chore(cam): file issue CAM-NNN" commit
   ```

2. Cherry-pick it onto `main`:

   ```bash
   git checkout main
   git cherry-pick <sha>
   git push origin main
   ```

3. Drop the stray commit from the feature branch (rebase to remove it):

   ```bash
   git checkout <feature-branch>
   git rebase main
   git push --force-with-lease origin <feature-branch>
   ```

   The force push is safe here because the stray commit is a harness-state commit that was never part of the story implementation.

4. Verify `main` has the entry and the feature branch no longer carries a delta:

   ```bash
   git show main:scripts/cam/issues/<PREFIX>-NNNN.json | jq '{id, stage, title}'
   git diff main..<feature-branch> -- scripts/cam/issues/   # should be empty
   ```

### Recovery: divergent local main

If your local `main` has diverged from `origin/main` (e.g. the file-on-main commit landed locally but another writer also committed to `origin/main` before your push):

1. Try a fast-forward push first:

   ```bash
   git push origin main
   ```

2. If the push is rejected (non-fast-forward), inspect the divergence:

   ```bash
   git fetch origin
   git log --oneline main..origin/main    # commits on remote not in local
   git log --oneline origin/main..main    # commits in local not on remote
   ```

3. Rebase local `main` onto `origin/main`:

   ```bash
   git rebase origin/main main
   git push origin main
   ```

   If two writers added different issue files to `scripts/cam/issues/` concurrently, the rebase will surface a conflict on those files. Accept both sides: each writer added a distinct `CAM-NNNN.json` file, so both files should be staged after resolving (both survive). The CAS retry in `writeIssueFile` prevents id collisions between concurrent writers at write time; a post-hoc rebase conflict means both files are valid and should both be kept.

4. Confirm the feature branch is still consistent with `main`:

   ```bash
   git log --oneline main..origin/main   # should be empty after push
   ```

Cross-reference: `src/commands/issue-file.ts` (commit-tree-to-main implementation),
`scripts/cam/patterns.md` (up-to-date guard + best-effort push pattern,
widened SpawnFn for git plumbing, commit-tree-to-main backlog mutation bullets).

## (o) CAM-77: single-source outcome model for the implementer channel

CAM-77 establishes `scripts/cam/worker-report.json` as the sole authoritative outcome
source for the implementer. This section documents the single-source contract,
explains the 5-concern model, and provides a diagnostic guide for absent, wrong,
or stale reports.

### The single-source contract

Three artifacts carry implementer outcome information. Only one is the authoritative
outcome source:

- `scripts/cam/worker-report.json` (PRIMARY, authoritative): the implementer writes
  this file before exiting. The sidecar reads `report.story` to identify which story
  completed and `report.outcome` to determine DONE/BLOCKED/PRD_COMPLETE. An absent,
  malformed (missing required string fields), or stale report (where `report.story`
  does not match the advisory story id) is not treated as a success signal: the poll
  loop continues and the pane-died/timeout failure nets (with CAM-44 backoff) remain
  the terminal signal. No false-pass is possible from a stale or missing report.
- `CAM_IMPLEMENTER_STATUS=...` sentinel in pane scrollback: human-readable
  corroboration for the operator only. The sidecar does not parse scrollback as a
  primary gate; the sentinel is purely observational.
- `scripts/cam/handoff.json`: forward-context for the NEXT implementer agent.
  It is NOT a sidecar control signal. An absent or stale handoff does not change
  the named story when a valid report is present.

### The 5-concern model

Each concern maps to exactly one file (operator decision 2026-06-25):

| Concern | File | Role |
|---|---|---|
| Event | `scripts/cam/worker-report.json` | AUTHORITATIVE outcome for the implementer channel |
| State | `scripts/cam/prd.json` | Integrity confirmation (`passes:true`); read-only by the sidecar after the report |
| Context | `scripts/cam/handoff.json` | Forward-context for the next implementer; not a control signal |
| Observability | `.claude/cam-worker-events.jsonl` | Append-only flight recorder; supervisor-owned |
| Wisdom | `scripts/cam/patterns.md` | Durable codebase conventions; agent-read at story start |

### Diagnosing a missing or stale report

If the sidecar does not detect completion after a worker run:

1. Check whether the implementer wrote the report:

   ```bash
   cat scripts/cam/worker-report.json 2>/dev/null || echo "(absent)"
   ```

2. Confirm the `story` field matches the dispatched story:

   ```bash
   jq '.story' scripts/cam/worker-report.json
   ```

   A stale story field (from a previous run that was not cleared) causes the
   poll guard to skip the break. The sidecar then waits for pane death or timeout.
   `cam stop` + `cam resume` restarts the sidecar and clears the stale report via
   `clearWorkerReport` before the next `respawn-pane -k`.

3. Check the event log for the worker outcome:

   ```bash
   grep '"kind":"result"' .claude/cam-worker-events.jsonl | tail -5
   ```

   A `"result"` line with `"outcome":"BLOCKED_QUALITY"` means the report was
   written but gates failed; the sidecar treated it as a non-DONE outcome and will
   re-dispatch.

4. Confirm `prd.json` integrity:

   ```bash
   jq '.userStories[] | select(.id=="US-XXX") | .passes' scripts/cam/prd.json
   ```

   The sidecar only writes `passes:true` AFTER reading a valid authoritative report.
   If `passes` is still `false` after the worker exited, the report was absent or
   stale at poll time.

### Manual override

If the poll timed out and you know the story is complete (gates passed, commit
landed):

1. Confirm quality gates:

   ```bash
   bun run typecheck
   bun test
   ```

2. Flip `passes: true` in `scripts/cam/prd.json` for the completed story.

3. Remove the stale report so the next run starts clean:

   ```bash
   rm -f scripts/cam/worker-report.json
   ```

4. Resume:

   ```bash
   cam resume
   ```

Cross-reference: `src/supervisor/loop.ts` (poll-loop staleness + shape guard before sentinel break),
`src/supervisor/result.ts` (readWorkerOutcome priority order: report first, prd integrity, fallback),
`src/supervisor/host.ts` (makeReadWorkerReport shape guard),
`scripts/cam/patterns.md` (single-source outcome contract + 5-concern model bullet,
poll-loop staleness + shape guard bullet).

## (p) CAM-78: single-pusher invariant for [cam] narration lines

The sidecar's `notifyOrchestrator` (in `src/supervisor/loop.ts`) is the single pusher of
`[cam]` terminal-event narrations to the orchestrator pane. No implementer or reviewer agent
writes its own narration line directly; every `[cam]` line in the orchestrator pane was sent
by the sidecar.

### What the single-pusher invariant means

- **Implementer outcome**: when the worker writes `scripts/cam/worker-report.json` and exits,
  the sidecar reads the report, calls
  `opts.notifyOrchestrator(formatWorkerReportSummary(report))`, and sends the
  `[cam] US-XXX DONE` (or BLOCKED/PRD_COMPLETE) line to the orchestrator pane via `send-keys`.
  The worker itself no longer sends any `send-keys` call (Step B removed in CAM-78).
- **Review verdict**: after a non-error review dispatch, the sidecar reads
  `prd.review.lastVerdict` and calls
  `opts.notifyOrchestrator(formatReviewVerdictLine(round, lastVerdict))` to emit the
  `[cam] review round-N CLEAN` (or FIXES_PENDING:K) line. Same seam, same code path.
- **cam next**: `cam next` is a pure `active:true` flip. It writes
  `.claude/cam-loop.local.md` and returns. It does NOT call `send-keys` to the orchestrator
  pane. Slash commands injected by other thin-proxies (plan, issue, review, ship) still
  use `sendKeysWhenIdle`; `cam next` is the exception.

### Diagnosing a glued double-push

**Symptom**: the orchestrator pane shows a line like:

```
Implement the next user story from scripts/cam/prd.json per your AGENT.md.[cam] US-XXX DONE: ...
```

The task prompt and the `[cam]` narration appear adjacent on the same line, glued together.

**Root cause (historical, now fixed)**: before CAM-78, the implementer worker contained a
Step B that sent its own `[cam]` line via `send-keys` BEFORE printing the
`CAM_IMPLEMENTER_STATUS` sentinel. The sidecar also sent the line via `notifyOrchestrator`
on detection. Two pushes, same pane, same event: the second arrived adjacent to the first
because the orchestrator pane buffer already had the task prompt on that line.

**Resolution**: CAM-78 (US-001 + US-003) removed the worker self-push from both agent files
and the sidecar template. If you see a glued line with the current binary, rebuild:

```bash
bun run build:release
```

**Verification after fix**: run a story end-to-end and confirm the orchestrator pane shows
exactly one `[cam] US-XXX DONE` line per story, with no adjacent task-prompt prefix.

Cross-reference: `src/supervisor/loop.ts` (notifyOrchestrator placement: post no-progress guard),
`src/supervisor/worker-report.ts` (formatWorkerReportSummary, formatReviewVerdictLine),
`src/supervisor/host.ts` (makeNotifyOrchestrator factory),
`scripts/cam/patterns.md` (single-pusher invariant bullet, cam-next-is-pure-trigger bullet).

## (q) CAM-102: orchestrator Task spawn denied by the agent-allowlist hook

Symptom: the orchestrator's `/cam-plan` flow blocks mid-execution, or a Task spawn is
denied with an error containing `permissionDecisionReason`. The orchestrator pane shows
output similar to:

```
Subagent type "..." is not in the cam capability allowlist.
Allowed read-only helpers: Explore, Plan, claude-code-guide, subagent-planner, subagent-auditor, subagent-reviewer.
For code work, dispatch the implementer worker via /cam-next instead.
(Policy is scoped to cam-managed sessions via CAM_SESSION.)
```

Cause: the PreToolUse hook `.claude/hooks/orch-agent-allowlist.sh` (registered in
`.claude/settings.json`) intercepts every `Task` and `Agent` tool call inside a
cam-managed session and applies the capability policy described below.

### Background

CAM-102 replaced the original fixed-name allowlist with a capability-based policy
gated by the `CAM_SESSION` environment variable.

**CAM_SESSION scope gate:** when `CAM_SESSION` is unset, the hook exits 0 immediately
(allow everything) without reading stdin. Interactive dev sessions are completely
unrestricted. Only sessions where the sidecar set `CAM_SESSION` (via `tmux new-session
-e CAM_SESSION=...`) are subject to the capability check below.

**Capability policy (applies only when CAM_SESSION is set):**

- ALLOW: read-only, plan-time helpers that do not write code.
  Types: `Explore`, `Plan`, `claude-code-guide`, `subagent-planner`, `subagent-auditor`,
  `subagent-reviewer`.
- DENY: everything else, including code-writers and absent/unknown types. Default-deny
  is preserved within scope: an unrecognised type is always DENY, so a misread
  `subagent_type` can only produce a false DENY, never a false ALLOW.

The hook reads the spawned subagent type from three field paths (defensive read, in
case the payload shape varies):

1. `.tool_input.subagent_type` (primary field, Claude hooks spec)
2. `.tool_input.agent_type` (alternate field observed in some payload shapes)
3. `.agent_type` (top-level alternate)

The first non-null, non-empty value wins. If all three are absent, the type is treated
as empty string and is denied.

The hook registration in `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Task|Agent",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/orch-agent-allowlist.sh" }]
      }
    ]
  }
}
```

### Diagnosing

1. Confirm the hook is causing the block. The denied Task call returns a
   `permissionDecisionReason` field in the tool result. Read it from the orchestrator
   pane or from the Claude Code event log.

2. Check whether the CAM_SESSION scope gate is set:

   ```bash
   tmux show-environment -t <session-name> CAM_SESSION
   ```

   If `CAM_SESSION` is unset in the tmux environment, the hook should be inactive (exit
   0 always). A denial in that case points to a different hook or settings entry.

3. Identify the subagent type that was denied:

   - If the orchestrator tried to spawn an ad-hoc Task that is not plan-related, the
     denial is expected behavior. Route the work to the worker pane via `/cam-next`
     instead.
   - If the orchestrator tried to spawn one of the ALLOW types and was still denied,
     the hook invocation itself may have a problem. Common causes:

     - **jq absent (fail-closed)**: the hook is fail-closed without jq. When `jq` is
       not on PATH, the hook denies every Task/Agent spawn (static deny, exit 0)
       rather than failing open or bypassing the gate. Without jq, ALLOW types are
       denied just like DENY types.
     - **settings.json malformed**: the hook is registered but cannot parse the
       payload cleanly.
     - **executable bit missing**: the hook file is not executable.

     Diagnostic commands:

     ```bash
     ls -la .claude/hooks/orch-agent-allowlist.sh   # should show -rwxr-xr-x
     which jq                                        # absent = hook denies all (fail-closed)
     cat .claude/settings.json | jq .               # must parse cleanly
     ```

4. To trace what the hook receives, run a test payload by hand:

   ```bash
   # Expect: no output (allow) -- must set CAM_SESSION for the scope gate to pass
   CAM_SESSION=test echo '{"tool_input":{"subagent_type":"subagent-planner"}}' \
     | CAM_SESSION=test bash .claude/hooks/orch-agent-allowlist.sh

   # Expect: JSON deny payload on stdout
   CAM_SESSION=test echo '{"tool_input":{"subagent_type":"unknown-type"}}' \
     | CAM_SESSION=test bash .claude/hooks/orch-agent-allowlist.sh

   # Expect: no output (allow) -- hook inactive when CAM_SESSION is absent
   echo '{"tool_input":{"subagent_type":"unknown-type"}}' \
     | bash .claude/hooks/orch-agent-allowlist.sh
   ```

### Manual override

**Extending the capability allowlist with a new read-only helper type:**

The capability policy is based on what a subagent type does, not on its name. Before
adding a type to the ALLOW set, confirm it is a read-only, plan-time helper (no file
edits, no commits, no shell mutations). Code-writing types must stay in the DENY set
and be dispatched as sidecar-managed worker panes, not as Task subagents inside the
orchestrator.

When a new read-only helper type is introduced, both copies of the hook must be updated
(the runtime copy used by the current project and the template copy embedded at
`cam init` time).

1. Edit the `case` statement in each copy:

   ```bash
   # Runtime copy:          .claude/hooks/orch-agent-allowlist.sh
   # Template copy:   templates/.claude/hooks/orch-agent-allowlist.sh
   ```

   Add the new type to the ALLOW branch. Example adding `subagent-researcher`:

   ```bash
   # Before:
   Explore|Plan|claude-code-guide|subagent-planner|subagent-auditor|subagent-reviewer)

   # After:
   Explore|Plan|claude-code-guide|subagent-planner|subagent-auditor|subagent-reviewer|subagent-researcher)
   ```

2. Update the human-readable deny message (the `permissionDecisionReason` string) in
   the same files to list the new member, so future diagnostics are accurate.

3. Regenerate the embedded vendor file and verify:

   ```bash
   bun run embed-vendor
   bun run embed-vendor:check
   ```

4. Run quality gates and commit:

   ```bash
   bun run typecheck
   bun test
   git add .claude/hooks/orch-agent-allowlist.sh \
           templates/.claude/hooks/orch-agent-allowlist.sh \
           src/vendor/_generated.ts
   git commit -m "feat: extend capability allowlist with subagent-<name> (CAM-NNN)"
   ```

**Restoring the executable bit** (if the hook file loses its executable permission,
e.g. after a `git checkout` or `cp` without mode preservation):

```bash
chmod +x .claude/hooks/orch-agent-allowlist.sh
```

Cross-reference: `.claude/hooks/orch-agent-allowlist.sh` (hook implementation),
`.claude/settings.json` (hook registration),
`templates/.claude/hooks/orch-agent-allowlist.sh` (template copy),
`src/vendor/_generated.ts` (embedded copy),
`scripts/cam/patterns.md` (CAM_SESSION scope-gate pattern bullet, PreToolUse deny
contract bullet, Template hook executable-bit restoration bullet).

## (r) CAM-89: conventional commits version bump and tag flow

### Background

`cam ship --bump` reads branch commits via `git log main..HEAD --pretty=%s`,
classifies the bump level using conventional commit prefixes, and writes a
`chore(release): bump version to X.Y.Z` commit on the feature branch.
`cam tag` runs after the PR squash-merges to main and creates and pushes
the `vX.Y.Z` git tag.

**0.x convention:** while the major component of the current version is 0, a
`major` bump (breaking change) is demoted to a minor increment. For example,
`0.1.2 + major -> 0.2.0`. No command path produces `1.0.0` automatically; the
1.0.0 escape hatch requires a manual operator edit (see r.4 below).

**Squash-merge tag-timing decision:** the bump commit lives on the feature
branch. After the PR squash-merges to main, that SHA is gone; `cam tag` reads
`CAM_VERSION` from the newly minted main HEAD and creates the tag there.
Running `git tag vX.Y.Z` on the branch before the merge tags the wrong SHA;
always run `cam tag` after checking out main.

### r.1 -- Bump misfired (wrong level committed)

If `cam ship --bump` wrote the wrong bump level (e.g. `0.2.0` when `0.3.0`
was intended):

1. Undo the bump commit on the feature branch:

   ```bash
   git revert HEAD --no-edit
   # or, while the branch has not been pushed:
   git reset HEAD~1 --soft
   ```

2. Edit `src/version.ts` manually to the correct version and update
   `package.json` to match:

   ```bash
   # e.g. to reach 0.3.0
   sed -i '' "s/^export const CAM_VERSION.*/export const CAM_VERSION = '0.3.0';/" src/version.ts
   # then update the "version" field in package.json to "0.3.0"
   ```

3. Commit the corrected files:

   ```bash
   git add src/version.ts package.json
   git commit -m "chore(release): bump version to 0.3.0"
   ```

4. Proceed with the PR merge, then run `cam tag` on main.

### r.2 -- Tag drift (tag points to wrong commit)

If the tag was created before the squash merge (branch SHA), or a force-push
changed main HEAD after tagging:

1. Delete the local and remote tag:

   ```bash
   git tag -d vX.Y.Z
   git push origin :refs/tags/vX.Y.Z
   ```

2. Verify you are on main and the tree is clean:

   ```bash
   git checkout main && git pull origin main
   git status  # must be clean
   ```

3. Re-run `cam tag` to create and push the tag at the correct main HEAD SHA:

   ```bash
   cam tag
   ```

### r.3 -- Re-tag a release (correct tag contents)

Same procedure as r.2: delete local and remote tag, confirm a clean main HEAD,
then run `cam tag`. `cam tag` is idempotent: if the tag already exists at the
current SHA it prints a no-op message and exits 0 without creating a duplicate.

If you need the tag at a specific SHA that is not main HEAD, use raw git:

```bash
git tag vX.Y.Z <sha>
git push origin vX.Y.Z
```

### r.4 -- Manually declare 1.0.0

The auto-bump in `cam ship --bump` never produces `1.0.0` while the major
component is 0 (the 0.x convention). To graduate to 1.0.0:

1. Edit `src/version.ts` directly:

   ```bash
   # change the constant to:
   export const CAM_VERSION = '1.0.0';
   ```

2. Update the `"version"` field in `package.json` to `"1.0.0"` as well.

3. Commit the change:

   ```bash
   git add src/version.ts package.json
   git commit -m "chore(release): bump version to 1.0.0"
   ```

4. After the PR merges to main, run `cam tag` to create the `v1.0.0` tag.

Cross-reference: `src/release/version.ts` (computeNextVersion, 0.x demotion
rule), `src/release/ship-bump.ts` (runShipBump, bump commit logic),
`src/commands/tag.ts` (runTag, guard + tag + push),
`scripts/cam/CLAUDE.md` (Release Conventions section),
`scripts/cam/patterns.md` (0.x semver convention placement bullet,
cam ship --bump step placement bullet).

## (s) CAM-84: cam ship enabled auto-merge but the PR did not merge

Symptom: `cam ship` completed without error and the PR was created, but the
pull request remains open and was never auto-merged. During the ship step the
terminal printed a hint line similar to:

```
Prerequisite hint: go to Settings > General > Pull Requests and enable both
'Allow auto-merge' and 'Allow squash merging'. Once enabled, re-run:
gh pr merge --auto --squash
```

Cause: `gh pr merge --auto --squash` requires two settings to be enabled in
the repository. When either is disabled, the command exits non-zero with a
GraphQL `enablePullRequestAutoMerge` error. The `gh` manual does not document
this failure mode. Because cam ship runs the step as
`gh pr merge --auto --squash || echo "..."` (best-effort -- the PR is already
created, so the failure is recoverable), the PR is created but the auto-merge
flag is never set on GitHub.

The two required settings are:

- "Allow auto-merge" (Settings > General > Pull Requests)
- "Allow squash merging" (Settings > General > Pull Requests)

### Recovery

1. Enable both settings in the repository (requires admin access):

   GitHub repository > Settings > General > Pull Requests

   - Check "Allow auto-merge"
   - Check "Allow squash merging"

2. Re-enable auto-merge on the open PR:

   ```bash
   gh pr merge --auto --squash <PR#>
   ```

   Replace `<PR#>` with the pull-request number shown when `gh pr create` ran
   during the ship step. The PR will merge automatically once all required
   status checks pass.

3. If all checks have already passed and an immediate merge is preferred:

   ```bash
   gh pr merge --squash <PR#>
   ```

Cross-reference: `.claude/commands/cam-ship.md` Step 7 (the best-effort
auto-merge call and hint), `scripts/cam/patterns.md` (gh pr merge --auto
best-effort pattern bullet).

## (t) CAM-101: ci-gated merge mode -- stuck CI or sidecar merge-watch stall

Symptom: the project is configured for `merge_mode = "ci-gated"` in
`scripts/cam/project.toml`. The PR was created and auto-merge was enabled, but
the pull request remains open: the sidecar is polling in merge-watch mode and
nothing is progressing. The orchestrator pane may show a narration line like:

```
[cam] CI red, PR #N open, not merged
```

or the merge-watch worker started silently and no narration appeared at all.

### Background: ci-gated merge mode

When `merge_mode = "ci-gated"`, the sidecar does not merge immediately after
creating the PR. Instead it starts a merge-watch poll loop (via
`runMergeWatch` in `src/release/merge-watch.ts`). The loop calls `gh pr view <N>
--json state,mergeStateStatus,statusCheckRollup` on a timer and handles these
outcomes:

| GitHub state | mergeStateStatus | statusCheckRollup | Sidecar action |
|---|---|---|---|
| MERGED | (any) | (any) | run post-merge (pull origin main, tag, prune), narrate `merge-watch-merged` |
| OPEN | BLOCKED | has a failed check | narrate `merge-watch-ci-red` (reason: blocked), stop |
| OPEN | BLOCKED | all pending / no failed check | keep polling (CI still in progress) |
| CLOSED | (any) | (any) | narrate `merge-watch-ci-red` (reason: closed), stop |
| (any) | (timeout) | (any) | narrate timeout, stop |

Non-terminal states (OPEN + CLEAN / BEHIND / CONFLICTING / DRAFT / UNKNOWN)
keep polling silently.

**Key distinction:** GitHub reports `mergeStateStatus == "BLOCKED"` for any
unmet merge condition, including required checks that are still pending or
in-progress. The sidecar only treats BLOCKED as a terminal CI failure when
`statusCheckRollup` contains at least one check with a conclusively failed
conclusion (`FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`,
`STARTUP_FAILURE`) or a failed status-context state (`FAILURE`, `ERROR`). An
absent or all-pending rollup means CI is still running: the loop keeps polling.

The structured events emitted to `.claude/cam-worker-events.jsonl` during a
merge-watch run are: `merge-watch-watching` (first gh poll, emitted inside stepMergeWatch on pollCount===0),
`merge-watch-merged` (on MERGED), `merge-watch-ci-red` (on BLOCKED or CLOSED
PR), and `merge-watch-post-merge-done` (after post-merge completes).

### Diagnosing a stuck merge-watch

1. Check whether the merge-watch marker is present (it is removed when the loop
   reaches a terminal outcome: merged, CI-red, or timeout):

   ```bash
   cat .claude/.cam-merge-watch.json 2>/dev/null || echo "(absent -- loop started or never wrote)"
   ```

2. Inspect recent events to see which state the loop last emitted:

   ```bash
   grep 'merge-watch' .claude/cam-worker-events.jsonl | tail -10
   ```

3. Check the current PR state directly:

   ```bash
   gh pr view --json number,state,mergeStateStatus,statusCheckRollup
   ```

4. Check the sidecar log for merge-watch output:

   ```bash
   tail -n 80 .claude/cam-supervisor.log | grep -i 'merge'
   ```

### Recovery: CI is red (BLOCKED)

The sidecar stops the merge-watch loop when it detects `mergeStateStatus ==
BLOCKED` AND `statusCheckRollup` contains at least one conclusively failed
check (conclusion in `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`,
`STARTUP_FAILURE` for CheckRun, or state `FAILURE` / `ERROR` for a legacy
StatusContext). If checks are still pending the loop keeps polling; you will
only see the narration `[cam] CI red, PR #N open, not merged` after a check
has definitively failed. The PR stays open. Steps to unblock:

1. Identify the failing CI job:

   ```bash
   gh pr checks
   ```

2. Fix the underlying issue, push a fixup commit to the feature branch, and
   wait for CI to turn green:

   ```bash
   git push origin $(git branch --show-current)
   ```

3. Once CI is green, GitHub auto-merge (enabled by `cam ship`) will merge
   the PR automatically. After the merge the post-merge step runs the next time
   `cam sidecar` idles: `git pull origin main`, version tag, and branch prune.

   If the sidecar is no longer running (it stopped after the BLOCKED narration),
   restart it and re-arm:

   ```bash
   cam stop
   cam resume
   ```

4. To merge immediately without waiting for the sidecar (if CI just went green
   and the PR has not auto-merged yet):

   ```bash
   gh pr merge --squash <PR#>
   ```

   Then run post-merge by hand (see scenario r.2 for tag flow).

### Recovery: branch-protection verify+warn fallback (no admin access)

CAM-101 includes a `configureBranchProtection` step in the ci-gated setup flow.
It attempts to PUT the branch-protection rule via the GitHub API and then
verifies it with a GET. When the PUT returns 403 (caller lacks admin
permissions), the helper falls back to verify+warn mode: it checks whether
branch protection is already configured (by reading the GET response) and emits
a warning hint rather than aborting.

Symptom: during `cam config` or the ci-gated setup step the terminal prints a
warning similar to:

```
Warning: could not configure branch protection via API (403 -- admin required).
Hint: go to Settings > Branches > Add rule, set branch 'main', and require
the 'ci' status check before merging.
```

Recovery (manual branch-protection setup):

1. Open the repository on GitHub: Settings > Branches > Add rule.
2. Set the "Branch name pattern" to `main`.
3. Under "Require status checks to pass before merging", add the `ci` check
   (this is the check name emitted by `.github/workflows/ci.yml`).
4. Save the rule.
5. Verify the rule is active:

   ```bash
   gh api repos/{owner}/{repo}/branches/main/protection \
     --jq '.required_status_checks.checks[].context'
   # should print: ci
   ```

6. Re-run the ci-gated flow:

   ```bash
   cam config
   ```

   The setup step will GET the branch-protection rule, confirm `ci` is present,
   and proceed without a warning.

Cross-reference: `src/release/merge-watch.ts` (runMergeWatch, poll loop,
terminal states), `src/release/branch-protection.ts` (configureBranchProtection,
verify+warn fallback), `src/config/models.ts` (readMergeMode),
`scripts/cam/patterns.md` (merge-watch state machine pattern bullet,
branch-protection helper bullet, [ship].merge_mode config surface bullet).

## (u) CAM-107: grill / spec flow -- re-running or recovering from a failed promotion

The grill/spec flow turns a `stage:idea` issue into a `stage:specified` issue via the
`/cam-spec <id>` slash command. `/cam-spec` runs the **grill-with-docs** interview
chain (`.claude/skills/grill-with-docs/SKILL.md`), then calls `specifyIssueOnMain`
(`src/commands/issue-specify.ts`) to commit the result directly on `main` without
touching the working branch. The on-main commit uses the same commit-tree plumbing as
the `/cam-issue --file-local` flow described in section (n).

### (u.1) Re-running a grill (interview interrupted mid-session)

Symptom: a `/cam-spec <id>` session was interrupted (browser refresh, claude session
timeout, `cam stop`, etc.) before the grill completed. The issue is still
`stage:idea` in `scripts/cam/issues/` on `main`; no spec was committed.

Because the grill is a stateless conversational loop, recovery is simply re-running it:

1. Confirm the issue is still `stage:idea` and `status:open`:

   ```bash
   # e.g. for CAM-42, the filename is CAM-0042.json
   git show main:scripts/cam/issues/<PREFIX>-NNNN.json | jq '{id, stage, status}'
   ```

2. Re-run the spec command from the orchestrator pane:

   ```
   /cam-spec <id>
   ```

   The grill starts from the beginning. There is no partial state to clear.

3. If the orchestrator session is absent:

   ```bash
   cam run
   ```

   Then inject:

   ```bash
   cam spec <id>
   ```

The grill has no on-disk draft state: a clean re-run is always safe.

### (u.2) Recovering a half-written spec (specifyIssueOnMain never ran)

Symptom: the grill interview finished and the orchestrator assembled a spec object, but
the `specifyIssueOnMain` call was not reached (the session was killed at the final step,
or a validation error blocked the write). The issue is still `stage:idea` in
`scripts/cam/issues/` on `main`.

Confirm before re-running:

```bash
# Stage must still be 'idea' (e.g. for CAM-42, filename is CAM-0042.json):
git show main:scripts/cam/issues/<PREFIX>-NNNN.json | jq '.stage'
# Expected: "idea"

# No stale spec commit on main:
git log --oneline -5 main -- scripts/cam/issues/<PREFIX>-NNNN.json
# The most recent commit for this file should NOT be "chore(cam): specify <id>"
```

Recovery: re-run the grill per (u.1). The spec assembled in the previous session exists
only in that session's transcript; it is not persisted anywhere on disk.

If you have saved answers from the previous session (e.g. in a text editor), re-entering
them is faster: the grill stages are operator-driven and accept pasted answers. If
`specifyIssueOnMain` returned a validation error (e.g. `invalid-spec` or `invalid-wsjf`),
the error message lists the failing fields. Correct those in the next session.

### (u.3) Fixing a malformed spec (specifyIssueOnMain ran but the spec is wrong)

Symptom: `specifyIssueOnMain` committed successfully and the issue file in
`scripts/cam/issues/` is now `stage:specified`, but the spec content is incorrect
(wrong title, missing acceptance criteria, bad WSJF scores, etc.).

Inspect the current spec (e.g. for CAM-42, filename is CAM-0042.json):

```bash
git show main:scripts/cam/issues/<PREFIX>-NNNN.json \
  | jq '{stage, spec, wsjf}'
```

**Option A: targeted field fix via commit-tree.**

Use the same commit-tree-to-main steps from section (n) to write a corrected
issue file directly on `main`:

```bash
# 1. Dump the current file from main:
git show main:scripts/cam/issues/<PREFIX>-NNNN.json > /tmp/issue-fix.json

# 2. Edit /tmp/issue-fix.json to correct the spec or wsjf field.

# 3. Apply via commit-tree (mirrors section (n) plumbing):
TMPDIR=$(mktemp -d)
GIT_INDEX_FILE="$TMPDIR/index" git read-tree main
BLOB=$(GIT_INDEX_FILE="$TMPDIR/index" git hash-object -w /tmp/issue-fix.json)
GIT_INDEX_FILE="$TMPDIR/index" git update-index --add --cacheinfo \
  "100644,$BLOB,scripts/cam/issues/<PREFIX>-NNNN.json"
TREE=$(GIT_INDEX_FILE="$TMPDIR/index" git write-tree)
PARENT=$(git rev-parse main)
COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "chore(cam): fix spec <id>")
git update-ref refs/heads/main "$COMMIT"
git push origin main
rm -rf "$TMPDIR"
```

**Option B: re-run the grill from scratch.**

If the spec needs a full revision, first reset the issue back to `stage:idea` using
Option A above (set `stage` to `"idea"` and remove the `spec`/`wsjf` keys in the JSON),
then run `/cam-spec <id>` again. `specifyIssueOnMain` guards against issues that are
not `stage:idea`, so the reset is required before re-running.

Note: a re-promotion produces a new `stage-promoted` event in
`.claude/cam-worker-events.jsonl`. The prior event is preserved (the log is
append-only).

**If the malformed spec blocks `/cam-plan`:**

`selectPlannableIssue` (`src/issues/select.ts`) filters on `stage:specified` and
`status:open`. A missing or corrupt `spec` field surfaces as a planner error. Confirm
which issue the planner would select by reading all issue files from main:

```bash
git ls-tree -r --name-only main scripts/cam/issues/ \
  | while read f; do git show main:"$f"; done \
  | jq -s '.[] | select(.stage=="specified" and .status=="open") | {id, stage, status, rank}'
```

Correct the entry using Option A above before re-running `/cam-plan`.

### (u.4) Where CONTEXT.md and ADRs live

The domain model for any cam-managed project lives at two pinned paths:

- `CONTEXT.md` at the **repo root**: glossary-only. Canonical terminology,
  bounded-context definitions, and ubiquitous language. No implementation details, no
  specs, no decisions. Created lazily on the first term that needs a definition.

- `docs/adr/` at the **repo root**: Architectural Decision Records. Write one only when
  all three gates pass: (1) hard to reverse, (2) surprising without context, (3) the
  result of a real trade-off with genuine alternatives considered. Created lazily; do not
  pre-create empty stubs.

The grill-with-docs skill (`.claude/skills/grill-with-docs/SKILL.md`) and the
domain-modeling skill (`.claude/skills/domain-modeling/SKILL.md`) are the two skills
that most frequently produce new entries for these files.

Cross-reference: `src/commands/issue-specify.ts` (specifyIssueOnMain, the deterministic
spec writer), `templates/commands/cam-spec.md` (/cam-spec slash command),
`.claude/skills/grill-with-docs/SKILL.md` (grill interview chain),
`src/issues/spec.ts` (validateSpec, validateWsjf),
section (n) (commit-tree-to-main primitive reused by specifyIssueOnMain),
`scripts/cam/CLAUDE.md` (Domain Model Convention section).

## (v) CAM-109: auto pipeline, non-convergence terminal, and Resend escalation

### Context

When `plan_approval = "auto"` (the default, stored in `[plan]` of
`scripts/cam/project.toml`), the sidecar advances without a human gate after a
successful plan audit. The review loop can hit a non-convergence terminal if it
exhausts `maxRounds` (default 3) without a CLEAN verdict: the supervisor promotes
`prd.review.lastVerdict` to `"MAX_ROUNDS_DEBT"` and stops.

In auto mode, the operator may not be watching the terminal at that moment. The
Resend escalation (configured in `[notify]`) fires a best-effort email so the
operator is alerted asynchronously.

### (v.1) Configure Resend escalation

The Resend API key is a secret and must NOT be stored in `project.toml` (which
is git-tracked). Set it as a shell environment variable instead:

```bash
export RESEND_API_KEY="re_xxxx"
```

Add that line to your `~/.zshrc` or `~/.bashrc` so it persists across sessions.
The recipient address (non-sensitive) is persisted to `scripts/cam/project.toml`
and is set via `cam init` or `cam config`:

```toml
[notify]
resend_recipient = "you@example.com"
```

To set the recipient during `cam init`:

```bash
cam init --plan-approval auto --resend-recipient you@example.com
```

If `plan_approval = "auto"` but `RESEND_API_KEY` is absent from the
environment, `cam init` prints a loud warning:

```
WARN: plan_approval is "auto" but Resend is not configured: non-convergence failures will be SILENT
Set RESEND_API_KEY in your shell environment (like LINEAR_API_KEY); also set resend_recipient in [notify] of scripts/cam/project.toml
```

Heed this warning: without `RESEND_API_KEY` set at runtime, a non-convergence
event is invisible unless the operator is watching the orchestrator pane.

### (v.2) Diagnose a non-convergence terminal

Symptom: the loop stops with `prd.review.lastVerdict = "MAX_ROUNDS_DEBT"` and
no further stories are dispatched.

1. Confirm the verdict:

   ```bash
   jq '.review.lastVerdict' scripts/cam/prd.json
   # => "MAX_ROUNDS_DEBT"
   ```

2. Inspect the last review report for findings:

   ```bash
   cat scripts/cam/review-report.json
   ```

3. Check the event log for the promotion:

   ```bash
   grep 'MAX_ROUNDS_DEBT' .claude/cam-worker-events.jsonl | tail -3 | jq .
   ```

4. Check whether the Resend escalation failed (stderr log from the sidecar). This
   grep surfaces only FAILED escalations: `sendEscalation` writes to stderr only
   on failure (the error and catch branches); on success it writes nothing, so a
   silent log means success or no attempt was made.

   ```bash
   grep 'Resend escalation' .claude/cam-supervisor.log | tail -5
   ```

### (v.3) Recover from a non-convergence terminal

Option A: fix the root cause (the reviewer's findings) manually and re-trigger
the loop.

1. Read the findings in `scripts/cam/review-report.json`.
2. Fix the issues in source code.
3. Reset the review state so the loop re-enters the implement cycle:

   ```bash
   # Reset review to round 0 so the loop picks up the next story normally.
   jq '.review = null' scripts/cam/prd.json > /tmp/prd-reset.json \
     && mv /tmp/prd-reset.json scripts/cam/prd.json
   git add scripts/cam/prd.json && git commit -m "chore: reset review after MAX_ROUNDS_DEBT recovery"
   ```

4. Re-arm: `cam next`.

Option B: increase `maxRounds` for projects that legitimately need more review
iterations. The real sources for `maxRounds` are (no `[review]` section in
`project.toml` is read by any code):

- **`prd.review.maxRounds`** in `scripts/cam/prd.json`: set via `/cam-plan` when
  the PRD is created. To raise it for an existing PRD, edit the file directly:

  ```bash
  jq '.review.maxRounds = 6' scripts/cam/prd.json > /tmp/prd-rounds.json \
    && mv /tmp/prd-rounds.json scripts/cam/prd.json
  git add scripts/cam/prd.json && git commit -m "chore: raise maxRounds to 6"
  ```

- **`CAM_MAX_REVIEW_ROUNDS`** environment variable: overrides the PRD field.
  Set it before `cam run` or `cam next`:

  ```bash
  CAM_MAX_REVIEW_ROUNDS=6 cam next
  ```

Then reset the review state as in Option A and re-arm.

Option C: switch to `plan_approval = "operator"` if the auto pipeline is
causing too many non-convergence events. Operator mode requires a human gate
before each loop iteration, so the operator can intervene before maxRounds is
hit.

```toml
[plan]
plan_approval = "operator"
```

Cross-reference: `src/notify/resend.ts` (best-effort Resend client),
`src/supervisor/loop.ts` (MAX_ROUNDS_DEBT terminal, escalateFn injection),
`src/config/models.ts` (readPlanApproval, readResendConfig),
`src/commands/setup.ts` (warnIfResendUnconfigured),
section (a) (stuck supervisor general triage).

## (w) CAM-122: cam journal append -- deterministic housekeeping channel

`cam journal append` is the gated write channel for appending structured cycle
entries to `scripts/cam/journal.md` directly on `main`. The orchestrator (a
read-only LLM session) pipes a JSON object to this command at cycle close time;
the command validates, normalises, and commits via the commit-tree-to-main
primitive (same plumbing as `cam issue --file-local`, section (n)).

### How the channel works

1. The orchestrator assembles a JSON object matching the `JournalCycleEntry`
   schema (cycleId, title, started, closed, branch, issue, outcome, summary,
   plus optional decisions, blockers, followups strings).
2. It pipes the JSON to `cam journal append` via stdin (or with `--force` to
   replace an existing entry for the same cycleId).
3. `appendJournalEntryOnMain` validates required fields, normalises em-dash
   characters to a colon, rejects duplicates (without `--force`),
   and writes the updated markdown to `main` via git plumbing without touching
   the working tree or HEAD branch.
4. On success the command prints `CAM_JOURNAL_APPENDED=<cycleId> sha=<sha>`
   and exits 0. On any error it prints via `printError` and exits 1.
5. A best-effort `git push origin main` follows the commit. Non-zero push exit
   is logged to stderr but is not fatal: the local commit already landed.

### Diagnosing a failed append

**Symptom: exit 1 with "invalid JSON" error**

The orchestrator produced a non-JSON payload or a malformed JSON string.

1. Re-run with the raw payload to inspect:

   ```bash
   echo '<payload>' | cam journal append
   ```

2. Confirm the payload has all required fields:
   cycleId, title, started, closed, branch, issue, outcome, summary.

3. Check for control characters or mismatched quotes in the JSON.

**Symptom: exit 1 with "duplicate cycleId" error**

An entry for the same `cycleId` already exists in `journal.md` on `main`.

Use `--force` to replace the existing block:

```bash
echo '<json>' | cam journal append --force
```

**Symptom: exit 1 with "missing required field" error**

One or more of the eight required fields is absent or empty. The error message
names the missing field. Confirm the orchestrator assembled the full entry
before piping.

**Symptom: commit succeeded but push failed**

The local commit is already on `main`; the push failure is logged but not
fatal. Push manually:

```bash
git push origin main
```

If the push is rejected (non-fast-forward), follow the divergent-main recovery
in section (n).

**Symptom: `git show main:scripts/cam/journal.md` fails (file missing)**

The journal file must pre-exist on `main` -- it is created by `cam init` from
the template at `templates/scripts/cam/journal.md`. If it is absent,
`appendJournalEntryOnMain` exits with reason `journal-missing`.

Restore it by materialising the template manually:

```bash
git show origin/main:scripts/cam/journal.md | head -10  # confirm it exists on origin
git fetch origin main:main                               # sync local main
git show main:scripts/cam/journal.md | head -10          # confirm local main is up to date
```

### Manual override (operator writes directly)

If the orchestrator session is unavailable and you need to append an entry
manually:

1. Build the JSON payload (all eight required fields must be present).

2. Pipe it to `cam journal append` from the project root:

   ```bash
   cat <<'EOF' | cam journal append
   {
     "cycleId": "cam/CAM-122-journal-append",
     "title": "cam journal append deterministico",
     "started": "2026-06-27",
     "closed": "2026-06-27",
     "branch": "cam/CAM-122-journal-append",
     "issue": "CAM-122",
     "outcome": "shipped",
     "summary": "Implemented the deterministic journal write channel via cam journal append."
   }
   EOF
   ```

3. Verify the entry landed on `main`:

   ```bash
   git show main:scripts/cam/journal.md | grep -A 20 'CAM-122'
   ```

Cross-reference: `src/commands/journal.ts` (appendJournalEntryOnMain, renderJournalBlock,
validateEntry, normalizeEmDash, hasDuplicateCycleId, replaceCycleBlock),
section (n) (commit-tree-to-main primitive),
`scripts/cam/patterns.md` (cam journal append: deterministic housekeeping channel bullet).

## (x) CAM-111: worker container model, firewall allowlist, and Docker dependency

The cam worker runs inside a local dev container (`.devcontainer/Dockerfile` +
`.devcontainer/devcontainer.json`). This section documents the container model,
the exact firewall allowlist, and the Docker dependency so an operator can
cross-check the live configuration. The architectural rationale is in
`docs/adr/0003-worker-isolation-boundary-dev-container.md`.

### Container model

Three isolation layers:

1. **Filesystem**: the repository is bind-mounted read-write into the container.
   No other host directories are accessible.
2. **Network (default-deny)**: an `iptables` + `ipset` egress firewall is
   applied by `.devcontainer/init-firewall.sh` at container start. Only the
   seven allowlisted domains below are reachable; all other outbound connections
   are dropped.
3. **Non-root user**: the worker runs as `bun` (uid 1000). Root is not
   available inside the container during normal operation.

The image tag is `cam-worker:latest`. Build it once from the project root:

```bash
docker build .devcontainer -t cam-worker:latest
```

The image must exist and the Docker daemon must be reachable before the sidecar
dispatches any worker. The preflight helper (`src/supervisor/preflight-container.ts`,
called before each dispatch) checks both; a failed preflight blocks the dispatch
without retrying.

Fail-closed spawn behavior (refusing dispatch when the container is not ready)
will be documented in Half B (CAM-150) once the conditional spawn logic is
implemented. This section covers setup and verification only.

### Firewall allowlist

The allowlist is managed exclusively by `.devcontainer/init-firewall.sh`. The
script declares exactly seven domains:

| Domain | Purpose |
|---|---|
| `api.anthropic.com` | Claude API (worker LLM calls) |
| `claude.ai` | Claude web (authentication flows) |
| `platform.claude.com` | Claude platform endpoints |
| `github.com` | git push/fetch, gh CLI |
| `*.github.com` | GitHub sub-services (codeload, uploads, objects, API) |
| `registry.npmjs.org` | npm/bun package registry |
| `raw.githubusercontent.com` | raw file downloads from GitHub |

DNS resolution (UDP + TCP port 53) is always permitted so the ipset can resolve
domain names to IPs at container start. SSH (port 22) outbound to allowlisted
IPs is permitted for git-over-SSH.

To cross-check the live allowlist against this table:

```bash
grep -A 12 'ALLOWED_DOMAINS=(' .devcontainer/init-firewall.sh
```

If a new domain is needed, update `ALLOWED_DOMAINS` in `init-firewall.sh` AND
update the table above AND the corresponding ADR
(`docs/adr/0003-worker-isolation-boundary-dev-container.md` Consequencias
section). Adding a domain is a deliberate architectural decision.

### Docker dependency

The firewall script requires two Linux capabilities:

- `NET_ADMIN`: to set iptables policies and rules.
- `NET_RAW`: to manipulate raw sockets (ipset).

Both are granted via `runArgs` in `.devcontainer/devcontainer.json`. On macOS
and Windows, Docker Desktop provides a Linux VM internally; the capabilities
work as expected inside that VM. On native Linux, the host kernel must allow
these capabilities for the container user.

**Symptom: `preflight-container` returns `daemon-unreachable`**

The Docker daemon is not running or is not accessible to the current user.

```bash
docker info          # should print daemon info; non-zero exit means daemon is down
systemctl start docker   # Linux systemd
open -a Docker           # macOS Docker Desktop
```

**Symptom: `preflight-container` returns `image-missing`**

The `cam-worker:latest` image does not exist locally. Build it:

```bash
docker build .devcontainer -t cam-worker:latest
```

**Symptom: `preflight-container` returns `image-stale`**

The image creation timestamp predates the `Dockerfile` mtime. The Dockerfile
was modified after the last build. Rebuild:

```bash
docker build .devcontainer -t cam-worker:latest
```

**Symptom: firewall self-verify fails (allowed domain unreachable)**

`init-firewall.sh` performs a self-verify step after applying rules. If
`api.anthropic.com` is unreachable after the rules are applied, the script
exits non-zero. Common causes:

- DNS is blocked: confirm UDP/TCP port 53 is not filtered upstream.
- IP for `api.anthropic.com` changed between DNS resolution and the curl check:
  rerun `init-firewall.sh` to refresh the ipset.
- The ipset is empty (dig not installed): install `dnsutils` (Debian/Ubuntu) or
  `bind-utils` (Fedora/Alpine) inside the container image.

**Symptom: firewall self-verify fails (blocked domain reachable)**

`example.com` is reachable after the firewall is applied, meaning the
default-deny policy did not take effect. Verify that `NET_ADMIN` capability is
granted:

```bash
docker inspect <container_id> | jq '.[0].HostConfig.CapAdd'
# expected: ["NET_ADMIN","NET_RAW"]
```

If the capability is absent, stop the container and re-create it from the
devcontainer (VS Code: "Reopen in Container"; CLI: `devcontainer up`).

Cross-reference: `.devcontainer/init-firewall.sh` (firewall script),
`.devcontainer/devcontainer.json` (capability grants, non-root user config),
`src/supervisor/preflight-container.ts` (preflight helper),
`docs/adr/0003-worker-isolation-boundary-dev-container.md` (architectural rationale).
