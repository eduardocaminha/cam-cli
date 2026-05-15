// src/ui/Select.tsx
//
// Keyboard-driven option list. Layout follows the target mock in
// `img/ui-snapshot.txt`:
//
//     ❯ Existing project   This folder already has code.
//       New project        Empty folder, scaffold from scratch.
//
//       ↑/↓ move · enter select · esc cancel
//
// Label + description share a single row (description in mutedForeground
// after a fixed-width label column). On the focused row, the cursor (`❯`)
// and label use --accentFg + bold; the description stays mutedForeground so
// the eye lands on the label first.
//
// `confirmed` flips the whole component into a single-line "✓ {label}"
// summary — callers in a wizard use this to keep the chosen answer visible
// above the next question.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';

import { colors } from './theme.ts';

export interface SelectOption<T extends string> {
	value: T;
	label: string;
	description?: string;
}

interface SelectProps<T extends string> {
	question: string;
	options: readonly SelectOption<T>[];
	defaultValue?: T;
	confirmed?: boolean;
	confirmedValue?: T;
	/**
	 * Width of the label column (in cells). Picks based on the longest label
	 * across `options` plus a small gap. Override when you know the visual
	 * grouping should match a sibling Select (e.g. issue-system options should
	 * share the column width with project-mode options).
	 */
	labelColumnWidth?: number;
	onChange: (value: T) => void;
	onCancel?: () => void;
}

function computeLabelColumnWidth<T extends string>(options: readonly SelectOption<T>[]): number {
	const longest = options.reduce((max, o) => Math.max(max, o.label.length), 0);
	return longest + 3; // small gap before description
}

export function Select<T extends string>({
	question,
	options,
	defaultValue,
	confirmed = false,
	confirmedValue,
	labelColumnWidth,
	onChange,
	onCancel,
}: SelectProps<T>): ReactElement {
	const initialIdx = (() => {
		if (defaultValue !== undefined) {
			const found = options.findIndex((o) => o.value === defaultValue);
			if (found !== -1) return found;
		}
		return 0;
	})();
	const [idx, setIdx] = useState(initialIdx);

	useInput((input, key) => {
		if (confirmed) return;
		if (key.upArrow || input === 'k') {
			setIdx((i) => (i === 0 ? options.length - 1 : i - 1));
		} else if (key.downArrow || input === 'j') {
			setIdx((i) => (i === options.length - 1 ? 0 : i + 1));
		} else if (key.return) {
			onChange(options[idx]!.value);
		} else if (key.escape && onCancel) {
			onCancel();
		}
	});

	if (confirmed) {
		const chosen = options.find((o) => o.value === confirmedValue) ?? options[idx]!;
		return (
			<Box flexDirection="column">
				<Box flexDirection="row">
					<Text color={colors.accent}>✓ </Text>
					<Text color={undefined}>{chosen.label}</Text>
				</Box>
				{chosen.description ? (
					<Box paddingLeft={2}>
						<Text color={colors.muted}>{chosen.description}</Text>
					</Box>
				) : null}
			</Box>
		);
	}

	const colWidth = labelColumnWidth ?? computeLabelColumnWidth(options);

	return (
		<Box flexDirection="column">
			<Text color={undefined}>{question}</Text>
			<Box flexDirection="column" marginTop={1}>
				{options.map((opt, i) => (
					<OptionRow
						key={opt.value}
						option={opt}
						focused={i === idx}
						labelColumnWidth={colWidth}
					/>
				))}
			</Box>
			<Box marginTop={1} paddingLeft={2}>
				<Text color={colors.muted}>
					↑/↓ move · enter select{onCancel ? ' · esc cancel' : ''}
				</Text>
			</Box>
		</Box>
	);
}

function OptionRow<T extends string>({
	option,
	focused,
	labelColumnWidth,
}: {
	option: SelectOption<T>;
	focused: boolean;
	labelColumnWidth: number;
}): ReactElement {
	return (
		<Box flexDirection="row">
			<Text color={focused ? colors.accent : undefined}>{focused ? '❯ ' : '  '}</Text>
			<Box width={labelColumnWidth}>
				<Text color={focused ? colors.accent : undefined} bold={focused}>
					{option.label}
				</Text>
			</Box>
			{option.description ? (
				<Text color={colors.muted}>{option.description}</Text>
			) : null}
		</Box>
	);
}
