import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ADR_PATH = join(import.meta.dir, "../docs/adr/0002-fast-track-plan-ready.md");

function readAdr(): string {
  return readFileSync(ADR_PATH, "utf8");
}

test("ADR 0002 exists and contains required section headings", () => {
  const content = readAdr();

  // Required section headings (Decisao / Contexto / Alternativas / Consequencias)
  expect(content).toMatch(/##\s+Decisao/);
  expect(content).toMatch(/##\s+Contexto/);
  expect(content).toMatch(/##\s+(Alternativas|Alternatives)/);
  expect(content).toMatch(/##\s+(Consequencias|Consequences)/);
});

test("ADR 0002 references CAM-107 and specSource", () => {
  const content = readAdr();

  expect(content).toContain("CAM-107");
  expect(content).toContain("specSource");
});

test("ADR 0002 contains no em-dash character", () => {
  const content = readAdr();

  // Em-dash (U+2014) must not appear in the file (project doc convention)
  expect(content).not.toContain("—");
});
