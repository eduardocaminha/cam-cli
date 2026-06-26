import { test, expect } from "bun:test";
import { templatesContents } from "../../src/vendor/_generated";

// Regression guard: the actually-shipped cam-ship.md text (written into user
// projects by `cam init`) must delegate cycle-close to `cam ship --finalize`,
// never expose raw git rm commands or the masked-atomic `2>/dev/null || true`
// pattern that silently swallowed real errors.

const SHIP_KEY = "commands/cam-ship.md";

test("embedded cam-ship.md delegates cycle-close to cam ship --finalize", () => {
  const content = templatesContents[SHIP_KEY];
  expect(content).toBeDefined();
  expect(content).toContain("cam ship --finalize");
});

test("embedded cam-ship.md does NOT contain masked-atomic git rm pattern", () => {
  const content = templatesContents[SHIP_KEY];
  expect(content).toBeDefined();
  expect(content).not.toContain(
    "git rm -q scripts/cam/prd.json scripts/cam/handoff.json scripts/cam/progress.txt 2>/dev/null || true"
  );
});

test("embedded cam-ship.md Step 3 pins bun run check:all (full gate spine)", () => {
  const content = templatesContents[SHIP_KEY];
  expect(content).toBeDefined();
  expect(content).toContain("bun run check:all");
});

test("embedded cam-ship.md Step 3 does NOT pin the partial-gate-only placeholder", () => {
  const content = templatesContents[SHIP_KEY];
  expect(content).toBeDefined();
  expect(content).not.toContain("<project typecheck command>");
});

test("embedded cam-ship.md contains gh pr merge --auto --squash", () => {
  const content = templatesContents[SHIP_KEY];
  expect(content).toBeDefined();
  expect(content).toContain("gh pr merge --auto --squash");
});

test("embedded cam-ship.md gh pr merge --auto --squash is positioned after gh pr create", () => {
  const content = templatesContents[SHIP_KEY];
  expect(content).toBeDefined();
  const mergeIdx = content!.indexOf("gh pr merge --auto --squash");
  const createIdx = content!.indexOf("gh pr create");
  expect(mergeIdx).toBeGreaterThan(createIdx);
});

test("embedded cam-ship.md documents ci-gated merge mode branching after gh pr merge", () => {
  const content = templatesContents[SHIP_KEY];
  expect(content).toBeDefined();
  expect(content).toContain("ci-gated");
});

test("embedded cam-ship.md ci-gated path instructs skipping inline pull/tag/prune", () => {
  const content = templatesContents[SHIP_KEY];
  expect(content).toBeDefined();
  expect(content).toContain("Do NOT run pull/tag/prune inline");
});

test("embedded cam-ship.md ci-gated path states sidecar completes post-merge autonomously", () => {
  const content = templatesContents[SHIP_KEY];
  expect(content).toBeDefined();
  expect(content).toContain("sidecar detects the CI-merged event");
});

test("embedded cam-ship.md immediate mode is documented as the unchanged path", () => {
  const content = templatesContents[SHIP_KEY];
  expect(content).toBeDefined();
  expect(content).toContain("immediate");
  expect(content).toContain("post-merge by hand as today");
});
