// src/ui/TabBar.tsx
//
// Horizontal chip-style tab bar. Renders one chip per provided tab; the
// active chip is highlighted (accent + bold), and a confirmed tab shows its
// chosen value alongside the label ("Label: value") so an operator can see
// progress across tabs without leaving the current one.
//
// Pure controlled presentational primitive: `activeIndex` + `onChange` live
// in the caller, not in local state. Left/Right moves the active tab
// (wrap-around at the bounds, mirroring the Select.tsx up/down idiom) by
// calling `onChange` with the next index; the caller re-renders with the new
// `activeIndex`. This keeps TabBar itself state-free so ConfigScreen (US-004)
// owns the keypress lifecycle end to end.

import type { ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';

import { colors } from './theme.ts';

export interface TabDef {
	/** Tab label, always rendered. */
	label: string;
	/** True once the operator has confirmed a value for this tab. */
	confirmed?: boolean;
	/** Chosen value rendered alongside the label when `confirmed` is true. */
	value?: string;
}

interface TabBarProps {
	tabs: readonly TabDef[];
	activeIndex: number;
	onChange: (index: number) => void;
}

export function TabBar({ tabs, activeIndex, onChange }: TabBarProps): ReactElement {
	useInput((_input, key) => {
		if (tabs.length === 0) return;
		if (key.leftArrow) {
			onChange(activeIndex === 0 ? tabs.length - 1 : activeIndex - 1);
		} else if (key.rightArrow) {
			onChange(activeIndex === tabs.length - 1 ? 0 : activeIndex + 1);
		}
	});

	return (
		<Box flexDirection="row">
			{tabs.map((tab, i) => (
				<TabChip
					key={tab.label}
					tab={tab}
					active={i === activeIndex}
					isLast={i === tabs.length - 1}
				/>
			))}
		</Box>
	);
}

function TabChip({
	tab,
	active,
	isLast,
}: {
	tab: TabDef;
	active: boolean;
	isLast: boolean;
}): ReactElement {
	const text = tab.confirmed && tab.value !== undefined ? `${tab.label}: ${tab.value}` : tab.label;
	return (
		<Box marginRight={isLast ? 0 : 1}>
			<Text color={active ? colors.accent : colors.muted} bold={active}>
				[ {text} ]
			</Text>
		</Box>
	);
}
