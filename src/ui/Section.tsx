// src/ui/Section.tsx
//
// Layout primitive shared by every cam screen: a heading line, a horizontal
// rule, and an indented content block. Centralizing the pattern means the
// indent (2 cols heading / 4 cols content), the divisor width (50 cols), and
// the divisor color semantics (muted | accentFg | destructiveFg) stay in one
// place — every screen that uses Section automatically matches the target
// snapshot in `img/ui-snapshot.txt`.

import type { ReactElement, ReactNode } from 'react';
import { Box, Text } from 'ink';

import { DIVIDER, layout } from '../design/tokens.ts';
import { colors } from './theme.ts';

export type SectionTone = 'default' | 'accent' | 'destructive';

interface SectionProps {
	heading: string;
	/** Color of the rule under the heading. `default` = muted, `accent` =
	 *  success states ("All set", "Init complete"), `destructive` = failures. */
	tone?: SectionTone;
	children: ReactNode;
	/** Vertical gap before this section. Defaults to 1 (one blank line). */
	gapTop?: number;
	/** Override the rule width (cells). Defaults to `layout.dividerWidth` (50).
	 *  Narrow hosts (e.g. the dashboard's ~36-col tmux pane) pass a smaller
	 *  width so the rule fits the pane instead of wrapping onto a second line. */
	dividerWidth?: number;
}

function dividerColor(tone: SectionTone): string {
	switch (tone) {
		case 'accent':
			return colors.accent;
		case 'destructive':
			return colors.destructive;
		default:
			return colors.muted;
	}
}

export function Section({ heading, tone = 'default', children, gapTop = 1, dividerWidth }: SectionProps): ReactElement {
	const rule = dividerWidth === undefined ? DIVIDER : '─'.repeat(Math.max(1, dividerWidth));
	return (
		<Box flexDirection="column" marginTop={gapTop}>
			<Box paddingLeft={layout.headingIndent}>
				<Text bold>{heading}</Text>
			</Box>
			<Box paddingLeft={layout.headingIndent}>
				<Text color={dividerColor(tone)}>{rule}</Text>
			</Box>
			<Box flexDirection="column" paddingLeft={layout.contentIndent}>
				{children}
			</Box>
		</Box>
	);
}
