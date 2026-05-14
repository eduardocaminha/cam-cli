// src/ui/Select.tsx
//
// Reusable keyboard-driven option list: arrow keys (or j/k) move focus, Enter
// accepts, Esc cancels. Mirrors the look of Claude Code's CustomSelect:
// `❯` pointer + bold accent on the focused row, dimmed description below.
//
// `confirmed` prop renders a single "✓ {label}" line in place of the list —
// callers in a wizard-style flow set it to true after the user picks to keep
// the chosen answer visible while the next question is shown below.

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
	onChange: (value: T) => void;
	onCancel?: () => void;
}

export function Select<T extends string>({
	question,
	options,
	defaultValue,
	confirmed = false,
	confirmedValue,
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
			<Box flexDirection="row">
				<Text color={colors.accent}>✓ </Text>
				<Text>{chosen.label}</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<Text bold>{question}</Text>
			<Box flexDirection="column" marginTop={1}>
				{options.map((opt, i) => (
					<OptionRow key={opt.value} option={opt} focused={i === idx} />
				))}
			</Box>
			<Box marginTop={1}>
				<Text color={colors.muted}>↑/↓ navigate · ⏎ select{onCancel ? ' · esc cancel' : ''}</Text>
			</Box>
		</Box>
	);
}

function OptionRow<T extends string>({
	option,
	focused,
}: {
	option: SelectOption<T>;
	focused: boolean;
}): ReactElement {
	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				<Text color={focused ? colors.accent : undefined}>{focused ? '❯ ' : '  '}</Text>
				<Text color={focused ? colors.accent : undefined} bold={focused}>
					{option.label}
				</Text>
			</Box>
			{option.description ? (
				<Box marginLeft={2}>
					<Text color={colors.muted}>{option.description}</Text>
				</Box>
			) : null}
		</Box>
	);
}
