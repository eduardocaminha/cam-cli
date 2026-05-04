#!/usr/bin/env node
// scripts/smoke/check-agent-frontmatter.ts
//
// WHY THIS SMOKE EXISTS
// ---------------------
// Claude Code's agent loader rejects .claude/agents/*.md files whose YAML
// frontmatter is malformed, missing required keys, or whose `name:` value
// disagrees with the filename slug. The rejection is silent — the agent
// never appears in the registry, and Task(subagent_type="X") fails with
// "agent type 'X' not found". The trailing-LF check at check-agent-files.sh
// catches one specific byte-level regression class; this file catches the
// structural-frontmatter regression class.
//
// Validations per file (.claude/agents/*.md, excluding _archive/):
//   1. Trailing LF byte (defense-in-depth — primary check is check-agent-files.sh).
//   2. Frontmatter is delimited by `---` lines at top + closing.
//   3. Frontmatter parses as YAML (js-yaml v4 throws YAMLException on syntax errors).
//   4. Required top-level keys: name, description, model, plus at least one of
//      (tools, disallowedTools).
//   5. `name` value matches the filename slug (e.g. prd-implementer.md → name: prd-implementer).
//   6. `model` is a non-empty string.
//   7. Body has at least one non-empty line after the closing `---`.
//
// Exit codes:
//   0 — every file scanned passes
//   1 — at least one file violates a rule (gcc-style diagnostics on stderr)
//   2 — environmental error (not in a git repo, agents dir missing, js-yaml not installed)
//
// Diagnostic format: `<file>:<line>: <reason>` (gcc-style — IDE-jumpable). When
// a violation has no specific source line (e.g. a missing top-level key, an
// empty body) the diagnostic uses the line number of the closing `---` of the
// frontmatter so the operator's editor lands somewhere relevant.
//
// Invocation:
//   bun scripts/smoke/check-agent-frontmatter.ts                    # walk all files
//   bun scripts/smoke/check-agent-frontmatter.ts path/to/agent.md    # validate only the listed paths
//   scripts/smoke/check-agent-frontmatter.sh                         # auto-detect runtime
//
// CONSUMERS
//   - .github/workflows/agent-files-lint.yml (CI on push + pull_request)
//   - .claude/hooks/pre-commit-check.sh (skip-when-untouched)
//   - docs/runbooks/cam-loop-recovery.md §Scenario 4 (manual diagnostic)

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import process from 'node:process';

import yaml from 'js-yaml';

// --- Repo discovery --------------------------------------------------------

let repoRoot: string;
try {
  repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
} catch {
  console.error('check-agent-frontmatter: not inside a git repo.');
  process.exit(2);
}

const AGENT_DIR = join(repoRoot, '.claude/agents');
if (!existsSync(AGENT_DIR)) {
  // No agents dir — fresh repo / new clone, nothing to validate.
  process.exit(0);
}

// --- Build target list -----------------------------------------------------
// CLI args (positional file paths) take precedence over directory walking.
// Used by the runbook demo and ad-hoc operator runs against tmp copies.

const argFiles = process.argv.slice(2);
let targets: string[];
if (argFiles.length > 0) {
  targets = argFiles.map((p) => (p.startsWith('/') ? p : join(process.cwd(), p)));
} else {
  // Walk top-level .md only — _archive/ and other subdirs are skipped by design
  // (matches existing check-agent-files.sh convention).
  targets = readdirSync(AGENT_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(AGENT_DIR, f));
}

// --- Required keys ---------------------------------------------------------

const REQUIRED_TOP_LEVEL_KEYS = ['name', 'description', 'model'] as const;
const REQUIRED_AT_LEAST_ONE = ['tools', 'disallowedTools'] as const;

// --- Per-file validator ----------------------------------------------------

interface Diagnostic {
  file: string;
  line: number;
  reason: string;
}

function emit(diagnostics: Diagnostic[], file: string, line: number, reason: string): void {
  diagnostics.push({ file, line, reason });
}

function relPath(absolute: string): string {
  // Best-effort relative path for diagnostics. If the file lives outside the
  // repo (e.g. /tmp during the self-test), fall back to the absolute path.
  const rel = relative(repoRoot, absolute);
  return rel.startsWith('..') ? absolute : rel;
}

