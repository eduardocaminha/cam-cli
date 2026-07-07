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
import type { ReactElement, ReactNode } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { spawnSync } from 'node:child_process';

import { colors } from './theme.ts';
import { layout } from '../design/tokens.ts';
import { Section } from './Section.tsx';
import type { DashboardData } from '../commands/dashboard.ts';
import type { PrdStory } from '../commands/status.ts';
import { formatWallClock } from '../commands/status.ts';
import { renderTokensLine, type TranscriptUsage } from '../transcript/usage.ts';
import { tmuxArgs } from '../tmux/session.ts';

/** Max width of the iteration progress bar (cells). Shrinks to fit narrow
 *  panes; this is the cap for a wide standalone terminal. */
const PROGRESS_BAR_WIDTH = 22;

/** How many stories the panel shows around the current one. */
const STORIES_WINDOW = 8;

/** View mode for the Stories panel: list cursor or story detail. */
export type SelectionMode = 'list' | 'detail';

/** State managed by the selection reducer: cursor index + view mode. */
export interface SelectionState {
	selected: number;
	mode: SelectionMode;
}

/**
 * Pure reducer for the Stories panel.
 * Handles navigation (up/down) and view transitions (enter/esc).
 * - enter in list mode (storyCount > 0): open detail view.
 * - esc in detail mode: return to list.
 * - up/down: clamp cursor to [0, storyCount-1], only in list mode.
 * - No-ops when the action does not apply to the current mode.
 */
export function selectionReducer(
	state: SelectionState,
	action: 'up' | 'down' | 'enter' | 'esc',
	storyCount: number,
): SelectionState {
	if (action === 'enter') {
		if (state.mode === 'list' && storyCount > 0) {
			return { ...state, mode: 'detail' };
		}
		return state;
	}
	if (action === 'esc') {
		if (state.mode === 'detail') {
			return { ...state, mode: 'list' };
		}
		return state;
	}
	// up/down only apply in list mode
	if (state.mode !== 'list') return state;
	if (storyCount === 0) return state;
	if (action === 'up') {
		return { ...state, selected: Math.max(0, state.selected - 1) };
	}
	return { ...state, selected: Math.min(storyCount - 1, state.selected + 1) };
}

/**
 * Shown in the Stories panel next to a story that has no worker session marker
 * yet (US-014). A muted middot keeps the row visually quiet for the pending
 * queue while still signalling "no token data" rather than crashing.
 */
export const STORY_TOKENS_PLACEHOLDER = '·';

/** A single dispatch command wired to the keybar. */
interface KeybarCommand {
	key: string;
	label: string;
	desc: string;
	slash: string;
}

const KEYBAR_COMMANDS: readonly KeybarCommand[] = [
	{ key: 'n', label: '/cam-next', desc: 'run next story', slash: '/cam-next' },
	{ key: 'r', label: '/cam-review', desc: 'review PRD', slash: '/cam-review' },
	{ key: 's', label: '/cam-ship', desc: 'ship iteration', slash: '/cam-ship' },
	{ key: 'p', label: '/cam-plan', desc: 'plan an issue', slash: '/cam-plan' },
	{ key: 'i', label: '/cam-issue', desc: 'create issue', slash: '/cam-issue' },
];

export interface DashboardAppProps {
	/** Called every `pollIntervalMs` to refresh the data snapshot. */
	readSnapshot: () => DashboardData;
	pollIntervalMs: number;
	/**
	 * tmux pane id of the orchestrator (target for send-keys).
	 * When undefined (standalone `cam dashboard`), dispatch keys are inert no-ops.
	 */
	orchPane?: string;
	/** Injectable tmux runner for tests. Defaults to a real spawnSync. */
	runTmux?: (args: string[]) => void;
}

