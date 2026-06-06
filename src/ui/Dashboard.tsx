// src/ui/Dashboard.tsx
//
// Ink-rendered dashboard for `cam dashboard`. Layout:
//
//   ┌─ cam · <branch> ───────────────────────────────────────────┐
//   │ <US-ID>  <title>                                           │
//   │                                                            │
//   │ Progress  █████████░░░░░░░░░░░  N/M iter  ·  elapsed Hh Mm │
//   │ Status    ● running | ◌ idle | ! paused | ✓ booting        │
//   └────────────────────────────────────────────────────────────┘
//
//   Stories                          Recent
//   ─────────────────────────       ─────────────────────────
//     ✓ US-001  Title                · ## 2026-05-15 - US-007
//     → US-007  Title                · ## 2026-05-14 - US-006
//     ◌ US-008  Title                ...
//
//   press q or Ctrl+C to exit
//
// State comes from `readSnapshot()` (re-invoked on a poll interval). `q` or
// Ctrl+C unmounts via `useApp().exit()`. SIGWINCH triggers an Ink re-render
// automatically (Ink listens for it internally).

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';

import { colors } from './theme.ts';
import { layout } from '../design/tokens.ts';
import { Section } from './Section.tsx';
import type { DashboardData } from '../commands/dashboard.ts';
import type { PrdStory } from '../commands/status.ts';
import { formatWallClock } from '../commands/status.ts';

/** Width of the iteration progress bar (cells). */
const PROGRESS_BAR_WIDTH = 22;

/** How many stories the panel shows around the current one. */
const STORIES_WINDOW = 8;

export interface DashboardAppProps {
	/** Called every `pollIntervalMs` to refresh the data snapshot. */
	readSnapshot: () => DashboardData;
	pollIntervalMs: number;
}

export function DashboardApp({ readSnapshot, pollIntervalMs }: DashboardAppProps): ReactElement {
	const [data, setData] = useState<DashboardData>(() => readSnapshot());
	const { exit } = useApp();
	const { stdout } = useStdout();
	// Fit the section rule to the host pane. In the cam-run layout the dashboard
	// lives in a narrow (~36-col) tmux pane, so a fixed 50-col rule wrapped onto
	// a second line. Cap at the canonical width for a wide standalone terminal,
	// shrink to fit narrow panes. Recomputed on SIGWINCH (Ink re-renders).
	const cols = stdout?.columns ?? 80;
	const dividerWidth = Math.max(12, Math.min(layout.dividerWidth, cols - layout.headingIndent - 1));

	useEffect(() => {
		const id = setInterval(() => {
			setData(readSnapshot());
		}, pollIntervalMs);
		return () => clearInterval(id);
	}, [pollIntervalMs, readSnapshot]);

	useInput((input, key) => {
		if (input === 'q' || (key.ctrl && input === 'c')) {
			exit();
		}
	});

	return (
		<Box flexDirection="column">
			<SummaryPanel data={data} />
			<StoriesSection
				stories={data.stories ?? []}
				currentId={data.currentStoryId}
				dividerWidth={dividerWidth}
			/>
			<RecentSection recent={data.recent} dividerWidth={dividerWidth} />
			<Box marginTop={1} paddingLeft={2}>
				<Text color={colors.muted}>press q or Ctrl+C to exit</Text>
			</Box>
		</Box>
	);
}

function SummaryPanel({ data }: { data: DashboardData }): ReactElement {
	const elapsedMs = data.startedAtMs > 0 ? Math.max(0, data.nowMs - data.startedAtMs) : 0;
	const elapsed = data.startedAtMs > 0 ? formatWallClock(elapsedMs) : '—';
	const storyLabel = data.currentStoryId
		? `${data.currentStoryId}  ${data.currentStoryTitle}`
		: data.idle
			? '(idle)'
			: '(booting)';
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={colors.muted}
			paddingX={2}
			paddingY={1}
		>
			<Box>
				<Text bold>cam </Text>
				<Text color={colors.muted}>· </Text>
				<Text color={colors.accent}>{data.branchName}</Text>
			</Box>
			<Box marginTop={1}>
				<Text>{storyLabel}</Text>
			</Box>
			<Box marginTop={1} flexDirection="row">
				<Box width={11}>
					<Text color={colors.muted}>Progress</Text>
				</Box>
				<ProgressBar value={data.iteration} max={data.maxIterations} />
				<Text color={colors.muted}>
					{'  '}
					{data.iteration}/{data.maxIterations} iter · {elapsed}
				</Text>
			</Box>
			<Box flexDirection="row">
				<Box width={11}>
					<Text color={colors.muted}>Status</Text>
				</Box>
				<StatusIndicator data={data} />
			</Box>
		</Box>
	);
}