function filenameSlug(absolute: string): string {
  const name = basename(absolute);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function validateFile(absolute: string, diagnostics: Diagnostic[]): void {
  const display = relPath(absolute);
  let raw: string;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch (err) {
    emit(diagnostics, display, 1, `cannot read file — ${(err as Error).message}`);
    return;
  }

  // 1. Trailing LF (defense-in-depth — check-agent-files.sh is the primary check).
  if (!raw.endsWith('\n')) {
    emit(diagnostics, display, Math.max(1, raw.split('\n').length), 'missing trailing LF');
    // Continue — frontmatter checks still meaningful even without trailing LF.
  }

  const lines = raw.split('\n');

  // 2. Frontmatter delimiters.
  if (lines.length === 0 || lines[0] !== '---') {
    emit(diagnostics, display, 1, "missing opening '---' frontmatter delimiter");
    return;
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    emit(diagnostics, display, lines.length, "missing closing '---' frontmatter delimiter");
    return;
  }

  // The closing-delimiter line number is the anchor for diagnostics that have
  // no specific source line (missing key, empty body, etc.). 1-indexed for gcc.
  const closeLine = closeIdx + 1;
  const frontmatterText = lines.slice(1, closeIdx).join('\n');

  // 3. YAML parse. js-yaml v4 throws YAMLException with .mark.line (0-indexed
  // within the parsed string). Add the +2 offset (frontmatter starts at line 2,
  // i.e. one after the opening `---`) to convert to a 1-indexed file line.
  let parsed: unknown;
  try {
    parsed = yaml.load(frontmatterText);
  } catch (err) {
    const e = err as { mark?: { line?: number }; reason?: string; message?: string };
    const offset = typeof e.mark?.line === 'number' ? e.mark.line + 2 : closeLine;
    const message = e.reason ?? e.message ?? 'unknown YAML error';
    emit(diagnostics, display, offset, `malformed YAML — ${message}`);
    return;
  }
  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    emit(diagnostics, display, closeLine, 'frontmatter must be a YAML mapping');
    return;
  }
  const fm = parsed as Record<string, unknown>;

  // Helper: locate the source line of a top-level key. Returns 0 (sentinel)
  // when the key is absent — the caller should fall back to `closeLine`.
  const keyLineOf = (key: string): number => {
    const re = new RegExp(`^${key}:`);
    for (let i = 1; i < closeIdx; i += 1) {
      if (re.test(lines[i])) return i + 1;
    }
    return 0;
  };

  // 4. Required keys.
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(fm, key)) {
      emit(diagnostics, display, closeLine, `missing required key '${key}'`);
    }
  }
  const hasAtLeastOne = REQUIRED_AT_LEAST_ONE.some((k) =>
    Object.prototype.hasOwnProperty.call(fm, k),
  );
  if (!hasAtLeastOne) {
    emit(
      diagnostics,
      display,
      closeLine,
      `missing required key — must declare at least one of '${REQUIRED_AT_LEAST_ONE.join("', '")}'`,
    );
  }

  // 5. name matches filename slug.
  if (typeof fm.name === 'string') {
    const expectedSlug = filenameSlug(absolute);
    if (fm.name !== expectedSlug) {
      emit(
        diagnostics,
        display,
        keyLineOf('name') || closeLine,
        `name '${fm.name}' does not match filename slug '${expectedSlug}'`,
      );
    }
  } else if (Object.prototype.hasOwnProperty.call(fm, 'name')) {
    emit(diagnostics, display, keyLineOf('name') || closeLine, "key 'name' must be a string");
  }

  // 6. model is a non-empty string.
  if (Object.prototype.hasOwnProperty.call(fm, 'model')) {
    if (typeof fm.model !== 'string' || fm.model.trim() === '') {
      emit(
        diagnostics,
        display,
        keyLineOf('model') || closeLine,
        "key 'model' must be a non-empty string",
      );
    }
  }

  // 7. Body has ≥1 non-empty line after closing `---`.
  const body = lines.slice(closeIdx + 1);
  const hasBody = body.some((l) => l.trim().length > 0);
  if (!hasBody) {
    emit(diagnostics, display, closeLine, 'frontmatter has no body — body must contain at least one non-empty line');
  }
}

// --- Main ------------------------------------------------------------------

const diagnostics: Diagnostic[] = [];
let scanned = 0;
for (const t of targets) {
  if (!existsSync(t)) {
    emit(diagnostics, relPath(t), 1, 'file not found');
    continue;
  }
  scanned += 1;
  validateFile(t, diagnostics);
}

if (diagnostics.length > 0) {
  for (const d of diagnostics) {
    console.error(`${d.file}:${d.line}: ${d.reason}`);
  }
  console.error(
    `check-agent-frontmatter: ${diagnostics.length} violation(s) across ${scanned} file(s) — Claude Code's agent registry will silently reject affected files.`,
  );
  process.exit(1);
}

console.log(`check-agent-frontmatter: ${scanned} agent file(s) ok.`);
process.exit(0);
