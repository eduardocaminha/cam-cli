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

3. **Run quality gates**:
   ```bash
   # Typecheck
   <project typecheck command>
   # Tests
   <project test command>
   ```
   Fix any failures before proceeding.

4. **Cycle-close hygiene (backend-aware close + harness reset) -- before push.**

   Run the finalize command. It reads the issue backend from `scripts/cam/project.toml`, closes the local issue (when `issue_system = "none"`), removes per-branch harness state (`prd.json`, `handoff.json`, `progress.txt`) via `git rm -f --ignore-unmatch`, and commits everything in a single cycle-close commit.

   ```bash
   cam ship --finalize
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

7. **Close the `github` / `linear` backend issue (if applicable).** The `none` backend was already closed by `cam ship --finalize` in Step 4; for the others:
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
