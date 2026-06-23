import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { checkAgentFrontmatterTsContents } from "../../src/vendor/_generated";

// Minimal agent fixture. 'name' MUST match the filename slug 'example'.
const EXAMPLE_AGENT_MD = [
  "---",
  "name: example",
  "description: An example agent for testing.",
  "model: claude-opus-4-5",
  "tools:",
  "  - Read",
  "  - Write",
  "---",
  "",
  "Example agent body text.",
  "",
].join("\n");

let tmpDir: string;
let scriptPath: string;

beforeEach(() => {
  // Fresh tmpdir with no node_modules -- mirrors the zero-dep invariant.
  tmpDir = mkdtempSync(join(tmpdir(), "cam-smoke-standalone-"));

  // git init so the smoke's `git rev-parse --show-toplevel` resolves correctly.
  spawnSync("git", ["init"], { cwd: tmpDir });

  // Write the minimal .claude/agents/example.md fixture.
  mkdirSync(join(tmpDir, ".claude", "agents"), { recursive: true });
  writeFileSync(join(tmpDir, ".claude", "agents", "example.md"), EXAMPLE_AGENT_MD);

  // Materialize the embedded smoke script -- mirrors runVendoredSmoke in init.ts.
  scriptPath = join(tmpDir, "check-agent-frontmatter.ts");
  writeFileSync(scriptPath, checkAgentFrontmatterTsContents, "utf8");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test(
  "smoke exits 0 and stdout contains 'agent file(s) ok' in a no-node_modules tmpdir",
  () => {
    const result = spawnSync('bun', [scriptPath], {
      cwd: tmpDir,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("agent file(s) ok");
  },
);
