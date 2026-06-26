/**
 * Deterministic Conventional-Commits bump classifier.
 *
 * Classifies a list of commit subjects to the highest semver bump level.
 * Pure regex; no model, no subagent, no external dependencies.
 *
 * The returned level is the raw SIGNAL:
 *   - 'major' = breaking change (feat!, fix!, BREAKING CHANGE: token)
 *   - 'minor' = feat (new feature, non-breaking)
 *   - 'patch' = fix (bug fix, non-breaking)
 *   - 'none'  = no user-visible change (chore, docs, refactor, etc.) or
 *               unrecognized subject (never throws)
 *
 * 0.x demotion (major -> minor for pre-1.0 versions) is NOT applied here;
 * that mapping lives in computeNextVersion (US-002).
 */

export type BumpLevel = 'major' | 'minor' | 'patch' | 'none';

/**
 * Matches any conventional-commit type with a breaking-change bang before the colon.
 * Examples: feat!:  fix!:  feat(scope)!:  chore(deps)!:
 */
const BREAKING_BANG_RE = /^[a-z]+(?:\([^)]*\))?!:/;

/**
 * Matches feat: or feat(<scope>):  (no bang).
 */
const FEAT_RE = /^feat(?:\([^)]*\))?:/;

/**
 * Matches fix: or fix(<scope>):  (no bang).
 */
const FIX_RE = /^fix(?:\([^)]*\))?:/;

/** Numeric order for bump levels (higher index = higher priority). */
const BUMP_RANK: Record<BumpLevel, number> = {
  none: 0,
  patch: 1,
  minor: 2,
  major: 3,
};

function classifySubject(subject: string): BumpLevel {
  // Breaking change: bang syntax OR literal BREAKING CHANGE: token anywhere in the subject.
  // Subjects come from `git log --pretty=%s` (single line), so BREAKING CHANGE: may appear
  // as an inline token when the author squashes the footer into the subject.
  if (BREAKING_BANG_RE.test(subject) || subject.includes('BREAKING CHANGE:')) {
    return 'major';
  }
  if (FEAT_RE.test(subject)) {
    return 'minor';
  }
  if (FIX_RE.test(subject)) {
    return 'patch';
  }
  return 'none';
}

/**
 * Classifies a list of commit subjects to the single highest bump level.
 *
 * Empty input returns 'none'.
 * Unrecognized subjects (free-text, CAM-NNN prefix, etc.) return 'none' silently.
 */
export function classifyBump(subjects: string[]): BumpLevel {
  let highest: BumpLevel = 'none';
  for (const subject of subjects) {
    const level = classifySubject(subject);
    if (BUMP_RANK[level] > BUMP_RANK[highest]) {
      highest = level;
    }
    // Short-circuit: major is the ceiling.
    if (highest === 'major') break;
  }
  return highest;
}
