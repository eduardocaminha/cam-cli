// src/ui/Splash.tsx
//
// Entry / identity panel for cam-cli. Three rows inside a rounded border:
//   1. Lowercase "cam" wordmark — bold `█` outline (--foreground) plus a
//      hatched `░` shadow rendered in --muted, so the two-tone effect from
//      the target mock in `img/ui-snapshot.txt` lines up. The split into
//      per-character runs is done by `coloredRow` below.
//   2. Two-line tagline ("Autonomous Claude Code loop" / "powered by your
//      subscription").
//   3. Version + repo URL line.
//
// Hardcoded panel width (54 cells) keeps the box square-ish regardless of
// terminal size, matching the OPENCODE/Hermes-Agent reference plates the
// design draws from.

import type { ReactElement } from 'react';
import { Box, Text } from 'ink';

import { colors } from './theme.ts';

/**
 * Five-line lowercase "cam" wordmark. `█` characters are the letter outline
 * (rendered in --foreground); `░` characters are the hatched shadow (rendered
 * in --muted). Spaces stay as gaps. Every row is the same width (29 cells)
 * so the panel padding stays even.
 */
const WORDMARK_ROWS = [
	'██████░  ██████░  ██░ ██░ ██░',
	'██░░░░░  ██░░░██░  ██████████░',
	'██░      ██░  ██░  ██░ ██░ ██░',
	'██░      ██░ ███░  ██░ ██░ ██░',
	'██████░  ████░██░ ██░ ██░ ██░',
] as const;

/**
 * Outer width (cells) of the bordered panel. Picked so the 29-cell rows
 * (rows 1 and 5) get 11 cells of horizontal padding on each side, and the
 * 30-cell rows (rows 2-4) get 10/11 — matching the target in
 * `img/ui-snapshot.txt`.
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
 * characters of the same kind (`█` / `░` / space) collapse into one <Text>
 * span so the output stays tidy and Ink doesn't insert spurious resets
 * between every glyph.
 */
function WordmarkRow({ row }: { row: string }): ReactElement {
	const segments: { text: string; kind: 'block' | 'shade' | 'space' }[] = [];
	let current = '';
	let kind: 'block' | 'shade' | 'space' | null = null;
	for (const ch of row) {
		const next = ch === '█' ? 'block' : ch === '░' ? 'shade' : 'space';
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
						<Text key={i} color={colors.accent}>
							{seg.text}
						</Text>
					);
				}
				if (seg.kind === 'shade') {
					return (
						<Text key={i} color={colors.accent}>
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
			borderColor={colors.muted}
			paddingX={2}
			paddingY={1}
			width={PANEL_WIDTH}
			alignItems="center"
		>
			{/*
			 * Render each wordmark row as a direct child of the panel so the
			 * panel's `alignItems="center"` centers every row by its own width.
			 * Rows 1 and 5 (29 cells) get an extra leading space compared to
			 * rows 2-4 (30 cells), producing the staggered shape from the
			 * target mock.
			 */}
			{WORDMARK_ROWS.map((row, i) => (
				<WordmarkRow key={i} row={row} />
			))}
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
