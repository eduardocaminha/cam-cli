# ADR 0031: syncWorktreeIfOnMain must materialize paths absent from the worktree, not only restore present ones

## Context

CAM-137's sync restored the worktree for MODIFY (files already present) but left newly-created files deletion-staged after a CREATE-on-main commit, because the CREATE path either did not propagate the new file's path into the sync or the staged-restore did not materialize an absent path.

## Decision

Fix at the invariant level: propagate the created file's path into syncWorktreeIfOnMain AND make sync materialize a path absent from the worktree, so 'worktree coherent with HEAD after the call' holds for CREATE the same as for MODIFY. Rejected the narrower call-site-only patch because it fixes only one of the two candidate causes.

## Consequences

syncWorktreeIfOnMain's contract now explicitly covers absent paths; future on-main CREATE writers inherit a clean worktree. A real-git regression pins the invariant. Slightly more work in sync than a targeted patch, justified by robustness against both root-cause hypotheses.
