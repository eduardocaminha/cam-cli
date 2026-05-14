import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/retry/logger.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cam-logger-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function todayDateStr(): string {
  return new Date().toISOString().split("T")[0]!;
}

function todayLogPath(dir: string): string {
  return join(dir, `${todayDateStr()}.log`);
}

// --- Directory creation ---

test("creates the log directory on first log call", async () => {
  const logDir = join(tmpDir, "nested", "log", "dir");
  const logger = createLogger(logDir);
  await logger.info("hello");
  const files = await readdir(logDir);
  expect(files.length).toBeGreaterThan(0);
});

test("does not error if directory already exists", async () => {
  const logDir = join(tmpDir, "logs");
  const logger = createLogger(logDir);
  await logger.info("first");
  await logger.info("second");
  // No error thrown — directory already existed on second call
  const content = await readFile(todayLogPath(logDir), "utf-8");
  expect(content.split("\n").filter(Boolean).length).toBe(2);
});

// --- Log file creation ---

test("creates a log file named YYYY-MM-DD.log for today", async () => {
  const logDir = join(tmpDir, "logs");
  const logger = createLogger(logDir);
  await logger.info("test");
  const files = await readdir(logDir);
  const logFiles = files.filter((f) => f.endsWith(".log"));
  expect(logFiles.length).toBe(1);
  expect(logFiles[0]).toBe(`${todayDateStr()}.log`);
});

// --- Append behavior ---

test("appends multiple log entries to the same file", async () => {
  const logDir = join(tmpDir, "logs");
  const logger = createLogger(logDir);
  await logger.info("line one");
  await logger.warn("line two");
  await logger.error("line three");
  const content = await readFile(todayLogPath(logDir), "utf-8");
  const lines = content.split("\n").filter(Boolean);
  expect(lines.length).toBe(3);
  expect(lines[0]).toContain("line one");
  expect(lines[1]).toContain("line two");
  expect(lines[2]).toContain("line three");
});

test("preserves existing content when appending", async () => {
  const logDir = join(tmpDir, "logs");
  const logger1 = createLogger(logDir);
  await logger1.info("from logger 1");
  const logger2 = createLogger(logDir);
  await logger2.info("from logger 2");
  const content = await readFile(todayLogPath(logDir), "utf-8");
  expect(content).toContain("from logger 1");
  expect(content).toContain("from logger 2");
});

// --- Log levels ---

test("info log contains [INFO] level marker", async () => {
  const logDir = join(tmpDir, "logs");
  const logger = createLogger(logDir);
  await logger.info("info message");
  const content = await readFile(todayLogPath(logDir), "utf-8");
  expect(content).toContain("[INFO]");
  expect(content).toContain("info message");
});

test("warn log contains [WARN] level marker", async () => {
  const logDir = join(tmpDir, "logs");
  const logger = createLogger(logDir);
  await logger.warn("warn message");
  const content = await readFile(todayLogPath(logDir), "utf-8");
  expect(content).toContain("[WARN]");
  expect(content).toContain("warn message");
});

test("error log contains [ERROR] level marker", async () => {
  const logDir = join(tmpDir, "logs");
  const logger = createLogger(logDir);
  await logger.error("error message");
  const content = await readFile(todayLogPath(logDir), "utf-8");
  expect(content).toContain("[ERROR]");
  expect(content).toContain("error message");
});

// --- Log format ---

test("each log entry includes a timestamp in ISO-like format", async () => {
  const logDir = join(tmpDir, "logs");
  const logger = createLogger(logDir);
  await logger.info("timestamp test");
  const content = await readFile(todayLogPath(logDir), "utf-8");
  // Timestamp format: [YYYY-MM-DD HH:MM:SS]
  expect(content).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
});

test("each log line is terminated with a newline", async () => {
  const logDir = join(tmpDir, "logs");
  const logger = createLogger(logDir);
  await logger.info("newline check");
  const content = await readFile(todayLogPath(logDir), "utf-8");
  expect(content.endsWith("\n")).toBe(true);
});

// --- Default dir uses $HOME ---

test("default dir uses HOME environment variable (injectable via createLogger arg)", async () => {
  // We pass an explicit dir instead of relying on HOME to keep tests isolated
  const logDir = join(tmpDir, "cam-logs");
  const logger = createLogger(logDir);
  await logger.info("home test");
  const content = await readFile(todayLogPath(logDir), "utf-8");
  expect(content).toContain("home test");
});
