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

3. The clean fix is `cam stop`, which SIGTERMs that pid, removes the state file,
   and kills the project tmux session:

   ```bash
   cam stop
   ```

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
```

To correlate a story with its transcript, read its session marker and resolve
the uuid:

```bash
cat .claude/.cam-worker-US-XXX.session
```

Cross-references: `.claude/cam-loop.local.md`, `.claude/.cam-worker-pane`, `.claude/.cam-worker-<US>.session`, `.claude/cam-worker-events.jsonl`, `.claude/.cam-supervisor.lock`.
