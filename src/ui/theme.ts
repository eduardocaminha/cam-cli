// src/ui/theme.ts
//
// Ink-side view of the shared palette. The actual hex values live in
// `src/design/tokens.ts` (the one design-system both render paths derive
// from); this module just re-exports them under the `colors` name that the
// Ink components already consume via `<Text color={colors.x}>`.
//
// Mapping (token → role in the TUI):
//   accent      success ✓, live ●, spinner, focused row, wordmark body,
//               divisor on success Sections
//   warning     soft warnings (skipped smokes, paused loop)
//   destructive hard errors (✗), failure-section divisor
//   muted       structural lines (panel borders, section divisors), pending
//               ◌, descriptions, hints, version strings, wordmark shadow

import { palette } from '../design/tokens.ts';

export const colors = palette;
