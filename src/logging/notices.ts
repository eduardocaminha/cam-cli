/**
 * Shared operator-facing notice strings.
 *
 * Defined in a leaf module (no deps on setup.ts or config.ts) so both
 * src/commands/setup.ts and src/commands/config.ts can import without a
 * circular dependency.
 */

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
 * writeFn defaults to process.stdout.write so callers can inject a
 * capture function in unit tests without monkey-patching the global.
 */
export function printAutomergeNotice(
  writeFn: (s: string) => void = (s) => process.stdout.write(s),
): void {
  writeFn(`  ${AUTOMERGE_NOTICE}\n`);
}
