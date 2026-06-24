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
still present and tracked in the repo, or `scripts/cam/issues.local.json` still
shows the issue as open.

When it happens: the sidecar exited before running the cycle-close commit,
or the process crashed mid-finalize.

Recovery: run the deterministic cycle-close primitive:

```bash
cam ship --finalize
```

What it does (in order):

1. Reads `scripts/cam/project.toml` for `issue_system` and `issue_prefix`.
2. Reads `scripts/cam/prd.json` for the issue number (before removing it).
3. When `issue_system == 'none'`: marks the matching entry in
   `scripts/cam/issues.local.json` as `state: "closed"` with a timestamp.
   For `github` or `linear`: skips this step (the backend closes the issue via
   PR merge or explicit API call).
4. Removes `scripts/cam/prd.json`, `scripts/cam/handoff.json`, and
   `scripts/cam/progress.txt` via `git rm -f --ignore-unmatch` (idempotent:
   missing or untracked files are silently skipped).
5. Stages `issues.local.json` when applicable.
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

# Step 3 (if issue_system == 'none'): edit issues.local.json by hand.
#   Set "state": "closed" and "closedAt": "<ISO timestamp>" on the matching entry.
git add scripts/cam/issues.local.json

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
