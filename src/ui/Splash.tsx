// src/ui/Splash.tsx
//
// Entry / identity panel for CAM Runtime. Inside a rounded border:
//   1. Uppercase "CAM" block wordmark, letter-by-letter (C / A / M), rendered
//      in the CAM Runtime brand primary (Fir Green, `brandGreens.firGreen` in
//      `src/design/tokens.ts`) rather than the chrome `palette.accent`. The
//      wordmark rows are composed programmatically from per-letter glyph
//      grids (`LETTER_C` / `LETTER_A` / `LETTER_M`) so every row is
//      guaranteed the same width.
//   2. A styled "Runtime" line directly under the wordmark, also in Fir
//      Green, so the panel reads as the "CAM Runtime" brand identity.
//   3. Two-line tagline ("Autonomous Claude Code loop" / "powered by your
//      subscription").
//   4. Version + repo URL line.
//
// Hardcoded panel width (54 cells) keeps the box square-ish regardless of
// terminal size, matching the OPENCODE/Hermes-Agent reference plates the
// design draws from.

import type { ReactElement } from 'react';
import { Box, Text } from 'ink';

import { colors } from './theme.ts';
import { brandGreens } from '../design/tokens.ts';

/** Single letter glyph: 5 rows x 5 columns, `█` = ink, space = background. */
const LETTER_C = ['█████', '█    ', '█    ', '█    ', '█████'] as const;
const LETTER_A = [' ███ ', '█   █', '█████', '█   █', '█   █'] as const;
const LETTER_M = ['█   █', '██ ██', '█ █ █', '█   █', '█   █'] as const;

/**
 * Uppercase "CAM" wordmark, composed row-by-row from the per-letter glyphs
 * above with a single-space gap between letters. Composing programmatically
 * (rather than hand-typing each full row) guarantees every row is the same
 * width, which is what keeps the panel's `alignItems="center"` centering the
 * wordmark evenly.
 */
const WORDMARK_ROWS = LETTER_C.map(
	(row, i) => `${row} ${LETTER_A[i]} ${LETTER_M[i]}`,
);

/**
 * Outer width (cells) of the bordered panel. Wide enough for the tagline
 * lines (the widest content); the narrower wordmark and "Runtime" line are
 * centered inside it.
 */
const PANEL_WIDTH = 53;

export interface SplashProps {
	version: string;
	url?: string;
	tagline?: readonly [string, string];
}

const DEFAULT_TAGLINE: readonly [string, string] = [
	'Autonomous Claude Code loop',
	'powered by your subscription',
];

/**
 * Render a single wordmark row as a sequence of colored runs. Adjacent
 * characters of the same kind (`█` / space) collapse into one <Text> span so
 * the output stays tidy and Ink doesn't insert spurious resets between every
 * glyph.
 */
function WordmarkRow({ row }: { row: string }): ReactElement {
	const segments: { text: string; kind: 'block' | 'space' }[] = [];
	let current = '';
	let kind: 'block' | 'space' | null = null;
	for (const ch of row) {
		const next = ch === '█' ? 'block' : 'space';
		if (next !== kind) {
			if (current) segments.push({ text: current, kind: kind! });
			current = ch;
			kind = next;
		} else {
			current += ch;
		}
	}
	if (current && kind) segments.push({ text: current, kind });

	return (
		<Text>
			{segments.map((seg, i) => {
				if (seg.kind === 'block') {
					return (
						<Text key={i} color={brandGreens.firGreen}>
							{seg.text}
						</Text>
					);
				}
				return <Text key={i}>{seg.text}</Text>;
			})}
		</Text>
	);
}

export function Splash({
	version,
	url = 'eduardocaminha/cam-cli',
	tagline = DEFAULT_TAGLINE,
}: SplashProps): ReactElement {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={brandGreens.firGreen}
			paddingX={2}
			paddingY={1}
			width={PANEL_WIDTH}
			alignItems="center"
		>
			{/*
			 * Render each wordmark row as a direct child of the panel so the
			 * panel's `alignItems="center"` centers every row by its own width.
			 */}
			{WORDMARK_ROWS.map((row, i) => (
				<WordmarkRow key={i} row={row} />
			))}
			<Text bold color={brandGreens.firGreen}>
				Runtime
			</Text>
			<Box marginTop={1} flexDirection="column" alignItems="center">
				<Text>{tagline[0]}</Text>
				<Text color={colors.muted}>{tagline[1]}</Text>
				<Text color={colors.muted}>
					v{version} · {url}
				</Text>
			</Box>
		</Box>
	);
}
