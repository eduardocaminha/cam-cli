// test/release/changelog-hygiene.test.ts
//
// Hygiene regression guard for the live CHANGELOG.md (repo root). Locks the
// single-[Unreleased] invariant so a future `cam ship --bump` roll (or a
// hand-edit) cannot silently reintroduce a duplicate or stale [Unreleased]
// heading. See US-002 (CAM-98/PR-98): the live file was found corrupted
// (intro prose had swallowed the real heading; a stale bottom [Unreleased]
// section from an already-shipped release had never been cleaned up).
//
// US-002 (PR-98).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHANGELOG_PATH = join(import.meta.dir, '..', '..', 'CHANGELOG.md');

function readChangelog(): string {
  return readFileSync(CHANGELOG_PATH, 'utf8');
}

describe('CHANGELOG.md hygiene', () => {
  test('contains exactly one line-anchored [Unreleased] heading', () => {
    const content = readChangelog();
    const matches = content.match(/^## \[Unreleased\][ \t]*$/gm) ?? [];
    expect(matches.length).toBe(1);
  });

  test('the [Unreleased] heading precedes the first versioned heading', () => {
    const content = readChangelog();
    const lines = content.split('\n');
    const unreleasedIdx = lines.findIndex((line) => /^## \[Unreleased\][ \t]*$/.test(line));
    const versionedIdx = lines.findIndex((line) => /^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}/.test(line));

    expect(unreleasedIdx).toBeGreaterThanOrEqual(0);
    expect(versionedIdx).toBeGreaterThan(unreleasedIdx);
  });

  test('no [Unreleased] heading appears after any versioned heading (no stale bottom section)', () => {
    const content = readChangelog();
    const lines = content.split('\n');
    const firstVersionedIdx = lines.findIndex((line) => /^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}/.test(line));

    expect(firstVersionedIdx).toBeGreaterThanOrEqual(0);

    const tail = lines.slice(firstVersionedIdx + 1);
    const staleUnreleased = tail.some((line) => /^## \[Unreleased\][ \t]*$/.test(line));
    expect(staleUnreleased).toBe(false);
  });

  test('the intro prose line does not end with a dangling [Unreleased] fragment', () => {
    const content = readChangelog();
    const lines = content.split('\n');
    const formatLine = lines.find((line) => line.startsWith('Format:'));

    expect(formatLine).toBeDefined();
    expect(formatLine).not.toMatch(/## \[Unreleased\]\s*$/);
    // Must not itself start a heading line.
    expect(formatLine?.startsWith('## ')).toBe(false);
  });
});