export function DashboardApp({ readSnapshot, pollIntervalMs, orchPane, runTmux }: DashboardAppProps): ReactElement {
	const [data, setData] = useState<DashboardData>(() => readSnapshot());
	const { exit } = useApp();
	const { stdout } = useStdout();
	const stories = data.stories ?? [];
	const [sel, setSel] = useState<SelectionState>({ selected: 0, mode: 'list' });
	// Fit the section rule to the host pane: full width minus a symmetric margin
	// (the heading indent on each side), so the rule spans the pane instead of
	// stopping at a fixed 50-col cap. Recomputed on SIGWINCH (Ink re-renders).
	const cols = stdout?.columns ?? 80;
	const dividerWidth = Math.max(12, cols - layout.headingIndent * 2);
	// Progress bar shrinks to fit: leave room for the content indent, the
	// `iter` key column, and the ` N/M` counter that follows the bar.
	const barWidth = Math.max(6, Math.min(PROGRESS_BAR_WIDTH, cols - 22));

	// Resolve the tmux runner the same way Menu.tsx does: injectable for tests,
	// real spawnSync as the default. The -L socket flag is applied by tmuxArgs().
	const tmux =
		runTmux ?? ((args: string[]) => void spawnSync('tmux', tmuxArgs(args), { stdio: 'ignore' }));

	useEffect(() => {
		const id = setInterval(() => {
			setData(readSnapshot());
		}, pollIntervalMs);
		return () => clearInterval(id);
	}, [pollIntervalMs, readSnapshot]);

	useInput((input, key) => {
		if (input === 'q' || (key.ctrl && input === 'c')) {
			exit();
			return;
		}
		// Esc: return to list from detail mode (no-op in list mode).
		if (key.escape) {
			setSel((s) => selectionReducer(s, 'esc', stories.length));
			return;
		}
		// Enter: open detail for the selected story (no-op in detail mode or empty list).
		if (key.return) {
			setSel((s) => selectionReducer(s, 'enter', stories.length));
			return;
		}
		// Navigation and dispatch keys are only active in list mode.
		if (sel.mode === 'detail') return;
		// j / downArrow: move selection cursor down.
		if (input === 'j' || key.downArrow) {
			setSel((s) => selectionReducer(s, 'down', stories.length));
			return;
		}
		// k / upArrow: move selection cursor up.
		if (input === 'k' || key.upArrow) {
			setSel((s) => selectionReducer(s, 'up', stories.length));
			return;
		}
		const lower = input.toLowerCase();
		if (lower === 'd') {
			// Focus the orchestrator pane; inert when orchPane is undefined.
			if (orchPane !== undefined) {
				tmux(['select-pane', '-t', orchPane]);
			}
			return;
		}
		const cmd = KEYBAR_COMMANDS.find((c) => c.key === lower);
		if (cmd) {
			// Send the slash command to the orchestrator; inert when orchPane is undefined.
			if (orchPane !== undefined) {
				tmux(['send-keys', '-t', orchPane, cmd.slash, 'Enter']);
			}
		}
	});

	// Compute the sorted story order for the detail view (same sort as StoriesSection uses).
	const orderedForDetail: readonly PrdStory[] =
		stories.length === 0
			? []
			: [...stories].sort((a, b) => {
					const pa = a.priority ?? Number.POSITIVE_INFINITY;
					const pb = b.priority ?? Number.POSITIVE_INFINITY;
					return pa - pb;
				});
	const selectedStory: PrdStory | undefined = orderedForDetail[sel.selected];

	return (
		<Box flexDirection="column">
			<SummaryPanel data={data} dividerWidth={dividerWidth} barWidth={barWidth} />
			{sel.mode === 'list' ? (
				<>
					<StoriesSection
						stories={stories}
						currentId={data.currentStoryId}
						selectedIdx={sel.selected}
						dividerWidth={dividerWidth}
						storyTokens={data.storyTokens ?? {}}
					/>
					<RecentSection recent={data.recent} dividerWidth={dividerWidth} />
					<Keybar dividerWidth={dividerWidth} />
				</>
			) : (
				<>
					<StoryDetailView
						story={selectedStory}
						currentId={data.currentStoryId}
						reviewLastVerdict={data.reviewLastVerdict}
						dividerWidth={dividerWidth}
					/>
					<DetailKeybar />
				</>
			)}
		</Box>
	);
}

