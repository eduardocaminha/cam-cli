#!/usr/bin/env node
// scripts/smoke/check-agent-frontmatter.ts
//
// WHY THIS SMOKE EXISTS
// ---------------------
// Claude Code's agent loader rejects .claude/agents/*.md files whose YAML
// frontmatter is malformed, missing required keys, or whose `name:` value
// disagrees with the filename slug. The rejection is silent -- the agent
// never appears in the registry, and Task(subagent_type="X") fails with
// "agent type 'X' not found". The trailing-LF check at check-agent-files.sh
// catches one specific byte-level regression class; this file catches the
// structural-frontmatter regression class.
//
// Validations per file (.claude/agents/*.md, excluding _archive/):
//   1. Trailing LF byte (defense-in-depth -- primary check is check-agent-files.sh).
//   2. Frontmatter is delimited by `---` lines at top + closing.
//   3. Frontmatter parses as a simple YAML mapping (hand-rolled zero-dep parser;
//      see parseFrontmatter below -- no js-yaml, no bare-specifier imports).
//   4. Required top-level keys: name, description, model, plus at least one of
//      (tools, disallowedTools).
//   5. `name` value matches the filename slug (e.g. prd-implementer.md -> name: prd-implementer).
//   6. `model` is a non-empty string.
//   7. Body has at least one non-empty line after the closing `---`.
//
// Exit codes:
//   0 -- every file scanned passes
//   1 -- at least one file violates a rule (gcc-style diagnostics on stderr)
//   2 -- environmental error (not in a git repo, agents dir missing)
//
// Diagnostic format: `<file>:<line>: <reason>` (gcc-style -- IDE-jumpable). When
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
//   - docs/runbooks/cam-loop-recovery.md (manual diagnostic)
//
// CAM-69: rewritten to zero npm dependencies (hand-rolled frontmatter parser
// replaces js-yaml so `bun` can run this script from a tmpdir without a
// node_modules directory present).

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import process from 'node:process';

// --- Hand-rolled frontmatter parser (zero runtime deps, replaces js-yaml) ---
//
// Parser scope:
//   - Top-level `key: scalar` pairs (unquoted, single-quoted, or double-quoted
//     strings; integers; floats; booleans; null).
//   - Simple block-sequence lists: lines matching `^  - <item>$` directly under
//     a key that has an empty value (tools:/disallowedTools: pattern).
//   - Blank lines are skipped.
//
// Anything outside that scope (block scalars, nested mappings, anchors, etc.)
// returns a parse error with the offending 0-indexed line number within the
// frontmatter text. The caller adds +2 to convert to a 1-indexed file line
// (matching the old js-yaml mark.line + 2 semantics).

interface ParseOk {
  ok: true;
  data: Record<string, unknown>;
}
interface ParseErr {
  ok: false;
  /** 0-indexed line number within the frontmatter text. Add +2 for file line. */
  line: number;
  reason: string;
}

function parseScalarValue(raw: string): unknown {
  // Quoted string (double or single): strip delimiters, return as string.
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  // Boolean
  if (raw === 'true' || raw === 'True' || raw === 'TRUE') return true;
  if (raw === 'false' || raw === 'False' || raw === 'FALSE') return false;
  // Null
  if (raw === 'null' || raw === 'Null' || raw === 'NULL' || raw === '~') return null;
  // Integer
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  // Float
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  // Unquoted string (default)
  return raw;
}

