---
description: Direct lane for internal fixes with a machine-checkable oracle. Skips the cam loop (plan/audit/review rounds), never skips the deterministic gates.
---

# /direct-fix

The direct lane for internal maintenance work on cam-cli itself. Policy lives in
`memory/project_faixa_direta.md` (operator decision, 2026-08-03) — this command
is its executable form.

Use it when the loop would be ceremony. Do NOT use it to escape verification:
you skip the LLM cycle, never `bun run check:all`.

**The task is:** $ARGUMENTS

If that is empty, ask the operator what the task is before doing anything else.

Normally you are launched by `scripts/direct-fix.sh`, already inside a
throwaway git worktree cut from `origin/main`, on a `direct/<slug>` branch. That
worktree has none of the repo's gitignored dev artifacts, which is deliberate:
it reproduces CI's conditions, so a green `check:all` here means a green CI.

## Step 0 — entry gate (answer BEFORE editing anything)

> Which test or gate goes green when this is done?

Write the answer down explicitly, as a command you can run. Examples of a valid
answer: `bun run check:all` gate `skip-ratchet` flips from fail to ok; a named
test in `test/foo.test.ts` currently red goes green.

If you cannot name it, **STOP**. The work does not qualify for this lane — it
needs the full loop, because its acceptance criterion requires judgment about
intent rather than a machine check. Tell the operator that and stop.

## Step 1 — load the project disciplines

These do NOT auto-load in a plain session, and skipping them is how this lane
turns into the problem it exists to avoid:

1. Read `scripts/cam/CLAUDE.md` in full (stack, quality gates, curated
   invariants, knowledge-layer routing).
2. Read `memory/project_faixa_direta.md` (this lane's policy).
3. Grep `scripts/cam/patterns.md` for the subsystem you are touching, and read
   only the matching bullets. Never read it whole.

## Step 2 — establish the red

Run the check named in Step 0 and confirm it is RED right now. A fix whose
oracle was never observed failing is unfalsifiable: you cannot tell a real fix
from a no-op. If it is already green, you have the wrong oracle or the wrong
diagnosis — go back to Step 0.

## Step 3 — fix the cause

Hard prohibitions. These hold even though the allowlist hook does not gate an
interactive session (it keys on worker env vars, so nothing mechanically stops
you here — the discipline is the only guard):

- Never delete, skip, or weaken a test to make a gate pass.
- Never edit `test/helpers/lane-expectations.json`, `scripts/coverage-budget.json`,
  `scripts/file-size-budget.json`, or any budget/ratchet file so the observed
  number matches. Those files record measured reality; changing them to fit is
  gate-gaming. Raising a file-size ceiling with a tracker ref is the one
  sanctioned exception.
- Never dismiss a failing test as flaky, pre-existing, or environmental. A red
  gate is a hard stop: fix the root cause or hand it back to the operator.
- Never edit `scripts/cam/prd.json`.
- Stay surgical: every changed line must trace to the stated fix.

## Step 4 — verify

1. The Step 0 check now goes GREEN, and you observed it RED in Step 2.
2. `bun run check:all` passes **whole**. Not a subset, not just the touched
   test. This is the safety net that makes the lane defensible: 14 gates and
   the full suite.
3. If the change touched `vendor/` or `templates/`, also run
   `bun run embed-vendor` and `bun run embed-vendor:check`.

## Step 5 — record the insight, if there is one

If the fix produced a durable, reusable insight, append one bullet to
`scripts/cam/patterns.md`. Route by the table in `scripts/cam/CLAUDE.md`:
patterns for technical gotchas, `memory/` for operator policy, `docs/adr/` only
when all three ADR gates pass.

Persisted human-readable markdown in this repo carries no em-dash and no
decorative emoji (operator convention). Agent instruction files are exempt.

## Step 6 — ship it

You are already on a `direct/<slug>` branch if launched by the script. If not,
cut one: never commit straight to main.

```bash
git add -A && git commit -m "<type>: <what and why>"
git push -u origin HEAD
gh pr create --fill
```

No version bump, no tag, no journal entry, no cycle-metrics. Those belong to
the loop's ship phase; this lane is deliberately lighter. If the change
warrants a release, say so and let the operator decide.

Do NOT add AI-attribution trailers to commits or PR text.

## Step 7 — hand back

Report to the operator in three lines:

1. The oracle: what was red, what is now green.
2. `check:all` result.
3. PR number, plus anything you noticed and deliberately did NOT fix (scope
   discipline: note it, do not silently absorb it).

Then remind them of the cleanup command for this worktree, and stop. Do not
merge your own PR.

## Gotchas worth carrying

- `gh pr view --json statusCheckRollup` returns `conclusion: ""` (empty string,
  not null) while a check is still running, so `.conclusion // .status` in jq
  never reaches the fallback and a first poll reads as final. Gate completion on
  `.status` (`IN_PROGRESS` / `COMPLETED`), never on `.conclusion`.
- `gh pr list -q '.[0]|"..."'` on an empty array yields a literal string of
  `null`s rather than nothing. Use `.[0].number // empty`.
- If a cam loop session is running, check `.claude/cam-loop.local.md` in the
  PRIMARY checkout first. Working in a worktree already isolates you from the
  sidecar's checkouts and branch pruning, which is one of the reasons the lane
  uses one.
