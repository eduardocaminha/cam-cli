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

4. **Push the branch**:
   ```bash
   git push origin $(git branch --show-current)
   ```

5. **Open PR**:
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

6. **Close the GitHub issue** (if applicable):
   ```bash
   gh issue close <N> --reason completed --comment "Shipped via PR #<PR>"
   ```

7. **Print summary**:
   ```
   ✅ Shipped: PR #<N> opened
   Branch: <branch>
   Stories: <M> completed
   ```

Rules:
- NEVER force-push.
- NEVER push directly to `main`.
- Do NOT ship if quality gates are failing.
