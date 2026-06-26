/**
 * Shared operator-facing notice strings.
 *
 * Defined in a leaf module (no deps on setup.ts or config.ts) so both
 * src/commands/setup.ts and src/commands/config.ts can import without a
 * circular dependency.
 */

import { printHint } from './color.ts';

/**
 * Operator notice for the auto-merge prerequisite.
 * Printed unconditionally at cam init completion and referenced in config
 * confirmation output (US-003).
 */
export const AUTOMERGE_NOTICE =
  "GitHub prerequisite: in Settings > General > Pull Requests, enable both 'Allow auto-merge' and 'Allow squash merging' so cam ship can auto-merge PRs.";

/**
 * Print the auto-merge prerequisite notice.
 *
 * writeFn defaults to printHint (from color.ts), which is quiet-gated:
 * the notice is suppressed when quiet mode is active (setQuiet(true)).
 * Callers can inject a capture function in unit tests without
 * monkey-patching the global.
 */
export function printAutomergeNotice(
  writeFn: (s: string) => void = printHint,
): void {
  writeFn(AUTOMERGE_NOTICE);
}
