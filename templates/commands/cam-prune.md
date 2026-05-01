Clean up the current cam branch after PR is merged (or abandoned) and return to main.

Steps:
1. `git status` — check for uncommitted changes. If dirty, STOP and warn:
   ```
   ❌ Cannot prune — uncommitted changes detected. Commit or stash first.
   ```
2. Identify the current branch name via `git branch --show-current`
   - If already on `main`, STOP: "Already on main — nothing to prune."
   - If NOT a `cam/*` branch, ask for confirmation before proceeding.
3. Check if the branch has an open PR: `gh pr view --json state,mergedAt,url 2>/dev/null`
   - If PR is open (not merged), WARN and ask for confirmation:
     ```
     ⚠️  Branch has an open PR: <url>
     Are you sure you want to prune? The PR will remain open but the local branch will be deleted.
     ```
   - If PR is merged, proceed without confirmation.
   - If no PR exists, proceed without confirmation.
4. Switch to main and pull latest:
   ```bash
   git checkout main
   git pull origin main
   ```
5. Delete the local branch:
   ```bash
   git branch -D <branch-name>
   ```
6. Prune stale remote tracking branches:
   ```bash
   git fetch --prune
   ```
7. Print summary:
   ```
   ✅ Pruned branch: <branch-name>
   Now on: main (up to date with origin)
   ```

Rules:
- NEVER delete `main` or `master`.
- NEVER force-push anything.
- If uncommitted changes exist, STOP — don't offer to stash or discard.
- Ask for confirmation if the branch has an open (unmerged) PR.
- The remote branch is NOT deleted here — GitHub auto-deletes on merge when `delete_branch_on_merge` is enabled.
