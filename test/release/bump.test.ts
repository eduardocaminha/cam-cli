import { test, expect, describe } from 'bun:test';
import { classifyBump } from '../../src/release/bump';
import type { BumpLevel } from '../../src/release/bump';

// ---------------------------------------------------------------------------
// Single-subject table
// Each row: [subject, expectedBumpLevel]
// ---------------------------------------------------------------------------
const singleSubjectCases: Array<[string, BumpLevel]> = [
  // feat (minor)
  ['feat: add new login screen', 'minor'],
  ['feat: allow empty subject', 'minor'],

  // fix (patch)
  ['fix: correct off-by-one in parser', 'patch'],
  ['fix: handle null response gracefully', 'patch'],

  // scoped feat (minor)
  ['feat(auth): add OAuth2 support', 'minor'],
  ['feat(ui): redesign settings panel', 'minor'],

  // scoped fix (patch)
  ['fix(api): retry on 429 status code', 'patch'],
  ['fix(cli): remove extra newline on exit', 'patch'],

  // breaking bang on feat (major)
  ['feat!: remove legacy v1 endpoint', 'major'],

  // breaking bang on fix (major)
  ['fix!: change config key from token to api_key', 'major'],

  // scoped breaking bang (major)
  ['feat(scope)!: rename export classifyBump -> bumpFromSubjects', 'major'],

  // BREAKING CHANGE token in subject (major) -- from a squashed footer line
  ['fix: update config BREAKING CHANGE: removed old field', 'major'],
  ['feat: new scheduler BREAKING CHANGE: drops Node 16 support', 'major'],

  // no-bump types
  ['chore: update lockfile', 'none'],
  ['docs: add architecture diagram', 'none'],
  ['test: add unit tests for parser', 'none'],
  ['refactor: extract helper function', 'none'],
  ['style: fix inconsistent indentation', 'none'],
  ['ci: pin GitHub Actions to sha', 'none'],
  ['build: upgrade bun to 1.3', 'none'],
  ['perf: cache DNS lookups', 'none'],

  // scoped no-bump (chore(cam) pattern)
  ['chore(cam): plan CAM-89 (conventional-commits version bump)', 'none'],
  ['chore(deps): bump typescript from 5.4 to 5.5', 'none'],
  ['docs(readme): update installation instructions', 'none'],

  // CAM-NNN fallthrough (free-text style subject, no conventional-commit type prefix)
  ['CAM-91: orchestrator Task/Agent allowlist via PreToolUse hook', 'none'],
  ['CAM-89: implement version bump parser', 'none'],

  // free-text fallthrough (plain prose, not a conventional commit)
  ['initial commit', 'none'],
  ['WIP', 'none'],
  ['fixup: missed edge case', 'none'],
  ['Merge branch main into feature/xyz', 'none'],
];

describe('classifyBump — single subject', () => {
  for (const [subject, expected] of singleSubjectCases) {
    test(`"${subject}" -> ${expected}`, () => {
      expect(classifyBump([subject])).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-subject "highest level wins" table
// ---------------------------------------------------------------------------
const multiSubjectCases: Array<[string[], BumpLevel, string]> = [
  [
    ['fix: patch this', 'feat: add that'],
    'minor',
    'feat outranks fix',
  ],
  [
    ['feat: new flag', 'feat!: breaking rename', 'fix: small fix'],
    'major',
    'feat! outranks feat and fix',
  ],
  [
    ['chore: update deps', 'docs: improve readme'],
    'none',
    'all no-bump',
  ],
  [
    ['chore: update deps', 'fix: edge case'],
    'patch',
    'fix beats chore',
  ],
  [
    ['CAM-91: orchestrator Task/Agent allowlist via PreToolUse hook', 'feat: add login'],
    'minor',
    'feat beats CAM-NN fallthrough',
  ],
  [
    ['fix: correct crash', 'fix(scope): another fix'],
    'patch',
    'two patches stay patch',
  ],
  [
    ['feat: add API', 'feat(scope): another feature'],
    'minor',
    'two minors stay minor',
  ],
  [
    // BREAKING CHANGE token beats a plain feat
    ['feat: add scheduler', 'chore: bump BREAKING CHANGE: removed node 14'],
    'major',
    'BREAKING CHANGE token wins',
  ],
];

describe('classifyBump — multi-subject highest-wins', () => {
  for (const [subjects, expected, label] of multiSubjectCases) {
    test(label, () => {
      expect(classifyBump(subjects)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('classifyBump — edge cases', () => {
  test('empty array returns none', () => {
    expect(classifyBump([])).toBe('none');
  });

  test('does not throw on empty string subject', () => {
    expect(() => classifyBump([''])).not.toThrow();
    expect(classifyBump([''])).toBe('none');
  });

  test('does not throw on subjects with special characters', () => {
    expect(() => classifyBump(['feat: add emoji 🚀 support'])).not.toThrow();
  });

  test('feat! without a description still classified as major', () => {
    expect(classifyBump(['feat!: '])).toBe('major');
  });

  test('short-circuits at major (stops scanning after first major)', () => {
    // Even if there are many subjects after the major, result must be major.
    const subjects = [
      'feat!: breaking change',
      ...Array.from({ length: 50 }, (_, i) => `fix: fix #${i}`),
    ];
    expect(classifyBump(subjects)).toBe('major');
  });
});
