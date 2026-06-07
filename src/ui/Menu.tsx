// src/ui/Menu.tsx
//
// Ink-rendered interactive menu for the `cam run` workspace (the bottom-right
// pane). Renders the same way the dashboard does, on purpose: it reuses the
// shared Section primitive, so the heading + rule line up with the dashboard's
// "Loop"/"Stories" sections and the rule width is derived from the pane's own
// `stdout.columns` (always correct, recomputed on SIGWINCH) instead of the
// bash menu's fragile `tput cols` / `tmux display-message` width detection.
//
// Keys mirror the old bash loop: n/r/s/p/i send the matching slash command to
// the orchestrator pane; d focuses the dashboard pane; q (or Ctrl+C) exits,
// which closes the pane. The orchestrator/dashboard pane ids are passed in by
// the caller (`cam menu <orchPane> <dashboardPane>`), captured by `cam run`.

import type { ReactElement } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { spawnSync } from 'node:child_process';

import { colors } from './theme.ts';
import { layout } from '../design/tokens.ts';
import { Section } from './Section.tsx';
import { tmuxArgs } from '../tmux/session.ts';

/** A single dispatchable command row. */
interface MenuCommand {
	key: string;
	label: string;
	desc: string;
	slash: string;
}

const COMMANDS: readonly MenuCommand[] = [
	{ key: 'n', label: '/cam-next', desc: 'run next story', slash: '/cam-next' },
	{ key: 'r', label: '/cam-review', desc: 'review PRD', slash: '/cam-review' },
	{ key: 's', label: '/cam-ship', desc: 'ship iteration', slash: '/cam-ship' },
	{ key: 'p', label: '/cam-plan', desc: 'plan an issue', slash: '/cam-plan' },
	{ key: 'i', label: '/cam-issue', desc: 'create issue', slash: '/cam-issue' },
];

export interface MenuAppProps {
	/** tmux pane id of the orchestrator (target for send-keys). */
	orchPane: string;
	/** tmux pane id of the dashboard (target for select-pane). */
	dashboardPane: string;
	/** Injectable tmux runner for tests. Defaults to a real `spawnSync`. */
	runTmux?: (args: string[]) => void;
}

export function MenuApp({ orchPane, dashboardPane, runTmux }: MenuAppProps): ReactElement {
	const { exit } = useApp();
	const { stdout } = useStdout();
	// Same technique as the dashboard: rule width = full pane minus a symmetric
	// margin (the heading indent on each side). Recomputed on SIGWINCH.
	const cols = stdout?.columns ?? 80;
	const dividerWidth = Math.max(12, cols - layout.headingIndent * 2);

	const tmux =
		runTmux ?? ((args: string[]) => void spawnSync('tmux', tmuxArgs(args), { stdio: 'ignore' }));

	useInput((input, key) => {
		if (key.ctrl && input === 'c') {
			exit();
			return;
		}
		const lower = input.toLowerCase();
		if (lower === 'q') {
			exit();
			return;
		}
		if (lower === 'd') {
			tmux(['select-pane', '-t', dashboardPane]);
			return;
		}
		const cmd = COMMANDS.find((c) => c.key === lower);
		if (cmd) {
			tmux(['send-keys', '-t', orchPane, cmd.slash, 'Enter']);
		}
	});

	return (
		<Box flexDirection="column">
			<Section heading="Commands" dividerWidth={dividerWidth} gapTop={0}>
				{COMMANDS.map((c) => (
					<MenuRow key={c.key} cmdKey={c.key} label={c.label} desc={c.desc} />
				))}
			</Section>
			<Box marginTop={1} flexDirection="column" paddingLeft={layout.headingIndent}>
				<Box flexDirection="row">
					<Text bold>d</Text>
					<Text color={colors.muted}>{'  '}focus dashboard pane</Text>
				</Box>
				<Box flexDirection="row">
					<Text bold>q</Text>
					<Text color={colors.muted}>{'  '}close pane</Text>
				</Box>
			</Box>
		</Box>
	);
}

/** One command row: bold key, bold command label (fixed column), muted desc. */
function MenuRow({ cmdKey, label, desc }: { cmdKey: string; label: string; desc: string }): ReactElement {
	return (
		<Box flexDirection="row">
			<Text bold>{cmdKey}</Text>
			<Text>{'  '}</Text>
			<Box width={11}>
				<Text bold>{label}</Text>
			</Box>
			<Text>{'  '}</Text>
			<Text color={colors.muted}>{desc}</Text>
		</Box>
	);
}
