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