function ProgressBar({ value, max }: { value: number; max: number }): ReactElement {
	const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
	const filled = Math.round(ratio * PROGRESS_BAR_WIDTH);
	const empty = PROGRESS_BAR_WIDTH - filled;
	return (
		<Text>
			<Text color={colors.accent}>{'█'.repeat(filled)}</Text>
			<Text color={colors.muted}>{'░'.repeat(empty)}</Text>
		</Text>
	);
}

function StatusIndicator({ data }: { data: DashboardData }): ReactElement {
	if (data.idle) {
		return (
			<Text>
				<Text color={colors.muted}>◌ </Text>
				<Text color={colors.muted}>idle (no state file)</Text>
			</Text>
		);
	}
	if (data.paused) {
		return (
			<Text>
				<Text color={colors.warning}>! </Text>
				<Text>paused (active:false) — `cam stop` to clear</Text>
			</Text>
		);
	}
	if (data.startedAtMs === 0) {
		return (
			<Text>
				<Text color={colors.accent}>◌ </Text>
				<Text>booting</Text>
			</Text>
		);
	}
	return (
		<Text>
			<Text color={colors.accent}>● </Text>
			<Text>running</Text>
		</Text>
	);
}

function StoriesSection({
	stories,
	currentId,
	dividerWidth,
}: {
	stories: readonly PrdStory[];
	currentId: string;
	dividerWidth: number;
}): ReactElement {
	if (stories.length === 0) {
		return (
			<Section heading="Stories" dividerWidth={dividerWidth}>
				<Text color={colors.muted}>(no prd.json found)</Text>
			</Section>
		);
	}

	// Stable order: respect `priority` ascending when present, otherwise input order.
	const ordered = [...stories].sort((a, b) => {
		const pa = a.priority ?? Number.POSITIVE_INFINITY;
		const pb = b.priority ?? Number.POSITIVE_INFINITY;
		return pa - pb;
	});

	// Window around the current story so the panel stays a fixed height even
	// when the PRD has 30+ stories. Falls back to "first N" when nothing is
	// current (idle / booting).
	const currentIdx = ordered.findIndex((s) => s.id === currentId);
	const window = computeWindow(ordered.length, currentIdx, STORIES_WINDOW);

	return (
		<Section heading="Stories" dividerWidth={dividerWidth}>
			{ordered.slice(window.start, window.end).map((s) => (
				<StoryRow key={s.id} story={s} isCurrent={s.id === currentId} />
			))}
			{window.end < ordered.length ? (
				<Text color={colors.muted}>
					{'  '}…{ordered.length - window.end} more
				</Text>
			) : null}
		</Section>
	);
}

function StoryRow({ story, isCurrent }: { story: PrdStory; isCurrent: boolean }): ReactElement {
	const { icon, iconColor, titleColor } = storyVisual(story, isCurrent);
	return (
		<Box flexDirection="row">
			<Text color={iconColor}>{icon} </Text>
			<Box width={9}>
				<Text color={titleColor}>{story.id}</Text>
			</Box>
			<Text color={titleColor}>{story.title}</Text>
		</Box>
	);
}

function storyVisual(
	story: PrdStory,
	isCurrent: boolean,
): { icon: string; iconColor: string; titleColor: string | undefined } {
	if (story.passes === true) {
		return { icon: '✓', iconColor: colors.accent, titleColor: colors.muted };
	}
	if (isCurrent) {
		return { icon: '→', iconColor: colors.accent, titleColor: undefined };
	}
	return { icon: '◌', iconColor: colors.muted, titleColor: colors.muted };
}

function computeWindow(total: number, currentIdx: number, size: number): { start: number; end: number } {
	if (total <= size) return { start: 0, end: total };
	if (currentIdx < 0) return { start: 0, end: size };
	// Keep the current story roughly 1/3 from the top of the window so the
	// operator sees a couple of passed stories above and the upcoming queue
	// below.
	const headroom = Math.floor(size / 3);
	const start = Math.max(0, Math.min(total - size, currentIdx - headroom));
	return { start, end: start + size };
}

function RecentSection({ recent, dividerWidth }: { recent: readonly string[]; dividerWidth: number }): ReactElement {
	if (recent.length === 0) {
		return (
			<Section heading="Recent" dividerWidth={dividerWidth}>
				<Text color={colors.muted}>(no progress.txt entries yet)</Text>
			</Section>
		);
	}
	return (
		<Section heading="Recent" dividerWidth={dividerWidth}>
			{recent.map((entry, i) => (
				<Box key={i} flexDirection="row">
					<Text color={colors.muted}>· </Text>
					<Text>{entry}</Text>
				</Box>
			))}
		</Section>
	);
}
