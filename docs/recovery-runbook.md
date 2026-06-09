# cam recovery runbook

When the autonomous loop gets stuck, this is the operator playbook for
unblocking it without reading source. Every scenario below is keyed to the
runtime files the supervisor writes under the project's `.claude/` directory,
and every tmux command targets the dedicated `-L cam` socket.

## Canonical runtime files

All paths are relative to the project root.

| File | Written by | What it tells you |
|---|---|---|
| `.claude/cam-loop.local.md` | `cam next` | Loop state. YAML frontmatter: `active`, `iteration`, `started_at`, `pid` (the supervisor process), `session_id`, `max_iterations`. |
| `.claude/.cam-worker-pane` | `cam plan` | The reused worker pane id (e.g. `%5`). The supervisor drives this single pane with `respawn-pane -k`. |
| `.claude/.cam-worker-<US>.session` | `cam next` | Per-story worker session uuid (one file per completed story), used to resolve that story's transcript. |
| `.claude/.cam-worker-out-<uuid>.log` | the worker | Durable per-worker stdout+stderr (survives the pane dying). |
| `.claude/cam-worker-events.jsonl` | `cam next` | One JSON line per worker lifecycle step (`worker-start`, `worker-end`, `result`, `tokens`, `pushed`, `stale-lock`, `rate-limited`). Your primary diagnostic log. |
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

## (e) Diagnosing with the event log

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

# Rate-limit pauses and resumes (US-016):
grep '"kind":"rate-limited"' .claude/cam-worker-events.jsonl

# Push verifications on each pass (US-002): which commits actually reached origin:
grep '"kind":"pushed"' .claude/cam-worker-events.jsonl

# Supervisor takeovers of a dead lock (US-015):
grep '"kind":"stale-lock"' .claude/cam-worker-events.jsonl
```

To correlate a story with its transcript, read its session marker and resolve
the uuid:

```bash
cat .claude/.cam-worker-US-XXX.session
```

Cross-references: `.claude/cam-loop.local.md`, `.claude/.cam-worker-pane`,
`.claude/.cam-worker-<US>.session`, `.claude/cam-worker-events.jsonl`,
`.claude/.cam-supervisor.lock`.
