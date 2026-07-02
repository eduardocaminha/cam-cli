---
model: claude-sonnet-4-6
---

Ship all changes on the current branch: verify PRD complete, run quality gates, push, and open PR.

**CLI thin-proxy invocation**: `cam ship` (run from a terminal outside the session) is a thin-proxy. It detects the active cam session, waits for the orchestrator to be idle, then injects `/cam-ship` into the orchestrator pane via atomic `send-keys`. The content below is what the orchestrator executes when it receives this slash command.

Steps:

1. **Verify PRD is complete -- MANDATORY, blocks everything if not.**
   Read `scripts/cam/prd.json`. Check that all stories where `requires != "operator"` have `passes: true`.

   Use this `jq` filter to find blocking stories:
   ```bash
   jq -r '.userStories[] | select(.passes == false and (.requires // "") != "operator") | "- \(.id): \(.title) (passes: false)"' scripts/cam/prd.json
   ```

   If the filter returns ANY rows, STOP and report:
   ```
   ❌ Cannot ship -- PRD has incomplete non-operator stories:
   - US-003: Create API route (passes: false)

   Run /cam-next to complete remaining stories first.
   ```
   Do NOT proceed. Do NOT offer workarounds.

2. `git status` -- verify there are changes or commits ahead of main.

3. **Run quality gates** -- `bun run check:all` is the same spine CI runs, so a green ship implies a green CI:
   ```bash
   bun run check:all
   ```
   Fix any failures before proceeding.

   If `check:all` fails on a **ratchet gate** (file-size ceiling or coverage floor) because the story represents LEGITIMATE growth, raise the ratchet and retry -- do not dead-end:

   - **File-size ceiling** (`scripts/file-size-budget.json`): raise the ceiling for the affected file, add the current issue tracker ref to the top-level `"_ref"` field (e.g. `"_ref": "CAM-NNN"`), stage the file.
   - **Coverage floor** (`scripts/coverage-budget.json`): lower the affected floor (`floors.functions` or `floors.lines`), set `"_ref"` to the tracker ref, stage the file.

   Then re-run `bun run check:all`. The gate reads only the staged diff, so the tracker ref must be staged before re-running.

4. **Bump version (deterministic, in-process) -- commits before push.**

   Reads `git log main..HEAD --pretty=%s`, classifies commit types (feat/fix/breaking), computes the next semver version (0.x convention: major bump -> minor increment while major is 0), writes `src/version.ts` and `package.json`, and commits `chore(release): bump version to X.Y.Z`. No-op when all commits classify as none.

   ```bash
   cam ship --bump
   ```

5. **Cycle-close hygiene (backend-aware close + harness reset) -- before push.**

   Run the finalize command. It reads the issue backend from `scripts/cam/project.toml`, removes per-branch harness state (`prd.json`, `handoff.json`, `progress.txt`) via `git rm -f --ignore-unmatch`, and commits everything in a single cycle-close commit. For the `none` backend, it stashes the issueId into `.cam-merge-watch.json` instead of closing the issue directly on the branch; the actual close happens post-merge.

   ```bash
   cam ship --finalize
   ```

6. **Push the branch**:
   ```bash
   git push origin $(git branch --show-current)
   ```

7. **Open PR**:
   ```bash
   gh pr create \
     --title "<issue title>" \
     --body-file /tmp/pr-body.md \
     --base main
   ```

   Then enable auto-merge (best-effort -- the PR is already created; do not abort if this fails):
   ```bash
   gh pr merge --auto --squash || echo "Prerequisite hint: go to Settings > General > Pull Requests and enable both 'Allow auto-merge' and 'Allow squash merging'. Once enabled, re-run: gh pr merge --auto --squash"
   ```
   <!-- cam-init: adaptation point -- downstream projects using merge-commit instead of squash should change `--squash` to `--merge` (or `--rebase`). -->

   PR body template:
   ```markdown
   ## Summary
   <1 paragraph: what this PR does and why>

   ## Stories completed
   <table of US-XXX stories with checkboxes>

   ## Testing
   - [ ] Typecheck passes
   - [ ] Tests pass
   - [ ] Manual verification done

   ## Notes
   <anything reviewers should know>
   ```

   Post the reviewer artifact-of-record as a PR comment (best-effort -- missing file or `gh` failure does not abort ship):
   ```bash
   PR_NUMBER=$(gh pr view --json number --jq '.number')
   if [ -f scripts/cam/review-artifact.txt ]; then
     { printf '**artifact-of-record**\n\n'; cat scripts/cam/review-artifact.txt; } > /tmp/cam-artifact-comment.txt
     gh pr comment "$PR_NUMBER" --body-file /tmp/cam-artifact-comment.txt || true
   fi
   ```

   **Merge mode** (read `scripts/cam/project.toml [ship] merge_mode`; default: `immediate`):

   - **`ci-gated`**: After `gh pr create` above, enrich the merge-watch state file with the PR number and branch (read-modify-write to preserve the issueId stashed by `cam ship --finalize`):
     ```bash
     PR_NUMBER=$(gh pr view --json number --jq '.number')
     BRANCH=$(git branch --show-current)
     WATCH=$(cat .claude/.cam-merge-watch.json 2>/dev/null || printf '{}')
     printf '%s' "$WATCH" | jq --argjson pr "$PR_NUMBER" --arg branch "$BRANCH" \
       '. + {"prNumber": $pr, "mergedBranch": $branch}' > .claude/.cam-merge-watch.json
     ```
     The sidecar is the owner of `.cam-merge-watch.json` from this point on; the write side must not re-write it (re-writing causes double post-merge).
     Do NOT run pull/tag/prune inline. The sidecar detects the CI-merged event by reading `.claude/.cam-merge-watch.json` on idle ticks and completes post-merge autonomously (pull main, push tag, prune branch, and -- for the `none` backend -- close the issue via `closeIssueOnMain` using the stashed issueId). For `github` and `linear` backends, close the issue manually after the PR merges (run `gh issue close <N>` or use the Linear UI). Skip Step 9.
   - **`immediate`**: Continue to Steps 8-9. The orchestrator does the post-merge by hand as today.

8. **Close the issue (per backend).**

   - **`none` backend**: read the stashed issueId from `.cam-merge-watch.json`, call `closeIssueOnMain` inline, then remove the watch file:
     ```typescript
     // Orchestrator runs this inline (mirroring the cam-spec.md specifyIssueOnMain pattern):
     import { closeIssueOnMain } from './src/commands/issue-specify.ts';
     import { spawnSync } from 'node:child_process';
     import { readFileSync, unlinkSync } from 'node:fs';

     const watch = JSON.parse(readFileSync('.claude/.cam-merge-watch.json', 'utf8'));
     const result = closeIssueOnMain({
       cwd: process.cwd(),
       id: watch.issueId,
       spawnFn: (cmd, args, opts) => spawnSync(cmd, args, { ...opts, stdio: 'pipe' }),
       clock: () => new Date().toISOString(),
     });
     if (result.ok) unlinkSync('.claude/.cam-merge-watch.json');
     ```
   - **`github` backend**:
     ```bash
     gh issue close <N> --reason completed --comment "Shipped via PR #<PR>"
     ```
   - **`linear` backend**: transition `<issue_prefix>-<N>` to Done via the Linear API.

9. **Print summary**:
   ```
   ✅ Shipped: PR #<N> opened
   Branch: <branch>
   Issue: <issue-id> closed (<backend>)
   Stories: <M> completed
   ```

Rules:
- NEVER force-push.
- NEVER push directly to `main`.
- Do NOT ship if quality gates are failing.