function parseFrontmatter(text: string): ParseOk | ParseErr {
  const lines = text.split('\n');
  const data: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Skip blank / all-whitespace lines.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Must be a top-level key: value pair (no leading whitespace).
    const kvMatch = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kvMatch) {
      return {
        ok: false,
        line: i,
        reason: `unexpected structure -- cannot parse: ${JSON.stringify(line)}`,
      };
    }

    const key = kvMatch[1] ?? '';
    const rest = (kvMatch[2] ?? '').trimEnd();

    if (rest === '') {
      // Empty value: check for a following block sequence (`  - item` lines).
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? '';
        const seqMatch = /^  - (.*)$/.exec(next);
        if (seqMatch) {
          items.push((seqMatch[1] ?? '').trim());
          j++;
        } else {
          break;
        }
      }
      if (j > i + 1) {
        // Block sequence captured.
        data[key] = items;
        i = j;
      } else {
        // Null scalar.
        data[key] = null;
        i++;
      }
    } else if (rest[0] === '|' || rest[0] === '>') {
      // Block scalar (literal/folded) -- not supported in agent frontmatter.
      return {
        ok: false,
        line: i,
        reason: `unsupported YAML block scalar at key '${key}' -- use a plain or quoted single-line string`,
      };
    } else {
      data[key] = parseScalarValue(rest);
      i++;
    }
  }

  return { ok: true, data };
}

// --- Repo discovery --------------------------------------------------------

let repoRoot: string;
try {
  // Ignore git's own stderr: outside a git repo it writes a raw
  // "fatal: not a git repository" line that would otherwise surface as the
  // skip diagnostic in `cam init` (CAM-46). We emit our own clean message below.
  repoRoot = execSync('git rev-parse --show-toplevel', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  console.error('check-agent-frontmatter: not inside a git repo.');
  process.exit(2);
}

const AGENT_DIR = join(repoRoot, '.claude/agents');
if (!existsSync(AGENT_DIR)) {
  // No agents dir -- fresh repo / new clone, nothing to validate.
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
  // Walk top-level .md only -- _archive/ and other subdirs are skipped by design
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
    emit(diagnostics, display, 1, `cannot read file -- ${(err as Error).message}`);
    return;
  }

  // 1. Trailing LF (defense-in-depth -- check-agent-files.sh is the primary check).
  if (!raw.endsWith('\n')) {
    emit(diagnostics, display, Math.max(1, raw.split('\n').length), 'missing trailing LF');
    // Continue -- frontmatter checks still meaningful even without trailing LF.
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

  // 3. Hand-rolled YAML parse. parseFrontmatter returns a 0-indexed line within
  // the frontmatter text on error; add +2 to convert to a 1-indexed file line
  // (frontmatter starts at line 2, i.e. one after the opening `---`), matching
  // the old js-yaml mark.line + 2 semantics.
  const parseResult = parseFrontmatter(frontmatterText);
  if (!parseResult.ok) {
    const offset = parseResult.line + 2;
    emit(diagnostics, display, offset, `malformed YAML -- ${parseResult.reason}`);
    return;
  }
  const fm = parseResult.data;

  if (Object.keys(fm).length === 0 && frontmatterText.trim() === '') {
    emit(diagnostics, display, closeLine, 'frontmatter must be a YAML mapping');
    return;
  }

  // Helper: locate the source line of a top-level key. Returns 0 (sentinel)
  // when the key is absent -- the caller should fall back to `closeLine`.
  const keyLineOf = (key: string): number => {
    const re = new RegExp(`^${key}:`);
    for (let i = 1; i < closeIdx; i += 1) {
      if (re.test(lines[i] ?? '')) return i + 1;
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
      `missing required key -- must declare at least one of '${REQUIRED_AT_LEAST_ONE.join("', '")}'`,
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

  // 7. Body has >= 1 non-empty line after closing `---`.
  const body = lines.slice(closeIdx + 1);
  const hasBody = body.some((l) => l.trim().length > 0);
  if (!hasBody) {
    emit(diagnostics, display, closeLine, 'frontmatter has no body -- body must contain at least one non-empty line');
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
    `check-agent-frontmatter: ${diagnostics.length} violation(s) across ${scanned} file(s) -- Claude Code's agent registry will silently reject affected files.`,
  );
  process.exit(1);
}

console.log(`check-agent-frontmatter: ${scanned} agent file(s) ok.`);
process.exit(0);
