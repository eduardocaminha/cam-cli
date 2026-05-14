/**
 * Ported from claude-auto-retry v0.2.2
 * Original authors: cheapestinference contributors
 * Port: Eduardo Caminha
 * License: MIT — see LICENSES/claude-auto-retry-MIT.txt
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export interface RetryConfig {
  maxRetries: number;
  pollIntervalSeconds: number;
  marginSeconds: number;
  fallbackWaitHours: number;
  retryMessage: string;
  customPatterns: string[];
  foregroundCommands?: string[];
}

export const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 5,
  pollIntervalSeconds: 5,
  marginSeconds: 60,
  fallbackWaitHours: 5,
  retryMessage: "Continue where you left off. The previous attempt was rate limited.",
  customPatterns: [],
};

const DEFAULT_TOML = `# cam-cli retry configuration
# See https://github.com/eduardocaminha/cam-cli for docs

maxRetries = 5
pollIntervalSeconds = 5
marginSeconds = 60
fallbackWaitHours = 5
retryMessage = "Continue where you left off. The previous attempt was rate limited."
customPatterns = []
`;

function validNumber(val: unknown, min: number, fallback: number): number {
  return typeof val === "number" && Number.isFinite(val) && val >= min
    ? val
    : fallback;
}

function validate(raw: Record<string, unknown>): RetryConfig {
  const cfg: RetryConfig = { ...DEFAULT_CONFIG };

  cfg.maxRetries = validNumber(raw["maxRetries"], 1, DEFAULT_CONFIG.maxRetries);
  cfg.pollIntervalSeconds = validNumber(
    raw["pollIntervalSeconds"],
    1,
    DEFAULT_CONFIG.pollIntervalSeconds
  );
  cfg.marginSeconds = validNumber(
    raw["marginSeconds"],
    0,
    DEFAULT_CONFIG.marginSeconds
  );
  cfg.fallbackWaitHours = validNumber(
    raw["fallbackWaitHours"],
    0.1,
    DEFAULT_CONFIG.fallbackWaitHours
  );

  if (typeof raw["retryMessage"] === "string" && raw["retryMessage"]) {
    cfg.retryMessage = raw["retryMessage"];
  }

  if (!Array.isArray(raw["customPatterns"])) {
    cfg.customPatterns = DEFAULT_CONFIG.customPatterns;
  } else {
    cfg.customPatterns = (raw["customPatterns"] as unknown[]).filter(
      (p): p is string => {
        if (typeof p !== "string") return false;
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      }
    );
  }

  const fc = raw["foregroundCommands"];
  if (fc !== undefined) {
    if (Array.isArray(fc) && fc.length > 0) {
      cfg.foregroundCommands = (fc as unknown[]).filter(
        (c): c is string => typeof c === "string"
      );
    }
    // if empty array or non-array, omit the field
  }

  return cfg;
}

export async function loadConfig(
  baseDir: string = join(process.env["HOME"] ?? "", ".config", "cam")
): Promise<RetryConfig> {
  const configPath = join(baseDir, "retry.toml");

  // Ensure parent directory exists
  await mkdir(baseDir, { recursive: true });

  const file = Bun.file(configPath);
  const exists = await file.exists();

  if (!exists) {
    // Write documented defaults on first read
    await Bun.write(configPath, DEFAULT_TOML);
    return { ...DEFAULT_CONFIG };
  }

  const raw = await file.text();

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse TOML config at ${configPath}: ${msg}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Invalid TOML config at ${configPath}: expected a TOML table at the top level`
    );
  }

  return validate(parsed as Record<string, unknown>);
}
