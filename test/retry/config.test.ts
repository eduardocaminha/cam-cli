import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_CONFIG } from "../../src/retry/config.ts";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "cam-config-test-"));
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
});

afterEach(async () => {
  if (originalHome !== undefined) {
    process.env["HOME"] = originalHome;
  } else {
    delete process.env["HOME"];
  }
  await rm(tmpHome, { recursive: true, force: true });
});

// Helper: get the expected config path using same logic as loadConfig
function configPath(baseDir?: string): string {
  const dir = baseDir ?? join(tmpHome, ".config", "cam");
  return join(dir, "retry.toml");
}

// --- Default creation ---

test("creates retry.toml with defaults when file does not exist", async () => {
  const cfg = await loadConfig();
  expect(cfg.maxRetries).toBe(DEFAULT_CONFIG.maxRetries);
  expect(cfg.pollIntervalSeconds).toBe(DEFAULT_CONFIG.pollIntervalSeconds);
  expect(cfg.marginSeconds).toBe(DEFAULT_CONFIG.marginSeconds);
  expect(cfg.fallbackWaitHours).toBe(DEFAULT_CONFIG.fallbackWaitHours);
  expect(cfg.retryMessage).toBe(DEFAULT_CONFIG.retryMessage);
  expect(cfg.customPatterns).toEqual([]);
});

test("creates the config file on disk when it does not exist", async () => {
  await loadConfig();
  const path = configPath();
  const content = await readFile(path, "utf-8");
  // File should exist and contain TOML content
  expect(content).toContain("maxRetries");
  expect(content).toContain("pollIntervalSeconds");
});

test("creates parent directories if they do not exist", async () => {
  const customDir = join(tmpHome, "deep", "nested", "dir");
  await loadConfig(customDir);
  const path = configPath(customDir);
  const content = await readFile(path, "utf-8");
  expect(content.length).toBeGreaterThan(0);
});

// --- Parse success ---

test("parses valid TOML config with overridden values", async () => {
  const baseDir = join(tmpHome, ".config", "cam");
  await mkdir(baseDir, { recursive: true });
  await writeFile(
    configPath(baseDir),
    `maxRetries = 10
pollIntervalSeconds = 30
marginSeconds = 120
fallbackWaitHours = 2.5
retryMessage = "Please retry now."
customPatterns = ["pattern1", "pattern2"]
`
  );
  const cfg = await loadConfig(baseDir);
  expect(cfg.maxRetries).toBe(10);
  expect(cfg.pollIntervalSeconds).toBe(30);
  expect(cfg.marginSeconds).toBe(120);
  expect(cfg.fallbackWaitHours).toBe(2.5);
  expect(cfg.retryMessage).toBe("Please retry now.");
  expect(cfg.customPatterns).toEqual(["pattern1", "pattern2"]);
});

test("returns defaults for missing optional fields in partial config", async () => {
  const baseDir = join(tmpHome, ".config", "cam");
  await mkdir(baseDir, { recursive: true });
  await writeFile(configPath(baseDir), `maxRetries = 3\n`);
  const cfg = await loadConfig(baseDir);
  expect(cfg.maxRetries).toBe(3);
  expect(cfg.pollIntervalSeconds).toBe(DEFAULT_CONFIG.pollIntervalSeconds);
  expect(cfg.marginSeconds).toBe(DEFAULT_CONFIG.marginSeconds);
  expect(cfg.fallbackWaitHours).toBe(DEFAULT_CONFIG.fallbackWaitHours);
  expect(cfg.retryMessage).toBe(DEFAULT_CONFIG.retryMessage);
});

test("filters invalid customPatterns (non-strings and bad regex)", async () => {
  const baseDir = join(tmpHome, ".config", "cam");
  await mkdir(baseDir, { recursive: true });
  await writeFile(
    configPath(baseDir),
    `customPatterns = ["valid.*", "also-valid", "[invalid"]\n`
  );
  const cfg = await loadConfig(baseDir);
  expect(cfg.customPatterns).toEqual(["valid.*", "also-valid"]);
});

test("accepts foregroundCommands when provided as non-empty array", async () => {
  const baseDir = join(tmpHome, ".config", "cam");
  await mkdir(baseDir, { recursive: true });
  await writeFile(
    configPath(baseDir),
    `foregroundCommands = ["git", "vim"]\n`
  );
  const cfg = await loadConfig(baseDir);
  expect(cfg.foregroundCommands).toEqual(["git", "vim"]);
});

test("omits foregroundCommands when provided as empty array", async () => {
  const baseDir = join(tmpHome, ".config", "cam");
  await mkdir(baseDir, { recursive: true });
  await writeFile(configPath(baseDir), `foregroundCommands = []\n`);
  const cfg = await loadConfig(baseDir);
  expect(cfg.foregroundCommands).toBeUndefined();
});

test("clamps below-min values to defaults", async () => {
  const baseDir = join(tmpHome, ".config", "cam");
  await mkdir(baseDir, { recursive: true });
  await writeFile(
    configPath(baseDir),
    `maxRetries = 0
pollIntervalSeconds = 0
fallbackWaitHours = 0.0
`
  );
  const cfg = await loadConfig(baseDir);
  expect(cfg.maxRetries).toBe(DEFAULT_CONFIG.maxRetries);
  expect(cfg.pollIntervalSeconds).toBe(DEFAULT_CONFIG.pollIntervalSeconds);
  expect(cfg.fallbackWaitHours).toBe(DEFAULT_CONFIG.fallbackWaitHours);
});

// --- Parse failure ---

test("throws a clear error on invalid TOML with file path in message", async () => {
  const baseDir = join(tmpHome, ".config", "cam");
  await mkdir(baseDir, { recursive: true });
  const path = configPath(baseDir);
  await writeFile(path, `maxRetries = [this is not valid toml\n`);
  await expect(loadConfig(baseDir)).rejects.toThrow(path);
});

test("throws a clear error on invalid TOML with parser message included", async () => {
  const baseDir = join(tmpHome, ".config", "cam");
  await mkdir(baseDir, { recursive: true });
  await writeFile(configPath(baseDir), `= bad\n`);
  let errMsg = "";
  try {
    await loadConfig(baseDir);
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
  }
  // Should include "Failed to parse TOML config at"
  expect(errMsg).toContain("Failed to parse TOML config at");
  expect(errMsg.length).toBeGreaterThan(40);
});

// --- Path expansion ---

test("expands $HOME via process.env.HOME for default base dir", async () => {
  // process.env.HOME is tmpHome from beforeEach
  const cfg = await loadConfig();
  // If path expansion works, no error is thrown and defaults are returned
  expect(cfg.maxRetries).toBe(DEFAULT_CONFIG.maxRetries);
  // Verify file was created in tmpHome, not literal "$HOME"
  const expected = join(tmpHome, ".config", "cam", "retry.toml");
  const content = await readFile(expected, "utf-8");
  expect(content).toContain("maxRetries");
});

test("injected baseDir overrides HOME-based default", async () => {
  const customDir = join(tmpHome, "custom-cam-dir");
  await loadConfig(customDir);
  const path = join(customDir, "retry.toml");
  const content = await readFile(path, "utf-8");
  expect(content).toContain("maxRetries");
});