/** Full keybar footer: a "Commands" section (heading + divider, matching Loop/
 * Stories/Recent) wrapping the slash-command keys + d (focus orchestrator) + q. */
function Keybar({ dividerWidth }: { dividerWidth: number }): ReactElement {
	return (
		<Section heading="Commands" dividerWidth={dividerWidth}>
			{KEYBAR_COMMANDS.map((c) => (
				<Box key={c.key} flexDirection="row">
					<Text bold>{c.key}</Text>
					<Text>{'  '}</Text>
					<Box width={11}>
						<Text bold>{c.label}</Text>
					</Box>
					<Text>{'  '}</Text>
					<Text color={colors.muted}>{c.desc}</Text>
				</Box>
			))}
			<Box flexDirection="row">
				<Text bold>d</Text>
				<Text color={colors.muted}>{'  '}focus orchestrator</Text>
			</Box>
			<Box flexDirection="row">
				<Text bold>q</Text>
				<Text color={colors.muted}>{'  '}close pane</Text>
			</Box>
		</Section>
	);
}

/** Contextual keybar for detail mode: Esc to go back, q to quit. */
function DetailKeybar(): ReactElement {
	return (
		<Box marginTop={1} flexDirection="column" paddingLeft={layout.headingIndent}>
			<Box flexDirection="row">
				<Text bold>Esc</Text>
				<Text color={colors.muted}>{'  '}back to list</Text>
			</Box>
			<Box flexDirection="row">
				<Text bold>q</Text>
				<Text color={colors.muted}>{'  '}close pane</Text>
			</Box>
		</Box>
	);
}

/** Structural checkbox glyph for acceptanceCriteria items: purely visual scaffolding. */
const AC_CHECKBOX = '□';

/**
 * Detail subview for a single story: id, title, status glyph, acceptanceCriteria
 * checklist, notes block (when non-empty), and the review verdict when present.
 * Status stays signalled by the glyph (accent check / accent arrow / muted ring),
 * never by divider color.
 */
function StoryDetailView({
	story,
	currentId,
	reviewLastVerdict,
	dividerWidth,
}: {
	story: PrdStory | undefined;
	currentId: string;
	reviewLastVerdict: string | undefined;
	dividerWidth: number;
}): ReactElement {
	if (story === undefined) {
		return (
			<Section heading="Story" dividerWidth={dividerWidth}>
				<Text color={colors.muted}>(no story selected)</Text>
			</Section>
		);
	}
	const { icon, iconColor } = storyVisual(story, story.id === currentId);
	const criteria = story.acceptanceCriteria ?? [];
	return (
		<Section heading="Story" dividerWidth={dividerWidth}>
			<Box flexDirection="row">
				<Text color={iconColor}>{icon} </Text>
				<Text bold>{story.id}</Text>
				<Text>{'  '}{story.title}</Text>
			</Box>
			{criteria.length > 0 ? (
				<Box flexDirection="column" marginTop={1}>
					{criteria.map((ac, i) => (
						<Box key={i} flexDirection="row">
							<Text color={colors.muted}>{AC_CHECKBOX} </Text>
							<Text>{ac}</Text>
						</Box>
					))}
				</Box>
			) : null}
			{story.notes ? (
				<Box flexDirection="column" marginTop={1}>
					<Text color={colors.muted}>Notes:</Text>
					<Box paddingLeft={2}>
						<Text>{story.notes}</Text>
					</Box>
				</Box>
			) : null}
			{reviewLastVerdict !== undefined ? (
				<Box flexDirection="row" marginTop={1}>
					<Text color={colors.muted}>Review: </Text>
					<Text>{reviewLastVerdict}</Text>
				</Box>
			) : null}
		</Section>
	);
}

