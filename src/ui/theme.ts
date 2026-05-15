// src/ui/theme.ts
//
// cam-cli terminal palette — the minimal 4-token set that maps cleanly to
// Ink's <Text color> prop on both dark and light terminals. Reverted from
// the experimental 12-token `cliDarkTheme` because that dark-only palette
// (white body, very dark shadow) was invisible on light-bg terminals.
//
// Mapping (token → role in the TUI):
//   accent      success ✓, spinner, focused row, wordmark body, divisor on
//               success Sections
//   warning     soft warnings (skipped smokes, version-floor mismatches)
//   destructive hard errors (✗), failure-section divisor
//   muted       structural lines (panel borders, section divisors), pending
//               indicators, descriptions, hints, version strings, wordmark
//               shadow

export const colors = {
	accent: '#4EBE7D',
	warning: '#FFCB1F',
	destructive: '#F25F5C',
	muted: '#808080',
} as const;

export type ThemeColor = keyof typeof colors;
