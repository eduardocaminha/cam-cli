// src/ui/theme.ts
//
// cam-cli terminal palette — derived from the reporter design system v2
// (`reporter/.claude/skills/reporter-design-system-v2/tokens.css`). OKLCH
// source values are translated to hex for Ink's <Text color> prop. Ink picks
// the nearest ANSI 256 color on terminals that don't support truecolor, so
// the hex acts as a high-fidelity hint, not a hard constraint.
//
// Mapping (token → role in the TUI):
//   accent      → success ✓, spinner while running, focus indicator in Select,
//                 the `cam` wordmark in headers
//   warning     → soft warnings (skipped smokes, version-floor mismatches)
//   destructive → hard errors ✗
//   muted       → pending ◌, hints, sublines

export const colors = {
	accent: '#4EBE7D',
	warning: '#FFCB1F',
	destructive: '#F25F5C',
	muted: '#808080',
} as const;

export type ThemeColor = keyof typeof colors;