function SummaryPanel({
	data,
	dividerWidth,
	barWidth,
}: {
	data: DashboardData;
	dividerWidth: number;
	barWidth: number;
}): ReactElement {
	const elapsedMs = data.startedAtMs > 0 ? Math.max(0, data.nowMs - data.startedAtMs) : 0;
	const elapsed = data.startedAtMs > 0 ? formatWallClock(elapsedMs) : '—';
	// US-002: `since` row uses last_activity when present (real last-work
	// heartbeat), falling back to started_at-based elapsed so a stalled loop
	// is visually distinguishable from a productive one.
	const lastActivityMs =
		data.lastActivity !== undefined ? Date.parse(data.lastActivity) : NaN;
	const sinceDisplay = Number.isFinite(lastActivityMs)
		? formatWallClock(Math.max(0, data.nowMs - lastActivityMs))
		: elapsed;
	const storyLabel = data.currentStoryId
		? `${data.currentStoryId}  ${data.currentStoryTitle}`
		: data.idle
			? '(idle)'
			: '(booting)';
	// The progress bar reflects PRD completion (stories passed / total).
	const storiesTotal = (data.stories ?? []).length;
	const storiesDone = (data.stories ?? []).filter((s) => s.passes === true).length;
	// No box: the summary is a Section ("Loop") so the dashboard speaks the same
	// vocabulary as `cam status` (bold heading + muted rule + key/value rows),
	// instead of a round border that nothing else in cam uses.
	return (
		<Section heading="Loop" dividerWidth={dividerWidth} gapTop={0}>
			<SummaryRow label="state">
				{/* US-002: StatusIndicator shows "running US-XXX (N/total)" when active */}
				<StatusIndicator
					data={data}
					storiesDone={storiesDone}
					storiesTotal={storiesTotal}
				/>
			</SummaryRow>
			<SummaryRow label="story">
				<Text>{storyLabel}</Text>
			</SummaryRow>
			<SummaryRow label="progress">
				<ProgressBar value={storiesDone} max={storiesTotal} width={barWidth} />
				<Text color={colors.muted}>
					{' '}
					{storiesDone}/{storiesTotal}
				</Text>
			</SummaryRow>
			{/* US-002: `iter` (stop-hook turns) row removed; replaced by stories
			    count in the StatusIndicator and progress bar above. */}
			<SummaryRow label="since">
				<Text color={colors.muted}>{sinceDisplay}</Text>
			</SummaryRow>
			{data.tokensInput !== undefined ? (
				<SummaryRow label="tokens">
					<Text color={colors.muted}>
						{renderTokensLine({
							input: data.tokensInput ?? 0,
							output: data.tokensOutput ?? 0,
							cacheRead: data.tokensCacheRead ?? 0,
							cacheCreation: data.tokensCacheCreation ?? 0,
						})}
					</Text>
				</SummaryRow>
			) : null}
			<SummaryRow label="branch">
				<Text color={colors.accent}>{data.branchName}</Text>
			</SummaryRow>
		</Section>
	);
}

/** One key/value row inside the Loop section. Key column matches the print
 *  path's status rows (muted label, fixed-width column). */
function SummaryRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
	return (
		<Box flexDirection="row">
			<Box width={9}>
				<Text color={colors.muted}>{label}</Text>
			</Box>
			{children}
		</Box>
	);
}

function ProgressBar({ value, max, width }: { value: number; max: number; width: number }): ReactElement {
	const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
	const filled = Math.round(ratio * width);
	const empty = width - filled;
	return (
		<Text>
			<Text color={colors.accent}>{'█'.repeat(filled)}</Text>
			<Text color={colors.muted}>{'░'.repeat(empty)}</Text>
		</Text>
	);
}

function StatusIndicator({
	data,
	storiesDone,
	storiesTotal,
}: {
	data: DashboardData;
	storiesDone: number;
	storiesTotal: number;
}): ReactElement {
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
				<Text>paused (active:false)</Text>
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
	// US-002: show "running US-XXX (N/total)" so the operator can see real
	// per-story progress instead of the meaningless stop-hook iteration count.
	const storyPart = data.currentStoryId ? ` ${data.currentStoryId}` : '';
	const countPart = storiesTotal > 0 ? ` (${storiesDone}/${storiesTotal})` : '';
	return (
		<Text>
			<Text color={colors.accent}>● </Text>
			<Text>running{storyPart}{countPart}</Text>
		</Text>
	);
}

