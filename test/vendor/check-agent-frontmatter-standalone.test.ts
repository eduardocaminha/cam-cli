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
  // CAM-508 GOTCHA 10(a): this test's whole premise is a directory with NO
  // node_modules resolvable from it, mirroring the vendored smoke script's
  // zero-third-party-dependency invariant. The repo-local scratch root
  // (test/helpers/test-tmpdir.ts::createTestTmpdir) lives INSIDE the cam-cli
  // checkout, so module resolution walks up and finds cam-cli's own
  // node_modules -- a script that grew a third-party import would silently
  // still pass. This is the one legitimate, allowlisted exception (see
  // scripts/check-test-tmpdir.ts::ALLOWLIST) that roots directly in the real
  // OS temp dir instead of the shared helper, specifically to stay outside
  // any node_modules resolution chain. Round 2 (US-R2-001): rooting outside
  // node_modules alone is NOT sufficient -- `bun` auto-installs a missing
  // bare-specifier import from ~/.bun/install/cache regardless of cwd, so
  // both spawnSync calls below also pass `--no-install` to make the guard
  // real (a grown third-party dependency now fails loudly instead of
  // resolving silently).
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
    // CAM-508 GOTCHA 10(a) round 2: bun auto-installs a missing import from
    // ~/.bun/install/cache even in a tmpdir with no node_modules of its own,
    // so a script that grew a third-party dependency would silently still
    // pass without --no-install. This flag is what actually earns the
    // ALLOWLIST exception in scripts/check-test-tmpdir.ts.
    const result = spawnSync('bun', ['--no-install', scriptPath], {
      cwd: tmpDir,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("agent file(s) ok");
  },
  { timeout: 20_000 },
);

test(
  "CAM-286: smoke exits 0 for an agent file with no 'model:' frontmatter key",
  () => {
    const noModelAgentMd = [
      "---",
      "name: example",
      "description: An example agent for testing.",
      "tools:",
      "  - Read",
      "  - Write",
      "---",
      "",
      "Example agent body text.",
      "",
    ].join("\n");
    writeFileSync(join(tmpDir, ".claude", "agents", "example.md"), noModelAgentMd);

    const result = spawnSync('bun', ['--no-install', scriptPath], {
      cwd: tmpDir,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("agent file(s) ok");
  },
  { timeout: 20_000 },
);
