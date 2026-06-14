---
model: claude-sonnet-4-6
---

Ship all changes on the current branch: verify PRD complete, run quality gates, push, and open PR.

Steps:

1. **Verify PRD is complete — MANDATORY, blocks everything if not.**
   Read `scripts/cam/prd.json`. Check that all stories where `requires != "operator"` have `passes: true`.

   Use this `jq` filter to find blocking stories:
   ```bash
   jq -r '.userStories[] | select(.passes == false and (.requires // "") != "operator") | "- \(.id): \(.title) (passes: false)"' scripts/cam/prd.json
   ```

   If the filter returns ANY rows, STOP and report:
   ```
   ❌ Cannot ship — PRD has incomplete non-operator stories:
   - US-003: Create API route (passes: false)

   Run /cam-next to complete remaining stories first.
   ```
   Do NOT proceed. Do NOT offer workarounds.

2. `git status` — verify there are changes or commits ahead of main.

3. **Run quality gates**:
   ```bash
   # Typecheck
   <project typecheck command>
   # Tests
   <project test command>
   ```
   Fix any failures before proceeding.

4. **Cycle-close hygiene (backend-aware close + harness reset) — before push.**

   Read the issue backend from `scripts/cam/project.toml`: `issue_system` (`none` | `github` | `linear`) and `issue_prefix` (default `CAM`).

   a. **Close the `none` (local) backend issue now (CAM-30).** When `issue_system = "none"`, the issue lives in `scripts/cam/issues.local.json` and must be flipped HERE, in a commit, so the closure propagates to `main` on merge. Read the PRD `issueNumber`, find the entry whose `id == "<issue_prefix>-<issueNumber>"`, and set its `state` to `"closed"` with a `closedAt` ISO timestamp. (For `github` / `linear` the close is a no-commit API call done in Step 7 after the PR exists; skip this sub-step for those backends.)

   b. **Reset the per-branch harness working state (CAM-27).** `prd.json` and `handoff.json` are per-branch artifacts. Left in the branch they leak into `main` on merge and make `/cam-plan` Step 1 report a FALSE 'in-progress' (it reads a stale `prd.json` in `main`). Remove them so `main` stays clean. `progress.txt` is legacy (retired in CAM-31): dropped if present.
   ```bash
   git rm -q scripts/cam/prd.json scripts/cam/handoff.json scripts/cam/progress.txt 2>/dev/null || true
   ```
   `issues.local.json` is the persistent backlog, NOT per-branch state: do NOT remove it. `scripts/cam/patterns.md` is durable, versioned wisdom: do NOT remove it.

   c. Stage the issues.local.json edit (if `none`) + the removals and commit them together:
   ```bash
   git add -A
   git commit -m "chore(cam): close <issue-id> + drop per-branch harness state (CAM-27 hygiene)"
   ```

5. **Push the branch**:
   ```bash
   git push origin $(git branch --show-current)
   ```

6. **Open PR**:
   ```bash
   gh pr create \
     --title "<issue title>" \
     --body-file /tmp/pr-body.md \
     --base main
   ```

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

7. **Close the `github` / `linear` backend issue (if applicable).** The `none` backend was already closed in Step 4a; for the others:
   ```bash
   # github:
   gh issue close <N> --reason completed --comment "Shipped via PR #<PR>"
   # linear: transition <issue_prefix>-<N> to Done via the Linear API.
   ```

8. **Print summary**:
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