function StoriesSection({
	stories,
	currentId,
	selectedIdx,
	dividerWidth,
	storyTokens,
}: {
	stories: readonly PrdStory[];
	currentId: string;
	selectedIdx: number;
	dividerWidth: number;
	storyTokens: Record<string, TranscriptUsage>;
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

	// Window follows the selection cursor so the highlighted row is always
	// visible even when the PRD has 30+ stories.
	const window = computeWindow(ordered.length, selectedIdx, STORIES_WINDOW);

	return (
		<Section heading="Stories" dividerWidth={dividerWidth}>
			{ordered.slice(window.start, window.end).map((s, i) => (
				<StoryRow
					key={s.id}
					story={s}
					isCurrent={s.id === currentId}
					tokens={storyTokens[s.id]}
					isSelected={window.start + i === selectedIdx}
				/>
			))}
			{window.end < ordered.length ? (
				<Text color={colors.muted}>
					{'  '}…{ordered.length - window.end} more
				</Text>
			) : null}
		</Section>
	);
}

/** Dark foreground for use on the accent-green selected-row background. */
const DARK = '#000000';

/**
 * Fixed row budget (chars) for a story title in the Stories list (US-001).
 * A fixed constant, not derived from terminal width: the tokens column must
 * stay visible on the same row regardless of pane width, and threading a
 * dynamic budget down from DashboardApp's `cols` would still need a cap to
 * leave room for the icon/id/tokens segments sharing the row.
 */
const STORY_TITLE_MAX_WIDTH = 40;

/**
 * Truncates `title` to at most `maxWidth` characters, cutting with a
 * trailing ellipsis (…) when it exceeds the budget. Titles within budget are
 * returned unchanged (no ellipsis appended). Exported for direct unit testing.
 */
export function truncateTitle(title: string, maxWidth: number): string {
	if (maxWidth <= 0) return '';
	if (title.length <= maxWidth) return title;
	if (maxWidth === 1) return '…';
	return `${title.slice(0, maxWidth - 1)}…`;
}

function StoryRow({
	story,
	isCurrent,
	tokens,
	isSelected,
}: {
	story: PrdStory;
	isCurrent: boolean;
	tokens: TranscriptUsage | undefined;
	isSelected: boolean;
}): ReactElement {
	const { icon, iconColor, titleColor } = storyVisual(story, isCurrent);
	// Per-story tokens sit next to the row (US-014). Reuse renderTokensLine so the
	// wording matches the Loop panel's `tokens` row; a missing marker shows a muted
	// placeholder instead of crashing. State stays signalled by the glyph (✓/→/◌),
	// never the Section divider color.
	if (isSelected) {
		// Selected row: accent background, dark fg. The glyph still encodes pass-state
		// (✓/→/◌); the background color signals selection only.
		const line = `${icon} ${story.id.padEnd(9)} ${truncateTitle(story.title, STORY_TITLE_MAX_WIDTH)}  ${tokens ? renderTokensLine(tokens) : STORY_TOKENS_PLACEHOLDER}`;
		return (
			<Text backgroundColor={colors.accent} color={DARK}>{line}</Text>
		);
	}
	return (
		<Box flexDirection="row">
			<Text color={iconColor}>{icon} </Text>
			<Box width={9}>
				<Text color={titleColor}>{story.id}</Text>
			</Box>
			<Text color={titleColor}>{truncateTitle(story.title, STORY_TITLE_MAX_WIDTH)}</Text>
			<Text color={colors.muted}>
				{'  '}
				{tokens ? renderTokensLine(tokens) : STORY_TOKENS_PLACEHOLDER}
			</Text>
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
				<Text color={colors.muted}>(no activity yet)</Text>
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
