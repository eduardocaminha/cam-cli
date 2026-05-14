/**
 * Ported from claude-auto-retry v0.2.2
 * Original authors: cheapestinference contributors
 * Port: Eduardo Caminha
 * License: MIT — see LICENSES/claude-auto-retry-MIT.txt
 */

import { join } from "node:path";
import { mkdir, readdir, unlink, stat, appendFile } from "node:fs/promises";

const MAX_AGE_DAYS = 7;
const CLEANUP_INTERVAL_MS = 3_600_000; // 1 hour

export interface Logger {
  info: (msg: string) => Promise<void>;
  warn: (msg: string) => Promise<void>;
  error: (msg: string) => Promise<void>;
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function todayFile(dir: string): string {
  return join(dir, `${new Date().toISOString().split("T")[0]}.log`);
}

async function cleanup(dir: string, lastCleanupRef: { value: number }): Promise<void> {
  if (Date.now() - lastCleanupRef.value < CLEANUP_INTERVAL_MS) return;
  lastCleanupRef.value = Date.now();
  try {
    const files = await readdir(dir);
    const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
    for (const file of files) {
      if (!file.endsWith(".log")) continue;
      const s = await stat(join(dir, file));
      if (s.mtimeMs < cutoff) await unlink(join(dir, file));
    }
  } catch {
    // ignore cleanup errors
  }
}

export function createLogger(
  dir: string = join(process.env["HOME"] ?? "", ".cam", "retry-logs")
): Logger {
  let dirCreated = false;
  const lastCleanupRef = { value: 0 };

  async function ensureDir(): Promise<void> {
    if (!dirCreated) {
      await mkdir(dir, { recursive: true });
      dirCreated = true;
    }
  }

  async function log(level: string, message: string): Promise<void> {
    await ensureDir();
    const line = `[${timestamp()}] [${level}] ${message}\n`;
    await appendFile(todayFile(dir), line);
    // fire-and-forget cleanup (matches original behavior)
    void cleanup(dir, lastCleanupRef);
  }

  return {
    info: (msg: string) => log("INFO", msg),
    warn: (msg: string) => log("WARN", msg),
    error: (msg: string) => log("ERROR", msg),
  };
}
