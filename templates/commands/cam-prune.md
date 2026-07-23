Clean up the current cam branch after PR is merged (or abandoned) and return to main.

`cam prune` (US-004, CAM-400) is a deterministic CLI subcommand — no LLM judgment
involved. Run it and narrate the result instead of re-running the git dance
yourself:

```bash
cam prune
```

Behaviour (enforced by the CLI, not by this session):
1. STOPs (nonzero exit) if the working tree is dirty, or if already on main.
2. STOPs unless `--force` if the current branch is not `cam/*`, or if it has
   an open (unmerged) PR.
3. Otherwise: `git checkout main`, `git pull origin main`,
   `git branch -D <branch>`, `git fetch --prune`.

On success, `cam prune` prints the pruned branch name and confirms the
working tree is on main — relay that to the user.

If `cam prune` exits nonzero, read its printed error and act on it:
- Dirty tree: tell the user to commit or stash first. Don't offer to stash
  or discard on their behalf.
- Non-`cam/*` branch, or an open unmerged PR: ask the user for confirmation,
  then re-run with `cam prune --force` if they confirm.
- Already on main: nothing to prune — tell the user.

Rules:
- NEVER delete `main` or `master` — `cam prune` enforces this internally and
  it is never bypassable via `--force`.
- NEVER force-push anything.
- The remote branch is NOT deleted here — GitHub auto-deletes on merge when
  `delete_branch_on_merge` is enabled.
